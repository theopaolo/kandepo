#!/usr/bin/env node

/**
 * kandepo: a kanban generated from the markdown tasks of a repo.
 * Usage: kandepo [tasks-dir] [output-file] [--no-serve] [--watch] [--sync[=name]] [--dry-run] [--help]
 * While it runs, the server serves the board on http://localhost:<port>, watches the
 * task folders and rebuilds the HTML. GET /events tells open boards to reload, POST /new creates
 * a task, POST /field sets one frontmatter key, POST /check ticks a checkbox, POST /open opens the file in the editor.
 * --sync runs the connectors of the config.
 * Config: kandepo.config.json in the current folder, every key optional, see DEFAULTS.
 * CLI arguments win over the config file.
 */

const fs = require('fs');
const path = require('path');

const STATUSES = ['not_started', 'in_progress', 'blocked', 'done'];

const DEFAULTS = {
  dirs: ['./tasks'],
  output: './kanban.html',
  title: 'Kanban',
  port: 7878,
  editor: process.env.EDITOR || 'code',
  columns: { not_started: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' },
  // Field name → allowed values, in sort order. An empty list takes any value.
  fields: { priority: ['high', 'medium', 'low'] },
};

// Built-in keys a custom field would shadow, in the task data or in the filter ids.
const RESERVED = ['title', 'status', 'scope', 'type', 'assign', 'due', 'issue_url', 'filename', 'body', 'links', 'sort', 'view', 'reset'];

function loadConfig(argv = process.argv.slice(2), cwd = process.cwd()) {
  const file = path.join(cwd, 'kandepo.config.json');
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
  const positional = argv.filter(a => !a.startsWith('--'));
  const cfg = { ...DEFAULTS, ...user, columns: { ...DEFAULTS.columns, ...user.columns } };
  cfg.fields = Object.fromEntries(Object.entries(cfg.fields).map(([name, values]) => {
    if (RESERVED.includes(name) || name.startsWith('_')) throw new Error(`kandepo.config.json: "${name}" is a built-in field, pick another name`);
    if (!Array.isArray(values)) throw new Error(`kandepo.config.json: fields.${name} must be a list of values, [] for free text`);
    return [name, values.map(String)];
  }));
  if (positional[0]) cfg.dirs = [positional[0]];
  if (positional[1]) cfg.output = positional[1];
  cfg.serve = !argv.includes('--no-serve');
  cfg.watch = cfg.serve || argv.includes('--watch');
  return cfg;
}

const CONFIG = loadConfig();

// --- YAML frontmatter parser (no dependencies) ---
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: content };

  const yamlStr = match[1];
  const body = match[2].trim();
  const data = {};

  const lines = yamlStr.split('\n');
  let currentKey = null;

  lines.forEach(line => {
    if (/^\s*#/.test(line)) return; // YAML comment, like the optional fields of a task created from the board

    // Multi-line list item: "  - value"
    if (currentKey && line.match(/^\s+- /)) {
      const val = line.replace(/^\s+- /, '').trim();
      if (val) data[currentKey].push(val);
      return;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { currentKey = null; return; }

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    currentKey = null;

    if (value === '~' || value === 'null' || value === '""') {
      data[key] = null;
    } else if (value === '') {
      // No inline value — may be followed by block list items
      data[key] = [];
      currentKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map(v => v.trim()).filter(Boolean);
    } else {
      data[key] = value;
    }
  });

  return { data, body };
}

// --- Read all .md files from multiple dirs ---
function readTasks(dirs) {
  const tasks = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    files.forEach(filename => {
      const file = path.join(dir, filename);
      const content = fs.readFileSync(file, 'utf-8');
      const { data, body } = parseFrontmatter(content);
      tasks.push({
        filename,
        ...data,
        body,
        status: (data.status && data.status !== '""') ? data.status : 'not_started',
        _dir: path.basename(dir),
        _path: path.resolve(file),
        // Last save of the file. A git clone or checkout resets it.
        _mtime: Math.round(fs.statSync(file).mtimeMs),
      });
    });
  }
  return tasks;
}

// --- Wikilinks: [[file-slug]] or [[Title]] in the body → index of the target task ---
function resolveLinks(tasks) {
  const byKey = new Map();
  tasks.forEach((t, i) => {
    byKey.set(t.filename.replace(/\.md$/, '').toLowerCase(), i);
    if (t.title) byKey.set(String(t.title).toLowerCase(), i);
  });
  tasks.forEach(t => {
    t.links = {};
    for (const [, raw] of (t.body || '').matchAll(/\[\[([^\]]+)\]\]/g)) {
      const i = byKey.get(raw.trim().toLowerCase());
      if (i !== undefined) t.links[raw] = i;
    }
  });
  return tasks;
}

// --- Filters: one select per key, values from the config or collected from the tasks ---
function collectFilters(tasks, fields = CONFIG.fields) {
  const collect = key => {
    const seen = new Map(); // lowercase → first casing met
    tasks.forEach(t => [].concat(t[key] ?? []).forEach(v => {
      const k = String(v).toLowerCase();
      if (!seen.has(k)) seen.set(k, String(v));
    }));
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  };
  return [
    ...Object.entries(fields).map(([key, values]) => ({ key, label: key, values: values.length ? values : collect(key) })),
    { key: 'assign', label: 'assign', values: collect('assign') },
    { key: 'scope', label: 'scope', values: collect('scope') },
    { key: '_dir', label: 'folder', values: collect('_dir') },
  ];
}

// --- Serialize tasks to JSON for the HTML ---
function escapeJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'task';
}

const columns = (cfg = CONFIG) => STATUSES.map(id => ({ id, label: cfg.columns[id] }));

// Optional fields, as comments in every task created from the board: uncomment the ones you fill.
function fieldTemplate(fields = CONFIG.fields) {
  return [
    ...Object.entries(fields).map(([name, values]) => `# ${name}:${values.length ? ' ' + values.join(' | ') : ''}`),
    '# scope: [api, pwa]',
    '# type: [feature]',
    '# assign: Ana',
    '# due: 2026-10-01',
  ].join('\n');
}

const help = () => `Usage: kandepo [tasks-dir] [html-file] [--no-serve] [--watch] [--sync[=name]] [--dry-run]

Reads the .md files in ./tasks (or the dirs of kandepo.config.json), writes ./kanban.html
and serves it on http://localhost:${CONFIG.port} while the command runs.
--sync runs every connector of kandepo.config.json, --sync=name one of them.

One task = one .md file, only title is required:

---
title: Task name
status: ${STATUSES.join(' | ')}
${fieldTemplate().replace(/^# /gm, '')}
---
`;

// Sets one key in the frontmatter, the rest of the file stays as is. The new line replaces the key
// with its block list items, else its commented template line (`# key:`), else goes last.
// A null value removes the key.
function setField(content, key, value) {
  const line = value == null ? [] : [`${key}: ${value}`];
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return line.length ? `---\n${line[0]}\n---\n${content}` : content;
  const lines = match[1].split('\n');
  let at = lines.findIndex(l => l.startsWith(key + ':'));
  let count = 1;
  if (at === -1) at = lines.findIndex(l => l.startsWith(`# ${key}:`));
  if (at === -1) { at = lines.length; count = 0; }
  else while (/^\s+- /.test(lines[at + count] ?? '')) count++;
  lines.splice(at, count, ...line);
  return `---\n${lines.join('\n')}\n---${content.slice(match[0].length)}`;
}

// Ticks or unticks the n-th checkbox of the body. Code blocks are skipped, as the board skips them.
// Returns null when there is no such checkbox.
function setCheck(content, index, checked) {
  const frontmatter = content.match(/^---\n[\s\S]*?\n---\n?/);
  const start = frontmatter ? frontmatter[0].length : 0;
  const lines = content.slice(start).split('\n');
  let fence = false;
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) { fence = !fence; continue; }
    if (fence || !/^\s*[-*]\s+\[[ xX]\]\s/.test(lines[i])) continue;
    if (n++ !== index) continue;
    lines[i] = lines[i].replace(/\[[ xX]\]/, checked ? '[x]' : '[ ]');
    return content.slice(0, start) + lines.join('\n');
  }
  return null;
}

// A field edited from the board, checked and written as one frontmatter line. Throws on a value
// the parser would misread. Returns null to remove the key.
const LIST_FIELDS = ['scope', 'type'];
function formatField(key, value, fields = CONFIG.fields) {
  if (!['status', 'assign', 'due', ...LIST_FIELDS].includes(key) && !Object.hasOwn(fields, key)) throw new Error(`Not editable: ${key}`);
  const clean = v => {
    const text = String(v ?? '').trim();
    if (/[\r\n]/.test(text)) throw new Error('One line only');
    return text;
  };
  if (LIST_FIELDS.includes(key)) {
    const items = [].concat(value ?? []).map(clean).filter(Boolean);
    if (items.some(v => /[,[\]]/.test(v))) throw new Error(`No comma or bracket in ${key}`);
    return items.length ? `[${items.join(', ')}]` : null;
  }
  const text = clean(value);
  if (key === 'status' && !STATUSES.includes(text)) throw new Error(`Unknown status: ${text}`);
  if (!text) return null;
  if (key === 'due' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('due is YYYY-MM-DD');
  if (fields[key]?.length && !fields[key].includes(text)) throw new Error(`${key} is one of ${fields[key].join(', ')}`);
  if (/^\[|^(~|null|"")$/.test(text)) throw new Error(`The parser would not read ${text} as text`);
  return text;
}

// --- Generate HTML ---
function generateHTML(tasks, filters) {
  const options = values => values.map(value => {
    const text = escapeHtml(value);
    return `<option value="${text}">${text}</option>`;
  }).join('');
  const cols = columns();
  const values = {
    title: escapeHtml(CONFIG.title),
    // Inlined so the board stays one file. Latin subset of Atkinson Hyperlegible Next, OFL, see src/fonts/OFL.txt.
    font: `@font-face { font-family: 'Atkinson Hyperlegible Next'; font-weight: 200 800; font-display: swap; src: url(data:font/woff2;base64,${
      fs.readFileSync(path.join(__dirname, 'src/fonts/atkinson-hyperlegible-next.woff2')).toString('base64')}) format('woff2'); }`,
    styles: fs.readFileSync(path.join(__dirname, 'src/board.css'), 'utf-8').trimEnd(),
    script: fs.readFileSync(path.join(__dirname, 'src/board.js'), 'utf-8').trimEnd(),
    tasks: escapeJson(tasks),
    columns: escapeJson(cols),
    fields: escapeJson(CONFIG.fields),
    serverUrl: escapeJson(`http://localhost:${CONFIG.port}`),
    filters: filters.map(({ key, label, values }) => `
    <span class="filter"><label for="f-${key}">${escapeHtml(label)}</label>
    <select id="f-${key}" data-key="${key}"><option value="">All</option>${options(values)}</select></span>`).join(''),
    sorts: options(Object.keys(CONFIG.fields).filter(name => CONFIG.fields[name].length)),
    board: cols.map(col => `
  <section class="column" data-col="${col.id}" aria-labelledby="h-${col.id}">
    <div class="column-header">
      <span class="status-dot" style="background: var(--status-${col.id})" aria-hidden="true"></span>
      <h2 id="h-${col.id}"><button class="col-toggle" aria-expanded="true" aria-controls="col-${col.id}">${escapeHtml(col.label)}</button></h2>
      <span class="col-count" id="count-${col.id}">0</span>
      <button class="col-add" type="button" title="New task" aria-label="New task in ${escapeHtml(col.label)}">+</button>
    </div>
    <form class="col-new" hidden>
      <input type="text" placeholder="Title, Enter to create" required autocomplete="off" aria-label="Title of the new task">
      <span class="error" role="alert"></span>
    </form>
    <div class="cards" id="col-${col.id}"></div>
  </section>`).join(''),
  };
  return fs.readFileSync(path.join(__dirname, 'src/board.html'), 'utf-8')
    .replace(/{{(\w+)}}/g, (_, key) => values[key]);
}

// --- File access: only the .md files of the task folders ---
// The Origin check keeps other sites out, this filter keeps the board's own writes
// inside the task folders.
function isAllowedPath(p, dirs = CONFIG.dirs) {
  if (!p) return false;
  const target = path.resolve(p);
  if (path.extname(target) !== '.md') return false;
  return dirs.some(dir => {
    const root = path.resolve(dir);
    return target.startsWith(root + path.sep);
  });
}

// --- Main ---
const http = require('http');
const { execFile } = require('child_process');

// Open boards, as server-sent event streams. A rebuild that changes the HTML tells them to reload.
const clients = new Set();
let lastHtml = null;

// A write from the board rebuilds at once, then the watcher fires on the same change: the second
// build produces the same HTML and stops here.
function build() {
  const tasks = resolveLinks(readTasks(CONFIG.dirs));
  const html = generateHTML(tasks, collectFilters(tasks));
  if (html === lastHtml) return;
  lastHtml = html;
  fs.writeFileSync(CONFIG.output, html, 'utf-8');
  console.log(`\u2713 ${tasks.length} tasks \u2192 ${CONFIG.output}`);
  clients.forEach(res => res.write('data: reload\n\n'));
}

// Rebuilds the board when a .md changes. fs.watch can fire several times per save, hence the debounce.
function watch() {
  let timer = null;
  const rebuild = () => { clearTimeout(timer); timer = setTimeout(build, 150); };
  CONFIG.dirs.filter(d => fs.existsSync(d)).forEach(dir => {
    fs.watch(dir, (event, file) => { if (!file || file.endsWith('.md')) rebuild(); });
  });
  console.log('Watching tasks (Ctrl+C to stop).');
}

function openInEditor(filePath) {
  // `open -t` opens the default text editor on macOS, without launching the associated app.
  execFile(CONFIG.editor, [filePath], err => {
    if (err) execFile('open', ['-t', filePath]);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

// Serves the board and takes its writes. Every write is a same-origin JSON POST: another site
// passes neither the preflight (no CORS) nor the Origin check.
function serve() {
  const origins = new Set([`http://localhost:${CONFIG.port}`, `http://127.0.0.1:${CONFIG.port}`]);
  const server = http.createServer(async (req, res) => {
    const end = (code, body) => {
      res.writeHead(code, body ? { 'Content-Type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    if (req.method === 'GET' && req.url.split('?')[0] === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(CONFIG.output));
    }
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method !== 'POST') return end(404);
    if (req.headers.origin && !origins.has(req.headers.origin)) return end(403);
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return end(415);
    let body;
    try { body = await readJson(req); } catch { return end(400); }

    if (req.url === '/open') {
      if (!isAllowedPath(body.path)) return end(403);
      if (!fs.existsSync(body.path)) return end(404);
      openInEditor(body.path);
      return end(200);
    }
    if (req.url === '/new') {
      const title = String(body.title || '').replace(/\s+/g, ' ').trim();
      const status = body.status || 'not_started';
      if (!title) return end(400, { error: 'Empty title' });
      if (!STATUSES.includes(status)) return end(400, { error: `Unknown status: ${status}` });
      const file = path.join(CONFIG.dirs[0], `${slugify(title)}.md`);
      if (fs.existsSync(file)) return end(409, { error: `${path.basename(file)} already exists` });
      fs.mkdirSync(CONFIG.dirs[0], { recursive: true });
      fs.writeFileSync(file, `---\ntitle: ${title}\nstatus: ${status}\n${fieldTemplate()}\n---\n\n## Tasks\n\n- [ ] ${title}\n\n## Notes\n`);
      build();
      openInEditor(file);
      return end(201, { path: path.resolve(file) });
    }
    if (req.url === '/check') {
      if (!isAllowedPath(body.path) || !fs.existsSync(body.path)) return end(403);
      const content = setCheck(fs.readFileSync(body.path, 'utf-8'), Number(body.index), Boolean(body.checked));
      if (content == null) return end(400, { error: 'No such checkbox' });
      fs.writeFileSync(body.path, content);
      build();
      return end(200);
    }
    if (req.url === '/field') {
      if (!isAllowedPath(body.path) || !fs.existsSync(body.path)) return end(403);
      let value;
      try { value = formatField(body.key, body.value); } catch (err) { return end(400, { error: err.message }); }
      fs.writeFileSync(body.path, setField(fs.readFileSync(body.path, 'utf-8'), body.key, value));
      build();
      return end(200);
    }
    end(404);
  });

  server.listen(CONFIG.port, '127.0.0.1', () => {
    console.log(`\u21b3 board on http://localhost:${CONFIG.port}`);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`\u26a0 Port ${CONFIG.port} already in use, server not started. ${CONFIG.output} opens read-only.`);
    } else {
      throw err;
    }
  });
}

// A connector is a module listed in the config, resolved from the project, then from kandepo's
// own folder for `npx -p kandepo -p <connector>`. It exports sync(context) and writes task files
// itself, kandepo rebuilds the board after.
async function sync(argv, config = CONFIG, cwd = process.cwd()) {
  const only = (argv.find(a => a.startsWith('--sync=')) || '').slice('--sync='.length);
  const connectors = Object.entries(config.connectors || {}).filter(([name]) => !only || name === only);
  if (!connectors.length) throw new Error(only ? `No connector "${only}" in kandepo.config.json` : 'No connectors in kandepo.config.json');
  const dryRun = argv.includes('--dry-run');
  for (const [name, { use, ...options }] of connectors) {
    if (!use) throw new Error(`kandepo.config.json: connectors.${name} needs "use", a path or a package name`);
    const connector = require(require.resolve(use, { paths: [cwd, __dirname] }));
    await connector.sync({
      options, dryRun, dirs: config.dirs, statuses: STATUSES,
      tasks: readTasks(config.dirs),
      log: message => console.log(`[${name}] ${message}`),
      slugify, setField, parseFrontmatter,
    });
  }
  return dryRun;
}

if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(help());
  } else if (process.argv.some(a => a === '--sync' || a.startsWith('--sync='))) {
    sync(process.argv).then(dryRun => { if (!dryRun) build(); }).catch(err => {
      console.error(`Sync failed: ${err.message}`);
      process.exitCode = 1;
    });
  } else {
    build();
    if (CONFIG.serve) serve();
    if (CONFIG.watch) watch();
  }
}

module.exports = { loadConfig, parseFrontmatter, readTasks, resolveLinks, collectFilters, isAllowedPath, setField, setCheck, formatField, slugify, fieldTemplate, sync, DEFAULTS };

#!/usr/bin/env node
// Parser, config, generated HTML, server and watcher, against temporary projects.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { once } = require('events');
const { setTimeout: delay } = require('timers/promises');
const vm = require('vm');
const { loadConfig, parseFrontmatter, readTasks, resolveLinks, collectFilters, isAllowedPath, setField, setCheck, formatField, slugify, fieldTemplate, sync, DEFAULTS } = require('./kanban.cjs');

// frontmatter : scalaire, ~, liste inline, liste en bloc
const { data, body } = parseFrontmatter(
  '---\ntitle: Test\ndue: ~\nscope: [PWA, API]\ntype:\n  - bug-fix\n---\n## Tasks\n- [ ] a\n'
);
assert.strictEqual(data.title, 'Test');
assert.strictEqual(data.due, null);
assert.deepStrictEqual(data.scope, ['PWA', 'API']);
assert.deepStrictEqual(data.type, ['bug-fix']);
assert.ok(body.startsWith('## Tasks'));

// sans frontmatter : tout le contenu part dans body
assert.deepStrictEqual(parseFrontmatter('juste du texte').data, {});

// commentaires YAML ignorés, y compris entre deux items d'une liste en bloc
assert.deepStrictEqual(parseFrontmatter('---\ntitle: T\n# energy: 3\ntype:\n  - a\n  # - skip\n  - b\n---\n').data, { title: 'T', type: ['a', 'b'] });

// setField : remplace la clé, l'ajoute en fin de frontmatter, ou crée la frontmatter
assert.strictEqual(setField('---\ntitle: A\nstatus: done\n---\n\nbody\n', 'status', 'blocked'), '---\ntitle: A\nstatus: blocked\n---\n\nbody\n');
assert.strictEqual(setField('---\ntitle: A\n---\nbody', 'status', 'done'), '---\ntitle: A\nstatus: done\n---\nbody');
assert.strictEqual(setField('body', 'status', 'done'), '---\nstatus: done\n---\nbody');
assert.strictEqual(parseFrontmatter(setField('---\ntitle: A\nscope:\n  - x\n---\n', 'status', 'done')).data.status, 'done');
// setField: null removes the key, a block list goes with its items, a commented template line is uncommented
assert.strictEqual(setField('---\ntitle: A\nassign: Ana\n---\nbody', 'assign', null), '---\ntitle: A\n---\nbody');
assert.strictEqual(setField('---\ntitle: A\nscope:\n  - x\n  - y\ndue: 2026-01-01\n---\n', 'scope', '[z]'), '---\ntitle: A\nscope: [z]\ndue: 2026-01-01\n---\n');
assert.strictEqual(setField('---\ntitle: A\n# priority: high | low\n# assign: Ana\n---\n', 'priority', 'low'), '---\ntitle: A\npriority: low\n# assign: Ana\n---\n');
assert.strictEqual(setField('body', 'assign', null), 'body');

// setCheck: the n-th checkbox of the body, code blocks and the frontmatter skipped
const checks = '---\ntitle: A\n---\n- [ ] a\n```\n- [ ] in code\n```\n* [X] b\n- [ ]\n';
assert.strictEqual(setCheck(checks, 0, true), checks.replace('- [ ] a', '- [x] a'));
assert.strictEqual(setCheck(checks, 1, false), checks.replace('* [X] b', '* [ ] b'));
assert.strictEqual(setCheck(checks, 2, true), null);
assert.strictEqual(setCheck('- [ ] no frontmatter', 0, true), '- [x] no frontmatter');

// formatField: what the board may write, checked against the parser and the config
const fields = { priority: ['high', 'low'], mood: [] };
assert.strictEqual(formatField('status', 'done', fields), 'done');
assert.throws(() => formatField('status', '', fields), /Unknown status/);
assert.strictEqual(formatField('priority', 'low', fields), 'low');
assert.throws(() => formatField('priority', 'urgent', fields), /one of high, low/);
assert.strictEqual(formatField('mood', ' calm ', fields), 'calm');
assert.strictEqual(formatField('assign', '', fields), null);
assert.strictEqual(formatField('scope', ['api', ' ', 'pwa '], fields), '[api, pwa]');
assert.strictEqual(formatField('type', [], fields), null);
assert.throws(() => formatField('scope', ['a,b'], fields), /comma/);
assert.throws(() => formatField('assign', 'Ana\nstatus: done', fields), /One line/);
assert.throws(() => formatField('due', 'tomorrow', fields), /YYYY-MM-DD/);
assert.throws(() => formatField('assign', 'null', fields), /parser/);
assert.throws(() => formatField('title', 'X', fields), /Not editable/);
assert.throws(() => formatField('__proto__', 'X', fields), /Not editable/);

// config : défauts < kandepo.config.json < arguments CLI
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kandepo-'));
assert.deepStrictEqual(loadConfig([], dir).dirs, DEFAULTS.dirs);
fs.writeFileSync(path.join(dir, 'kandepo.config.json'), '{"title":"X","port":9000}');
assert.strictEqual(loadConfig([], dir).title, 'X');
assert.strictEqual(loadConfig([], dir).port, 9000);
assert.deepStrictEqual(loadConfig(['tasks'], dir).dirs, ['tasks']);
assert.strictEqual(loadConfig(['tasks', 'out.html'], dir).output, 'out.html');
assert.strictEqual(loadConfig(['--no-serve'], dir).serve, false);
assert.strictEqual(loadConfig([], dir).serve, true);
assert.strictEqual(loadConfig([], dir).watch, true);
assert.strictEqual(loadConfig(['--no-serve'], dir).watch, false);
assert.strictEqual(loadConfig(['--no-serve', '--watch'], dir).watch, true);

// columns: partial override on top of the default labels
assert.strictEqual(loadConfig([], dir).columns.done, 'Done');
fs.writeFileSync(path.join(dir, 'kandepo.config.json'), '{"columns":{"done":"Fait"}}');
assert.deepStrictEqual(loadConfig([], dir).columns, { ...DEFAULTS.columns, done: 'Fait' });

// fields: priority by default, replaced by the config, values as strings, built-in names refused
assert.deepStrictEqual(loadConfig([], path.join(dir, 'absent')).fields, { priority: ['high', 'medium', 'low'] });
fs.writeFileSync(path.join(dir, 'kandepo.config.json'), '{"fields":{"energy":[1,2,3],"mood":[]}}');
assert.deepStrictEqual(loadConfig([], dir).fields, { energy: ['1', '2', '3'], mood: [] });
assert.strictEqual(fieldTemplate(loadConfig([], dir).fields).split('\n').slice(0, 2).join('\n'), '# energy: 1 | 2 | 3\n# mood:');
fs.writeFileSync(path.join(dir, 'kandepo.config.json'), '{"fields":{"assign":[]}}');
assert.throws(() => loadConfig([], dir), /built-in field/);
fs.writeFileSync(path.join(dir, 'kandepo.config.json'), '{"fields":{"energy":"1-5"}}');
assert.throws(() => loadConfig([], dir), /must be a list/);
fs.unlinkSync(path.join(dir, 'kandepo.config.json'));

// reading tasks: default status and source folder
fs.mkdirSync(path.join(dir, 'tasks'));
fs.writeFileSync(path.join(dir, 'tasks', 'a.md'), '---\ntitle: A\n---\nbody\n');
const tasks = readTasks([path.join(dir, 'tasks'), path.join(dir, 'absent')]);
assert.strictEqual(tasks.length, 1);
assert.strictEqual(tasks[0].status, 'not_started');
assert.strictEqual(tasks[0]._dir, 'tasks');
assert.ok(tasks[0]._mtime > 0);

// wikilinks: resolved by file slug or by title, case-insensitive, unknown ones ignored
const linked = resolveLinks([
  { filename: 'a.md', title: 'Alpha', body: 'voir [[b]] et [[ALPHA]] et [[nope]]' },
  { filename: 'b.md', title: 'Bêta', body: '' },
]);
assert.deepStrictEqual(linked[0].links, { b: 1, ALPHA: 0 });
assert.deepStrictEqual(linked[1].links, {});

// filters: configured values in their order, free fields and scope collected, deduplicated case-insensitively
const filters = collectFilters([{ scope: ['API', 'pwa'], mood: 'calm' }, { scope: ['api', 'PWA'], mood: 'Busy' }], { priority: ['high', 'low'], mood: [] });
const values = key => filters.find(f => f.key === key).values;
assert.deepStrictEqual(values('priority'), ['high', 'low']);
assert.deepStrictEqual(values('mood'), ['Busy', 'calm']);
assert.deepStrictEqual(values('scope'), ['API', 'pwa']);

// file access: limited to the .md files of the task folders
const taskDir = path.join(dir, 'tasks');
assert.strictEqual(isAllowedPath(path.join(taskDir, 'a.md'), [taskDir]), true);
assert.strictEqual(isAllowedPath('/etc/passwd', [taskDir]), false);
assert.strictEqual(isAllowedPath(path.join(dir, 'a.md'), [taskDir]), false);
assert.strictEqual(isAllowedPath(path.join(taskDir, '../../secret.md'), [taskDir]), false);
assert.strictEqual(isAllowedPath(path.join(taskDir, 'script.sh'), [taskDir]), false);
assert.strictEqual(isAllowedPath(taskDir, [taskDir]), false);
assert.strictEqual(isAllowedPath(null, [taskDir]), false);

// --help prints the task template and exits
const help = execFileSync(process.execPath, [path.join(__dirname, 'kanban.cjs'), '--help'], { cwd: dir, encoding: 'utf8' });
assert.ok(help.includes('priority: high | medium | low') && help.includes('only title is required'));
assert.ok(!fs.existsSync(path.join(dir, 'kanban.html')));

// The sources come from the package, the tasks and the config from the current project.
const title = 'X <&> "test" {{styles}} $&';
const assign = 'A "<&>\'';
const markdown = '## Tasks\n- [ ] a\n- [x] b\n\n```js\nconst file = `C:\\tmp\\${name}`;\n```\n</script> {{script}} $&';
fs.writeFileSync(path.join(dir, 'kandepo.config.json'), JSON.stringify({ title, port: 9000, fields: { size: ['S', 'M', 'L'] } }));
fs.writeFileSync(path.join(taskDir, 'a.md'), `---\ntitle: ${title}\nassign: ${assign}\nsize: M\n---\n${markdown}\n`);
execFileSync(process.execPath, [path.join(__dirname, 'kanban.cjs'), '--no-serve'], { cwd: dir });
const html = fs.readFileSync(path.join(dir, 'kanban.html'), 'utf-8');
assert.ok(html.includes('<title>X &lt;&amp;&gt; &quot;test&quot; {{styles}} $&amp;</title>'));
assert.ok(html.includes('<option value="A &quot;&lt;&amp;&gt;&#39;">A &quot;&lt;&amp;&gt;&#39;</option>'));
assert.ok(html.includes(fs.readFileSync(path.join(__dirname, 'src/board.css'), 'utf-8').trimEnd()));
assert.ok(html.includes(fs.readFileSync(path.join(__dirname, 'src/board.js'), 'utf-8').trimEnd()));
assert.ok(!/<script\b[^>]*\bsrc=|<link\b[^>]*\brel=["']stylesheet/i.test(html));
// The theme script in <head>, then the board's. Task data cannot close a script early.
assert.strictEqual((html.match(/<script>/g) || []).length, 2);
assert.strictEqual((html.match(/<\/script>/g) || []).length, 2);

const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
new vm.Script(script);
const documentStub = { querySelectorAll: () => [], getElementById: () => ({ options: [{ value: 'size' }] }) };
const client = vm.runInNewContext(script.slice(0, script.indexOf('\nconst dialog ='))
  + '\n({ TASKS, COLUMNS, FIELDS, SERVER_URL, mdToHtml, countTasks, renderCard, rank })', { document: documentStub });
assert.strictEqual(client.TASKS.length, 1);
assert.strictEqual(client.TASKS[0].title, title);
assert.strictEqual(client.TASKS[0].body, markdown);
assert.strictEqual(client.COLUMNS.map(c => c.label).join('|'), 'To do|In progress|Blocked|Done');
assert.strictEqual(JSON.stringify(client.FIELDS), '{"size":["S","M","L"]}');
assert.ok(html.includes('<select id="f-size" data-key="size"><option value="">All</option><option value="S">S</option>'));
assert.ok(html.includes('<select id="f-sort"><option value="_mtime">recent</option><option value="size">size</option><option value="">file</option></select>'));
assert.strictEqual(client.SERVER_URL, 'http://localhost:9000');
assert.strictEqual(client.countTasks(markdown).done, 1);
assert.ok(client.mdToHtml(markdown).includes('<pre><code>const file = `C:\\tmp\\${name}`;</code></pre>'));
assert.ok(client.mdToHtml(markdown).includes('<input type="checkbox" id="chk-1" data-check="1" checked><label for="chk-1">b</label>'));

// card: one folder so no folder tag, field named in its tooltip, checkboxes counted from two
const card = client.renderCard(client.TASKS[0], 0);
assert.ok(!card.includes('class="tag dir"'));
assert.ok(card.includes('<span class="tag field" title="size: M">M</span>'));
// a leading ID moves to the top line, screen readers still read it with the title
const withId = client.renderCard({ title: 'OPS-001 Write the image' }, 5);
assert.ok(withId.includes('<span class="card-id">OPS-001</span>'));
assert.ok(withId.includes('<span class="visually-hidden">OPS-001 </span>Write the image</div>'));
assert.ok(card.includes('1/2'));
assert.ok(!client.renderCard({ title: 't', body: '- [ ] a' }, 1).includes('0/1'));
// scope and type deduplicated, a past due date red only on an open task
const tags = client.renderCard({ title: 't', scope: ['ops'], type: ['OPS', 'bug'], due: '2000-01-01', status: 'in_progress' }, 2);
assert.strictEqual((tags.match(/class="tag label"/g) || []).length, 2);
assert.ok(tags.includes('class="due late"'));
assert.ok(!client.renderCard({ title: 't', due: '2000-01-01', status: 'done' }, 3).includes('late'));
assert.ok(!client.renderCard({ title: 't', due: '2999-01-01', status: 'in_progress' }, 4).includes('late'));

// sort: position in the field's list, a missing or unknown value last
assert.deepStrictEqual([{ size: 'L' }, {}, { size: 'S' }, { size: 'XL' }].sort((a, b) => client.rank(a, 'size') - client.rank(b, 'size')).map(t => t.size),
  ['S', 'L', undefined, 'XL']);

assert.strictEqual(slugify('Réécrire l’app : test'), 'reecrire-lapp-test');

// Connectors: resolved from the project, get the options without "use", run all or one by name.
async function checkSync() {
  const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kandepo-sync-'));
  fs.mkdirSync(path.join(syncDir, 'tasks'));
  fs.writeFileSync(path.join(syncDir, 'tasks', 'a.md'), '---\ntitle: A\n---\n');
  fs.writeFileSync(path.join(syncDir, 'fake.cjs'), `exports.sync = async ctx => {
    require('fs').appendFileSync(${JSON.stringify(path.join(syncDir, 'calls.json'))}, JSON.stringify({ options: ctx.options, dryRun: ctx.dryRun, tasks: ctx.tasks.length }) + '\\n');
  };`);
  const config = { dirs: [path.join(syncDir, 'tasks')], connectors: { one: { use: './fake.cjs', token: 'x' }, two: { use: './fake.cjs' } } };
  try {
    assert.strictEqual(await sync(['--sync', '--dry-run'], config, syncDir), true);
    assert.strictEqual(await sync(['--sync=two'], config, syncDir), false);
    const calls = fs.readFileSync(path.join(syncDir, 'calls.json'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepStrictEqual(calls, [
      { options: { token: 'x' }, dryRun: true, tasks: 1 },
      { options: {}, dryRun: true, tasks: 1 },
      { options: {}, dryRun: false, tasks: 1 },
    ]);
    await assert.rejects(sync(['--sync=nope'], config, syncDir), /No connector "nope"/);
    await assert.rejects(sync(['--sync'], { dirs: [] }, syncDir), /No connectors/);
  } finally {
    fs.rmSync(syncDir, { recursive: true, force: true });
  }
}

async function checkWatch() {
  const child = spawn(process.execPath, [path.join(__dirname, 'kanban.cjs'), '--no-serve', '--watch'], { cwd: dir });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  async function waitForBuild(marker = '✓') {
    for (let i = 0; i < 100 && !output.includes(marker); i++) await delay(30);
    assert.ok(output.includes(marker), `Expected output: ${marker}`);
    output = '';
  }
  try {
    await waitForBuild('Watching tasks');
    for (const change of [
      () => fs.writeFileSync(path.join(taskDir, 'a.md'), '---\ntitle: Modifiée\n---\n'),
      () => fs.writeFileSync(path.join(taskDir, 'b.md'), '---\ntitle: Ajoutée\n---\n'),
      () => fs.unlinkSync(path.join(taskDir, 'b.md')),
    ]) {
      change();
      await waitForBuild();
      const generated = fs.readFileSync(path.join(dir, 'kanban.html'), 'utf-8');
      assert.ok(generated.includes('"title":"Modifiée"'));
      assert.strictEqual(generated.includes('"title":"Ajoutée"'), fs.existsSync(path.join(taskDir, 'b.md')));
    }
  } finally {
    child.kill();
    await closed;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// The server: serves the board, creates a task, changes a status, refuses the rest.
async function checkServer() {
  const net = require('net');
  const port = await new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  const serverDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kandepo-serve-'))); // server cwd, without the macOS symlink
  const tasksDir = path.join(serverDir, 'tasks');
  fs.mkdirSync(tasksDir);
  fs.writeFileSync(path.join(tasksDir, 'a.md'), '---\ntitle: A\n---\n');
  fs.writeFileSync(path.join(serverDir, 'kandepo.config.json'), JSON.stringify({ title: 'Serve', port, editor: 'true' }));
  const child = spawn(process.execPath, [path.join(__dirname, 'kanban.cjs')], { cwd: serverDir });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const post = (route, body, headers = {}) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body),
  });
  try {
    for (let i = 0; i < 100 && !output.includes('board on'); i++) await delay(30);
    assert.ok(output.includes('board on'), 'server started');

    const page = await fetch(base + '/');
    assert.strictEqual(page.status, 200);
    assert.ok((await page.text()).includes('<title>Serve</title>'));

    const created = await post('/new', { title: 'Nouvelle  tâche : test', status: 'in_progress' });
    assert.strictEqual(created.status, 201);
    const file = path.join(tasksDir, 'nouvelle-tache-test.md');
    assert.strictEqual((await created.json()).path, file);
    assert.ok(fs.readFileSync(file, 'utf8').startsWith('---\ntitle: Nouvelle tâche : test\nstatus: in_progress\n# priority:'));
    assert.deepStrictEqual(parseFrontmatter(fs.readFileSync(file, 'utf8')).data, { title: 'Nouvelle tâche : test', status: 'in_progress' });
    assert.ok((await (await fetch(base + '/')).text()).includes('Nouvelle tâche : test'), 'board rebuilt before the response');
    assert.strictEqual((await post('/new', { title: 'Nouvelle tâche : test' })).status, 409);
    assert.strictEqual((await post('/new', { title: '  ' })).status, 400);
    assert.strictEqual((await post('/new', { title: 'X', status: 'nope' })).status, 400);
    assert.strictEqual((await post('/new', { title: 'Sans statut' })).status, 201);
    assert.ok(fs.readFileSync(path.join(tasksDir, 'sans-statut.md'), 'utf8').includes('\nstatus: not_started\n'));

    // An open board gets an event when a write changes the HTML.
    const events = await fetch(base + '/events');
    const reader = events.body.getReader();
    await reader.read(); // the ": connected" comment
    assert.strictEqual((await post('/field', { path: file, key: 'status', value: 'done' })).status, 200);
    assert.ok(new TextDecoder().decode((await reader.read()).value).includes('data: reload'));
    await reader.cancel();
    assert.ok(fs.readFileSync(file, 'utf8').includes('\nstatus: done\n'));
    assert.strictEqual((await post('/field', { path: file, key: 'priority', value: 'high' })).status, 200);
    assert.strictEqual((await post('/field', { path: file, key: 'scope', value: ['api', 'pwa'] })).status, 200);
    assert.deepStrictEqual(parseFrontmatter(fs.readFileSync(file, 'utf8')).data,
      { title: 'Nouvelle tâche : test', status: 'done', priority: 'high', scope: ['api', 'pwa'] });
    assert.strictEqual((await post('/field', { path: file, key: 'status', value: 'nope' })).status, 400);
    assert.strictEqual((await post('/field', { path: file, key: 'title', value: 'X' })).status, 400);
    assert.strictEqual((await post('/field', { path: path.join(serverDir, 'kandepo.config.json'), key: 'status', value: 'done' })).status, 403);
    assert.strictEqual((await fetch(base + '/?task=a')).status, 200);

    fs.appendFileSync(file, '\n- [ ] one\n- [ ] two\n'); // index 0 is the checkbox of the template
    assert.strictEqual((await post('/check', { path: file, index: 2, checked: true })).status, 200);
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('- [ ] one\n- [x] two\n'));
    assert.strictEqual((await post('/check', { path: file, index: 9, checked: true })).status, 400);
    assert.strictEqual((await post('/check', { path: '/etc/hosts', index: 0, checked: true })).status, 403);

    assert.strictEqual((await post('/open', { path: file })).status, 200);
    assert.strictEqual((await post('/open', { path: '/etc/passwd' })).status, 403);

    // Other origin, wrong type, GET on a write route: refused.
    assert.strictEqual((await post('/new', { title: 'X' }, { Origin: 'https://evil.example' })).status, 403);
    assert.strictEqual((await fetch(base + '/new', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.strictEqual((await fetch(base + '/open?path=' + encodeURIComponent(file))).status, 404);
  } finally {
    child.kill();
    await closed;
    fs.rmSync(serverDir, { recursive: true, force: true });
  }
}

Promise.all([checkSync(), checkWatch(), checkServer()])
  .then(() => console.log('ok'))
  .catch(err => { console.error(err); process.exitCode = 1; });

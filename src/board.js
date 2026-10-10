function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function countTasks(body) {
  if (!body) return { total: 0, done: 0 };
  const all = (body.match(/- \[[ x]\]/g) || []).length;
  const done = (body.match(/- \[x\]/g) || []).length;
  return { total: all, done };
}

// The folder tag is redundant when the folder filter is set, and when there is one folder.
const ONE_DIR = new Set(TASKS.map(t => t._dir)).size < 2;
let HIDE_DIR = ONE_DIR;

function tagsHtml(task) {
  const tag = (v, cls) => `<span class="tag${cls ? ' ' + cls : ''}">${esc(v)}</span>`;
  const list = v => [].concat(v ?? []).map(x => tag(x)).join('');
  const { total, done } = countTasks(task.body);
  return (task._dir && !HIDE_DIR ? tag(task._dir, 'dir') : '')
    + Object.keys(FIELDS).filter(name => task[name]).map(name => tag(`${name} ${task[name]}`, 'field')).join('')
    + (task.assign ? tag(task.assign, 'assign') : '')
    + list(task.scope) + list(task.type)
    + (task.due ? tag('due ' + task.due, 'due') : '')
    + (total > 1 ? `<span class="checks">${done}/${total}</span>` : '');
}

function renderCard(task, index) {
  return `
  <div class="card" data-i="${index}" role="button" tabindex="0" draggable="true" aria-labelledby="card-title-${index}">
    <div class="card-title" id="card-title-${index}">${esc(task.title || task.filename)}</div>
    <div class="card-meta">${tagsHtml(task)}</div>
  </div>`;
}

// One select per filter key, generated from the config: data-key is the task property it reads.
const FILTERS = [...document.querySelectorAll('select[data-key]')];
const CONTROLS = [...FILTERS, document.getElementById('f-sort')];
const SORT_DEFAULT = document.getElementById('f-sort').options[0].value;
let FILTERED = TASKS;

const matches = (value, wanted) => [].concat(value ?? []).some(v => String(v).toLowerCase() === wanted.toLowerCase());

// Sorts on the position of the value in the field's list, tasks without the field go last.
function rank(task, field) {
  const i = FIELDS[field].indexOf(String(task[field]));
  return i === -1 ? Infinity : i;
}

function render() {
  const sortBy = document.getElementById('f-sort').value;
  HIDE_DIR = ONE_DIR || Boolean(document.getElementById('f-_dir').value);

  const filtered = TASKS.filter(task => FILTERS.every(el => !el.value || matches(task[el.dataset.key], el.value)));
  if (sortBy) filtered.sort((a, b) => rank(a, sortBy) - rank(b, sortBy));

  COLUMNS.forEach(col => {
    const inCol = filtered.filter(t => t.status === col.id);
    const el = document.getElementById(`col-${col.id}`);
    el.innerHTML = inCol.map(task => renderCard(task, TASKS.indexOf(task))).join('');
    document.getElementById(`count-${col.id}`).textContent = inCol.length;
    el.closest('.column').classList.toggle('empty', inCol.length === 0);
  });
  applyCols();

  const visible = filtered.filter(t => COLUMNS.some(c => c.id === t.status)).length;
  document.getElementById('count').textContent = `${visible} task${visible !== 1 ? 's' : ''}`;

  const active = FILTERS.some(el => el.value);
  document.getElementById('f-reset').hidden = !active;
  document.getElementById('empty').hidden = !(active && visible === 0);

  FILTERED = filtered;
  if (document.getElementById('f-view').getAttribute('aria-pressed') === 'true') renderGraph();
  saveState();
  syncUrl();
}

// Filters also live in the URL, so a bookmark or a link holds them. The URL wins over localStorage on load.
const param = el => el.id.slice(2).replace(/^_/, ''); // f-_dir → dir
function syncUrl() {
  const url = new URL(location.href);
  CONTROLS.forEach(el => {
    const keep = el.id === 'f-sort' ? el.value !== SORT_DEFAULT : el.value;
    if (keep) url.searchParams.set(param(el), el.value); else url.searchParams.delete(param(el));
  });
  history.replaceState(null, '', url);
}
function setIfValid(el, v) {
  if (v != null && !el.disabled && [...el.options].some(o => o.value === v)) el.value = v;
}
function loadUrl() {
  const q = new URLSearchParams(location.search);
  CONTROLS.forEach(el => setIfValid(el, q.get(param(el))));
}

// Filters survive a reload and a rebuild of the board, per project.
const stateKey = () => 'kandepo:' + document.title + ':state';
function saveState() {
  try { localStorage.setItem(stateKey(), JSON.stringify(Object.fromEntries(CONTROLS.map(el => [el.id, el.value])))); } catch {}
}
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(stateKey()) || '{}');
    CONTROLS.forEach(el => setIfValid(el, saved[el.id]));
  } catch {}
}

// Columns collapse by hand, remembered per project. An empty column collapses unless expanded by hand.
const colsKey = () => 'kandepo:' + document.title + ':cols';
function applyCols() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(colsKey()) || '{}'); } catch {}
  document.querySelectorAll('.column').forEach(col => {
    const state = saved[col.dataset.col];
    col.classList.toggle('collapsed', state === 'collapsed');
    col.classList.toggle('expanded', state === 'expanded');
    const rail = getComputedStyle(col.querySelector('.cards')).display === 'none';
    col.querySelector('.col-toggle').setAttribute('aria-expanded', String(!rail));
  });
}
// A filter no task fills is disabled instead of left silent.
function disableEmptyFilters() {
  FILTERS.forEach(el => {
    if (TASKS.some(t => [].concat(t[el.dataset.key] ?? []).length)) return;
    el.disabled = true;
    el.title = 'No task fills this field';
  });
  if (ONE_DIR) document.getElementById('f-_dir').closest('.filter').hidden = true;
}

function resetFilters() {
  FILTERS.forEach(el => { el.value = ''; });
  render();
}

// Minimal markdown: headings, lists, checkboxes, inline code, bold.
function mdToHtml(src, links = {}) {
  // The map keys are raw and the text is already escaped, so the keys get escaped too.
  const L = Object.fromEntries(Object.entries(links).map(([k, v]) => [esc(k), v]));
  const inline = t => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[\[([^\]]+)\]\]/g, (m, n) => L[n] !== undefined ? `<a class="wikilink" data-i="${L[n]}" tabindex="0">${n}</a>` : m);
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const openList = () => { if (!inList) { out.push('<ul>'); inList = true; } };

  let fence = null;
  for (const line of src.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (fence) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null; }
      else { closeList(); fence = []; }
      continue;
    }
    if (fence) { fence.push(line); continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    const check = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)/);
    const item = line.match(/^\s*[-*]\s+(.*)/);
    if (heading) { closeList(); out.push(`<h3>${inline(heading[2])}</h3>`); }
    else if (check) { openList(); out.push(`<li class="check">${check[1] === ' ' ? '☐' : '☑'} ${inline(check[2])}</li>`); }
    else if (item) { openList(); out.push(`<li>${inline(item[1])}</li>`); }
    else if (line.trim() === '') closeList();
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  if (fence) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
  return out.join('\n');
}

const dialog = document.getElementById('task-dialog');
let currentPath = null;
let trail = []; // tasks opened through a wikilink, for Back

// The server runs only during `npx kandepo`, and the board says so when it is missing.
// Served by it, the board talks to its own origin. Opened over file://, it cannot write.
const API = location.protocol.startsWith('http') ? location.origin : SERVER_URL;
function api(route, body) {
  return fetch(API + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch(() => { throw new Error(location.protocol === 'file:'
      ? `This file is open over file://, open ${SERVER_URL} instead (run \`npx kandepo\`).`
      : `No kandepo server on ${API}, run \`npx kandepo\` and reload.`); })
    .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`); });
}

function setStatus(i, status) {
  if (!TASKS[i] || TASKS[i].status === status) return;
  api('/status', { path: TASKS[i]._path, status })
    .then(() => location.reload())
    .catch(e => { document.getElementById('notice').textContent = e.message; });
}

function openTask(i, { push = false } = {}) {
  const task = TASKS[i];
  if (!task) return;
  if (!push) trail = [];
  currentPath = task._path || null;
  document.getElementById('dlg-back').hidden = !trail.length;

  document.getElementById('dlg-title').textContent = task.title || task.filename;
  const status = `<select class="tag status" id="dlg-status" aria-label="Status">${COLUMNS.map(c =>
    `<option value="${c.id}"${c.id === task.status ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`;
  document.getElementById('dlg-meta').innerHTML = status + tagsHtml(task);
  document.getElementById('dlg-status').addEventListener('change', e => setStatus(i, e.target.value));
  const back = TASKS.map((t, j) => Object.values(t.links).includes(i) ? j : -1).filter(j => j >= 0)
    .map(j => `<a class="wikilink" data-i="${j}" tabindex="0">${esc(TASKS[j].title || TASKS[j].filename)}</a>`).join('');
  document.getElementById('dlg-body').innerHTML = (task.body
    ? mdToHtml(task.body, task.links)
    : '<p class="empty">No description.</p>')
    + (back ? `<div class="links">← ${back}</div>` : '');
  document.getElementById('dlg-path').textContent = task.filename;
  document.getElementById('dlg-error').textContent = '';

  // http(s) only, so a frontmatter value cannot inject a javascript: link.
  const link = (url, label) => /^https?:\/\//.test(url || '')
    ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${label} ↗</a>` : '';
  document.getElementById('dlg-links').innerHTML = link(task.issue_url, 'Issue');

  if (!dialog.open) dialog.showModal();
  document.getElementById('dlg-open').focus();
}

function followLink(a) {
  trail.push(TASKS.findIndex(t => t._path === currentPath));
  openTask(Number(a.dataset.i), { push: true });
}

// Cards by click and keyboard: Enter/Space opens, arrows move the focus
// (up/down in the column, left/right to the next column, same row).
const board = document.getElementById('board');
board.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (card) openTask(Number(card.dataset.i));
});
board.addEventListener('click', e => {
  const btn = e.target.closest('.col-toggle');
  if (!btn) return;
  const col = btn.closest('.column');
  const open = btn.getAttribute('aria-expanded') === 'true';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(colsKey()) || '{}'); } catch {}
  saved[col.dataset.col] = open ? 'collapsed' : 'expanded';
  try { localStorage.setItem(colsKey(), JSON.stringify(saved)); } catch {}
  applyCols();
});
dialog.addEventListener('click', e => {
  const a = e.target.closest('.wikilink');
  if (a) followLink(a);
});
dialog.addEventListener('keydown', e => {
  const a = e.target.closest('.wikilink');
  if (a && e.key === 'Enter') { e.preventDefault(); followLink(a); }
});
document.getElementById('dlg-back').addEventListener('click', () => {
  const prev = trail.pop();
  openTask(prev, { push: true });
});
board.addEventListener('keydown', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(Number(card.dataset.i)); return; }
  const cols = [...board.querySelectorAll('.cards')];
  const col = card.parentElement;
  const cards = [...col.querySelectorAll('.card')];
  const i = cards.indexOf(card), c = cols.indexOf(col);
  let next = null;
  if (e.key === 'ArrowDown') next = cards[i + 1];
  else if (e.key === 'ArrowUp') next = cards[i - 1];
  else if (e.key === 'Home') next = cards[0];
  else if (e.key === 'End') next = cards[cards.length - 1];
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    // First non-empty column in that direction.
    const step = e.key === 'ArrowRight' ? 1 : -1;
    for (let k = c + step; k >= 0 && k < cols.length && !next; k += step) {
      const other = cols[k].querySelectorAll('.card');
      next = other[Math.min(i, other.length - 1)];
    }
  } else return;
  e.preventDefault();
  if (next) next.focus();
});

document.getElementById('dlg-open').addEventListener('click', () => {
  if (!currentPath) return;
  api('/open', { path: currentPath })
    .then(() => dialog.close())
    .catch(e => { document.getElementById('dlg-error').textContent = e.message; });
});

// Capture: "+" in a column opens a field, Enter creates the file with the column's status
// and opens it in the editor for the rest. Escape closes the field.
board.addEventListener('click', e => {
  const btn = e.target.closest('.col-add');
  if (!btn) return;
  const form = btn.closest('.column').querySelector('.col-new');
  form.hidden = !form.hidden;
  if (!form.hidden) form.querySelector('input').focus();
});
board.addEventListener('submit', e => {
  const form = e.target.closest('.col-new');
  if (!form) return;
  e.preventDefault();
  const err = form.querySelector('.error');
  err.textContent = '';
  api('/new', { title: form.querySelector('input').value, status: form.closest('.column').dataset.col })
    .then(() => location.reload())
    .catch(ex => { err.textContent = ex.message; });
});
board.addEventListener('keydown', e => {
  const form = e.target.closest('.col-new');
  if (form && e.key === 'Escape') { form.hidden = true; form.closest('.column').querySelector('.col-add').focus(); }
});

// Dropping a card on a column changes its status in the file.
board.addEventListener('dragstart', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.dataTransfer.setData('text/plain', card.dataset.i);
  e.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
board.addEventListener('dragover', e => {
  const col = e.target.closest('.column');
  if (!col) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  board.querySelectorAll('.column.drop').forEach(c => { if (c !== col) c.classList.remove('drop'); });
  col.classList.add('drop');
});
board.addEventListener('dragend', () => {
  board.querySelectorAll('.drop, .dragging').forEach(el => el.classList.remove('drop', 'dragging'));
});
board.addEventListener('drop', e => {
  const col = e.target.closest('.column');
  if (!col) return;
  e.preventDefault();
  setStatus(Number(e.dataTransfer.getData('text/plain')), col.dataset.col);
});

document.getElementById('dlg-close').addEventListener('click', () => dialog.close());

// Click on the backdrop: the target is the <dialog> itself, not its content.
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

// Graph: naive force layout, a few hundred iterations, then static SVG.
// ponytail: O(n²) per iteration, move to d3-force if a board passes ~300 tasks.
function renderGraph() {
  const svg = document.getElementById('graph');
  const W = svg.clientWidth, H = svg.clientHeight;
  const LABEL = 200; // room for the label right of the node
  const all = FILTERED.map(t => TASKS.indexOf(t));
  const linked = new Set();
  all.forEach(i => Object.values(TASKS[i].links).forEach(t => { if (all.includes(t)) { linked.add(i); linked.add(t); } }));
  const ids = all.filter(i => linked.has(i));
  const alone = all.length - ids.length;
  const note = alone ? `<text class="empty" x="24" y="40">${alone} task${alone > 1 ? 's' : ''} without a [[...]] link, not shown.</text>` : '';
  if (!ids.length) { svg.innerHTML = note || `<text class="empty" x="24" y="40">No task matches these filters.</text>`; return; }
  const nodes = ids.map((i, k) => ({ i, x: W / 2 + Math.cos(k) * 100, y: H / 2 + Math.sin(k) * 100, vx: 0, vy: 0 }));
  const pos = new Map(nodes.map((n, k) => [n.i, k]));
  const edges = [];
  nodes.forEach((n, a) => Object.values(TASKS[n.i].links).forEach(t => { if (pos.has(t)) edges.push([a, pos.get(t)]); }));
  for (let it = 0; it < 300; it++) {
    for (const a of nodes) for (const b of nodes) {
      if (a === b) continue;
      const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01, f = 30000 / d2;
      a.vx += dx * f / Math.sqrt(d2); a.vy += dy * f / Math.sqrt(d2);
    }
    for (const [a, b] of edges) {
      const dx = nodes[b].x - nodes[a].x, dy = nodes[b].y - nodes[a].y;
      nodes[a].vx += dx * 0.02; nodes[a].vy += dy * 0.02; nodes[b].vx -= dx * 0.02; nodes[b].vy -= dy * 0.02;
    }
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.002; n.vy += (H / 2 - n.y) * 0.002;
      n.x = Math.min(W - LABEL, Math.max(40, n.x + (n.vx *= 0.6))); n.y = Math.min(H - 20, Math.max(20, n.y + (n.vy *= 0.6)));
    }
  }
  svg.innerHTML = note + edges.map(([a, b]) =>
    `<line x1="${nodes[a].x}" y1="${nodes[a].y}" x2="${nodes[b].x}" y2="${nodes[b].y}"/>`).join('')
  + nodes.map(n => `<g data-i="${n.i}" tabindex="0" role="button" aria-label="${esc(TASKS[n.i].title || TASKS[n.i].filename)}"><circle cx="${n.x}" cy="${n.y}" r="${5 + Object.keys(TASKS[n.i].links).length * 2}" fill="var(--status-${TASKS[n.i].status})"><title>${esc(TASKS[n.i].title || TASKS[n.i].filename)}</title></circle>
      <text x="${n.x + 9}" y="${n.y + 4}">${esc(String(TASKS[n.i].title || TASKS[n.i].filename).slice(0, 28))}</text></g>`).join('');
}
document.getElementById('graph').addEventListener('click', e => {
  const g = e.target.closest('g[data-i]');
  if (g) openTask(Number(g.dataset.i));
});
document.getElementById('graph').addEventListener('keydown', e => {
  const g = e.target.closest('g[data-i]');
  if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTask(Number(g.dataset.i)); }
});
document.getElementById('f-view').addEventListener('click', e => {
  const on = e.target.getAttribute('aria-pressed') !== 'true';
  e.target.setAttribute('aria-pressed', on);
  document.getElementById('board').classList.toggle('hidden', on);
  document.getElementById('graph').classList.toggle('hidden', !on);
  if (on) renderGraph();
});

CONTROLS.forEach(el => el.addEventListener('change', render));
['f-reset', 'empty-reset'].forEach(id => document.getElementById(id).addEventListener('click', resetFilters));

disableEmptyFilters();
loadState();
loadUrl();
render();

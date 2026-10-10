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

const TODAY = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

// A title that starts with an ID like OPS-001 shows the ID on the card's top line.
const TITLE_ID = /^([A-Z][A-Z0-9]*-\d+)\s+(.+)/;

const tag = (v, cls, title) => `<span class="tag ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(v)}</span>`;

// Top line: what identifies and sizes the task on the left, due date and progress on the right.
function headHtml(task, id) {
  const { total, done } = countTasks(task.body);
  const late = task.due && task.status !== 'done' && String(task.due) < TODAY;
  const aside = (task.due ? `<span class="due${late ? ' late' : ''}">due ${esc(task.due)}</span>` : '')
    + (total > 1 ? `<span class="checks">${done}/${total}</span>` : '');
  return (id ? `<span class="card-id">${esc(id)}</span>` : '')
    + Object.keys(FIELDS).filter(name => task[name]).map(name => tag(task[name], 'field', `${name}: ${task[name]}`)).join('')
    + (task.assign ? tag(task.assign, 'assign') : '')
    + (aside ? `<span class="card-aside">${aside}</span>` : '');
}

function labelsHtml(task) {
  // scope and type share one list, a value in both shows once.
  const seen = new Set();
  const labels = [].concat(task.scope ?? [], task.type ?? []).filter(v => {
    const k = String(v).toLowerCase();
    return !seen.has(k) && seen.add(k);
  });
  return (task._dir && !HIDE_DIR ? tag(task._dir, 'dir') : '') + labels.map(v => tag(v, 'label')).join('');
}

function renderCard(task, index) {
  const full = String(task.title || task.filename);
  const [, id, title = full] = full.match(TITLE_ID) || [];
  return `
  <div class="card" data-i="${index}" role="button" tabindex="0" draggable="true" aria-labelledby="card-title-${index}">
    <div class="card-head">${headHtml(task, id)}</div>
    <div class="card-title" id="card-title-${index}">${id ? `<span class="visually-hidden">${esc(id)} </span>` : ''}${esc(title)}</div>
    <div class="card-meta">${labelsHtml(task)}</div>
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
  if (sortBy === '_mtime') filtered.sort((a, b) => b._mtime - a._mtime);
  else if (sortBy) filtered.sort((a, b) => rank(a, sortBy) - rank(b, sortBy));

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
  let box = 0; // checkbox index in the body, as the server's setCheck counts them
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
    else if (check) {
      openList();
      const id = `chk-${box}`;
      out.push(`<li class="check"><input type="checkbox" id="${id}" data-check="${box++}"${check[1] === ' ' ? '' : ' checked'}><label for="${id}">${inline(check[2])}</label></li>`);
    }
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

// Live reload: the server sends an event after each rebuild, including the ones that follow
// the board's own writes. The reload waits while you type in a field, then puts the focus back.
const SERVED = location.protocol.startsWith('http');
let reloadPending = false;
function reload() {
  reloadPending = true;
  if (document.activeElement?.matches('input:not([type=checkbox])')) return;
  try { sessionStorage.setItem('kandepo:focus', document.activeElement?.id || ''); } catch {}
  location.reload();
}
document.addEventListener('focusout', () => setTimeout(() => { if (reloadPending) reload(); }));
if (SERVED) new EventSource('/events').onmessage = reload;

function saveField(i, key, value, onError) {
  if (!TASKS[i]) return;
  api('/field', { path: TASKS[i]._path, key, value }).catch(e => onError(e.message));
}

function setStatus(i, status) {
  if (TASKS[i]?.status === status) return;
  saveField(i, 'status', status, message => { document.getElementById('notice').textContent = message; });
}

// The dialog's fields. A change writes one frontmatter key.
const LIST_FIELDS = ['scope', 'type'];
function fieldsHtml(task) {
  const attrs = key => `id="fld-${esc(key)}" data-field="${esc(key)}"${SERVED ? '' : ' disabled title="Read-only over file://"'}`;
  const row = (key, control) => `<label for="fld-${esc(key)}">${esc(key)}</label>${control}`;
  const option = (value, label, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
  const select = (key, values) => {
    const current = String(task[key] ?? '');
    const all = ['', ...values, ...(current && !values.includes(current) ? [current] : [])];
    return `<select ${attrs(key)}>${all.map(v => option(v, v, current)).join('')}</select>`;
  };
  // Free text, with the values other tasks use as suggestions.
  const text = key => {
    const known = [...new Set(TASKS.flatMap(t => [].concat(t[key] ?? []).map(String)))].sort();
    return `<input ${attrs(key)} type="text" value="${esc(task[key] ?? '')}" list="dl-${esc(key)}" autocomplete="off">`
      + `<datalist id="dl-${esc(key)}">${known.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
  };
  return row('status', `<select ${attrs('status')}>${COLUMNS.map(c => option(c.id, c.label, task.status)).join('')}</select>`)
    + Object.entries(FIELDS).map(([key, values]) => row(key, values.length ? select(key, values) : text(key))).join('')
    + row('assign', text('assign'))
    + row('due', `<input ${attrs('due')} type="date" value="${esc(task.due ?? '')}">`)
    + LIST_FIELDS.map(key => row(key, `<input ${attrs(key)} type="text" value="${esc([].concat(task[key] ?? []).join(', '))}" placeholder="a, b" autocomplete="off">`)).join('');
}

function openTask(i, { push = false } = {}) {
  const task = TASKS[i];
  if (!task) return;
  if (!push) trail = [];
  currentPath = task._path || null;
  document.getElementById('dlg-back').hidden = !trail.length;

  document.getElementById('dlg-title').textContent = task.title || task.filename;
  document.getElementById('dlg-fields').innerHTML = fieldsHtml(task);
  const back = TASKS.map((t, j) => Object.values(t.links).includes(i) ? j : -1).filter(j => j >= 0)
    .map(j => `<a class="wikilink" data-i="${j}" tabindex="0">${esc(TASKS[j].title || TASKS[j].filename)}</a>`).join('');
  document.getElementById('dlg-body').innerHTML = (task.body
    ? mdToHtml(task.body, task.links)
    : '<p class="empty">No description.</p>')
    + (back ? `<div class="links">← ${back}</div>` : '');
  if (!SERVED) document.querySelectorAll('#dlg-body [data-check]').forEach(el => { el.disabled = true; });
  const edited = task._mtime ? `, edited ${new Date(task._mtime).toLocaleString('en-CA', { dateStyle: 'short', timeStyle: 'short', hour12: false })}` : '';
  document.getElementById('dlg-path').textContent = `${task._dir}/${task.filename}${edited}`;
  document.getElementById('dlg-error').textContent = '';

  // http(s) only, so a frontmatter value cannot inject a javascript: link.
  const link = (url, label) => /^https?:\/\//.test(url || '')
    ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${label} ↗</a>` : '';
  document.getElementById('dlg-links').innerHTML = link(task.issue_url, 'Issue');

  // The open task lives in the URL, so a reload or a shared link reopens it.
  const url = new URL(location.href);
  url.searchParams.set('task', task.filename.replace(/\.md$/, ''));
  history.replaceState(null, '', url);

  if (!dialog.open) dialog.showModal();
  document.getElementById('dlg-open').focus();
}

dialog.addEventListener('close', () => {
  const url = new URL(location.href);
  url.searchParams.delete('task');
  history.replaceState(null, '', url);
});

dialog.addEventListener('change', e => {
  const error = document.getElementById('dlg-error');
  error.textContent = '';
  const box = e.target.closest('[data-check]');
  if (box) {
    api('/check', { path: currentPath, index: Number(box.dataset.check), checked: box.checked })
      .catch(err => { box.checked = !box.checked; error.textContent = err.message; });
    return;
  }
  const el = e.target.closest('[data-field]');
  if (!el) return;
  const key = el.dataset.field;
  saveField(TASKS.findIndex(t => t._path === currentPath), key, LIST_FIELDS.includes(key) ? el.value.split(',') : el.value,
    message => { error.textContent = message; });
});

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
  if (!a) return;
  e.preventDefault(); // a wikilink inside a checkbox label follows the link without ticking the box
  followLink(a);
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
    .then(() => form.querySelector('input').blur())
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

// Color mode for every board on this machine. The <head> script applies it before the first paint.
document.querySelectorAll('input[name="theme"]').forEach(radio => {
  radio.checked = radio.value === (document.documentElement.dataset.theme || '');
  radio.addEventListener('change', () => {
    document.documentElement.dataset.theme = radio.value;
    try { localStorage.setItem('kandepo:theme', radio.value); } catch {}
  });
});

CONTROLS.forEach(el => el.addEventListener('change', render));
['f-reset', 'empty-reset'].forEach(id => document.getElementById(id).addEventListener('click', resetFilters));

disableEmptyFilters();
loadState();
loadUrl();
render();

const openFromUrl = new URLSearchParams(location.search).get('task');
if (openFromUrl) openTask(TASKS.findIndex(t => t.filename === openFromUrl + '.md'));
try {
  document.getElementById(sessionStorage.getItem('kandepo:focus') || '')?.focus();
  sessionStorage.removeItem('kandepo:focus');
} catch {}

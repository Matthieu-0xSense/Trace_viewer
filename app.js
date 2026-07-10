/* Trace Viewer — read PCAN .trc, decode with PCAN .sym, plot signals.
   No build step. uPlot vendored locally so it runs from file://. */

'use strict';

// ---------- state ----------
const DB = {
  enums: new Map(),        // enumName -> Map(value -> label)
  messages: new Map(),     // idNum   -> [ {name,type,dlc,bus,signals:[sig]} ]
  catalog: [],             // flat list of selectable signals
};
let FRAMES = [];           // { t, id, dlc, bytes:Uint8Array }
let T0 = 0;                // first frame epoch seconds
const selected = new Set(); // catalog keys currently plotted
let plots = [];             // active uPlot instances (1 in single mode, N in split/custom)
let layout = 'single';      // 'single' | 'split' | 'custom'
let chartCount = 2;         // number of charts in custom layout
const chartOf = new Map();  // signal key -> chart index (custom layout)
let fullX = null;           // [min,max] of full time range for reset
let syncing = false;        // guard for cross-chart x-scale propagation

const PALETTE = ['#4da3ff','#ffb454','#5ad18a','#ff6b6b','#c792ea','#ffd866',
  '#78dce8','#ff9e64','#a9dc76','#fc9867','#ab9df2','#e06c9f','#66d9ef','#f08d49'];

// ---------- SYM parser ----------
function parseSym(text, bus) {
  const lines = text.split(/\r?\n/);
  let section = null;      // ENUMS / SEND / RECEIVE / SENDRECEIVE
  let msg = null;          // current message being built

  const stripComment = s => { const i = s.indexOf('//'); return (i >= 0 ? s.slice(0, i) : s).trim(); };

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const sec = line.match(/^\{(\w+)\}/);
    if (sec) { section = sec[1].toUpperCase(); continue; }

    if (section === 'ENUMS' || line.startsWith('enum ')) {
      const m = line.match(/^enum\s+(\w+)\s*\((.*)\)\s*$/);
      if (m) {
        const map = new Map();
        // entries: 0="Off", 1="On"
        const re = /(-?\d+)\s*=\s*"([^"]*)"/g; let e;
        while ((e = re.exec(m[2]))) map.set(Number(e[1]), e[2]);
        DB.enums.set(m[1], map);
      }
      continue;
    }

    // message header  [Name]
    const mh = line.match(/^\[([^\]]+)\]/);
    if (mh) {
      msg = { name: mh[1], type: 'Extended', dlc: 8, bus, signals: [] };
      continue;
    }
    if (!msg) continue;

    if (line.startsWith('ID=')) {
      const h = stripComment(line.slice(3)).replace(/h$/i, '');
      msg.idNum = parseInt(h, 16);
      registerMessage(msg);
      continue;
    }
    if (line.startsWith('Type=')) { msg.type = stripComment(line.slice(5)); continue; }
    if (line.startsWith('DLC='))  { msg.dlc = parseInt(stripComment(line.slice(4)), 10) || 8; continue; }

    if (line.startsWith('VAR=')) {
      const sig = parseVar(line.slice(4), msg);
      if (sig) msg.signals.push(sig);
      continue;
    }
  }
}

function registerMessage(msg) {
  if (msg.idNum == null || Number.isNaN(msg.idNum)) return;
  if (!DB.messages.has(msg.idNum)) DB.messages.set(msg.idNum, []);
  DB.messages.get(msg.idNum).push(msg);
}

function parseVar(s, msg) {
  // name  type  start,len  /f: /o: /u:"" /e:ENUM /min: /max:
  const m = s.match(/^(\S+)\s+(signed|unsigned|float|double|bit|char|string)\s+(\d+)\s*,\s*(\d+)\s*(.*)$/);
  if (!m) return null;
  const opts = m[5] || '';
  const factor = readOpt(opts, 'f');
  const offset = readOpt(opts, 'o');
  const unitM = opts.match(/\/u:"([^"]*)"/);
  const enumM = opts.match(/\/e:(\w+)/);
  const type = m[2];
  return {
    name: m[1],
    kind: type,
    sign: type === 'signed' ? '-' : '+',
    isFloat: type === 'float' || type === 'double',
    start: parseInt(m[3], 10),
    length: parseInt(m[4], 10),
    scale: factor == null ? 1 : factor,
    offset: offset == null ? 0 : offset,
    unit: unitM ? unitM[1] : '',
    enumName: enumM ? enumM[1] : null,
    msgName: msg.name,
    idNum: msg.idNum,
  };
}
function readOpt(opts, key) {
  const m = opts.match(new RegExp('\\/' + key + ':\\s*(-?[0-9.]+)'));
  return m ? parseFloat(m[1]) : null;
}

// ---------- decode (Intel / little-endian, PCAN sym default) ----------
function decodeSignal(bytes, sig) {
  if (sig.isFloat && (sig.start & 7) === 0) {
    const byteIdx = sig.start >> 3;
    if (byteIdx + (sig.length >> 3) <= bytes.length) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + byteIdx, sig.length >> 3);
      const raw = sig.length === 64 ? dv.getFloat64(0, true) : dv.getFloat32(0, true);
      return raw * sig.scale + sig.offset;
    }
  }
  let value = 0;
  for (let i = 0; i < sig.length; i++) {
    const bitPos = sig.start + i;
    const byteIdx = bitPos >> 3;
    if (byteIdx >= bytes.length) break;
    const bit = (bytes[byteIdx] >> (bitPos & 7)) & 1;
    if (bit) value += Math.pow(2, i);
  }
  if (sig.sign === '-' && value >= Math.pow(2, sig.length - 1)) {
    value -= Math.pow(2, sig.length);
  }
  return value * sig.scale + sig.offset;
}

// ---------- TRC parser ----------
// One long tab-delimited stream. Each record: ts \t chan \t flags \t id \t dlc \t data \t xtra \t ascii
// ts uses comma decimal (epoch seconds). data is space-separated hex, right-padded.
function parseTrc(text) {
  const frames = [];
  // anchor on the 8-hex "xtra" field that follows the data field
  const re = /(\d+),(\d+)\t\d+\t[0-9A-Fa-f]+\t([0-9A-Fa-f]+)\t(\d+)\t([0-9A-Fa-f ]*?)\t[0-9A-Fa-f]{8}\t/g;
  let m;
  while ((m = re.exec(text))) {
    const t = parseInt(m[1], 10) + parseInt(m[2], 10) / 1e6;
    const id = parseInt(m[3], 16);
    const dlc = parseInt(m[4], 10);
    const hex = m[5].trim().split(/\s+/).filter(Boolean);
    const n = Math.min(dlc, hex.length);
    const bytes = new Uint8Array(8);
    for (let i = 0; i < n; i++) bytes[i] = parseInt(hex[i], 16);
    frames.push({ t, id, dlc, bytes: bytes.subarray(0, 8) });
  }
  return frames;
}

// ---------- catalog build ----------
function buildCatalog() {
  DB.catalog = [];
  const idCounts = new Map();
  for (const f of FRAMES) idCounts.set(f.id, (idCounts.get(f.id) || 0) + 1);

  for (const [idNum, msgs] of DB.messages) {
    for (const msg of msgs) {
      const count = idCounts.get(idNum) || 0;
      for (const sig of msg.signals) {
        DB.catalog.push({
          key: msg.name + '.' + sig.name,
          label: sig.name,
          msgName: msg.name,
          idNum,
          idHex: '0x' + idNum.toString(16).toUpperCase(),
          count,
          unit: sig.unit,
          enumName: sig.enumName,
          sig,
        });
      }
    }
  }
  // sort: messages that actually appear in the trace first, then by name
  DB.catalog.sort((a, b) =>
    (b.count > 0) - (a.count > 0) || a.msgName.localeCompare(b.msgName) || a.label.localeCompare(b.label));
}

// ---------- rendering the signal picker ----------
const $ = sel => document.querySelector(sel);
const catalogEl = () => $('#catalog');

function renderCatalog(filter = '') {
  const f = filter.toLowerCase();
  const groups = new Map(); // msgName -> {info, sigs[]}
  for (const c of DB.catalog) {
    if (f && !(c.label.toLowerCase().includes(f) || c.msgName.toLowerCase().includes(f) || c.idHex.toLowerCase().includes(f)))
      continue;
    if (!groups.has(c.msgName)) groups.set(c.msgName, { idHex: c.idHex, count: c.count, bus: c.sig, sigs: [] });
    groups.get(c.msgName).sigs.push(c);
  }
  const host = catalogEl();
  host.innerHTML = '';
  if (!groups.size) { host.innerHTML = '<div class="empty" style="height:120px">No matches</div>'; return; }

  for (const [name, g] of groups) {
    const grp = document.createElement('div');
    grp.className = 'msg-group';
    const seen = g.count > 0;
    grp.innerHTML =
      `<div class="msg-head"><span class="caret">▸</span>
        <span class="name" style="${seen ? '' : 'color:var(--muted)'}">${esc(name)}</span>
        <span class="meta">${g.idHex} · ${seen ? g.count + ' frm' : 'absent'}</span></div>
       <div class="sigs hidden"></div>`;
    const body = grp.querySelector('.sigs');
    const head = grp.querySelector('.msg-head');
    const caret = grp.querySelector('.caret');
    head.onclick = () => { body.classList.toggle('hidden'); caret.textContent = body.classList.contains('hidden') ? '▸' : '▾'; };

    for (const c of g.sigs) {
      const row = document.createElement('label');
      row.className = 'sig-row';
      const checked = selected.has(c.key);
      const color = colorFor(c.key);
      row.innerHTML =
        `<input type="checkbox" ${checked ? 'checked' : ''}>
         <span class="swatch" style="background:${checked ? color : 'transparent'};border:1px solid ${color}"></span>
         <span class="sname">${esc(c.label)}</span>
         <span class="unit">${esc(c.unit || (c.enumName ? 'enum' : ''))}</span>`;
      const cb = row.querySelector('input');
      cb.onchange = () => { toggleSignal(c.key, cb.checked); renderCatalog(currentFilter()); };
      body.appendChild(row);
    }
    if (f) body.classList.remove('hidden'), (caret.textContent = '▾'); // expand while searching
    host.appendChild(grp);
  }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// stable color per selected signal
const colorMap = new Map();
function colorFor(key) {
  if (!colorMap.has(key)) colorMap.set(key, PALETTE[colorMap.size % PALETTE.length]);
  return colorMap.get(key);
}

function toggleSignal(key, on) {
  if (on) { selected.add(key); colorFor(key); } else selected.delete(key);
  redraw();
}

// ---------- decode selected -> series & plot ----------
function destroyPlots() { for (const p of plots) p.destroy(); plots = []; }

function redraw() {
  const host = $('#chart-host');
  destroyPlots();
  host.innerHTML = '';
  if (!selected.size) {
    fullX = null;
    host.innerHTML = `<div class="empty"><div class="big">Select signals to plot</div>
      <div>Pick from the catalog on the left. Messages present in the trace are listed first.</div></div>`;
    $('#legend').innerHTML = '';
    return;
  }
  const cats = DB.catalog.filter(c => selected.has(c.key));
  const idsNeeded = new Set(cats.map(c => c.idNum));

  // union timeline of frames belonging to needed messages
  const times = [];
  const tset = new Set();
  for (const fr of FRAMES) {
    if (!idsNeeded.has(fr.id)) continue;
    if (!tset.has(fr.t)) { tset.add(fr.t); times.push(fr.t); }
  }
  times.sort((a, b) => a - b);
  const tIndex = new Map();
  for (let i = 0; i < times.length; i++) tIndex.set(times[i], i);
  const xs = times.map(t => t - T0);
  fullX = xs.length ? [xs[0], xs[xs.length - 1]] : null;

  // one value array per selected signal, keyed for reuse across groups
  const series = cats.map(() => new Array(times.length).fill(null));
  for (const fr of FRAMES) {
    if (!idsNeeded.has(fr.id)) continue;
    const xi = tIndex.get(fr.t);
    for (let s = 0; s < cats.length; s++) {
      if (cats[s].idNum !== fr.id) continue;
      series[s][xi] = decodeSignal(fr.bytes, cats[s].sig);
    }
  }
  const seriesOf = new Map();
  cats.forEach((c, i) => seriesOf.set(c.key, series[i]));

  const groups = buildGroups(cats);   // [{cats:[...]}, ...]
  const n = groups.length;
  const single = layout === 'single';
  const h = single ? Math.max(320, host.clientHeight - 8)
                   : Math.max(150, Math.floor((host.clientHeight - 24) / n) - 8);
  for (let gi = 0; gi < n; gi++) {
    const box = document.createElement('div');
    box.className = 'chart-box' + (single ? ' solo' : '');
    host.appendChild(box);
    const g = groups[gi];
    if (g.cats.length) {
      makeChart(box, xs, g.cats.map(c => seriesOf.get(c.key)), g.cats, h);
    } else {
      box.innerHTML = `<div class="chart-empty">Chart ${gi + 1} — drag a signal here from the legend below</div>`;
    }
  }
  renderLegend(groups);
}

// split selected signals into per-chart groups per the active layout
function buildGroups(cats) {
  if (layout === 'single') return [{ cats }];
  if (layout === 'split') return cats.map(c => ({ cats: [c] }));
  // custom: chartCount buckets, assigned by chartOf (clamped, default 0)
  const groups = Array.from({ length: chartCount }, () => ({ cats: [] }));
  for (const c of cats) {
    let idx = chartOf.has(c.key) ? chartOf.get(c.key) : 0;
    idx = Math.max(0, Math.min(chartCount - 1, idx));
    groups[idx].cats.push(c);
  }
  return groups;
}

function fmtVal(v, c) {
  if (v == null) return '—';
  if (c.enumName && DB.enums.has(c.enumName)) {
    const lbl = DB.enums.get(c.enumName).get(Math.round(v));
    return (lbl != null ? lbl : Math.round(v)) + '';
  }
  const a = Math.abs(v);
  const s = (a !== 0 && (a < 0.01 || a >= 1e5)) ? v.toExponential(2)
          : Number.isInteger(v) ? String(v) : v.toFixed(3);
  return c.unit ? `${s} ${c.unit}` : s;
}

// wheel = zoom toward cursor, drag = pan the x window
function setupInteractions(u) {
  const over = u.over;
  over.style.cursor = 'grab';

  over.addEventListener('dblclick', e => { e.preventDefault(); resetZoom(); });

  over.addEventListener('wheel', e => {
    e.preventDefault();
    const { min, max } = u.scales.x;
    if (min == null) return;
    const rect = over.getBoundingClientRect();
    const at = min + ((e.clientX - rect.left) / rect.width) * (max - min);
    const f = e.deltaY < 0 ? 0.8 : 1.25;
    u.setScale('x', { min: at - (at - min) * f, max: at + (max - at) * f });
  }, { passive: false });

  over.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const { min, max } = u.scales.x;
    if (min == null) return;
    const startX = e.clientX, x0 = min, x1 = max;
    const unitPerPx = (max - min) / over.clientWidth;
    over.style.cursor = 'grabbing';
    e.preventDefault();
    const move = ev => {
      const shift = -(ev.clientX - startX) * unitPerPx;
      u.setScale('x', { min: x0 + shift, max: x1 + shift });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      over.style.cursor = 'grab';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

// keep every chart's x range in lock-step
function propagateX(src) {
  if (syncing) return;
  syncing = true;
  const { min, max } = src.scales.x;
  for (const p of plots) if (p !== src) p.setScale('x', { min, max });
  syncing = false;
}

function makeChart(container, xs, series, cats, height) {
  const wrap = document.createElement('div');
  wrap.className = 'chart-inner';
  container.appendChild(wrap);
  const tt = document.createElement('div');
  tt.className = 'u-tooltip';
  wrap.appendChild(tt);

  const uSeries = [{}];
  for (const c of cats) {
    uSeries.push({
      label: c.msgName + '.' + c.label,
      stroke: colorFor(c.key),
      width: 1.4,
      points: { show: false },
      spanGaps: true,
      value: (u, v) => fmtVal(v, c),
    });
  }

  const opts = {
    width: (container.clientWidth || $('#chart-host').clientWidth) - 8,
    height,
    legend: { show: false },
    cursor: { drag: { x: false, y: false }, sync: { key: 'trace' } },
    scales: { x: { time: false } },
    axes: [
      { stroke: '#8b93a3', grid: { stroke: '#232833' }, ticks: { stroke: '#232833' },
        values: (u, sp) => sp.map(v => v.toFixed(v < 10 ? 2 : 1) + 's') },
      { stroke: '#8b93a3', grid: { stroke: '#232833' }, ticks: { stroke: '#232833' },
        size: 60 },
    ],
    series: uSeries,
    hooks: {
      setCursor: [u => updateTooltip(u, tt, cats)],
      setScale: [(u, key) => { if (key === 'x') propagateX(u); }],
      ready: [u => setupInteractions(u)],
    },
  };
  const u = new uPlot(opts, [xs, ...series], wrap);
  plots.push(u);
  return u;
}

function resetZoom() {
  if (!fullX) return;
  syncing = true;
  for (const p of plots) p.setScale('x', { min: fullX[0], max: fullX[1] });
  syncing = false;
}

function updateTooltip(u, tt, cats) {
  const { idx, left, top } = u.cursor;
  if (idx == null || left < 0) { tt.style.display = 'none'; return; }
  const tx = u.data[0][idx];
  let html = `<div class="tt-t">t = ${tx.toFixed(3)} s</div>`;
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    const v = u.data[i + 1][idx];
    html += `<div class="tt-row"><span class="sw" style="background:${colorFor(c.key)}"></span>
      <span>${esc(c.label)}</span><span class="v">${esc(fmtVal(v, c))}</span></div>`;
  }
  tt.innerHTML = html;
  tt.style.display = 'block';
  const r = u.over.getBoundingClientRect();
  let x = left + 14;
  if (x + tt.offsetWidth > r.width) x = left - tt.offsetWidth - 14;
  tt.style.left = Math.max(0, x) + 'px';
  tt.style.top = Math.max(0, top + 14) + 'px';
}

function renderLegend(groups) {
  const host = $('#legend');
  host.innerHTML = '';
  if (layout === 'custom') {
    host.classList.add('by-chart');
    groups.forEach((g, gi) => host.appendChild(makeLegendCol(g, gi)));
  } else {
    host.classList.remove('by-chart');
    for (const g of groups) for (const c of g.cats) host.appendChild(makeChip(c, false));
  }
}

// one drop-target column per chart (custom layout)
function makeLegendCol(g, gi) {
  const col = document.createElement('div');
  col.className = 'lg-col';
  const head = document.createElement('div');
  head.className = 'lg-head';
  head.textContent = 'Chart ' + (gi + 1);
  col.appendChild(head);
  col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drop-hi'); });
  col.addEventListener('dragleave', () => col.classList.remove('drop-hi'));
  col.addEventListener('drop', e => {
    e.preventDefault();
    col.classList.remove('drop-hi');
    const key = e.dataTransfer.getData('text/plain');
    if (key && selected.has(key)) { chartOf.set(key, gi); redrawKeepZoom(); }
  });
  for (const c of g.cats) col.appendChild(makeChip(c, true));
  if (!g.cats.length) {
    const ph = document.createElement('div');
    ph.className = 'lg-empty';
    ph.textContent = 'drop signals here';
    col.appendChild(ph);
  }
  return col;
}

// a legend chip: color picker + name; drag to move (custom), right-click to remove
function makeChip(c, draggable) {
  const item = document.createElement('div');
  item.className = 'item';
  item.title = 'Right-click to remove' + (draggable ? ' · drag to another chart' : '');
  if (draggable) {
    item.draggable = true;
    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', c.key);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
  }
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'sw';
  picker.value = toHex(colorFor(c.key));
  picker.title = 'Change color';
  picker.oninput = () => { colorMap.set(c.key, picker.value); recolor(); };
  const name = document.createElement('span');
  name.className = 'nm';
  name.textContent = c.msgName + '.' + c.label;
  item.append(picker, name);
  item.addEventListener('contextmenu', e => {
    e.preventDefault();
    selected.delete(c.key);
    chartOf.delete(c.key);
    renderCatalog(currentFilter());
    redrawKeepZoom();
  });
  return item;
}

// re-render, keeping the current zoom window (used by recolor / reassign / remove)
function redrawKeepZoom() {
  const keep = plots.length ? { ...plots[0].scales.x } : null;
  redraw();
  if (keep && keep.min != null) {
    syncing = true;
    for (const p of plots) p.setScale('x', { min: keep.min, max: keep.max });
    syncing = false;
  }
}
function recolor() { redrawKeepZoom(); }

// normalize any css color to #rrggbb for <input type=color>
function toHex(col) {
  if (/^#[0-9a-f]{6}$/i.test(col)) return col;
  const cv = document.createElement('canvas').getContext('2d');
  cv.fillStyle = col;
  return cv.fillStyle;
}

// ---------- stats ----------
function updateStats() {
  const dur = FRAMES.length ? (FRAMES[FRAMES.length - 1].t - FRAMES[0].t) : 0;
  const ids = new Set(FRAMES.map(f => f.id));
  const known = [...ids].filter(id => DB.messages.has(id)).length;
  $('#stat-frames').textContent = FRAMES.length.toLocaleString();
  $('#stat-dur').textContent = dur.toFixed(1) + ' s';
  $('#stat-ids').textContent = `${known}/${ids.size}`;
  $('#stat-sigs').textContent = DB.catalog.filter(c => c.count > 0).length.toLocaleString();
}

// ---------- file loading ----------
function readFile(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsText(file, 'latin1'); // sym files use latin1 (°C etc.)
  });
}

async function loadSymFiles(files) {
  const names = [];
  for (const file of files) {
    const text = await readFile(file);
    parseSym(text, file.name);
    names.push(file.name);
  }
  $('#sym-list').textContent = [...new Set([...($('#sym-list').textContent ? $('#sym-list').textContent.split(', ') : []), ...names])].filter(Boolean).join(', ');
  afterLoad();
}

async function loadTrcFile(file) {
  banner('Parsing ' + file.name + ' …');
  const text = await readFile(file);
  FRAMES = parseTrc(text);
  T0 = FRAMES.length ? FRAMES[0].t : 0;
  $('#trc-list').textContent = `${file.name} — ${FRAMES.length.toLocaleString()} frames`;
  banner('');
  afterLoad();
}

function afterLoad() {
  if (DB.messages.size) buildCatalog();
  updateStats();
  renderCatalog(currentFilter());
  redraw();
}

function banner(msg) {
  const b = $('#banner');
  if (!msg) { b.style.display = 'none'; return; }
  b.textContent = msg; b.style.display = 'block';
}

const currentFilter = () => $('#search').value.trim();

// ---------- wire up ----------
function setupDrop(dropId, inputId, onFiles, accept) {
  const drop = $('#' + dropId), input = $('#' + inputId);
  drop.onclick = () => input.click();
  input.onchange = () => { if (input.files.length) onFiles([...input.files]); };
  ['dragover', 'dragenter'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', ev => {
    const files = [...ev.dataTransfer.files].filter(f => !accept || accept.some(a => f.name.toLowerCase().endsWith(a)));
    if (files.length) onFiles(files);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  setupDrop('drop-sym', 'in-sym', loadSymFiles, ['.sym']);
  setupDrop('drop-trc', 'in-trc', fs => loadTrcFile(fs[0]), ['.trc']);
  $('#search').oninput = () => renderCatalog(currentFilter());
  $('#btn-clear').onclick = () => { selected.clear(); renderCatalog(currentFilter()); redraw(); };
  $('#btn-expand').onclick = () => catalogEl().querySelectorAll('.sigs').forEach(s => {
    s.classList.remove('hidden'); s.parentElement.querySelector('.caret').textContent = '▾';
  });
  const setLayout = m => {
    layout = m;
    $('#lay-single').classList.toggle('active', m === 'single');
    $('#lay-split').classList.toggle('active', m === 'split');
    $('#lay-custom').classList.toggle('active', m === 'custom');
    $('#count-ctrl').classList.toggle('hidden', m !== 'custom');
    if (selected.size) redraw();
  };
  $('#lay-single').onclick = () => setLayout('single');
  $('#lay-split').onclick = () => setLayout('split');
  $('#lay-custom').onclick = () => setLayout('custom');
  const setCount = n => {
    chartCount = Math.max(1, Math.min(8, n));
    $('#count-n').textContent = chartCount;
    if (layout === 'custom' && selected.size) redrawKeepZoom();
  };
  $('#count-dec').onclick = () => setCount(chartCount - 1);
  $('#count-inc').onclick = () => setCount(chartCount + 1);
  $('#btn-reset').onclick = resetZoom;
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (plots.length && selected.size) redraw(); }, 150);
  });
  redraw();
});

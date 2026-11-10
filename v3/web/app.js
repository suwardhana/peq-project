'use strict';
/* Protocol Micro control deck. Curves use the same RBJ @96k math as
   v3/micro.py, so the graph shows exactly what the DSP applies. */

const BANDS = 8;
const FS = 96000, FMIN = 20, FMAX = 20000, DB = 12;
const BAND_COLORS = ['#60a5fa', '#4ade80', '#facc15', '#fb923c',
  '#f87171', '#22d3ee', '#f472b6', '#e5e7eb'];
const FACTORY_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000];

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const debounce = (fn, ms) => {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

const state = {
  connected: false, device: null, pregain: 0,
  bands: null,      // [{freq,q,gain,type}]
  selected: 0,
  reveal: 1,
  importNote: '',
};

/* ---------- API ---------- */
async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw { status: res.status, data };
  return data;
}
const apiGet = (p) => api('GET', p);
const apiPost = (p, b) => api('POST', p, b);

/* ---------- DSP math (mirrors v3/micro.py) ---------- */
function rbjPeak(freq, Q, gainDb) {
  const A = Math.sqrt(Math.pow(10, gainDb / 20));
  const w = 2 * Math.PI * freq / FS;
  const c = Math.cos(w), s = Math.sin(w) / (2 * Q);
  const d4 = s * A, d5 = s / A, d6 = 1 + d5;
  return [
    (1 + d4) / d6, (-2 * c) / d6, (1 - d4) / d6,
    (-2 * c) / d6, (1 - d5) / d6,
  ];
}

function magDb(cf, f) {
  const w = 2 * Math.PI * f / FS;
  const cw = Math.cos(w), sw = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const [b0, b1, b2, a1, a2] = cf;
  const nr = b0 + b1 * cw + b2 * c2, ni = -(b1 * sw + b2 * s2);
  const dr = 1 + a1 * cw + a2 * c2, di = -(a1 * sw + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/* ---------- Graph ---------- */
const canvas = $('graph');
const ctx = canvas.getContext('2d');
const PAD = { l: 46, r: 14, t: 14, b: 26 };
let plot = { x: 0, y: 0, w: 0, h: 0 };

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  plot = { x: PAD.l, y: PAD.t, w: r.width - PAD.l - PAD.r, h: r.height - PAD.t - PAD.b };
}
const fToX = (f) => plot.x + plot.w * Math.log(f / FMIN) / Math.log(FMAX / FMIN);
const xToF = (x) => FMIN * Math.pow(FMAX / FMIN, (x - plot.x) / plot.w);
const gToY = (g) => plot.y + plot.h * (DB - clamp(g, -DB, DB)) / (2 * DB);
const yToG = (y) => DB - (y - plot.y) / plot.h * 2 * DB;

function drawGraph() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.font = '10.5px "Segoe UI", system-ui, sans-serif';
  const ticks = [[20, '20'], [50, '50'], [100, '100'], [200, '200'], [500, '500'],
    [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k'], [20000, '20k']];
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const [f, label] of ticks) {
    const x = fToX(f);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
    ctx.fillStyle = '#8b93a3';
    ctx.fillText(label, x, plot.y + plot.h + 7);
  }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let db = -DB; db <= DB; db += 3) {
    const y = gToY(db);
    ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
    ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
    ctx.fillStyle = db === 0 ? '#c6ccd8' : '#8b93a3';
    ctx.fillText((db > 0 ? '+' : '') + db, plot.x - 7, y);
  }
  if (!state.bands) {
    ctx.fillStyle = '#8b93a3'; ctx.textAlign = 'center';
    ctx.fillText('Connect DAC to load PEQ', plot.x + plot.w / 2, plot.y + plot.h / 2);
    return;
  }
  const N = 140, xs = [];
  for (let i = 0; i < N; i++) xs.push(FMIN * Math.pow(FMAX / FMIN, i / (N - 1)));
  const per = state.bands.map((b) => {
    if (Math.abs(b.gain) < 1e-6 && b.type !== 'LPF' && b.type !== 'HPF') return null;
    return xs.map((f) => magDb(rbjPeak(b.freq, b.q, b.gain), f));
  });
  ctx.save();
  if (state.reveal < 1) {
    ctx.beginPath();
    ctx.rect(plot.x, plot.y - 4, plot.w * state.reveal, plot.h + 8);
    ctx.clip();
  }
  state.bands.forEach((b, i) => {
    if (!per[i]) return;
    ctx.strokeStyle = BAND_COLORS[i];
    ctx.globalAlpha = i === state.selected ? 0.95 : 0.55;
    ctx.lineWidth = i === state.selected ? 1.75 : 1.25;
    ctx.beginPath();
    per[i].forEach((g, k) => {
      const x = fToX(xs[k]), y = gToY(g);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#f4f6fa'; ctx.lineWidth = 2.25;
  ctx.lineJoin = 'round'; ctx.beginPath();
  xs.forEach((f, k) => {
    let g = 0;
    for (const curve of per) if (curve) g += curve[k];
    const x = fToX(f), y = gToY(g);
    k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
  state.bands.forEach((b, i) => {
    const x = fToX(b.freq), y = gToY(b.gain);
    const sel = i === state.selected;
    if (sel) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, sel ? 7 : 5.5, 0, 7);
    ctx.fillStyle = BAND_COLORS[i]; ctx.fill();
    ctx.strokeStyle = '#0c0e12'; ctx.lineWidth = 2; ctx.stroke();
  });
}

/* ---------- Status ---------- */
function setPill(mode, text) {
  const pill = $('status-pill');
  pill.className = 'pill ' + mode;
  pill.textContent = text;
}
function setPeqStatus(mode, text) {
  const el = $('peq-status');
  el.className = 'mini-status ' + mode;
  el.textContent = text;
}

/* ---------- Device ---------- */
async function loadState() {
  const s = await apiGet('/api/state');
  state.connected = true;
  state.device = s;
  $('offline-banner').hidden = true;
  $('app').classList.remove('offline');
  $('app').setAttribute('aria-busy', 'false');
  $('device-line').textContent =
    `${s.product} · FW ${s.firmware ?? '?'} · slot ${s.slot ?? '?'}`;
  setPill('ok', 'Connected');
  state.pregain = s.pregain ?? 0;
  $('pre').value = state.pregain;
  $('raw-line').textContent =
    `fw=${s.firmware ?? '?'} slot=${s.slot ?? '?'} pregain=${s.pregain ?? '?'} dB · ` +
    `bands=${(s.bands || []).length}/${BANDS}`;
  return s;
}

function goOffline(message) {
  state.connected = false;
  $('offline-banner').hidden = false;
  $('app').classList.add('offline');
  $('app').setAttribute('aria-busy', 'false');
  $('device-line').textContent = message || 'DAC not connected';
  setPill('bad', 'Disconnected');
}

async function boot() {
  $('app').setAttribute('aria-busy', 'true');
  try {
    await loadState();
    await loadPeq(true);
  } catch (e) {
    goOffline(e?.data?.error || 'DAC not connected');
    pollOffline();
  }
}

let pollTimer = 0;
function pollOffline() {
  clearTimeout(pollTimer);
  if (state.connected) return;
  pollTimer = setTimeout(async () => {
    try {
      await loadState();
      await loadPeq(true);
    } catch (e) {
      goOffline(e?.data?.error || 'DAC not connected');
      pollOffline();
    }
  }, 3000);
}

/* ---------- PEQ editor ---------- */
async function loadPeq(first = false) {
  const data = await apiGet('/api/peq');
  state.bands = data.bands.map((b) => ({
    freq: b.freq, q: b.q, gain: b.gain_db,
    type: b.type_name || 'PEAK',
  }));
  if (typeof data.pregain === 'number') state.pregain = data.pregain;
  $('pre').value = state.pregain;
  renderChips();
  syncEditor();
  drawGraph();
  if (first && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    state.reveal = 0;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 700);
      state.reveal = 1 - Math.pow(2, -10 * p);
      if (p < 1) { drawGraph(); requestAnimationFrame(step); }
      else { state.reveal = 1; drawGraph(); }
    };
    requestAnimationFrame(step);
  }
  setPeqStatus('', '');
}

/* The device has no bypass id: a flat PEAK/LSHELF/HSHELF *is* bypass. */
function displayType(b) {
  if (b.gain === 0 && ['PEAK', 'LSHELF', 'HSHELF', 'BYPASS'].includes(b.type)) {
    return 'BYPASS';
  }
  return b.type;
}

function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  state.bands.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(i === state.selected));
    btn.innerHTML = `<span class="dot" style="background:${BAND_COLORS[i]}"></span>${b.freq} · ${displayType(b)}`;
    btn.addEventListener('click', () => selectBand(i));
    box.appendChild(btn);
  });
}

function selectBand(i) {
  state.selected = clamp(i, 0, BANDS - 1);
  renderChips();
  syncEditor();
  drawGraph();
}

function syncEditor() {
  const b = state.bands[state.selected];
  $('f-freq').value = b.freq;
  $('f-gain').value = (+b.gain.toFixed(2));
  $('f-q').value = (+b.q.toFixed(2));
  $('f-type').value = displayType(b);
  canvas.setAttribute('aria-label',
    `Band ${state.selected + 1}: ${b.freq} Hz, ${b.gain.toFixed(1)} dB, Q ${b.q.toFixed(2)}, ${b.type}. Drag to edit.`);
}

function touchBand(patch) {
  const cur = state.bands[state.selected];
  const nextGain = patch.gain !== undefined ? patch.gain : cur.gain;
  if (cur.type === 'BYPASS' && Math.abs(nextGain) > 1e-9 && !patch.type) {
    patch = { ...patch, type: 'PEAK' };
  }
  Object.assign(state.bands[state.selected], patch);
  renderChips();
  syncEditor();
  drawGraph();
  setPeqStatus('', 'Editing…');
  scheduleApply();
}

const scheduleApply = debounce(applyPeq, 500);

async function applyPeq() {
  if (!state.bands) return;
  setPill('busy', 'Saving EQ…');
  try {
    const res = await apiPost('/api/peq', {
      pregain: Math.round(state.pregain),
      bands: state.bands.map((b) => ({
        freq: Math.round(b.freq), q: +b.q, gain: +b.gain, type: b.type,
      })),
    });
    const bad = res.bands.filter((r) => !r.verified).map((r) => r.band);
    if (bad.length) throw { data: { error: `bands ${bad} not verified` } };
    const t = new Date().toLocaleTimeString();
    const note = state.importNote ? ` · ${state.importNote}` : '';
    state.importNote = '';
    setPeqStatus('ok', `Saved ✓ ${t}${note}`);
    setPill('ok', 'Connected');
  } catch (e) {
    setPeqStatus('bad', 'Save failed — reloading device state');
    try {
      await loadPeq();
      setPill('ok', 'Connected');
    } catch (e2) {
      goOffline(e2?.data?.error || 'DAC not connected');
      pollOffline();
    }
  }
}

/* ---------- Graph pointer interaction ---------- */
let drag = null;
function dotAt(x, y) {
  let best = -1, bestD = 18;
  state.bands?.forEach((b, i) => {
    const d = Math.hypot(fToX(b.freq) - x, gToY(b.gain) - y);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}
function eventXY(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
canvas.addEventListener('pointerdown', (e) => {
  if (!state.bands) return;
  const [x, y] = eventXY(e);
  const i = dotAt(x, y);
  if (i < 0) return;
  state.selected = i;
  drag = { pointer: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
  renderChips();
  syncEditor();
  drawGraph();
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointer || !state.bands) return;
  const [x, y] = eventXY(e);
  const b = state.bands[state.selected];
  b.freq = clamp(Math.round(xToF(clamp(x, plot.x, plot.x + plot.w))), FMIN, FMAX);
  b.gain = clamp(+yToG(clamp(y, plot.y, plot.y + plot.h)).toFixed(2), -12, 12);
  renderChips();
  syncEditor();
  drawGraph();
  setPeqStatus('', 'Editing…');
});
function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.pointer)) return;
  drag = null;
  canvas.classList.remove('dragging');
  scheduleApply();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => { drag = null; canvas.classList.remove('dragging'); });
canvas.addEventListener('dblclick', (e) => {
  if (!state.bands) return;
  const [x, y] = eventXY(e);
  const i = dotAt(x, y);
  if (i < 0) return;
  state.selected = i;
  state.bands[i].gain = 0;
  renderChips(); syncEditor(); drawGraph();
  scheduleApply();
});
canvas.addEventListener('keydown', (e) => {
  if (!state.bands) return;
  const b = state.bands[state.selected];
  const step = e.shiftKey ? 1 : 0.1;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    touchBand({ gain: clamp(+(b.gain + (e.key === 'ArrowUp' ? step : -step)).toFixed(2), -12, 12) });
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    selectBand(state.selected + (e.key === 'ArrowRight' ? 1 : -1));
  }
});

/* ---------- Editor controls ---------- */
document.querySelectorAll('[data-step]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!state.bands) return;
    const [field, delta] = btn.dataset.step.split(',');
    const b = state.bands[state.selected];
    if (field === 'freq') touchBand({ freq: clamp(Math.round(b.freq + Number(delta)), FMIN, FMAX) });
    if (field === 'gain') touchBand({ gain: clamp(+(b.gain + Number(delta)).toFixed(2), -12, 12) });
    if (field === 'q') touchBand({ q: clamp(+(b.q + Number(delta)).toFixed(2), 0.1, 10) });
  });
});
for (const [id, field, parse, min, max] of [
  ['f-freq', 'freq', (v) => Math.round(Number(v)), FMIN, FMAX],
  ['f-gain', 'gain', (v) => +Number(v).toFixed(2), -12, 12],
  ['f-q', 'q', (v) => +Number(v).toFixed(2), 0.1, 10],
]) {
  $(id).addEventListener('change', (e) => {
    if (!state.bands) return;
    const v = parse(e.target.value);
    if (!Number.isFinite(v)) { syncEditor(); return; }
    touchBand({ [field]: clamp(v, min, max) });
  });
}
$('f-type').addEventListener('change', (e) => {
  if (!state.bands) return;
  if (e.target.value === 'BYPASS') touchBand({ type: 'BYPASS', gain: 0 });
  else touchBand({ type: e.target.value });
});
$('reset-band').addEventListener('click', () => {
  if (state.bands) touchBand({ gain: 0, type: 'BYPASS' });
});
$('reset-all').addEventListener('click', () => {
  if (!state.bands || !confirm('Reset all 8 bands to flat?')) return;
  state.bands = FACTORY_FREQS.map((freq) => ({ freq, q: 0.71, gain: 0, type: 'BYPASS' }));
  renderChips(); syncEditor(); drawGraph();
  scheduleApply();
});

/* ---------- Pregain ---------- */
async function postPregain(value) {
  setPill('busy', 'Saving pregain…');
  try {
    const r = await apiPost('/api/pregain', { value });
    state.pregain = r.readback ?? value;
    $('pre').value = state.pregain;
    setPill(r.verified ? 'ok' : 'bad', r.verified ? 'Connected' : 'Pregain not verified');
    $('raw-line').textContent =
      `fw=${state.device?.firmware ?? '?'} slot=${state.device?.slot ?? '?'} ` +
      `pregain=${state.pregain} dB`;
  } catch (e) {
    setPill('bad', 'Pregain failed');
  }
}
$('pre').addEventListener('change', (e) => {
  const v = clamp(Math.round(Number(e.target.value)), -12, 0);
  if (!Number.isFinite(v)) { e.target.value = state.pregain; return; }
  postPregain(v);
});
$('pre-down').addEventListener('click', () => {
  $('pre').value = clamp(Math.round(state.pregain) - 1, -12, 0);
  $('pre').dispatchEvent(new Event('change'));
});
$('pre-up').addEventListener('click', () => {
  $('pre').value = clamp(Math.round(state.pregain) + 1, -12, 0);
  $('pre').dispatchEvent(new Event('change'));
});

$('retry-btn').addEventListener('click', boot);

/* ---------- AutoEq import (parseAutoEq lives in autoeq.js) ---------- */
$('import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) $('import-text').value = await f.text();
  e.target.value = '';
});
$('import-btn').addEventListener('click', () => {
  if (!state.bands) return;
  const fold = $('import-preamp').checked;
  let res;
  try {
    res = parseAutoEq($('import-text').value, { foldPreamp: fold });
  } catch (e) {
    setPeqStatus('bad', `Import failed: ${e.message}`);
    return;
  }
  const n = res.bands.filter((b) => Math.abs(b.gain) > 1e-9).length;
  let note = `imported ${n} filter${n === 1 ? '' : 's'}`;
  if (res.sawPreamp) {
    if (fold) {
      note += ` · preamp ${res.preampDb} dB folded in`;
    } else {
      const whole = clamp(Math.round(res.preampDb), -12, 0);
      state.pregain = whole;
      $('pre').value = whole;
      note += ` · pregain ${whole} dB`;
    }
  }
  if (res.warnings.length) note += ` · ${res.warnings.length} clamped (${res.warnings[0]})`;
  state.bands = res.bands.slice(0, BANDS);
  state.selected = 0;
  state.importNote = note;
  renderChips();
  syncEditor();
  drawGraph();
  setPeqStatus('', `${note} — saving…`);
  scheduleApply();
});
$('peq-status').setAttribute('aria-live', 'polite');
new ResizeObserver(() => { fitCanvas(); drawGraph(); }).observe(canvas);

/* ---------- Boot ---------- */
fitCanvas();
drawGraph();
boot();

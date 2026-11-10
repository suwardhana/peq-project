'use strict';
/* RU3 v2 control deck. Curves use the same RBJ @96k math as v2/dac.py,
   so the graph shows exactly what the DSP applies. */

const FS = 96000, FMIN = 20, FMAX = 20000, DB = 12;
const BAND_COLORS = ['#60a5fa', '#4ade80', '#facc15', '#fb923c', '#f87171',
  '#22d3ee', '#2dd4bf', '#a3e635', '#f472b6', '#e5e7eb'];
const FACTORY_FREQS = [32, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const FILTERS = ['Minimum Phase', 'Linear phase trace rapid roll-off',
  'Linear phase rapid roll-off', 'Linear phase rapid roll-off - low ripple',
  'Linear phase slow roll-off', 'Minimum phase rapid roll-off',
  'Minimum phase slow roll-off'];

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const debounce = (fn, ms) => {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

const state = {
  connected: false, device: null,
  bands: null,      // [{freq,q,gain,type}]
  geq: null,
  editor: 'peq',
  selected: 0,
  reveal: 1,        // graph entrance progress
  importNote: '',   // appended to the next "Saved" status
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

/* ---------- DSP math (mirrors v2/dac.py) ---------- */
function rbj(type, freq, Q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w = 2 * Math.PI * freq / FS;
  const c = Math.cos(w), s = Math.sin(w);
  const alpha = s / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'PEAK' || type === 'BYPASS') {
    const g = type === 'BYPASS' ? 0 : gainDb;
    const a = Math.pow(10, g / 40), al = s / (2 * Q);
    b0 = 1 + al * a; b1 = -2 * c; b2 = 1 - al * a;
    a0 = 1 + al / a; a1 = -2 * c; a2 = 1 - al / a;
  } else if (type === 'LSHELF' || type === 'HSHELF') {
    const sq = 2 * Math.sqrt(A) * alpha;
    if (type === 'LSHELF') {
      b0 = A * ((A + 1) - (A - 1) * c + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * c);
      b2 = A * ((A + 1) - (A - 1) * c - sq);
      a0 = (A + 1) + (A - 1) * c + sq;
      a1 = -2 * ((A - 1) + (A + 1) * c);
      a2 = (A + 1) + (A - 1) * c - sq;
    } else {
      b0 = A * ((A + 1) + (A - 1) * c + sq);
      b1 = -2 * A * ((A - 1) + (A + 1) * c);
      b2 = A * ((A + 1) + (A - 1) * c - sq);
      a0 = (A + 1) - (A - 1) * c + sq;
      a1 = 2 * ((A - 1) - (A + 1) * c);
      a2 = (A + 1) - (A - 1) * c - sq;
    }
  } else {
    if (type === 'LPF') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
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
  // Grid: frequencies.
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
  // Grid: dB.
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
    if (b.type === 'BYPASS') return null;
    const cf = rbj(b.type, b.freq, b.q, b.gain);
    return xs.map((f) => magDb(cf, f));
  });
  // Entrance reveal: clip composite sweep on first load.
  ctx.save();
  if (state.reveal < 1) {
    ctx.beginPath();
    ctx.rect(plot.x, plot.y - 4, plot.w * state.reveal, plot.h + 8);
    ctx.clip();
  }
  // Per-band curves (audible ones + selected).
  state.bands.forEach((b, i) => {
    if (!per[i] || (Math.abs(b.gain) < 0.005 && i !== state.selected)) return;
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
  // Composite.
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
  // Dots.
  state.bands.forEach((b, i) => {
    const x = fToX(b.freq), y = gToY(b.gain);
    const sel = i === state.selected, byp = b.type === 'BYPASS';
    if (sel) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, sel ? 7 : 5.5, 0, 7);
    if (byp) {
      ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 2; ctx.stroke();
    } else {
      ctx.fillStyle = BAND_COLORS[i]; ctx.fill();
      ctx.strokeStyle = '#0c0e12'; ctx.lineWidth = 2; ctx.stroke();
    }
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

/* ---------- Device panel ---------- */
function paintSeg(id, value) {
  document.querySelectorAll(`#${id} button`).forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.v) === value));
  });
}

async function loadState() {
  const s = await apiGet('/api/state');
  state.connected = true;
  state.device = s;
  $('offline-banner').hidden = true;
  $('app').classList.remove('offline');
  $('app').setAttribute('aria-busy', 'false');
  $('device-line').textContent =
    `${s.product} · FW ${s.firmware ?? '?'} · ${s.uac_label ?? ''}`.trim();
  setPill('ok', 'Connected');
  $('vol').value = s.volume ?? 0;
  $('vol-num').textContent = s.volume ?? '–';
  paintSeg('seg-gain', s.gain);
  paintSeg('seg-output', s.output);
  paintSeg('seg-work', s.work_mode);
  paintSeg('seg-eq', s.eq);
  paintSeg('seg-uac', s.uac);
  const sel = $('sel-filter');
  if (!sel.options.length) {
    FILTERS.forEach((name, i) => sel.add(new Option(`${i} · ${name}`, i)));
  }
  sel.value = s.filter ?? 0;
  const extra = ![0, 8, 9].includes(s.eq) ? ` eq_raw=${s.eq}` : '';
  $('raw-line').textContent =
    `fw=${s.firmware ?? '?'} uac=${s.uac_label ?? '?'}${extra} · unk16=${s.unknown_16} 1f=${s.unknown_1f} 20=${s.unknown_20} 24=${s.unknown_24}`;
  refreshEqWarn();
  refreshGeqWarn();
  return s;
}

function refreshEqWarn() {
  const el = $('eq-warn');
  const eq = state.device?.eq;
  if (!state.connected || eq === 9) { el.hidden = true; return; }
  el.hidden = false;
  $('eq-warn-text').textContent = eq === 0
    ? 'EQ is OFF on the DAC — edits are saved but silent.'
    : `EQ is on preset ${eq}, not Parametric — edits are saved but silent.`;
}

function goOffline(message) {
  state.connected = false;
  clearTimeout(geqTimer);
  geqEpoch++;
  geqLoading = null;
  $('geq-sliders').inert = true;
  $('offline-banner').hidden = false;
  $('app').classList.add('offline');
  $('app').setAttribute('aria-busy', 'false');
  $('device-line').textContent = message || 'DAC not connected';
  setPill('bad', 'Disconnected');
  refreshEqWarn();
  refreshGeqWarn();
}

async function boot() {
  $('app').setAttribute('aria-busy', 'true');
  try {
    await loadState();
    await loadActiveEditor();
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
      await loadActiveEditor();
    } catch (e) {
      // loadState may have succeeded while loadPeq failed: still offline,
      // otherwise we get stuck on "Connected" with no bands and no retry.
      goOffline(e?.data?.error || 'DAC not connected');
      pollOffline();
    }
  }, 3000);
}

/* GEQ is the independent preset 8 bank. Viewing an editor never switches
   the hardware preset; Use Graphic / Use Parametric does that explicitly. */
function showEditor(mode) {
  state.editor = mode;
  for (const name of ['geq', 'peq']) {
    $(`${name}-panel`).hidden = name !== mode;
    $(`tab-${name}`).setAttribute('aria-selected', String(name === mode));
    $(`tab-${name}`).tabIndex = name === mode ? 0 : -1;
  }
  if (mode === 'peq') { fitCanvas(); drawGraph(); }
}

async function loadActiveEditor() {
  clearTimeout(geqTimer);
  geqEpoch++;
  geqLoading = null;
  state.geq = null;
  state.bands = null;
  $('geq-sliders').replaceChildren();
  $('geq-reset').disabled = true;
  showEditor(state.device?.eq === 8 ? 'geq' : 'peq');
  if (state.editor === 'geq') await loadGeq();
  else await loadPeq(true);
}

for (const mode of ['geq', 'peq']) {
  const button = $(`tab-${mode}`);
  button.addEventListener('click', async () => {
    showEditor(mode);
    if (!state.connected) return;
    try {
      if (mode === 'geq' && !state.geq) await loadGeq();
      if (mode === 'peq' && !state.bands) await loadPeq(true);
    } catch (e) {
      goOffline(e?.data?.error || 'Could not read EQ');
      pollOffline();
    }
  });
  button.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 'geq' : e.key === 'End' ? 'peq'
      : mode === 'geq' ? 'peq' : 'geq';
    $(`tab-${next}`).focus();
    $(`tab-${next}`).click();
  });
}

function refreshGeqWarn() {
  const eq = state.device?.eq;
  $('geq-warn').hidden = !state.connected || eq === 8;
  $('geq-warn-text').textContent = eq === 0
    ? 'EQ is OFF. Activate Graphic EQ to hear these settings.'
    : 'Graphic EQ is saved separately. Activate it to hear these settings.';
}

function geqStatus(mode, text) {
  $('geq-status').className = 'mini-status ' + mode;
  $('geq-status').textContent = text;
}

function renderGeq() {
  const box = $('geq-sliders');
  box.replaceChildren();
  const scale = document.createElement('div');
  scale.className = 'geq-scale';
  scale.setAttribute('aria-hidden', 'true');
  for (const text of ['+12', '0', '−12']) {
    const tick = document.createElement('span');
    tick.textContent = text;
    scale.append(tick);
  }
  box.append(scale);
  state.geq.bands.forEach((band, i) => {
    const freq = state.geq.frequencies[i];
    const row = document.createElement('div');
    row.className = 'geq-row';
    const label = document.createElement('label');
    label.htmlFor = `geq-${i}`;
    label.textContent = freq >= 1000 ? `${freq / 1000}k` : String(freq);
    const unit = document.createElement('small');
    unit.textContent = 'Hz';
    label.append(unit);
    const slider = document.createElement('input');
    slider.type = 'range'; slider.id = `geq-${i}`;
    slider.min = -12; slider.max = 12; slider.step = 0.1;
    slider.setAttribute('aria-orientation', 'vertical');
    slider.value = band.gain_db;
    const number = document.createElement('input');
    number.type = 'number'; number.min = -12; number.max = 12; number.step = 0.1;
    number.value = band.gain_db.toFixed(1);
    number.setAttribute('aria-label', `${freq} Hz gain in dB`);
    slider.setAttribute('aria-valuetext', `${band.gain_db.toFixed(1)} dB`);
    const edit = (value) => {
      if (!state.connected || geqLoading) return;
      const gain = clamp(Math.round(value * 10) / 10, -12, 12);
      band.gain_db = gain;
      slider.value = gain; number.value = gain.toFixed(1);
      slider.setAttribute('aria-valuetext', `${gain.toFixed(1)} dB`);
      geqRevision++;
      geqStatus('', 'Editing…');
      clearTimeout(geqTimer);
      geqTimer = setTimeout(saveGeq, 500);
    };
    slider.addEventListener('input', () => edit(Number(slider.value)));
    slider.addEventListener('dblclick', () => edit(0));
    number.addEventListener('change', () => {
      const gain = number.value.trim() === '' ? NaN : Number(number.value);
      if (Number.isFinite(gain)) edit(gain);
      else number.value = band.gain_db.toFixed(1);
    });
    row.append(slider, label, number);
    box.append(row);
  });
}

let geqTimer = 0, geqRevision = 0, geqSaving = false;
let geqLoading = null, geqEpoch = 0;
async function loadGeq() {
  if (geqLoading) return geqLoading;
  const epoch = geqEpoch;
  $('geq-reset').disabled = true;
  $('geq-reload').disabled = true;
  $('geq-sliders').inert = true;
  geqStatus('', 'Reading Graphic EQ…');
  geqLoading = (async () => {
    const data = await apiGet('/api/geq');
    if (epoch !== geqEpoch) return;
    if (data.bands?.length !== 10 || data.frequencies?.length !== 10
        || data.bands.some((b, i) => b.band !== i || !Number.isFinite(b.gain_db))) {
      throw { data: { error: 'Incomplete Graphic EQ read-back' } };
    }
    state.geq = data;
    renderGeq();
    geqStatus('', 'Loaded from DAC · all 10 bands');
    refreshGeqWarn();
  })();
  try { await geqLoading; }
  finally {
    if (epoch === geqEpoch) {
      geqLoading = null;
      $('geq-reset').disabled = !state.geq;
      $('geq-reload').disabled = geqSaving;
      $('geq-sliders').inert = !state.connected;
    }
  }
}

async function saveGeq() {
  if (!state.geq || !state.connected || geqSaving) return;
  geqSaving = true;
  $('geq-reload').disabled = true;
  const revision = geqRevision;
  const epoch = geqEpoch;
  const gains = state.geq.bands.map((b) => b.gain_db);
  geqStatus('', 'Saving Graphic EQ…');
  try {
    const result = await apiPost('/api/geq', { gains });
    if (result.bands?.length !== 10 || result.bands.some((b) => !b.verified)) {
      throw { data: { error: 'Graphic EQ read-back did not match' } };
    }
    if (epoch === geqEpoch && revision === geqRevision) geqStatus('ok', 'Saved & verified · 10/10 bands');
  } catch (e) {
    if (epoch === geqEpoch && revision === geqRevision) {
      try { await loadGeq(); }
      catch { goOffline('Could not read Graphic EQ'); pollOffline(); }
      geqStatus('bad', e?.data?.error || 'Save failed · device settings reloaded');
    }
  } finally {
    geqSaving = false;
    $('geq-reload').disabled = !!geqLoading;
    // Keep a newer slider edit when an earlier request finishes or fails.
    if (state.connected && revision !== geqRevision) { clearTimeout(geqTimer); geqTimer = setTimeout(saveGeq, 0); }
  }
}

$('geq-reset').addEventListener('click', () => {
  if (!state.geq || !confirm('Reset all 10 Graphic EQ bands to flat?')) return;
  state.geq.bands.forEach((b) => { b.gain_db = 0; });
  geqRevision++;
  renderGeq();
  clearTimeout(geqTimer);
  saveGeq();
});
$('geq-reload').addEventListener('click', async () => {
  clearTimeout(geqTimer);
  try { await loadGeq(); }
  catch (e) {
    geqStatus('bad', e?.data?.error || 'Could not read Graphic EQ');
    if (e?.status === 503 || !e?.status) { goOffline(); pollOffline(); }
  }
});
$('geq-on-btn').addEventListener('click', () => postSetting('eq', 8));

/* ---------- PEQ editor ---------- */
async function loadPeq(first = false) {
  const data = await apiGet('/api/peq');
  state.bands = data.bands.map((b) => ({
    freq: b.freq, q: b.q, gain: b.gain_db,
    type: b.type_name || 'BYPASS',
  }));
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

function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  state.bands.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(i === state.selected));
    btn.innerHTML = `<span class="dot" style="background:${BAND_COLORS[i]}"></span>${b.freq} · ${b.type}`;
    btn.addEventListener('click', () => selectBand(i));
    box.appendChild(btn);
  });
}

function selectBand(i) {
  state.selected = clamp(i, 0, 9);
  renderChips();
  syncEditor();
  drawGraph();
}

function syncEditor() {
  const b = state.bands[state.selected];
  $('f-freq').value = b.freq;
  $('f-gain').value = (+b.gain.toFixed(2));
  $('f-q').value = (+b.q.toFixed(2));
  $('f-type').value = b.type;
  canvas.setAttribute('aria-label',
    `Band ${state.selected + 1}: ${b.freq} Hz, ${b.gain.toFixed(1)} dB, Q ${b.q.toFixed(2)}, ${b.type}. Drag to edit.`);
}

function touchBand(patch) {
  Object.assign(state.bands[state.selected], patch);
  renderChips();
  syncEditor();
  drawGraph();
  setPeqStatus('', 'Editing…');
  scheduleApply();
}

const scheduleApply = debounce(applyPeq, 400);

async function applyPeq() {
  if (!state.bands) return;
  setPill('busy', 'Saving EQ…');
  try {
    const res = await apiPost('/api/peq', {
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

/* Graph pointer interaction. */
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
  b.gain = clamp(+yToG(clamp(y, plot.y, plot.y + plot.h)).toFixed(2), -DB, DB);
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
    touchBand({ gain: clamp(+(b.gain + (e.key === 'ArrowUp' ? step : -step)).toFixed(2), -DB, DB) });
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    selectBand(state.selected + (e.key === 'ArrowRight' ? 1 : -1));
  }
});

/* Editor controls. */
document.querySelectorAll('[data-step]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!state.bands) return;
    const [field, delta] = btn.dataset.step.split(',');
    const b = state.bands[state.selected];
    if (field === 'freq') touchBand({ freq: clamp(Math.round(b.freq + Number(delta)), FMIN, FMAX) });
    if (field === 'gain') touchBand({ gain: clamp(+(b.gain + Number(delta)).toFixed(2), -DB, DB) });
    if (field === 'q') touchBand({ q: clamp(+(b.q + Number(delta)).toFixed(2), 0.1, 10) });
  });
});
for (const [id, field, parse, min, max] of [
  ['f-freq', 'freq', (v) => Math.round(Number(v)), FMIN, FMAX],
  ['f-gain', 'gain', (v) => +Number(v).toFixed(2), -DB, DB],
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
  if (state.bands) touchBand({ type: e.target.value });
});
$('reset-band').addEventListener('click', () => {
  if (state.bands) touchBand({ gain: 0 });
});
$('reset-all').addEventListener('click', () => {
  if (!state.bands || !confirm('Reset all 10 bands to flat?')) return;
  state.bands = FACTORY_FREQS.map((freq) => ({ freq, q: 0.71, gain: 0, type: 'PEAK' }));
  renderChips(); syncEditor(); drawGraph();
  scheduleApply();
});

/* Device controls. */
const postVolume = debounce(async (v) => {
  try {
    const r = await apiPost('/api/volume', { value: v });
    $('vol-num').textContent = r.readback ?? v;
    if (!r.verified) setPill('bad', 'Volume not verified');
  } catch (e) { setPill('bad', 'Volume failed'); }
}, 150);
$('vol').addEventListener('input', (e) => {
  $('vol-num').textContent = e.target.value;
  postVolume(Number(e.target.value));
});
$('vol-down').addEventListener('click', () => {
  const el = $('vol');
  el.value = clamp(Number(el.value) - 1, 0, 100);
  el.dispatchEvent(new Event('input'));
});
$('vol-up').addEventListener('click', () => {
  const el = $('vol');
  el.value = clamp(Number(el.value) + 1, 0, 100);
  el.dispatchEvent(new Event('input'));
});

async function postSetting(key, value) {
  setPill('busy', 'Saving…');
  try {
    const r = await apiPost('/api/setting', { key, value });
    if (key === 'uac') return pollReconnect();
    if (r.verified === false) throw { data: { error: 'Setting read-back did not match' } };
    paintSeg({ gain: 'seg-gain', output: 'seg-output', work_mode: 'seg-work', eq: 'seg-eq', uac: 'seg-uac' }[key], r.readback);
    await loadState();
    if (key === 'eq' && [8, 9].includes(value)) {
      showEditor(value === 8 ? 'geq' : 'peq');
      if (value === 8 && !state.geq) await loadGeq();
      if (value === 9 && !state.bands) await loadPeq(true);
    }
  } catch (e) {
    setPill('bad', 'Save failed');
    try { await loadState(); } catch { goOffline(); pollOffline(); }
  }
}
for (const [id, key] of [['seg-gain', 'gain'], ['seg-output', 'output'],
                         ['seg-work', 'work_mode'], ['seg-eq', 'eq'], ['seg-uac', 'uac']]) {
  $(id).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const value = Number(btn.dataset.v);
    if (key === 'uac' && !confirm('Switching UAC mode reconnects USB audio for a moment. Continue?')) return;
    postSetting(key, value);
  });
}
$('sel-filter').addEventListener('change', (e) => postSetting('filter', Number(e.target.value)));

async function pollReconnect(tries = 12) {
  setPill('busy', 'Reconnecting USB…');
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await loadState();
      await loadActiveEditor();
      return;
    } catch { /* keep polling */ }
  }
  goOffline('DAC did not come back after UAC switch');
  pollOffline();
}

$('retry-btn').addEventListener('click', boot);
$('eq-on-btn').addEventListener('click', () => postSetting('eq', 9));

/* AutoEq import (parseAutoEq lives in autoeq.js). */
$('import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) $('import-text').value = await f.text();
  e.target.value = '';
});
$('import-btn').addEventListener('click', () => {
  if (!state.bands) return;
  let res;
  try {
    res = parseAutoEq($('import-text').value, { foldPreamp: $('import-preamp').checked });
  } catch (e) {
    setPeqStatus('bad', `Import failed: ${e.message}`);
    return;
  }
  const n = res.bands.filter((b) => b.type !== 'BYPASS').length;
  let note = `imported ${n} filter${n === 1 ? '' : 's'}`;
  if (res.folded) note += ` · preamp ${res.preampDb} dB folded in`;
  else if (res.sawPreamp) note += ' · preamp ignored';
  if (res.warnings.length) note += ` · ${res.warnings.length} clamped (${res.warnings[0]})`;
  state.bands = res.bands;
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

/* Boot. */
fitCanvas();
drawGraph();
boot();


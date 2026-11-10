(function (root, factory) {
  'use strict';
  const api = factory(root.RU3);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RU3UI = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RU3) {
  'use strict';

  const PEQ_COLS = ['freq', 'gain', 'q', 'type'];
  const TYPE_OPTIONS = ['BYPASS', 'LSHELF', 'PEAK', 'HSHELF', 'LPF', 'HPF'];
  const LIMITS = { freqMin: 20, freqMax: 20000, qMin: 0.1, qMax: 10, gainMin: -12, gainMax: 12 };
  const GEQ_GAINS_STEP = 0.1;

  function connect() {
    return (async () => {
      // Reuse an already-granted device if present; otherwise ask.
      let devices = await navigator.hid.getDevices();
      let device = RU3.pickDevice(devices);
      if (!device) {
        const picked = await navigator.hid.requestDevice({ filters: RU3.requestDeviceFilters() });
        device = picked[0];
        if (!device) throw new Error('No Cayin RU3 selected.');
      }
      if (!device.opened) await device.open();
      const controller = new RU3.Controller(device);
      const uac = RU3.PIDS[device.productId];
      return {
        device, controller,
        info: {
          productName: device.productName || 'Cayin RU3',
          productId: device.productId,
          uacFromPid: uac || null,
        },
      };
    })();
  }

  function disconnect(session) {
    if (!session) return;
    try { session.controller.close(); } catch { /* noop */ }
    if (session.device && session.device.opened) {
      session.device.close().catch(() => {});
    }
  }

  function bandValue(band, key) {
    if (key === 'gain') return band.gain_db ?? band.gain;
    return band[key];
  }

  // ---- RBJ magnitude response (same math as v2/web/app.js, Fs = 96 kHz) ----
  function bandMagDb(band, freq) {
    const type = band.type_name || band.type;
    if (type === 'BYPASS') return 0;
    const [b0, b1, b2, a1, a2] = RU3.rbjNormalized(
      type, band.freq, band.q, bandValue(band, 'gain'), RU3.PEQ_FS);
    const w = 2 * Math.PI * freq / RU3.PEQ_FS;
    const cw = Math.cos(w), sw = Math.sin(w);
    const cos2 = 2 * cw, cos1 = cw;
    const numRe = b0 + b1 * cw + b2 * (cw * cw - sw * sw);
    const numIm = -(b1 * sw + b2 * 2 * sw * cw);
    const denRe = 1 + a1 * cw + a2 * (cw * cw - sw * sw);
    const denIm = -(a1 * sw + a2 * 2 * sw * cw);
    const num = numRe * numRe + numIm * numIm;
    const den = denRe * denRe + denIm * denIm;
    if (den === 0) return 0;
    return 10 * Math.log10(num / den);
  }

  function totalResponseDb(bands, freq) {
    return bands.reduce((sum, b) => sum + bandMagDb(b, freq), 0);
  }

  function drawResponse(canvas, bands, selected = -1) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 640, H = canvas.clientHeight || 220;
    if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const padL = 44, padR = 10, padT = 12, padB = 22;
    const iw = W - padL - padR, ih = H - padT - padB;
    const fMin = Math.log10(20), fMax = Math.log10(20000);
    const x = (f) => padL + (Math.log10(f) - fMin) / (fMax - fMin) * iw;
    const y = (db) => padT + ih / 2 - (db / 24) * ih * 0.5 * 2 / 2 * 1 - (db / 24) * (ih / 2);
    // y maps -12..+12 dB across the plot height.
    const yDb = (db) => padT + ih / 2 - (db / 12) * (ih / 2);
    ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = '#5a6b7a';
    ctx.strokeStyle = '#d5dde4'; ctx.lineWidth = 1;
    for (const db of [-12, -6, 0, 6, 12]) {
      const yy = yDb(db);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      ctx.fillText(String(db), 6, yy + 3);
    }
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), x(f) - 8, H - 6);
    }
    void y;
    // curve
    ctx.strokeStyle = '#2d73a7'; ctx.lineWidth = 2; ctx.beginPath();
    for (let px = 0; px <= iw; px += 2) {
      const f = Math.pow(10, fMin + (px / iw) * (fMax - fMin));
      const db = totalResponseDb(bands, f);
      const yy = yDb(db);
      if (px === 0) ctx.moveTo(padL + px, yy); else ctx.lineTo(padL + px, yy);
    }
    ctx.stroke();
    // band markers
    bands.forEach((b, i) => {
      const mx = x(b.freq), my = yDb(totalResponseDb(bands, b.freq));
      ctx.fillStyle = i === selected ? '#e8940a' : '#2d73a7';
      ctx.beginPath(); ctx.arc(mx, my, i === selected ? 5 : 3.5, 0, Math.PI * 2); ctx.fill();
    });
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderBandTable(container, bands, onChange, opts = {}) {
    // bands: editable array of {freq,q,gain,type} (mutable). Table with
    // per-band freq/gain/Q inputs + type select. Padded BYPASS rows included.
    const table = el('table', 'bands');
    const thead = el('thead');
    const hr = el('tr');
    ['#', 'Freq Hz', 'Gain dB', 'Q', 'Type'].forEach((h) => hr.append(el('th', null, h)));
    thead.append(hr);
    const tbody = el('tbody');
    bands.forEach((band, i) => {
      const tr = el('tr');
      tr.append(el('td', 'num', String(i + 1)));
      const mkNum = (key, step, min, max) => {
        const input = el('input');
        input.type = 'number'; input.value = band[key];
        input.step = step; input.min = min; input.max = max;
        input.dataset.band = i; input.dataset.key = key;
        input.addEventListener('change', () => {
          const v = parseFloat(input.value);
          if (!Number.isFinite(v)) { input.value = band[key]; return; }
          band[key] = Math.min(max, Math.max(min, v));
          input.value = band[key];
          onChange && onChange(i, key, band[key]);
        });
        const td = el('td'); td.append(input); return td;
      };
      tr.append(mkNum('freq', '1', LIMITS.freqMin, LIMITS.freqMax));
      tr.append(mkNum('gain', '0.1', LIMITS.gainMin, LIMITS.gainMax));
      tr.append(mkNum('q', '0.01', LIMITS.qMin, LIMITS.qMax));
      const sel = el('select');
      TYPE_OPTIONS.forEach((t) => {
        const o = el('option', null, t); o.value = t;
        if (t === band.type) o.selected = true;
        sel.append(o);
      });
      sel.addEventListener('change', () => {
        band.type = sel.value;
        onChange && onChange(i, 'type', band.type);
      });
      const td = el('td'); td.append(sel); tr.append(td);
      tbody.append(tr);
    });
    table.append(thead, tbody);
    container.replaceChildren(table);
    return table;
  }

  function renderGeq(container, gains, onChange) {
    // gains: array of 10 numbers, mutable.
    const wrap = el('div', 'geq');
    RU3.GEQ_FREQS.forEach((freq, i) => {
      const row = el('div', 'geq-row');
      row.append(el('span', 'geq-freq', freq >= 1000 ? (freq / 1000) + 'k' : String(freq)));
      const input = el('input', 'geq-slider');
      input.type = 'range'; input.min = -12; input.max = 12; input.step = GEQ_GAINS_STEP;
      input.value = gains[i]; input.dataset.band = i;
      const num = el('output', 'geq-val', Number(gains[i]).toFixed(1));
      input.addEventListener('input', () => {
        gains[i] = parseFloat(input.value);
        num.textContent = gains[i].toFixed(1);
        onChange && onChange(i, gains[i]);
      });
      input.addEventListener('dblclick', () => {
        gains[i] = 0; input.value = 0; num.textContent = '0.0';
        onChange && onChange(i, 0);
      });
      row.append(input, num);
      wrap.append(row);
    });
    container.replaceChildren(wrap);
    return wrap;
  }

  function setStatus(node, text, tone, detail) {
    if (!node) return;
    node.hidden = false;
    node.dataset.tone = tone || 'neutral';
    node.textContent = text;
    if (detail) node.title = detail; else node.removeAttribute('title');
  }

  function hexDump(bytes, max = 64) { return RU3.hex(bytes).slice(0, max * 2); }

  return {
    connect, disconnect, drawResponse, bandMagDb, totalResponseDb,
    renderBandTable, renderGeq, setStatus, hexDump, LIMITS, TYPE_OPTIONS, PEQ_COLS,
  };
});

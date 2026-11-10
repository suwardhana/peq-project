'use strict';
/* AutoEq ParametricEQ.txt parser. Pure function, no DOM access.
 * Browser: <script src="/autoeq.js"></script> then call parseAutoEq(text).
 * Node:    const { parseAutoEq } = require('./autoeq.js');
 *
 * Input shape:
 *   Preamp: -1.9 dB
 *   Filter 1: ON PK Fc 35 Hz Gain -0.6 dB Q 1.200
 *   ...
 *
 * Returns { bands, preampDb, sawPreamp, folded, warnings } where bands is
 * always 10 device-ready {freq,q,gain,type} objects (padded with BYPASS).
 * Throws Error with a human-readable message on invalid input.
 */

const AUTOEQ_TYPE_MAP = { PK: 'PEAK', LS: 'LSHELF', HS: 'HSHELF', LP: 'LPF', HP: 'HPF' };
const AUTOEQ_LIMITS = { fMin: 20, fMax: 20000, qMin: 0.1, qMax: 10, gMin: -12, gMax: 12 };

function parseAutoEq(text, opts = {}) {
  const foldPreamp = opts.foldPreamp !== false;
  const lines = String(text ?? '').split(/\r?\n/);
  let preampDb = 0;
  let sawPreamp = false;
  const filters = [];
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let m = line.match(/^Preamp\s*:\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*dB/i);
    if (m) { preampDb = parseFloat(m[1]); sawPreamp = true; return; }
    m = line.match(/^Filter\s+(\d+)\s*:\s*(ON|OFF)\s+([A-Za-z]+)\s+Fc\s+([\d.]+)\s*Hz\s+Gain\s+([+-]?[\d.]+)\s*dB\s+Q\s+([\d.]+)/i);
    if (!m) throw new Error(`line ${idx + 1}: not a Preamp/Filter line: ${raw.trim().slice(0, 60)}`);
    filters.push({
      num: +m[1], on: m[2].toUpperCase() === 'ON', type: m[3].toUpperCase(),
      fc: parseFloat(m[4]), gain: parseFloat(m[5]), q: parseFloat(m[6]), lineNo: idx + 1,
    });
  });
  if (!filters.length) throw new Error('no "Filter N: ..." lines found — is this AutoEq ParametricEQ.txt?');
  if (filters.length > 10) throw new Error(`found ${filters.length} filters, device has 10 bands`);
  const L = AUTOEQ_LIMITS;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const warnings = [];
  const bands = filters.map((f) => {
    if (![f.fc, f.gain, f.q].every(Number.isFinite)) {
      throw new Error(`line ${f.lineNo}: bad number in Filter ${f.num}`);
    }
    if (f.on && !(f.type in AUTOEQ_TYPE_MAP)) {
      throw new Error(`line ${f.lineNo}: unsupported type ${f.type} (want PK/LS/HS/LP/HP)`);
    }
    let freq = Math.round(f.fc);
    if (freq < L.fMin || freq > L.fMax) {
      const c = clamp(freq, L.fMin, L.fMax);
      warnings.push(`Filter ${f.num}: Fc ${freq} clamped to ${c}`);
      freq = c;
    }
    let q = f.q;
    if (q < L.qMin || q > L.qMax) {
      warnings.push(`Filter ${f.num}: Q ${q} clamped to ${clamp(q, L.qMin, L.qMax)}`);
      q = clamp(q, L.qMin, L.qMax);
    }
    if (!f.on) return { freq, q: +q.toFixed(3), gain: 0, type: 'BYPASS' };
    let gain = Math.round((f.gain + (foldPreamp ? preampDb : 0)) * 100) / 100;
    if (gain < L.gMin || gain > L.gMax) {
      warnings.push(`Filter ${f.num}: gain ${gain} dB clamped to ${clamp(gain, L.gMin, L.gMax)}`);
      gain = clamp(gain, L.gMin, L.gMax);
    }
    return { freq, q: +q.toFixed(3), gain, type: AUTOEQ_TYPE_MAP[f.type] };
  });
  while (bands.length < 10) {
    bands.push({ freq: 1000 + bands.length, q: 0.71, gain: 0, type: 'BYPASS' });
  }
  return {
    bands, preampDb: sawPreamp ? preampDb : 0, sawPreamp,
    folded: foldPreamp && sawPreamp && preampDb !== 0, warnings,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseAutoEq, AUTOEQ_TYPE_MAP, AUTOEQ_LIMITS };
}

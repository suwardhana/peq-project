(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MicroPeqCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BAND_COUNT = 8;

  const TYPE_MAP = {
    PK: 'PEAK',
    PEAK: 'PEAK',
    PEAKING: 'PEAK',
    LSQ: 'LSHELF',
    LS: 'LSHELF',
    LSC: 'LSHELF',
    LOW_SHELF: 'LSHELF',
    HSQ: 'HSHELF',
    HS: 'HSHELF',
    HSC: 'HSHELF',
    HIGH_SHELF: 'HSHELF',
    LPF: 'LPF',
    LP: 'LPF',
    LOW_PASS: 'LPF',
    HPF: 'HPF',
    HP: 'HPF',
    HIGH_PASS: 'HPF'
  };

  const LIMITS = {
    freqMin: 20,
    freqMax: 20000,
    qMin: 0.1,
    qMax: 10,
    gainMin: -12,
    gainMax: 12,
    pregainMin: -12,
    pregainMax: 0
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function readNumber(value, label, rowNumber) {
    const number = typeof value === 'number' ? value : Number.parseFloat(value);
    if (!Number.isFinite(number)) {
      throw new Error(`Band ${rowNumber}: ${label} is not a valid number.`);
    }
    return number;
  }

  function normalizeType(value, rowNumber) {
    const key = String(value || 'PK')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    const type = TYPE_MAP[key];
    if (!type) {
      throw new Error(`Band ${rowNumber}: unsupported filter type "${value}".`);
    }
    return type;
  }

  /* The device has no bypass id: the backend stores BYPASS as a flat PEAK. */
  function flatBand(index) {
    return {
      freq: 1000 + index,
      q: 0.71,
      gain: 0,
      type: 'BYPASS'
    };
  }

  /* A row the page shows but never filled in (freq 0 / gain 0). */
  function isBlankRow(row) {
    if (!row) return true;
    const freq = Number.parseFloat(row.freq);
    const gain = Number.parseFloat(row.gain);
    return Number.isFinite(freq) && freq === 0
      && Number.isFinite(gain) && gain === 0;
  }

  function isActiveRow(row) {
    return Boolean(row) && row.enabled !== false && !isBlankRow(row);
  }

  function countActiveRows(rows) {
    if (!Array.isArray(rows)) return 0;
    return rows.filter(isActiveRow).length;
  }

  /* "Pre-amp: -3.2 dB" -> -3 (the register is whole dB, signed int8). */
  function readPreamp(text) {
    const match = String(text || '')
      .match(/pre-?amp\s*:?\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/i);
    if (!match) return null;
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? clampPregain(value) : null;
  }

  function clampPregain(value) {
    const number = typeof value === 'number' ? value : Number.parseFloat(value);
    if (!Number.isFinite(number)) return LIMITS.pregainMax;
    return clamp(Math.round(number), LIMITS.pregainMin, LIMITS.pregainMax);
  }

  /* ---- response math (mirrors the device DSP: RBJ biquads @ 96 kHz) ---- */

  const FS = 96000;

  function coefficients(type, freq, Q, gainDb) {
    const A = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * freq) / FS;
    const c = Math.cos(w);
    const s = Math.sin(w);
    const alpha = s / (2 * Q);
    let b0, b1, b2, a0, a1, a2;

    if (type === 'LSHELF' || type === 'HSHELF') {
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
    } else if (type === 'LPF' || type === 'HPF') {
      if (type === 'LPF') {
        b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2;
      } else {
        b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2;
      }
      a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
    } else {
      b0 = 1 + alpha * A; b1 = -2 * c; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * c; a2 = 1 - alpha / A;
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }

  function magnitudeDb(cf, f) {
    const w = (2 * Math.PI * f) / FS;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = Math.sin(2 * w);
    const [b0, b1, b2, a1, a2] = cf;
    const nr = b0 + b1 * cw + b2 * c2;
    const ni = -(b1 * sw + b2 * s2);
    const dr = 1 + a1 * cw + a2 * c2;
    const di = -(a1 * sw + a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  function flatResponse(band) {
    return !Number.isFinite(band.gain) || (Math.abs(band.gain) < 1e-9
      && band.type !== 'LPF' && band.type !== 'HPF');
  }

  /* Highest point of the summed response. That is the headroom the EQ needs,
     and squig.link's own export calls the negated value the preamp. */
  function peakBoostDb(bands, samples) {
    if (!Array.isArray(bands) || !bands.length) return 0;
    const curves = bands
      .filter((band) => band && !flatResponse(band))
      .map((band) => coefficients(band.type, band.freq, band.q, band.gain));
    if (!curves.length) return 0;

    const steps = samples || 600;
    let peak = 0;
    for (let i = 0; i < steps; i += 1) {
      const f = 20 * Math.pow(1000, i / (steps - 1)); // 20 Hz .. 20 kHz
      let sum = 0;
      for (const curve of curves) sum += magnitudeDb(curve, f);
      if (sum > peak) peak = sum;
    }
    return peak;
  }

  /* Preamp the preset needs, one decimal like the site prints it. */
  function computePreamp(bands, samples) {
    const peak = peakBoostDb(bands, samples);
    return Math.round(-peak * 10) / 10 || 0; // avoid -0 for a flat preset
  }

  function buildDeviceBands(rows, options) {
    if (!Array.isArray(rows)) {
      throw new Error('EQ filter rows were not found.');
    }
    const maxBands = (options && options.bandCount) || BAND_COUNT;

    const activeRows = rows.filter(isActiveRow);
    if (activeRows.length > maxBands) {
      throw new Error(
        `${activeRows.length} bands are enabled, but this DAC accepts only ` +
        `${maxBands}. Uncheck the extra bands first.`
      );
    }

    const warnings = [];
    const bands = activeRows.map((row, index) => {
      const rowNumber = Number.isInteger(row.rowNumber) ? row.rowNumber : index + 1;
      const rawFreq = readNumber(row.freq, 'frequency', rowNumber);
      const rawQ = readNumber(row.q, 'Q', rowNumber);
      const rawGain = readNumber(row.gain, 'gain', rowNumber);

      if (rawFreq <= 0) {
        throw new Error(
          `Band ${rowNumber}: frequency must be greater than 0 Hz.`
        );
      }

      const freq = clamp(Math.round(rawFreq), LIMITS.freqMin, LIMITS.freqMax);
      const q = clamp(rawQ, LIMITS.qMin, LIMITS.qMax);
      const gain = clamp(rawGain, LIMITS.gainMin, LIMITS.gainMax);

      if (freq !== Math.round(rawFreq)) {
        warnings.push(`Band ${rowNumber}: frequency clamped to ${freq} Hz.`);
      }
      if (q !== rawQ) {
        warnings.push(`Band ${rowNumber}: Q clamped to ${q}.`);
      }
      if (gain !== rawGain) {
        warnings.push(`Band ${rowNumber}: gain clamped to ${gain} dB.`);
      }

      return {
        freq,
        q: Math.round(q * 1000) / 1000,
        gain: Math.round(gain * 1000) / 1000,
        type: normalizeType(row.type, rowNumber)
      };
    });

    while (bands.length < maxBands) {
      bands.push(flatBand(bands.length));
    }

    const pregain = options && options.pregain !== null
      && options.pregain !== undefined
      ? clampPregain(options.pregain)
      : null;

    return {
      bands,
      pregain,
      warnings,
      activeCount: activeRows.length,
      paddingCount: maxBands - activeRows.length
    };
  }

  /* Which rows to switch off so that at most `maxBands` stay active: the
     smallest absolute gain goes first, because it shapes the curve least.
     Ties drop the later row. Returns 1-based row numbers. */
  function rowsToDrop(rows, maxBands) {
    const limit = Number.isFinite(maxBands) ? maxBands : BAND_COUNT;
    const active = [];
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      if (!isActiveRow(row)) return;
      const gain = Number.parseFloat(row.gain);
      active.push({
        rowNumber: Number.isInteger(row.rowNumber) ? row.rowNumber : index + 1,
        absGain: Number.isFinite(gain) ? Math.abs(gain) : 0
      });
    });
    const overflow = active.length - limit;
    if (overflow <= 0) return [];
    return active
      .sort((a, b) => (a.absGain - b.absGain) || (b.rowNumber - a.rowNumber))
      .slice(0, overflow)
      .map((entry) => entry.rowNumber);
  }

  const BYPASS_TYPES = ['BYPASS', 'PEAK', 'LSHELF', 'HSHELF'];

  function displayType(band) {
    if (band && band.gain === 0 && BYPASS_TYPES.includes(band.type)) {
      return 'BYPASS';
    }
    return band ? band.type : band;
  }

  return {
    BAND_COUNT,
    LIMITS,
    buildDeviceBands,
    clampPregain,
    computePreamp,
    displayType,
    countActiveRows,
    flatBand,
    isActiveRow,
    isBlankRow,
    magnitudeDb,
    normalizeType,
    peakBoostDb,
    readPreamp,
    rowsToDrop
  };
});

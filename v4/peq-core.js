(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RU3PeqCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

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
    HIGH_PASS: 'HPF',
    BYPASS: 'BYPASS'
  };

  const LIMITS = {
    freqMin: 20,
    freqMax: 20000,
    qMin: 0.1,
    qMax: 10,
    gainMin: -12,
    gainMax: 12
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

  function resetBand(index) {
    return {
      freq: 1000 + index,
      q: 0.71,
      gain: 0,
      type: 'BYPASS'
    };
  }

  function isBlankRow(row) {
    if (!row) return true;
    const freq = Number.parseFloat(row.freq);
    const gain = Number.parseFloat(row.gain);
    return Number.isFinite(freq) && freq === 0
      && Number.isFinite(gain) && gain === 0;
  }

  function countActiveRows(rows) {
    if (!Array.isArray(rows)) return 0;
    return rows.filter((row) =>
      row && row.enabled !== false && !isBlankRow(row)
    ).length;
  }

  function buildDeviceBands(rows) {
    if (!Array.isArray(rows)) {
      throw new Error('Squiglink filter rows were not found.');
    }

    const activeRows = rows.filter((row) =>
      row && row.enabled !== false && !isBlankRow(row)
    );
    if (activeRows.length > 10) {
      throw new Error(
        `${activeRows.length} bands are enabled, but the DAC accepts only 10. ` +
        'Uncheck the extra bands first.'
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

    while (bands.length < 10) {
      bands.push(resetBand(bands.length));
    }

    return {
      bands,
      warnings,
      activeCount: activeRows.length,
      paddingCount: 10 - activeRows.length
    };
  }

  return {
    buildDeviceBands,
    countActiveRows,
    isBlankRow,
    normalizeType,
    LIMITS
  };
});

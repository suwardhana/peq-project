'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BAND_COUNT,
  buildDeviceBands,
  clampPregain,
  computePreamp,
  countActiveRows,
  displayType,
  readPreamp,
  rowsToDrop
} = require('../peq-core.js');

function row(overrides = {}) {
  return {
    enabled: true,
    type: 'PK',
    freq: '1000',
    gain: '1.5',
    q: '1.2',
    rowNumber: 1,
    ...overrides
  };
}

test('maps hangout filter types and pads to eight bands', () => {
  const result = buildDeviceBands([
    row({ type: 'LSQ', freq: '105', gain: '3', q: '0.7', rowNumber: 1 }),
    row({ type: 'PK', freq: '30', gain: '-8.3', q: '0.5', rowNumber: 2 }),
    row({ type: 'HSQ', freq: '13000', gain: '-9.3', q: '1.5', rowNumber: 3 }),
    row({ type: 'LP', freq: '18000', gain: '0', q: '0.7', rowNumber: 4 }),
    row({ type: 'HP', freq: '25', gain: '0', q: '0.7', rowNumber: 5 })
  ]);

  assert.equal(result.bands.length, BAND_COUNT);
  assert.equal(result.activeCount, 5);
  assert.equal(result.paddingCount, 3);
  assert.deepEqual(result.bands.slice(0, 5).map((b) => b.type), [
    'LSHELF', 'PEAK', 'HSHELF', 'LPF', 'HPF'
  ]);
  // Padding is BYPASS — the backend stores it as flat PEAK.
  assert.ok(result.bands.slice(5).every(
    (band) => band.type === 'BYPASS' && band.gain === 0
  ));
});

test('clamps to the device limits and reports warnings', () => {
  const result = buildDeviceBands([
    row({ freq: '5', gain: '18', q: '20' })
  ]);

  assert.deepEqual(result.bands[0], {
    freq: 20,
    q: 10,
    gain: 12,
    type: 'PEAK'
  });
  assert.equal(result.warnings.length, 3);
});

test('rejects more than eight enabled bands', () => {
  const rows = Array.from({ length: 9 }, (_, index) =>
    row({ rowNumber: index + 1 })
  );
  assert.throws(
    () => buildDeviceBands(rows),
    /9 bands are enabled.*only 8/
  );
});

test('ignores unticked rows and 0 Hz placeholders', () => {
  const rows = [
    row({ freq: '105', gain: '-3' }),
    row({ enabled: false, rowNumber: 2 }),
    row({ freq: '0', gain: '0', q: '0', rowNumber: 3 })
  ];
  assert.equal(countActiveRows(rows), 1);
  assert.equal(buildDeviceBands(rows).activeCount, 1);
});

test('rejects invalid numbers, zero frequency and unknown types', () => {
  assert.throws(
    () => buildDeviceBands([row({ freq: 'abc' })]),
    /frequency is not a valid number/
  );
  assert.throws(
    () => buildDeviceBands([row({ freq: '0', gain: '3' })]),
    /frequency must be greater than 0 Hz/
  );
  assert.throws(
    () => buildDeviceBands([row({ type: 'NOTCH' })]),
    /unsupported filter type/
  );
});

test('reads the preamp from the page text, whole dB', () => {
  assert.equal(readPreamp('Pre-amp: -3.2 dB'), -3);
  assert.equal(readPreamp('Preamp: -10.6 dB'), -11);
  assert.equal(readPreamp('Preamble'), null);
  assert.equal(readPreamp('Pre-amp: +4 dB'), 0);
  assert.equal(readPreamp('Pre-amp: -30 dB'), -12);
});

test('clampPregain keeps whole dB inside -12..0', () => {
  assert.equal(clampPregain(-3.6), -4);
  assert.equal(clampPregain(2), 0);
  assert.equal(clampPregain(-99), -12);
  assert.equal(clampPregain('nope'), 0);
});

test('carries pregain through buildDeviceBands', () => {
  const result = buildDeviceBands([row()], { pregain: -3.4 });
  assert.equal(result.pregain, -3);
  assert.equal(buildDeviceBands([row()]).pregain, null);
});

test('derives the preamp from the curve (squig.link export parity)', () => {
  // 7HZ ELUA ULTRA preset; squig.link exports "Preamp: -4.2 dB" for it.
  const bands = [
    { freq: 26, q: 2, gain: -0.6, type: 'PEAK' },
    { freq: 170, q: 0.5, gain: 4.3, type: 'PEAK' },
    { freq: 1000, q: 0.7, gain: -1.7, type: 'PEAK' },
    { freq: 4600, q: 2, gain: 1.5, type: 'PEAK' },
    { freq: 6000, q: 2, gain: -5.9, type: 'PEAK' },
    { freq: 9900, q: 2, gain: 12, type: 'PEAK' },
    { freq: 11000, q: 0.5, gain: -8.4, type: 'PEAK' },
    { freq: 13000, q: 2, gain: -5.6, type: 'PEAK' }
  ];
  assert.equal(computePreamp(bands), -4.2);
  assert.equal(clampPregain(computePreamp(bands)), -4);
});

test('a flat or purely cut preset needs no preamp', () => {
  const flat = Array.from({ length: BAND_COUNT }, (_, i) => ({
    freq: 1000 + i, q: 0.71, gain: 0, type: 'PEAK'
  }));
  assert.equal(computePreamp(flat), 0);
  assert.equal(computePreamp([]), 0);
  assert.equal(clampPregain(computePreamp([])), 0);
});

test('flat peak/shelf displays as BYPASS, pass filters keep their name', () => {
  assert.equal(displayType({ gain: 0, type: 'PEAK' }), 'BYPASS');
  assert.equal(displayType({ gain: 0, type: 'LSHELF' }), 'BYPASS');
  assert.equal(displayType({ gain: 0, type: 'BYPASS' }), 'BYPASS');
  assert.equal(displayType({ gain: 0, type: 'LPF' }), 'LPF');
  assert.equal(displayType({ gain: 3, type: 'PEAK' }), 'PEAK');
});

function band(n, freq, gain) {
  return { enabled: true, type: 'PK', freq: String(freq), gain: String(gain),
    q: '1', rowNumber: n };
}

test('drops nothing when the preset already fits', () => {
  const rows = Array.from({ length: 8 }, (_, i) => band(i + 1, 1000, 3));
  assert.deepEqual(rowsToDrop(rows, 8), []);
});

test('drops the smallest absolute gain first', () => {
  // 10 bands from the 7HZ ELUA ULTRA preset; |gain| 1.1 on rows 2 and 6
  // are the weakest, so those go.
  const rows = [
    band(1, 20, 4.1), band(2, 89, -1.1), band(3, 110, 1.2), band(4, 210, 1.7),
    band(5, 2200, 1.9), band(6, 3300, -1.1), band(7, 4200, -5),
    band(8, 6300, -1.7), band(9, 9900, 12), band(10, 13000, -7.6)
  ];
  assert.deepEqual(rowsToDrop(rows, 8), [6, 2]);
});

test('ignores unticked and placeholder rows when counting', () => {
  const rows = [
    band(1, 100, 5), band(2, 200, 0.5), band(3, 0, 0),
    { ...band(4, 300, 9), enabled: false },
    band(5, 400, 6), band(6, 500, 7), band(7, 600, 8), band(8, 700, 9),
    band(9, 800, 10)
  ];
  // 7 active rows (1, 2, 5..9) fit inside the limit -> nothing to drop.
  assert.deepEqual(rowsToDrop(rows, 8), []);
  rows.push(band(10, 900, 0.2));
  assert.deepEqual(rowsToDrop(rows, 8), []);
  rows.push(band(11, 950, 0.3));
  // 9 active -> one goes, and it is the 0.2 dB row, not the 0.5 dB one.
  assert.deepEqual(rowsToDrop(rows, 8), [10]);
});

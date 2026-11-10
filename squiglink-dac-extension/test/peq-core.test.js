'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeviceBands } = require('../peq-core.js');

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

test('maps Squiglink filters and pads inactive bands', () => {
  const result = buildDeviceBands([
    row({ type: 'PK', freq: '22', gain: '2.5', q: '0.5' }),
    row({ type: 'LSQ', freq: '100', gain: '-2', q: '0.7', rowNumber: 2 }),
    row({ type: 'HSQ', freq: '8000', gain: '3', q: '1.1', rowNumber: 3 }),
    row({ enabled: false, rowNumber: 4 })
  ]);

  assert.equal(result.bands.length, 10);
  assert.equal(result.activeCount, 3);
  assert.equal(result.paddingCount, 7);
  assert.deepEqual(result.bands.slice(0, 3), [
    { freq: 22, q: 0.5, gain: 2.5, type: 'PEAK' },
    { freq: 100, q: 0.7, gain: -2, type: 'LSHELF' },
    { freq: 8000, q: 1.1, gain: 3, type: 'HSHELF' }
  ]);
  assert.ok(result.bands.slice(3).every((band) => band.type === 'BYPASS'));
});

test('clamps values to the RU3 device limits', () => {
  const result = buildDeviceBands([
    row({ freq: '5', gain: '20', q: '20' })
  ]);

  assert.deepEqual(result.bands[0], {
    freq: 20,
    q: 10,
    gain: 12,
    type: 'PEAK'
  });
  assert.equal(result.warnings.length, 3);
});

test('rejects more than ten enabled bands', () => {
  const rows = Array.from({ length: 11 }, (_, index) =>
    row({ rowNumber: index + 1 })
  );
  assert.throws(
    () => buildDeviceBands(rows),
    /11 bands are enabled.*only 10/
  );
});

test('rejects invalid numbers and unsupported filter types', () => {
  assert.throws(
    () => buildDeviceBands([row({ freq: 'not-a-number' })]),
    /frequency is not a valid number/
  );
  assert.throws(
    () => buildDeviceBands([row({ type: 'NOTCH' })]),
    /unsupported filter type/
  );
});

test('treats checked 0 Hz / 0 dB rows as bypass placeholders', () => {
  const result = buildDeviceBands([
    row({ freq: '22', gain: '2.5', q: '0.5' }),
    row({ freq: '0', gain: '0', q: '0', rowNumber: 2 }),
    row({ freq: '0', gain: '0', q: '0', rowNumber: 3 })
  ]);

  assert.equal(result.activeCount, 1);
  assert.equal(result.paddingCount, 9);
  assert.equal(result.bands[0].type, 'PEAK');
  assert.ok(result.bands.slice(1).every((band) => band.type === 'BYPASS'));
});

test('rejects a non-zero gain with zero frequency', () => {
  assert.throws(
    () => buildDeviceBands([row({ freq: '0', gain: '3' })]),
    /frequency must be greater than 0 Hz/
  );
});

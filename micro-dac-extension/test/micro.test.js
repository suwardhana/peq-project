'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const micro = require('../micro.js');

// Coefficient words captured from real hardware (same table as v3/test_micro.py).
const CAPTURED = [
  [105, 0.7, 0.0, 'LSHELF', [1073741824, -2136943325, 1063251963, 2136943325, -1063251963]],
  [15000, 0.1, 0.0, 'PEAK', [1073741824, -231335558, -657348821, 231335558, 657348821]],
  [30, 0.5, -8.3, 'PEAK', [1071656277, -2140701755, 1069049604, 2140701755, -1066964057]],
  [360, 0.9, 3.5, 'PEAK', [1079382925, -2124158310, 1045365151, 2124158310, -1051006252]],
  [1600, 1.6, -1.5, 'PEAK', [1067885781, -2062279598, 1005753430, 2062279598, -999897387]],
  [2900, 1.9, 2.5, 'PEAK', [1088504119, -2021983233, 970455710, 2021983233, -985218005]],
  [4700, 2.0, -1.8, 'PEAK', [1058175112, -1888147849, 922970395, 1888147849, -907403683]],
  [13000, 1.5, -9.3, 'PEAK', [862209620, -991509410, 641567893, 991509410, -430035689]]
];

test('encodeBand reproduces hardware-captured coefficient words', () => {
  CAPTURED.forEach(([freq, q, gain, type, words], band) => {
    const packet = micro.encodeBand(band, freq, q, gain, type);
    assert.equal(packet.length, 64);
    assert.deepEqual(Array.from(packet.slice(0, 4)), [0x4B, 0x01, 0x09, 0x18]);
    const view = new DataView(packet.buffer);
    const got = [0, 1, 2, 3, 4].map((i) => view.getInt32(8 + i * 4, true));
    assert.deepEqual(got, words);
  });
});

test('decodeBand reads back what encodeBand wrote', () => {
  const packet = micro.encodeBand(2, 360, 0.9, 3.5, 'PEAK');
  const reply = Uint8Array.from(packet);
  reply[1] = 0x80;
  const back = micro.decodeBand(reply);
  assert.equal(back.band, 2);
  assert.equal(back.freq, 360);
  assert.equal(back.gain_db, 3.5);
  assert.equal(back.q, Math.round(0.9 * 256) / 256);
  assert.equal(back.type_name, 'PEAK');
  assert.equal(back.slot, 101);
});

test('flat band reads back as BYPASS', () => {
  const reply = Uint8Array.from(micro.encodeBand(0, 1000, 0.71, 0, 'BYPASS'));
  reply[1] = 0x80;
  assert.equal(micro.decodeBand(reply).type_name, 'BYPASS');
});

test('encodeBand rejects out-of-range input', () => {
  assert.throws(() => micro.encodeBand(0, 10, 1, 0, 'PEAK'));
  assert.throws(() => micro.encodeBand(0, 100, 1, 13, 'PEAK'));
  assert.throws(() => micro.encodeBand(0, 100, 11, 0, 'PEAK'));
  assert.throws(() => micro.encodeBand(8, 100, 1, 0, 'PEAK'));
});

test('decodePregain is signed and decodeVersion is NUL-terminated', () => {
  const pre = new Uint8Array(64);
  pre.set([0x4B, 0x80, 0x03, 1, 0, 0xF9]);
  assert.equal(micro.decodePregain(pre), -7);
  const ver = new Uint8Array(64);
  ver.set([0x4B, 0x80, 0x0C, 3, ...Buffer.from('0.2')]);
  assert.equal(micro.decodeVersion(ver), '0.2');
});

/* Fake WebHID device: remembers band records, answers READs like the DAC. */
class FakeHid extends EventTarget {
  constructor() {
    super();
    this.productName = 'Protocol Micro';
    this.bands = {};
    this.pregain = 0;
  }
  reply(raw) {
    const data = raw.slice(1);
    this.dispatchEvent(Object.assign(new Event('inputreport'), {
      reportId: raw[0], data: new DataView(data.buffer)
    }));
  }
  async sendReport(reportId, data) {
    const [op, cmd] = [data[0], data[1]];
    const pkt = Uint8Array.from([reportId, ...data]);
    if (op === 0x01 && cmd === 0x09) this.bands[pkt[5]] = pkt;
    else if (op === 0x01 && cmd === 0x03) this.pregain = pkt[5];
    else if (op === 0x80 && cmd === 0x09) {
      const out = Uint8Array.from(this.bands[pkt[5]]);
      out[1] = 0x80;
      setTimeout(() => this.reply(out), 1);
    } else if (op === 0x80 && cmd === 0x03) {
      setTimeout(() => this.reply(Uint8Array.from([0x4B, 0x80, 0x03, 1, 0, this.pregain & 0xFF,
        ...new Array(58).fill(0)])), 1);
    } else if (op === 0x80 && cmd === 0x0C) {
      setTimeout(() => this.reply(Uint8Array.from([0x4B, 0x80, 0x0C, 3, 0x30, 0x2E, 0x32,
        ...new Array(57).fill(0)])), 1);
    }
  }
}

test('Controller writes 8 bands + pregain and verifies by read-back', async () => {
  const device = new FakeHid();
  const ctl = new micro.Controller(device);
  const bands = CAPTURED.map(([freq, q, gain, type]) => ({ freq, q, gain, type }));
  const res = await ctl.setPeq(bands, -7);
  assert.equal(res.bands.length, 8);
  assert.ok(res.bands.every((b) => b.verified), JSON.stringify(res.bands));
  assert.equal(res.pregain.verified, true);
  const state = await ctl.readState();
  assert.equal(state.firmware, '0.2');
  assert.equal(state.pregain, -7);
  assert.equal(state.bands[3].freq, 360);
  ctl.close();
});

test('Controller read times out when the DAC stays silent', async () => {
  const device = new FakeHid();
  device.sendReport = async () => {};
  const ctl = new micro.Controller(device);
  await assert.rejects(ctl.read(0x0C, null, 50), /no response/);
});

/* CrinEar Protocol Micro over WebHID — port of v3/micro.py (see v3/PROTOCOL.md).
 *
 * Wire format: 64-byte HID report, report ID 0x4B (63 payload bytes after it):
 *   [0] 0x4B  [1] op (0x80 READ / 0x01 WRITE)  [2] command  [3] length  [4..] payload
 * Writes get no ACK, so every write is confirmed by a read-back.
 *
 * Pure encode/decode functions run in Node too (tests); the Controller only
 * needs a WebHID-like device (sendReport + 'inputreport' events).
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MicroDevice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VID = 0x3302;
  const PID = 0xC20F;
  const REPORT_ID = 0x4B;
  const REPORT_DATA = 63;
  const OP_READ = 0x80;
  const OP_WRITE = 0x01;

  const CMD_FLASH_EQ = 0x01;
  const CMD_GLOBAL_GAIN = 0x03;
  const CMD_UNLOCK_A = 0x05;
  const CMD_PEQ_VALUES = 0x09;
  const CMD_APPLY = 0x0A;
  const CMD_VERSION = 0x0C;
  const CMD_UNLOCK_B = 0x17;

  const BAND_COUNT = 8;
  const DEFAULT_SLOT = 101;
  const PEQ_FS = 96000;
  const PEQ_SCALE = 2 ** 30; // Q1.30, not 2^31 like the RU3

  const PEQ_TYPE_IDS = { LSHELF: 1, PEAK: 2, HSHELF: 3, LPF: 4, HPF: 5 };
  const PEQ_TYPE = Object.fromEntries(
    Object.entries(PEQ_TYPE_IDS).map(([name, id]) => [id, name])
  );
  const BYPASS_TYPES = ['BYPASS', 'LSHELF', 'PEAK', 'HSHELF'];

  const GAIN_LIMIT = 12;
  const Q_MIN = 0.1;
  const Q_MAX = 10;
  const FREQ_MIN = 20;
  const FREQ_MAX = 20000;
  const PREGAIN_MIN = -12;
  const PREGAIN_MAX = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* Python's round(): halves go to the even neighbour (JS rounds them up). */
  function pyRound(x) {
    const f = Math.floor(x);
    const diff = x - f;
    if (diff < 0.5) return f;
    if (diff > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  function frame(command, opcode, payload, length) {
    const data = payload ? Array.from(payload) : [];
    const len = length === undefined || length === null ? data.length : length;
    if (4 + data.length > 1 + REPORT_DATA) {
      throw new Error(`packet exceeds ${1 + REPORT_DATA} bytes`);
    }
    const packet = new Uint8Array(1 + REPORT_DATA);
    packet.set([REPORT_ID, opcode, command, len]);
    packet.set(data, 4);
    return packet;
  }

  function bandReadPacket(band) {
    if (!Number.isInteger(band) || band < 0 || band >= BAND_COUNT) {
      throw new Error(`band must be 0..${BAND_COUNT - 1}`);
    }
    return frame(CMD_PEQ_VALUES, OP_READ, [0x00, band, 0x00], 0);
  }

  /* The biquad the reference quantizes for every filter type. */
  function rbjPeak(freq, Q, gainDb, fs = PEQ_FS) {
    const A = Math.sqrt(10 ** (gainDb / 20));
    const w = (2 * Math.PI * freq) / fs;
    const s = Math.sin(w) / (2 * Q);
    const alphaA = s * A;
    const alphaDivA = s / A;
    const norm = 1 + alphaDivA;
    const c = (-2 * Math.cos(w)) / norm;
    return [(1 + alphaA) / norm, c, (1 - alphaA) / norm, c, (1 - alphaDivA) / norm];
  }

  /* 20-byte blob: 5 x int32 LE, order [b0, b1, b2, -a1, -a2]. */
  function coeffBlob(freq, Q, gainDb) {
    const [b0, b1, b2, a1, a2] = rbjPeak(freq, Q, gainDb);
    const out = new DataView(new ArrayBuffer(20));
    [b0, b1, b2, -a1, -a2].forEach((word, i) => {
      out.setInt32(i * 4, pyRound(word * PEQ_SCALE), true);
    });
    return new Uint8Array(out.buffer);
  }

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function encodeBand(band, freq, Q, gainDb, filterType, slot = DEFAULT_SLOT) {
    if (!Number.isInteger(band) || band < 0 || band >= BAND_COUNT) {
      throw new Error(`band must be 0..${BAND_COUNT - 1}`);
    }
    if (!Number.isInteger(freq) || freq < FREQ_MIN || freq > FREQ_MAX) {
      throw new Error(`freq must be an integer ${FREQ_MIN}..${FREQ_MAX}`);
    }
    if (!isNum(Q) || Q < Q_MIN || Q > Q_MAX) {
      throw new Error(`Q must be a number ${Q_MIN}..${Q_MAX}`);
    }
    if (!isNum(gainDb) || Math.abs(gainDb) > GAIN_LIMIT) {
      throw new Error(`gain_db must be a number -${GAIN_LIMIT}..+${GAIN_LIMIT}`);
    }
    if (!(filterType in PEQ_TYPE_IDS) && filterType !== 'BYPASS') {
      throw new Error(`unknown PEQ type ${filterType}`);
    }
    let wireType = filterType;
    if (filterType === 'BYPASS') {
      // No wire id: store a flat PEAK.
      gainDb = 0;
      wireType = 'PEAK';
    }
    const tail = new DataView(new ArrayBuffer(10));
    tail.setUint16(0, freq, true);
    tail.setUint16(2, pyRound(Q * 256), true);
    tail.setInt16(4, pyRound(gainDb * 256), true);
    tail.setUint8(6, PEQ_TYPE_IDS[wireType]);
    tail.setUint8(8, slot & 0xFF);
    const payload = new Uint8Array(4 + 20 + 10);
    payload.set([0x00, band, 0x00, 0x00]);
    payload.set(coeffBlob(freq, Q, gainDb), 4);
    payload.set(new Uint8Array(tail.buffer), 24);
    return frame(CMD_PEQ_VALUES, OP_WRITE, payload, 0x18);
  }

  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  function decodeBand(report) {
    const data = Uint8Array.from(report);
    if (data.length < 40 || data[0] !== REPORT_ID || data[1] !== OP_READ
        || data[2] !== CMD_PEQ_VALUES) {
      throw new Error(`not a PEQ band response: ${hex(data.slice(0, 8))}`);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const freq = view.getUint16(28, true);
    const qRaw = view.getUint16(30, true);
    const gainRaw = view.getInt16(32, true);
    const rawType = data[34];
    let typeName = PEQ_TYPE[rawType];
    // A flat shelf/peak is unity: present it as BYPASS.
    if (gainRaw === 0 && [1, 2, 3].includes(rawType)) typeName = 'BYPASS';
    return {
      band: data[5],
      freq,
      q: qRaw / 256,
      gain_db: gainRaw / 256,
      type: rawType,
      type_name: typeName,
      slot: data[36]
    };
  }

  function decodePregain(report) {
    const data = Uint8Array.from(report);
    if (data.length < 6 || data[0] !== REPORT_ID || data[1] !== OP_READ
        || data[2] !== CMD_GLOBAL_GAIN) {
      throw new Error(`not a pregain response: ${hex(data.slice(0, 8))}`);
    }
    return (data[5] << 24) >> 24; // signed int8
  }

  function decodeVersion(report) {
    const data = Uint8Array.from(report);
    if (data.length < 5 || data[0] !== REPORT_ID || data[1] !== OP_READ
        || data[2] !== CMD_VERSION) {
      throw new Error(`not a version response: ${hex(data.slice(0, 8))}`);
    }
    const body = data.slice(4);
    const end = body.indexOf(0);
    return String.fromCharCode(...(end < 0 ? body : body.slice(0, end)));
  }

  function normType(typeName, gainDb) {
    return BYPASS_TYPES.includes(typeName) && gainDb === 0 ? 'BYPASS' : typeName;
  }

  /* One open WebHID device. Operations are serialised: the UI debounces edits
     but a slow flash must never interleave with the next read. */
  class Controller {
    constructor(device) {
      this.device = device;
      this.inbox = [];
      this.wake = null;
      this.chain = Promise.resolve();
      this.onReport = (event) => {
        const raw = new Uint8Array(1 + REPORT_DATA);
        raw[0] = event.reportId;
        raw.set(new Uint8Array(event.data.buffer, event.data.byteOffset,
          Math.min(event.data.byteLength, REPORT_DATA)), 1);
        this.inbox.push(raw);
        if (this.wake) this.wake();
      };
      device.addEventListener('inputreport', this.onReport);
    }

    close() {
      this.device.removeEventListener('inputreport', this.onReport);
    }

    exclusive(task) {
      const run = this.chain.then(task);
      this.chain = run.catch(() => {});
      return run;
    }

    async send(packet) {
      if (packet[0] !== REPORT_ID) throw new Error('packet must start with report id 0x4B');
      await this.device.sendReport(REPORT_ID, packet.slice(1, 1 + REPORT_DATA));
    }

    async read(command, band, timeoutMs = 1500) {
      this.inbox.length = 0; // stale reports
      await this.send(band !== undefined && band !== null
        ? bandReadPacket(band)
        : frame(command, OP_READ));
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = this.inbox.findIndex((raw) => raw[1] === OP_READ && raw[2] === command);
        if (index >= 0) return this.inbox.splice(index, 1)[0];
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(`no response to READ 0x${command.toString(16).padStart(2, '0')}`);
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, left);
          this.wake = () => { clearTimeout(timer); resolve(); };
        });
        this.wake = null;
      }
    }

    firmware() { return this.read(CMD_VERSION).then(decodeVersion); }
    getPregain() { return this.read(CMD_GLOBAL_GAIN).then(decodePregain); }
    getBand(band) { return this.read(CMD_PEQ_VALUES, band).then(decodeBand); }

    async setPregainRaw(value) {
      if (!isNum(value)) throw new Error('pregain must be a number');
      value = Math.round(value);
      if (value < PREGAIN_MIN || value > PREGAIN_MAX) {
        throw new Error(`pregain must be ${PREGAIN_MIN}..${PREGAIN_MAX} dB`);
      }
      await this.send(frame(CMD_GLOBAL_GAIN, OP_WRITE, [0x00, value & 0xFF]));
      await sleep(50);
      const readback = await this.getPregain();
      return { requested_pregain: value, readback, verified: readback === value };
    }

    setPregain(value) { return this.exclusive(() => this.setPregainRaw(value)); }

    async getPeqRaw() {
      const bands = [];
      for (let i = 0; i < BAND_COUNT; i += 1) bands.push(await this.getBand(i));
      const slot = (bands.find((b) => b.slot) || {}).slot || DEFAULT_SLOT;
      return { bands, slot, pregain: await this.getPregain() };
    }

    getPeq() { return this.exclusive(() => this.getPeqRaw()); }

    async burst(records) {
      await this.send(frame(CMD_UNLOCK_A, OP_WRITE));
      await sleep(30);
      await this.send(frame(CMD_UNLOCK_B, OP_WRITE));
      await sleep(30);
      for (const record of records) {
        await this.send(record);
        await sleep(30);
      }
      await this.send(frame(CMD_APPLY, OP_WRITE, [0x00, 0x00, 0xFF, 0xFF, 0x00], 4));
      await sleep(50);
      await this.send(frame(CMD_FLASH_EQ, OP_WRITE));
      await sleep(900);
    }

    /* bands: 8 x {freq, q, gain, type}. Writes, flashes, verifies by read-back. */
    setPeq(bands, pregain, slot = DEFAULT_SLOT) {
      return this.exclusive(async () => {
        if (!Array.isArray(bands) || bands.length !== BAND_COUNT) {
          throw new Error(`setPeq needs exactly ${BAND_COUNT} bands`);
        }
        const records = bands.map((b, i) =>
          encodeBand(i, b.freq, b.q, b.gain, b.type, slot));
        await this.burst(records);
        const result = [];
        for (let i = 0; i < BAND_COUNT; i += 1) {
          try {
            const back = await this.getBand(i);
            const want = bands[i];
            const ok = back.freq === want.freq
              && back.gain_db === pyRound(want.gain * 256) / 256
              && back.q === pyRound(want.q * 256) / 256
              && normType(back.type_name, back.gain_db) === normType(want.type, want.gain);
            result.push({ band: i, verified: ok, freq: back.freq, q: back.q,
              gain_db: back.gain_db, type: back.type_name });
          } catch (error) {
            result.push({ band: i, verified: false, error: error.message });
          }
        }
        const pregainResult = pregain === undefined || pregain === null
          ? null
          : await this.setPregainRaw(pregain);
        return { bands: result, pregain: pregainResult };
      });
    }

    readState() {
      return this.exclusive(async () => {
        const state = { product: this.device.productName, errors: {} };
        try { state.firmware = await this.firmware(); } catch (e) {
          state.firmware = null; state.errors.firmware = e.message;
        }
        try {
          const peq = await this.getPeqRaw();
          state.bands = peq.bands;
          state.slot = peq.slot;
          state.pregain = peq.pregain;
        } catch (e) { state.errors.peq = e.message; }
        return state;
      });
    }
  }

  /* ---- WebHID plumbing --------------------------------------------------- */

  /* The DAC exposes several HID interfaces; only one carries report 0x4B. */
  function isControlInterface(device) {
    return device.vendorId === VID && device.productId === PID
      && (device.collections || []).some((c) =>
        (c.outputReports || []).some((r) => r.reportId === REPORT_ID));
  }

  /* Already-authorised device, or null. Works from a service worker too. */
  async function findDevice() {
    const devices = await navigator.hid.getDevices();
    return devices.find(isControlInterface) || null;
  }

  /* Chrome's chooser; needs a user gesture (a click in the extension page). */
  async function requestDevice() {
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: VID, productId: PID }]
    });
    return devices.find(isControlInterface) || null;
  }

  async function openController(device) {
    if (!device.opened) await device.open();
    return new Controller(device);
  }

  return {
    VID, PID, BAND_COUNT, DEFAULT_SLOT,
    frame, bandReadPacket, rbjPeak, coeffBlob, encodeBand,
    decodeBand, decodePregain, decodeVersion,
    Controller, isControlInterface, findDevice, requestDevice, openController
  };
});

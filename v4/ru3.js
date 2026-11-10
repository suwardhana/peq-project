(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RU3 = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Cayin RU3 controller — JS port of ../v2/dac.py (WebHID transport).
   *
   * Wire format: 64-byte HID report, report ID 75 (0x4B). No checksum.
   *   [0]    report ID (0x4B)
   *   [1]    opcode: 0x80 = GET, 0x01 = SET
   *   [2]    command ID (one byte)
   *   [3]    payload length N
   *   [4:4+N] payload, zero-padded to 64 bytes total.
   *
   * WebHID note: chrome splits report ID from data. sendReport(0x4B, b63)
   * puts [0x4B, ...b63] on the wire; a Python write of the 64-byte frame
   * including the 0x4B first byte is byte-identical on the wire.
   * ------------------------------------------------------------------ */

  const VID = 0x2D87;
  const PIDS = { 0x003B: 2, 0x003A: 1 };
  const REPORT_ID = 0x4B;
  const OP_GET = 0x80;
  const OP_SET = 0x01;

  const CMD_COMMIT = 0x01;
  const CMD_GAIN = 0x03;
  const CMD_PEQ_BAND = 0x09;
  const CMD_PEQ_APPLY = 0x0A;
  const CMD_FIRMWARE = 0x0C;
  const CMD_FILTER = 0x11;
  const CMD_EQ_PRESET = 0x1A;
  const CMD_UAC = 0x1E;
  const CMD_WORK_MODE = 0x21;
  const CMD_OUTPUT = 0x22;
  const CMD_VOLUME = 0x23;

  const GAIN = { 0: 'LOW', 1: 'HIGH' };
  const OUTPUT = { 0: 'PO', 1: 'LO' };
  const WORK_MODE = { 0: 'STD', 1: 'HYP' };
  const UAC = { 0: 'UAC1', 1: 'UAC2' };
  const USER_GEQ = 8;
  const USER_PEQ = 9;
  const GEQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const GEQ_Q = 0.71;
  const EQ_PRESET = { 0: 'OFF', [USER_GEQ]: 'Graphic', [USER_PEQ]: 'Parametric' };
  const DAC_FILTER = { 0: 'Minimum Phase', 1: 'Linear phase trace rapid roll-off' };

  // Exact 33-byte band query payload from the app capture (band index at [1]).
  const BAND_QUERY = new Uint8Array([
    0x09, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x7F,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x01,
  ]);

  const PEQ_FS = 96000;
  const PEQ_TYPE_IDS = { BYPASS: 0, LSHELF: 1, PEAK: 2, HSHELF: 3, LPF: 4, HPF: 5 };
  const PEQ_TYPE = {};
  for (const [name, id] of Object.entries(PEQ_TYPE_IDS)) PEQ_TYPE[id] = name;
  // Types 0/4/5 and the shelf/pass coefficient mapping are presumed from the
  // app UI order and the RBJ cookbook; only PEAK blobs are capture-verified.

  class TransportError extends Error {}

  function frame(opcode, command, payload = new Uint8Array()) {
    if (opcode !== OP_GET && opcode !== OP_SET) {
      throw new ValueErrorCheck('opcode must be 0x80 (GET) or 0x01 (SET)');
    }
    if (!Number.isInteger(command) || command < 0 || command > 0xFF) {
      throw new ValueErrorCheck('command must be a byte');
    }
    const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (p.length > 60) throw new ValueErrorCheck('payload exceeds 60 bytes');
    const packet = new Uint8Array(64);
    packet[0] = REPORT_ID; packet[1] = opcode; packet[2] = command; packet[3] = p.length;
    packet.set(p, 4);
    return packet;
  }

  // Python's round() is round-half-to-even; Math.round is half-up. Match
  // Python exactly so encodeBand is bit-identical to dac.py.
  function pyRound(x) {
    const f = Math.floor(x);
    const diff = x - f;
    if (diff < 0.5) return f;
    if (diff > 0.5) return f + 1;
    return (f % 2 === 0) ? f : f + 1;
  }

  function ValueErrorCheck(message) { const e = new Error(message); e.name = 'ValueError'; return e; }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function parseResponse(report, command) {
    const data = report instanceof Uint8Array ? report : new Uint8Array(report);
    if (data.length !== 64 || data[0] !== REPORT_ID || data[1] !== OP_GET) {
      throw ValueErrorCheck('not a RU3 GET response: ' + hex(data.slice(0, 8)));
    }
    if (data[2] !== command) {
      throw ValueErrorCheck(
        `response for 0x${data[2].toString(16).padStart(2, '0')}, ` +
        `expected 0x${command.toString(16).padStart(2, '0')}`);
    }
    return data.slice(4);
  }

  function hex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function bandQueryPayload(band, preset = USER_PEQ) {
    if (!Number.isInteger(band) || band < 0 || band > 9) {
      throw ValueErrorCheck('band must be 0..9');
    }
    if (preset !== USER_GEQ && preset !== USER_PEQ) {
      throw ValueErrorCheck('user preset must be 8 (GEQ) or 9 (PEQ)');
    }
    const query = new Uint8Array(BAND_QUERY);
    query[0] = preset; query[1] = band;
    return query;
  }

  function decodeBand(payload, preset = USER_PEQ) {
    const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (p.length < 33 || p[0] !== preset) {
      throw ValueErrorCheck(`not a band record for preset ${preset}`);
    }
    const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const gainRaw = view.getInt16(28, true);
    return {
      band: p[1],
      freq: view.getUint16(24, true),
      q: view.getUint16(26, true) / 256,
      gain_db: gainRaw / 256,
      type: p[30],
      type_name: PEQ_TYPE[p[30]] !== undefined ? PEQ_TYPE[p[30]] : null,
      enabled: p[32],
      coeffs_hex: hex(p.slice(4, 24)),
    };
  }

  function decodeCString(data) {
    const p = data instanceof Uint8Array ? data : new Uint8Array(data);
    let end = p.indexOf(0);
    if (end === -1) end = p.length;
    return new TextDecoder('ascii').decode(p.slice(0, end));
  }

  function rbjNormalized(filterType, freq, Q, gainDb, fs = PEQ_FS) {
    const A = Math.pow(10, gainDb / 40.0);
    const w = 2 * Math.PI * freq / fs;
    const c = Math.cos(w), s = Math.sin(w);
    const alpha = s / (2 * Q);
    let b0, b1, b2, a0, a1, a2;
    if (filterType === 'PEAK') {
      b0 = 1 + alpha * A; b1 = -2 * c; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * c; a2 = 1 - alpha / A;
    } else if (filterType === 'LSHELF' || filterType === 'HSHELF') {
      const sq = 2 * Math.sqrt(A) * alpha;
      if (filterType === 'LSHELF') {
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
    } else if (filterType === 'LPF' || filterType === 'HPF') {
      if (filterType === 'LPF') {
        b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2;
      } else {
        b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2;
      }
      a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
    } else {
      throw ValueErrorCheck(`unknown PEQ type ${JSON.stringify(filterType)}`);
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }

  function encodeBand(band, freq, Q, gainDb, filterType, preset = USER_PEQ) {
    if (!Number.isInteger(band) || band < 0 || band > 9) {
      throw ValueErrorCheck('band must be 0..9');
    }
    if (preset !== USER_GEQ && preset !== USER_PEQ) {
      throw ValueErrorCheck('user preset must be 8 (GEQ) or 9 (PEQ)');
    }
    if (!Number.isInteger(freq) || freq < 20 || freq > 20000) {
      throw ValueErrorCheck('freq must be an integer 20..20000');
    }
    if (typeof Q !== 'number' || !Number.isFinite(Q) || Q < 0.1 || Q > 10) {
      throw ValueErrorCheck('Q must be a number 0.1..10');
    }
    if (typeof gainDb !== 'number' || !Number.isFinite(gainDb) || gainDb < -12.0 || gainDb > 12.0) {
      throw ValueErrorCheck('gain_db must be a number -12..+12');
    }
    if (!(filterType in PEQ_TYPE_IDS)) {
      throw ValueErrorCheck(`unknown PEQ type ${JSON.stringify(filterType)}`);
    }
    let coeffs;
    if (filterType === 'BYPASS') coeffs = rbjNormalized('PEAK', freq, Q, 0.0);
    else if (filterType === 'LPF' || filterType === 'HPF') coeffs = rbjNormalized(filterType, freq, Q, 0.0);
    else coeffs = rbjNormalized(filterType, freq, Q, gainDb);
    const [b0n, b1n, b2n, a1n, a2n] = coeffs;
    const words = [b0n, b1n + 2, b2n, a1n + 2, a2n];
    const record = new Uint8Array(33);
    record[0] = preset; record[1] = band;
    const view = new DataView(record.buffer);
    words.forEach((value, i) => {
      let word = pyRound(value * 2 ** 31);
      if (word === 0x80000000) word = 0x7FFFFFFF; // app emits 7FFFFFFF for unity b0
      view.setUint32(4 + 4 * i, (word >>> 0), true);
    });
    view.setUint16(24, freq, true);
    view.setUint16(26, pyRound(Q * 256), true);
    view.setInt16(28, pyRound(gainDb * 256), true);
    record[30] = PEQ_TYPE_IDS[filterType];
    record[32] = 1;
    return record;
  }

  function label(table, value) {
    return Object.prototype.hasOwnProperty.call(table, value) ? table[value] : undefined;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* WebHID transport adapter: wraps the HIDDevice's sendReport /
   * inputreport events, reconstructing the 64-byte frame the Python
   * hidraw code reads/writes. Works with any object exposing
   * sendReport(id, Uint8Array) + addEventListener('inputreport', fn),
   * which is exactly the browser HIDDevice shape (and the test fake). */
  class Controller {
    constructor(device, opts = {}) {
      this.device = device;
      this.timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 1000;
      this.transactions = [];
      this._inbox = [];
      this._onInput = (event) => this._receive(event);
      device.addEventListener('inputreport', this._onInput);
      this.closed = false;
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.device && typeof this.device.removeEventListener === 'function') {
        this.device.removeEventListener('inputreport', this._onInput);
      }
    }

    _receive(event) {
      // event: {reportId, data: DataView}. Chrome strips the report ID from
      // `data`, so data is 63 bytes; prepend 0x4B to rebuild the frame.
      // Tolerate a 64-byte data that already includes the report ID.
      const data = event.data;
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      let frame;
      if (bytes.length === 64 && bytes[0] === REPORT_ID) {
        frame = new Uint8Array(bytes);
      } else {
        frame = new Uint8Array(1 + bytes.length);
        frame[0] = event.reportId !== undefined ? event.reportId : REPORT_ID;
        frame.set(bytes, 1);
      }
      this._inbox.push(frame);
      if (this._inbox.length > 64) this._inbox.shift();
    }

    _drain() {
      const stale = this._inbox.map((f) => hex(f));
      this._inbox.length = 0;
      return stale;
    }

    async _write(packet) {
      // sendReport(reportId, dataWithoutReportId)
      await this.device.sendReport(REPORT_ID, packet.slice(1));
    }

    async get(command, payload = new Uint8Array(), timeoutMs) {
      const record = {
        op: 'GET', command: '0x' + command.toString(16).padStart(2, '0'),
        stale_reports: this._drain(), stray: [],
      };
      this.transactions.push(record);
      const packet = frame(OP_GET, command, payload);
      record.tx_hex = hex(packet);
      await this._write(packet);
      const deadline = Date.now() + (timeoutMs !== undefined ? timeoutMs : this.timeoutMs);
      for (;;) {
        const idx = this._inbox.findIndex(
          (f) => f.length === 64 && f[0] === REPORT_ID && f[1] === OP_GET && f[2] === command);
        if (idx !== -1) {
          const raw = this._inbox.splice(idx, 1)[0];
          record.rx_hex = hex(raw);
          record.status = 'ok';
          return raw.slice(4);
        }
        if (Date.now() >= deadline) break;
        await sleep(20);
      }
      record.status = 'no_response';
      throw new TransportError(`no response to GET 0x${command.toString(16).padStart(2, '0')}`);
    }

    async set(command, payload = new Uint8Array()) {
      const record = {
        op: 'SET', command: '0x' + command.toString(16).padStart(2, '0'),
        stale_reports: this._drain(),
      };
      this.transactions.push(record);
      const packet = frame(OP_SET, command, payload);
      record.tx_hex = hex(packet);
      await this._write(packet);
      record.status = 'sent_no_ack_expected';
    }

    async getU8(command) { return (await this.get(command))[0]; }

    async setU8(command, value) {
      if (!Number.isInteger(value) || value < 0 || value > 0xFF) {
        throw ValueErrorCheck('value must be a byte');
      }
      await this.set(command, new Uint8Array([value]));
    }

    async commit() { await this.set(CMD_COMMIT); }

    async readState() {
      const state = {};
      const errors = {};
      const query = async (name, command, table, rawHex) => {
        try {
          const data = await this.get(command);
          const value = data[0];
          state[name] = value;
          if (table) state[name + '_label'] = label(table, value);
          if (rawHex) state[name + '_hex'] = hex(data.slice(0, 8));
        } catch (exc) {
          state[name] = null;
          errors[name] = String(exc && exc.message ? exc.message : exc);
        }
      };
      await query('volume', CMD_VOLUME);
      await query('gain', CMD_GAIN, GAIN);
      await query('output', CMD_OUTPUT, OUTPUT);
      await query('work_mode', CMD_WORK_MODE, WORK_MODE);
      await query('eq', CMD_EQ_PRESET, EQ_PRESET);
      await query('uac', CMD_UAC, UAC);
      await query('filter', CMD_FILTER, DAC_FILTER);
      for (const [name, command] of [['unknown_16', 0x16], ['unknown_1f', 0x1F],
                                     ['unknown_20', 0x20], ['unknown_24', 0x24]]) {
        await query(name, command, null, true);
      }
      try {
        state['firmware'] = decodeCString(await this.get(CMD_FIRMWARE));
      } catch (exc) {
        state['firmware'] = null;
        errors['firmware'] = String(exc && exc.message ? exc.message : exc);
      }
      state['settings_status'] = Object.keys(errors).length === 0 ? 'verified' : 'partial';
      if (Object.keys(errors).length) state['errors'] = errors;
      return state;
    }

    async setVolume(value) {
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        throw ValueErrorCheck('Volume must be an integer from 0 to 100');
      }
      await this.setU8(CMD_VOLUME, value);
      try {
        const readback = await this.getU8(CMD_VOLUME);
        return { requested_volume: value, readback, verified: readback === value };
      } catch (exc) {
        return { requested_volume: value, readback: null, verified: false,
                 error: String(exc && exc.message ? exc.message : exc) };
      }
    }

    async getBand(band) {
      return decodeBand((await this.get(CMD_PEQ_BAND, bandQueryPayload(band))).slice(0, 33));
    }

    async getPeq() {
      const bands = [];
      for (let i = 0; i < 10; i++) bands.push(await this.getBand(i));
      return bands;
    }

    async getGeq() {
      const bands = [];
      for (let i = 0; i < GEQ_FREQS.length; i++) {
        const back = (await this.get(CMD_PEQ_BAND, bandQueryPayload(i, USER_GEQ))).slice(0, 33);
        let band;
        try {
          band = decodeBand(back, USER_GEQ);
        } catch (exc) {
          throw new TransportError('invalid GEQ reply: ' + (exc && exc.message ? exc.message : exc));
        }
        if (band.band !== i) {
          throw new TransportError(`GEQ reply for wrong band: ${band.band}`);
        }
        bands.push(band);
      }
      return { preset: USER_GEQ, frequencies: [...GEQ_FREQS], q: GEQ_Q, bands };
    }

    async setGeq(gains, maxPasses = 3) {
      if (!Array.isArray(gains) || gains.length !== GEQ_FREQS.length) {
        throw ValueErrorCheck('GEQ needs exactly 10 gains');
      }
      const records = gains.map((g, i) => encodeBand(i, GEQ_FREQS[i], GEQ_Q, g, 'PEAK', USER_GEQ));
      let pending = records.map((_, i) => i);
      const results = {};
      for (let pass = 0; pass < Math.max(1, maxPasses); pass++) {
        for (const i of pending) {
          await this.set(CMD_PEQ_BAND, records[i]);
          await sleep(25);
        }
        await this.set(CMD_PEQ_APPLY, new Uint8Array([USER_GEQ, 0, 0, 0]));
        await this.commit();
        await sleep(150);
        for (const i of pending) {
          try {
            const back = (await this.get(CMD_PEQ_BAND, bandQueryPayload(i, USER_GEQ))).slice(0, 33);
            results[i] = { band: i, verified: bytesEqual(back, records[i]) };
          } catch (exc) {
            results[i] = { band: i, verified: false,
                           error: String(exc && exc.message ? exc.message : exc) };
          }
        }
        pending = pending.filter((i) => !results[i].verified);
        if (!pending.length) break;
      }
      return records.map((_, i) => results[i]);
    }

    async setBand(band, freq, Q, gainDb, filterType) {
      await this.set(CMD_PEQ_BAND, encodeBand(band, freq, Q, gainDb, filterType));
    }

    async setPeq(bands) {
      if (!Array.isArray(bands) || bands.length !== 10) {
        throw ValueErrorCheck('set_peq needs a list of exactly 10 bands');
      }
      const records = bands.map((b, i) => encodeBand(i, b.freq, b.q, b.gain, b.type));
      for (const record of records) {
        await this.set(CMD_PEQ_BAND, record);
        await sleep(25); // device drops back-to-back writes
      }
      await this.set(CMD_PEQ_APPLY, new Uint8Array([0x09, 0x00, 0x00, 0x00]));
      await sleep(25);
      await this.commit();
      await sleep(150);
      const result = [];
      for (let i = 0; i < records.length; i++) {
        try {
          const back = (await this.get(CMD_PEQ_BAND, bandQueryPayload(i))).slice(0, 33);
          result.push({
            band: i,
            verified: bytesEqual(back, records[i]),
            match_bytes: back.reduce((n, v, k) => n + (v === records[i][k] ? 1 : 0), 0),
          });
        } catch (exc) {
          result.push({ band: i, verified: false,
                        error: String(exc && exc.message ? exc.message : exc) });
        }
      }
      return result;
    }
  }

  function requestDeviceFilters() {
    return Object.keys(PIDS).map((pid) => ({ vendorId: VID, productId: Number(pid) }));
  }

  function pickDevice(devices) {
    return devices.find((d) => d.vendorId === VID && Object.prototype.hasOwnProperty.call(PIDS, d.productId)) || null;
  }

  return {
    VID, PIDS, REPORT_ID, OP_GET, OP_SET,
    CMD_COMMIT, CMD_GAIN, CMD_PEQ_BAND, CMD_PEQ_APPLY, CMD_FIRMWARE, CMD_FILTER,
    CMD_EQ_PRESET, CMD_UAC, CMD_WORK_MODE, CMD_OUTPUT, CMD_VOLUME,
    GAIN, OUTPUT, WORK_MODE, UAC, USER_GEQ, USER_PEQ, GEQ_FREQS, GEQ_Q,
    EQ_PRESET, DAC_FILTER, BAND_QUERY, PEQ_FS, PEQ_TYPE_IDS, PEQ_TYPE,
    TransportError, frame, parseResponse, bandQueryPayload, decodeBand,
    decodeCString, rbjNormalized, encodeBand, bytesEqual, hex, pyRound,
    Controller, sleep, requestDeviceFilters, pickDevice,
  };
});

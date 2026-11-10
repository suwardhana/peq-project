const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const calls = [];
const device = {
  vendorId: 1, productId: 2, productName: 'Test DAC', opened: false,
  async open() { this.opened = true; },
  async close() { this.opened = false; },
};
class Controller {
  constructor(d) { this.device = d; }
  close() {}
  async readState() { return { volume: 50, eq: 9 }; }
  async getPeq() { return [{ band: 0 }]; }
  async getGeq() { return { bands: [], frequencies: [] }; }
  async setVolume(value) { return { readback: value, verified: true }; }
  async setPeq(bands) { calls.push('peq'); return bands.map(() => ({ verified: true })); }
  async setGeq(gains) { return gains.map(() => ({ verified: true })); }
  async setU8(command, value) { calls.push(['set', command, value]); }
  async commit() { calls.push('commit'); }
  async getU8(command) { calls.push(['get', command]); return 9; }
}
const hid = {
  async requestDevice() { calls.push('chooser'); return [device]; },
  async getDevices() { return [device]; },
  addEventListener() {},
};
const context = {
  navigator: { hid }, RU3: {
    Controller, CMD_GAIN: 3, CMD_OUTPUT: 34, CMD_WORK_MODE: 33,
    CMD_EQ_PRESET: 26, CMD_UAC: 30, CMD_FILTER: 17,
    requestDeviceFilters: () => [], pickDevice: (devices) => devices[0],
    sleep: async () => {},
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../device-api.js'), 'utf8'), context);

(async () => {
  const api = context.RU3DeviceAPI;
  await api.chooseDevice();
  assert.equal(calls[0], 'chooser');
  assert.equal((await api.request('GET', '/api/state')).product, 'Test DAC');
  assert.equal((await api.request('GET', '/api/peq')).bands.length, 1);
  const result = await api.request('POST', '/api/setting', { key: 'eq', value: 9 });
  assert.equal(result.verified, true);
  assert.deepEqual(calls.slice(1), [['set', 26, 9], 'commit', ['get', 26]]);
  await api.request('POST', '/api/setting', { key: 'uac', value: 1 });
  assert.equal(device.opened, false);
  assert.equal((await api.request('GET', '/api/state')).volume, 50);
  await assert.rejects(api.request('GET', '/api/missing'), /Unknown request/);
  assert.equal((await api.request('POST', '/api/volume', { value: 30 })).readback, 30);
  console.log('device API tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

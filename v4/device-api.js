(function (root) {
  'use strict';

  let session = null;
  let queue = Promise.resolve();
  const commands = {
    gain: RU3.CMD_GAIN, output: RU3.CMD_OUTPUT,
    work_mode: RU3.CMD_WORK_MODE, eq: RU3.CMD_EQ_PRESET,
    uac: RU3.CMD_UAC, filter: RU3.CMD_FILTER,
  };

  async function closeSession() {
    const old = session;
    session = null;
    if (!old) return;
    old.controller.close();
    if (old.device.opened) await old.device.close().catch(() => {});
  }

  async function openDevice(device) {
    if (session && session.device === device && device.opened) return session;
    await closeSession();
    if (!device.opened) await device.open();
    session = { device, controller: new RU3.Controller(device) };
    return session;
  }

  async function chooseDevice() {
    if (!navigator.hid) throw new Error('WebHID is not available in this browser.');
    // Invoke the chooser directly from the click handler, before awaiting.
    const devices = await navigator.hid.requestDevice({ filters: RU3.requestDeviceFilters() });
    const device = RU3.pickDevice(devices);
    if (!device) throw new Error('No Cayin RU3 selected.');
    const result = queue.then(() => openDevice(device));
    queue = result.catch(() => {});
    return result;
  }

  async function getSession() {
    if (session && session.device.opened) return session;
    if (!navigator.hid) throw new Error('WebHID is not available in this browser.');
    const device = RU3.pickDevice(await navigator.hid.getDevices());
    if (!device) throw new Error('Select Connect DAC to authorize the device.');
    return openDevice(device);
  }

  async function execute(method, path, body) {
    const { device, controller } = await getSession();
    if (method === 'GET' && path === '/api/state') {
      const state = await controller.readState();
      if (state.volume == null) throw new Error('Unable to read the DAC.');
      return { ...state, product: device.productName || 'Cayin RU3' };
    }
    if (method === 'GET' && path === '/api/peq') return { bands: await controller.getPeq() };
    if (method === 'GET' && path === '/api/geq') return controller.getGeq();
    if (method === 'POST' && path === '/api/volume') return controller.setVolume(body.value);
    if (method === 'POST' && path === '/api/peq') return { bands: await controller.setPeq(body.bands) };
    if (method === 'POST' && path === '/api/geq') return { bands: await controller.setGeq(body.gains) };
    if (method === 'POST' && path === '/api/setting') {
      const command = commands[body.key];
      if (command === undefined) throw new Error('Unknown setting.');
      await controller.setU8(command, body.value);
      if (body.key === 'uac') {
        await closeSession();
        return { key: body.key, sent: true, reconnecting: true };
      }
      if (body.key === 'eq') {
        await RU3.sleep(25);
        await controller.commit();
      }
      await RU3.sleep(50);
      const readback = await controller.getU8(command);
      return { key: body.key, readback, verified: readback === body.value };
    }
    throw new Error(`Unknown request: ${method} ${path}`);
  }

  function request(method, path, body) {
    const result = queue.then(() => execute(method, path, body));
    queue = result.catch(() => {});
    return result;
  }

  if (navigator.hid) {
    navigator.hid.addEventListener('disconnect', (event) => {
      if (session && session.device === event.device) {
        session.controller.close();
        session = null;
        root.dispatchEvent(new Event('ru3-disconnect'));
      }
    });
  }
  root.RU3DeviceAPI = { request, chooseDevice };
})(globalThis);

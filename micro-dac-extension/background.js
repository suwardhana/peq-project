'use strict';

importScripts('micro.js');

const APPLY_MESSAGE = 'MICRO_APPLY_PEQ';
const APP_URL = chrome.runtime.getURL('app.html');

/* Toolbar button: open the PEQ editor (focus it if already open). */
chrome.action.onClicked.addListener(async () => {
  const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = open.find((client) => client.url === APP_URL);
  if (existing) {
    await existing.focus();
    return;
  }
  await chrome.tabs.create({ url: APP_URL });
});

/* Apply from the squig.link / hangout page. WebHID access is granted once in
   the editor page (same extension origin) and reused here. */
async function applyPeq(bands, pregain) {
  const device = await MicroDevice.findDevice();
  if (!device) {
    return {
      ok: false,
      error: 'DAC not authorised yet. Click the extension icon and press Connect once.'
    };
  }
  let controller;
  try {
    controller = await MicroDevice.openController(device);
    const payload = await controller.setPeq(
      bands, typeof pregain === 'number' ? pregain : null
    );
    const verifiedCount = payload.bands.filter((band) => band.verified).length;
    return {
      ok: verifiedCount === payload.bands.length,
      error: verifiedCount === payload.bands.length ? undefined : 'Read-back mismatch.',
      bands: payload.bands,
      verifiedCount,
      totalCount: payload.bands.length,
      pregain: payload.pregain
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (controller) {
      controller.close();
      await device.close().catch(() => {});
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== APPLY_MESSAGE) return false;
  if (!Array.isArray(message.bands) || message.bands.length !== 8) {
    sendResponse({ ok: false, error: 'Expected exactly 8 PEQ bands.' });
    return false;
  }
  applyPeq(message.bands, message.pregain).then(sendResponse);
  return true;
});

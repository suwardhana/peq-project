const controlPage = chrome.runtime.getURL('index.html');
let controlPort = null;
let nextRequestId = 0;
const pending = new Map();

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ru3-control' || port.sender?.url !== controlPage) return;
  controlPort = port;
  port.onMessage.addListener((message) => {
    const request = pending.get(message.id);
    if (!request || request.port !== port) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    request.respond(message.result);
  });
  port.onDisconnect.addListener(() => {
    if (controlPort === port) controlPort = null;
    for (const [id, request] of pending) {
      if (request.port !== port) continue;
      clearTimeout(request.timer);
      pending.delete(id);
      request.respond({ ok: false, error: 'Control page closed during the transfer. Check the DAC before retrying.' });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'RU3_APPLY_PEQ') return false;
  let origin;
  try { origin = new URL(sender.url); } catch { return false; }
  if (origin.protocol !== 'https:' || !(origin.hostname === 'squig.link' || origin.hostname.endsWith('.squig.link'))) return false;
  if (!Array.isArray(message.bands) || message.bands.length !== 10) {
    respond({ ok: false, error: 'Expected exactly 10 PEQ bands.' });
    return false;
  }
  if (!controlPort) {
    chrome.tabs.create({ url: controlPage });
    respond({ ok: false, error: 'The RU3 control page has opened. Connect the DAC there, then click Apply again.' });
    return false;
  }
  const id = ++nextRequestId;
  const port = controlPort;
  const timer = setTimeout(() => {
    pending.delete(id);
    respond({ ok: false, error: 'Transfer timed out. Check the DAC before retrying.' });
  }, 60000);
  pending.set(id, { respond, timer, port });
  try {
    port.postMessage({ type: 'RU3_APPLY_PEQ', id, bands: message.bands });
  } catch (error) {
    clearTimeout(timer);
    pending.delete(id);
    respond({ ok: false, error: 'Control page unavailable. Open it and try again.' });
  }
  return true;
});

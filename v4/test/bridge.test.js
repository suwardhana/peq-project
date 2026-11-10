const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...args) { return listeners.map((fn) => fn(...args)); } };
}

test('Squiglink requests are routed to the control page and verified results returned', () => {
  const onMessage = event(), onConnect = event(), onClicked = event();
  const opened = [];
  const chrome = {
    runtime: { onMessage, onConnect, getURL: (p) => `chrome-extension://test/${p}` },
    action: { onClicked },
    tabs: { create: (tab) => opened.push(tab) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'),
    { chrome, URL, setTimeout, clearTimeout, Map });
  const sender = { url: 'https://example.squig.link/' };
  const bands = Array.from({ length: 10 }, () => ({}));
  let response;
  onMessage.emit({ type: 'RU3_APPLY_PEQ', bands }, sender, (value) => { response = value; });
  assert.equal(opened.length, 1);
  assert.match(response.error, /Connect the DAC/);

  const sent = [];
  const port = {
    name: 'ru3-control', sender: { url: 'chrome-extension://test/index.html' },
    onMessage: event(), onDisconnect: event(), postMessage: (value) => sent.push(value),
  };
  onConnect.emit(port);
  response = null;
  assert.equal(onMessage.emit({ type: 'RU3_APPLY_PEQ', bands }, sender, (value) => { response = value; })[0], true);
  assert.equal(sent.length, 1);
  port.onMessage.emit({ id: sent[0].id, result: { ok: true, verifiedCount: 10 } });
  assert.equal(response.ok, true);
  assert.equal(response.verifiedCount, 10);

  response = null;
  onMessage.emit({ type: 'RU3_APPLY_PEQ', bands }, { url: 'https://evil.example/' }, (value) => { response = value; });
  assert.equal(response, null);
  assert.equal(sent.length, 1);
});

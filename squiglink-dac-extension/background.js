'use strict';

const API_URL = 'http://127.0.0.1:8765/api/peq';
const APPLY_MESSAGE = 'RU3_APPLY_PEQ';
const REQUEST_TIMEOUT_MS = 25000;

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function applyPeq(bands) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bands }),
      signal: controller.signal
    });
    const body = await readJson(response);
    const results = Array.isArray(body.bands) ? body.bands : null;
    const verifiedCount = results
      ? results.filter((band) => band.verified).length
      : null;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: body.error || `DAC backend returned HTTP ${response.status}.`,
        bands: results,
        verifiedCount
      };
    }

    return {
      ok: true,
      bands: results,
      verifiedCount,
      totalCount: results ? results.length : 10
    };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return {
        ok: false,
        error: 'Timed out waiting for the DAC backend.'
      };
    }
    return {
      ok: false,
      error: 'Backend not reachable. Start it with run-v2.bat first.'
    };
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== APPLY_MESSAGE) return false;
  if (!Array.isArray(message.bands) || message.bands.length !== 10) {
    sendResponse({ ok: false, error: 'Expected exactly 10 PEQ bands.' });
    return false;
  }

  applyPeq(message.bands)
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
  return true;
});

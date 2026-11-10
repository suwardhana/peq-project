'use strict';

const API_URL = 'http://127.0.0.1:8766/api/peq';
const APPLY_MESSAGE = 'MICRO_APPLY_PEQ';
const REQUEST_TIMEOUT_MS = 30000;

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function applyPeq(bands, pregain) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const body = { bands };
  if (typeof pregain === 'number') body.pregain = pregain;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await readJson(response);
    const results = Array.isArray(payload.bands) ? payload.bands : null;
    const verifiedCount = results
      ? results.filter((band) => band.verified).length
      : null;
    const pregainResult = payload.pregain || null;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload.error
          || `DAC backend returned HTTP ${response.status}.`,
        bands: results,
        verifiedCount,
        pregain: pregainResult
      };
    }

    return {
      ok: true,
      bands: results,
      verifiedCount,
      totalCount: results ? results.length : bands.length,
      pregain: pregainResult
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
      error: 'Backend not reachable. Start the v3 server first.'
    };
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== APPLY_MESSAGE) return false;
  if (!Array.isArray(message.bands) || message.bands.length !== 8) {
    sendResponse({ ok: false, error: 'Expected exactly 8 PEQ bands.' });
    return false;
  }

  applyPeq(message.bands, message.pregain)
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
  return true;
});

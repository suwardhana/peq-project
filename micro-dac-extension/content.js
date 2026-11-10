(function () {
  'use strict';

  const core = globalThis.MicroPeqCore;
  if (!core) {
    console.error('[Micro] PEQ core failed to load.');
    return;
  }

  const APPLY_MESSAGE = 'MICRO_APPLY_PEQ';
  const PANEL_ATTRIBUTE = 'data-micro-dac-panel';
  const ROW_SELECTOR = '.filter';
  let installQueued = false;

  /* ---- page scraping ------------------------------------------------- */

  /* The page has one band list (hangout: .filters-container, squig: the
     container of the .filter rows).  Everything else is read from there. */
  function rowsRoot() {
    const container = document.querySelector('.filters-container');
    if (container && container.querySelector('input[name="freq"]')) {
      return container;
    }
    const first = document.querySelector('input[name="freq"]');
    const row = first && first.closest(ROW_SELECTOR);
    return (row && row.parentElement) || document;
  }

  function findRowElements(root) {
    const withFreq = Array.from(root.querySelectorAll('input[name="freq"]'))
      .map((input) => input.closest(ROW_SELECTOR))
      .filter(Boolean);
    if (withFreq.length) return withFreq;
    return Array.from(root.querySelectorAll(ROW_SELECTOR));
  }

  function readRows() {
    return findRowElements(rowsRoot()).map((row, index) => {
      const enabled = row.querySelector('input[name="enabled"]');
      const type = row.querySelector('select[name="type"]');
      const freq = row.querySelector('input[name="freq"]');
      const gain = row.querySelector('input[name="gain"]');
      const q = row.querySelector('input[name="q"]');

      return {
        enabled: enabled ? enabled.checked : true,
        type: type ? type.value : 'PK',
        freq: freq ? freq.value : '',
        gain: gain ? gain.value : '',
        q: q ? q.value : '',
        rowNumber: index + 1
      };
    });
  }

  /* The site prints the preamp as "Pre-amp: -3.2 dB" in a heading. */
  function readPagePregain() {
    const nodes = document.querySelectorAll(
      '.preamp-disp, [class*="preamp"], [id*="preamp"]'
    );
    for (const node of nodes) {
      const value = core.readPreamp(node.textContent);
      if (value !== null) return value;
    }
    return null;
  }

  /* Untick the bands that shape the curve least, until the rest fits. */
  function trimWeakest() {
    const dropped = core.rowsToDrop(readRows(), core.BAND_COUNT);
    if (!dropped.length) return [];
    const rows = findRowElements(rowsRoot());
    for (const rowNumber of dropped) {
      const row = rows[rowNumber - 1];
      const checkbox = row && row.querySelector('input[name="enabled"]');
      if (!checkbox) continue;
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('input', { bubbles: true }));
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return dropped;
  }

  /* Preamp. eq.hangout.audio prints it ("Pre-amp: -3.2 dB"); squig.link only
     writes it into the export file, so there it is derived from the curve —
     the same "highest point of the summed response" squig's export uses. */
  function resolvePregain(bands) {
    const fromPage = readPagePregain();
    if (fromPage !== null) {
      return { db: fromPage, exact: fromPage, source: 'page' };
    }
    let curve = bands;
    if (!curve) {
      try {
        curve = core.buildDeviceBands(readRows()).bands;
      } catch {
        return { db: null, exact: null, source: null };
      }
    }
    const exact = core.computePreamp(curve);
    return { db: core.clampPregain(exact), exact, source: 'curve' };
  }

  /* Anchor the panel where it stays visible in every tab: the page's own
     "Device PEQ" block when there is one, else right under the band rows. */
  function findAnchor() {
    const deviceEq = document.querySelector('#deviceEqArea, .device-eq');
    if (deviceEq) return deviceEq;
    const rows = findRowElements(rowsRoot());
    return rows.length ? rows[0].parentElement : null;
  }

  /* ---- panel --------------------------------------------------------- */

  function setStatus(status, text, tone, detail) {
    status.dataset.visible = 'true';
    status.dataset.tone = tone || 'neutral';
    status.textContent = text;
    if (detail) status.title = detail;
    else status.removeAttribute('title');
  }

  function setBusy(button, busy) {
    button.disabled = busy;
    button.dataset.busy = busy ? 'true' : 'false';
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function sendApplyMessage(bands, pregain) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: APPLY_MESSAGE, bands, pregain },
        (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(response);
        }
      );
    });
  }

  function updatePanelState(panel) {
    const button = panel.querySelector('.micro-dac-apply');
    const count = panel.querySelector('.micro-dac-count');
    const pre = panel.querySelector('.micro-dac-pre');
    if (!button || !count) return;

    const activeCount = core.countActiveRows(readRows());
    const tooMany = activeCount > core.BAND_COUNT;
    const busy = button.dataset.busy === 'true';

    count.textContent = `${activeCount}/${core.BAND_COUNT}`;
    count.dataset.invalid = tooMany ? 'true' : 'false';

    const trim = panel.querySelector('.micro-dac-trim');
    const overflow = activeCount - core.BAND_COUNT;
    if (trim) {
      if (overflow > 0) {
        const weakest = core.rowsToDrop(readRows(), core.BAND_COUNT);
        trim.dataset.visible = 'true';
        trim.textContent = `Uncheck ${overflow} weakest`;
        trim.title = `Unticks band ${weakest.join(', ')} — the smallest `
          + 'absolute gain, so the curve barely changes.';
      } else {
        trim.dataset.visible = 'false';
        trim.removeAttribute('title');
      }
    }

    const pregain = resolvePregain();
    if (pre) {
      if (pregain.db === null) {
        pre.textContent = 'pregain –';
        pre.removeAttribute('title');
      } else if (pregain.source === 'curve') {
        pre.textContent = `pregain ${pregain.db} dB (auto)`;
        pre.title = `Derived from the filter curve: ${pregain.exact} dB `
          + '(the DAC takes whole dB)';
      } else {
        pre.textContent = `pregain ${pregain.db} dB`;
        pre.title = 'Read from the page';
      }
    }

    panel.dataset.state = activeCount === 0
      ? 'empty'
      : tooMany
        ? 'invalid'
        : 'ready';

    button.disabled = busy || activeCount === 0 || tooMany;
    button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
    button.title = activeCount === 0
      ? 'No EQ bands yet. Run AutoEQ or enter filter values first.'
      : tooMany
        ? `${activeCount} bands are on. This DAC holds ${core.BAND_COUNT}.`
        : 'Write the current EQ to the CrinEar Protocol Micro.';
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.className = 'micro-dac-panel';
    panel.setAttribute(PANEL_ATTRIBUTE, '');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'micro-dac-apply';
    button.innerHTML = `
      <span class="micro-dac-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
          <path d="M4 15V9M8 18V6M12 16V8M16 14V10M20 12.5V11.5"
                stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </span>
      <span class="micro-dac-label">Apply PEQ to Protocol Micro</span>
      <span class="micro-dac-count">0/8</span>
    `;

    const meta = document.createElement('div');
    meta.className = 'micro-dac-meta';

    /* Shown only when the page has more bands ticked than the DAC holds:
       unticks the least audible ones so the rest fits. */
    const trim = document.createElement('button');
    trim.type = 'button';
    trim.className = 'micro-dac-trim';
    trim.dataset.visible = 'false';

    const pre = document.createElement('span');
    pre.className = 'micro-dac-pre';
    pre.textContent = 'pregain –';

    meta.append(trim, pre);

    const status = document.createElement('div');
    status.className = 'micro-dac-status';
    status.dataset.visible = 'false';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    trim.addEventListener('click', () => {
      const dropped = trimWeakest();
      setStatus(
        status,
        dropped.length
          ? `Unchecked ${dropped.length} band(s) with the smallest gain: `
            + `${dropped.join(', ')}. Now ${core.BAND_COUNT}/${core.BAND_COUNT}.`
          : 'Could not find the band checkboxes on this page.',
        dropped.length ? 'neutral' : 'error'
      );
      updatePanelState(panel);
    });

    button.addEventListener('click', async () => {
      let prepared;
      try {
        const pregain = resolvePregain();
        prepared = core.buildDeviceBands(readRows(), { pregain: pregain.db });
        prepared.pregainExact = pregain.exact;
      } catch (error) {
        setStatus(status, error.message, 'error');
        return;
      }

      setBusy(button, true);
      const clampNote = prepared.warnings.length
        ? ` ${prepared.warnings.length} value(s) will be clamped.`
        : '';
      const pregainNote = prepared.pregain === null
        ? ''
        : ` Pregain ${prepared.pregain} dB`
          + (prepared.pregainExact !== null
            && prepared.pregainExact !== prepared.pregain
            ? ` (curve ${prepared.pregainExact} dB).` : '.');
      setStatus(
        status,
        `Sending ${prepared.activeCount} band(s) to the DAC…${pregainNote}${clampNote}`,
        'pending',
        prepared.warnings.join('\n')
      );

      try {
        const response = await sendApplyMessage(
          prepared.bands, prepared.pregain
        );
        if (response && response.ok) {
          const verified = response.verifiedCount ?? prepared.bands.length;
          const warningNote = prepared.warnings.length
            ? ` ${prepared.warnings.length} value(s) clamped — `
              + prepared.warnings[0].replace(/^Band (\d+): /, 'band $1: ')
            : '';
          setStatus(
            status,
            `Applied and verified: ${verified}/${core.BAND_COUNT} bands.${warningNote}`,
            prepared.warnings.length ? 'warning' : 'success',
            prepared.warnings.join('\n')
          );
          return;
        }

        if (response && Array.isArray(response.bands)) {
          const failed = response.bands
            .filter((band) => !band.verified)
            .map((band) => band.band + 1);
          setStatus(
            status,
            `DAC read-back failed for band ${failed.join(', ') || 'unknown'}.`,
            'error',
            response.error || ''
          );
          return;
        }

        setStatus(
          status,
          (response && response.error)
            || 'Could not apply PEQ. Is the DAC connected?',
          'error'
        );
      } catch (error) {
        setStatus(
          status,
          error instanceof Error ? error.message : String(error),
          'error'
        );
      } finally {
        setBusy(button, false);
        updatePanelState(panel);
      }
    });

    panel.append(button, meta, status);
    updatePanelState(panel);
    return panel;
  }

  /* One panel instance for the whole page. The site re-renders its own
     button panel now and then, so re-attach instead of rebuilding — that
     keeps the last status message on screen. */
  let panelEl = null;

  function installPanel() {
    const anchor = findAnchor();
    if (!anchor) return;

    if (!panelEl) panelEl = createPanel();
    if (panelEl.previousElementSibling !== anchor) {
      anchor.insertAdjacentElement('afterend', panelEl);
    }
    updatePanelState(panelEl);
  }

  function scheduleInstall() {
    if (installQueued) return;
    installQueued = true;
    requestAnimationFrame(() => {
      installQueued = false;
      installPanel();
    });
  }

  const observer = new MutationObserver(scheduleInstall);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  document.addEventListener('input', scheduleInstall, true);
  document.addEventListener('change', scheduleInstall, true);
  window.addEventListener('popstate', scheduleInstall);
  window.addEventListener('hashchange', scheduleInstall);

  installPanel();
})();

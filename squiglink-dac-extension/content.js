(function () {
  'use strict';

  const core = globalThis.RU3PeqCore;
  if (!core) {
    console.error('[RU3] PEQ core failed to load.');
    return;
  }

  const APPLY_MESSAGE = 'RU3_APPLY_PEQ';
  const PANEL_ATTRIBUTE = 'data-ru3-dac-panel';
  let installQueued = false;

  function findRows(root) {
    return Array.from(root.querySelectorAll('.filter'));
  }

  function readRows(root) {
    return findRows(root).map((row, index) => {
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

  function findInsertTarget(root) {
    const importButton = root.querySelector('.import-filters');
    if (importButton) return importButton.closest('.filters-button');

    const groups = Array.from(root.querySelectorAll('.filters-button'));
    return groups.find((group) =>
      /AutoEQ|Import|Export/i.test(group.textContent || '')
    ) || root.querySelector('.filters');
  }

  function setStatus(status, text, tone, detail) {
    status.hidden = false;
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

  function sendApplyMessage(bands) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: APPLY_MESSAGE, bands },
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

  function updatePanelState(root, panel) {
    const button = panel.querySelector('.ru3-dac-apply');
    const count = panel.querySelector('.ru3-dac-count');
    if (!button || !count) return;

    const activeCount = core.countActiveRows(readRows(root));
    const tooMany = activeCount > 10;
    const busy = button.dataset.busy === 'true';

    count.textContent = `${activeCount}/10`;
    count.dataset.invalid = tooMany ? 'true' : 'false';
    panel.dataset.state = activeCount === 0
      ? 'empty'
      : tooMany
        ? 'invalid'
        : 'ready';

    button.disabled = busy || activeCount === 0 || tooMany;
    button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
    button.title = activeCount === 0
      ? 'No PEQ values yet. Run Auto EQ or enter filter values first.'
      : tooMany
        ? `${activeCount} bands are enabled. Uncheck bands until only 10 remain.`
        : 'Apply the current 10-band PEQ to the Cayin RU3.';
  }

  function createPanel(root) {
    const panel = document.createElement('div');
    panel.className = 'ru3-dac-panel';
    panel.setAttribute(PANEL_ATTRIBUTE, '');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ru3-dac-apply';
    button.innerHTML = `
      <span class="ru3-dac-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
          <path d="M5 16.5V7.5M9.5 19V5M14.5 16V8M19 13V11"
                stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <circle cx="5" cy="12" r="1.7" fill="currentColor"/>
          <circle cx="9.5" cy="9.5" r="1.7" fill="currentColor"/>
          <circle cx="14.5" cy="12" r="1.7" fill="currentColor"/>
          <circle cx="19" cy="12" r="1.7" fill="currentColor"/>
        </svg>
      </span>
      <span class="ru3-dac-label">Apply PEQ to DAC</span>
      <span class="ru3-dac-count">0/10</span>
    `;

    const status = document.createElement('div');
    status.className = 'ru3-dac-status';
    status.hidden = true;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const count = button.querySelector('.ru3-dac-count');

    button.addEventListener('click', async () => {
      let prepared;
      try {
        prepared = core.buildDeviceBands(readRows(root));
      } catch (error) {
        setStatus(status, error.message, 'error');
        return;
      }

      setBusy(button, true);
      const clampNote = prepared.warnings.length
        ? ` ${prepared.warnings.length} value(s) will be clamped to DAC limits.`
        : '';
      setStatus(
        status,
        `Sending ${prepared.activeCount} active band(s) to the RU3...${clampNote}`,
        'pending',
        prepared.warnings.join('\n')
      );

      try {
        const response = await sendApplyMessage(prepared.bands);
        if (response && response.ok) {
          const verified = response.verifiedCount ?? prepared.bands.length;
          const warningNote = prepared.warnings.length
            ? ` ${prepared.warnings.length} value(s) were clamped.`
            : '';
          setStatus(
            status,
            `Applied and verified: ${verified}/10 bands.${warningNote}`,
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
          (response && response.error) ||
            'Could not apply PEQ. Is the DAC connected?',
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
        updatePanelState(root, panel);
      }
    });

    panel.append(button, status);
    updatePanelState(root, panel);
    return panel;
  }

  function installPanels() {
    const roots = Array.from(document.querySelectorAll('.extra-eq'))
      .filter((root) => findRows(root).length > 0);

    roots.forEach((root) => {
      let panel = root.querySelector(`[${PANEL_ATTRIBUTE}]`);
      if (!panel) {
        const target = findInsertTarget(root);
        if (!target) return;
        panel = createPanel(root);
        target.insertAdjacentElement('afterend', panel);
      }

      updatePanelState(root, panel);
    });
  }

  function scheduleInstall() {
    if (installQueued) return;
    installQueued = true;
    requestAnimationFrame(() => {
      installQueued = false;
      installPanels();
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

  installPanels();
})();

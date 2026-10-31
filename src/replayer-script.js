'use strict';

// Produces the JavaScript that replays a sequence of recorded actions inside a page. The main
// process substitutes live order values first, then calls webContents.executeJavaScript with the
// resulting script. The script walks the actions one at a time, resolving each target element
// via the recorded selector / attributes / text, dispatching the right event, and waiting between
// steps for the DOM to settle. All outcomes are reported back via window.postMessage so main
// can log a per-step trace.
//
// Design: idempotent + resumable — each run gets a run id tag; if the user kicks off a second
// run while the first is in progress, the first bails cleanly.

function buildReplayerScript(actions, { runId = 'default', stepDelayMs = 900, lookupMaxMs = 12000 } = {}) {
  const payload = JSON.stringify({ actions, runId, stepDelayMs, lookupMaxMs });
  return `(async () => {
    const PAYLOAD = ${payload};
    if (window.__fleetReplayRun === PAYLOAD.runId) return; // same run already active
    window.__fleetReplayRun = PAYLOAD.runId;

    const banner = document.createElement('div');
    banner.id = '__fleet-replay-banner';
    banner.style.cssText = [
      'position:fixed','top:12px','right:12px','z-index:2147483647',
      'background:#1b45a3','color:#fff','font:600 12px/1.3 -apple-system,system-ui,sans-serif',
      'padding:8px 14px','border-radius:8px','box-shadow:0 6px 20px rgba(0,0,0,.35)',
      'max-width:420px','pointer-events:auto','border:1px solid #0d2e74',
    ].join(';');
    banner.innerHTML = '<strong>Playbook running\\u2026</strong><br><span id="__fr-status">step 0 / ' + PAYLOAD.actions.length + '</span>';
    document.documentElement.appendChild(banner);
    const setStatus = (text, color) => {
      const span = banner.querySelector('#__fr-status');
      if (span) span.textContent = text;
      if (color) banner.style.background = color;
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const report = (step, status, detail) => window.postMessage({ __fleetReplay: true, runId: PAYLOAD.runId, step, status, detail }, '*');

    // Element lookup: try (in order) data-attrs → aria-label → textContent → selector path.
    const findTarget = (el) => {
      if (!el) return null;
      // 1. data-section-name / data-row-name / data-seat-name is the most reliable TM path.
      const attrQueries = [];
      if (el.attrs) {
        for (const [k, v] of Object.entries(el.attrs)) {
          if (!v) continue;
          if (['data-section-name','data-row-name','data-seat-name','data-seat','data-tid','data-testid','data-bdd','name','id','href','type'].includes(k)) {
            attrQueries.push('[' + k + '=' + JSON.stringify(v) + ']');
          }
        }
      }
      for (const q of attrQueries) {
        try { const match = document.querySelector(q); if (match) return match; } catch (_) {}
      }
      // 2. aria-label
      if (el.attrs?.['aria-label']) {
        const match = document.querySelector('[aria-label=' + JSON.stringify(el.attrs['aria-label']) + ']');
        if (match) return match;
      }
      // 3. Text match — look for an element with the same tag whose textContent contains the recorded snippet.
      if (el.tag && el.text && el.text.length < 60) {
        const candidates = document.querySelectorAll(el.tag.toLowerCase());
        for (const c of candidates) {
          if ((c.textContent || '').trim().startsWith(el.text.slice(0, 40))) return c;
        }
      }
      // 4. Full-blown CSS path as last resort.
      if (el.selector) {
        try { const match = document.querySelector(el.selector); if (match) return match; } catch (_) {}
      }
      return null;
    };

    // SVG + React synthetic events: dispatch the full pointer/mouse triple at the element's centroid.
    const synthClick = (el) => {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 0 }));
      }
    };

    // Wait for the DOM to look stable (no mutations for N ms, or a timeout).
    const waitForStable = (ms = 400, maxMs = 4000) => new Promise((resolve) => {
      let timer; const start = Date.now();
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        if (Date.now() - start >= maxMs) { observer.disconnect(); resolve('max'); return; }
        timer = setTimeout(() => { observer.disconnect(); resolve('stable'); }, ms);
      });
      observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: false });
      timer = setTimeout(() => { observer.disconnect(); resolve('initial'); }, ms);
    });

    // Wait up to lookupMaxMs for the element to appear in the DOM — pages often render async
    // and the recorded step may fire before the target element has been added. Polls every
    // 200ms. Returns the element or null on timeout.
    const findWithWait = async (el, label) => {
      const started = Date.now();
      let found = findTarget(el);
      let shownWaiting = false;
      while (!found && Date.now() - started < PAYLOAD.lookupMaxMs) {
        if (!shownWaiting && Date.now() - started > 1000) {
          setStatus('waiting for ' + label + '…', '#ffcc00');
          shownWaiting = true;
        }
        await sleep(200);
        if (window.__fleetReplayRun !== PAYLOAD.runId) return null;
        found = findTarget(el);
      }
      return found;
    };

    for (let i = 0; i < PAYLOAD.actions.length; i++) {
      if (window.__fleetReplayRun !== PAYLOAD.runId) { report(i, 'cancelled'); break; }
      const action = PAYLOAD.actions[i];
      const label = (action.el?.text || action.el?.attrs?.['data-section-name'] || action.el?.attrs?.['data-row-name']
        || action.el?.attrs?.['data-seat-name'] || action.el?.tag || action.type).toString().slice(0, 60);
      setStatus('step ' + (i + 1) + ' / ' + PAYLOAD.actions.length + ' — ' + action.type + ': ' + label);

      try {
        if (action.type === 'load') {
          if (location.href === action.url) { report(i, 'skip', 'already here'); continue; }
          location.href = action.url;
          report(i, 'navigate', action.url);
          return; // navigation reloads the frame; the replayer re-injects on did-navigate
        }
        if (action.type === 'click') {
          const target = await findWithWait(action.el, label);
          if (!target) { report(i, 'miss', 'element not found after ' + Math.round(PAYLOAD.lookupMaxMs / 1000) + 's'); setStatus('step ' + (i+1) + ': ' + label + ' missing', '#c91c1c'); break; }
          target.scrollIntoView({ block: 'center', inline: 'center' });
          await sleep(150); // small settle after scroll before clicking
          synthClick(target);
          report(i, 'click', label);
        } else if (action.type === 'input') {
          const target = await findWithWait(action.el, label);
          if (!target) { report(i, 'miss', 'input not found'); break; }
          target.focus();
          target.value = action.value ?? '';
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          report(i, 'input', '(len ' + (action.value?.length ?? 0) + ')');
        } else if (action.type === 'change') {
          const target = await findWithWait(action.el, label);
          if (!target) { report(i, 'miss', 'select not found'); break; }
          target.value = action.value ?? '';
          target.dispatchEvent(new Event('change', { bubbles: true }));
          report(i, 'change', action.value);
        } else if (action.type === 'submit') {
          const target = await findWithWait(action.el, label);
          if (target && typeof target.submit === 'function') target.submit();
          else if (target) target.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          report(i, 'submit');
          return; // submit usually navigates
        } else if (action.type === 'keydown') {
          const target = findTarget(action.el) || document.activeElement || document.body;
          target.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true, cancelable: true }));
          report(i, 'keydown', action.key);
        } else {
          report(i, 'skip', action.type);
        }
      } catch (err) {
        report(i, 'error', String(err && err.message || err));
        setStatus('step ' + (i+1) + ': ' + (err?.message || 'error'), '#c91c1c');
        break;
      }

      // Pacing: wait for the DOM to settle, with the step-delay as the minimum pause. On a busy
      // page the mutations never stop; the max is the hard ceiling so we always move on.
      await Promise.all([
        sleep(PAYLOAD.stepDelayMs),
        waitForStable(PAYLOAD.stepDelayMs, PAYLOAD.lookupMaxMs),
      ]);
    }

    setStatus('done', '#15803d');
    setTimeout(() => banner.remove(), 4000);
    report(PAYLOAD.actions.length, 'done');
  })();`;
}

module.exports = { buildReplayerScript };

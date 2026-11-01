'use strict';

// Produces the JavaScript that replays a sequence of recorded actions inside a page. The main
// process substitutes live order values first, then calls webContents.executeJavaScript with the
// resulting script. The script walks the actions one at a time, resolving each target element
// via the recorded selector / attributes / text, dispatching the right event, and waiting between
// steps for the DOM to settle. All outcomes are reported back via window.postMessage so main
// can log a per-step trace.
//
// Reliability features — the main reason this file is as long as it is:
// • findTarget walks nested iframes (same-origin) and open shadow roots, not just document.
// • Inputs are written via the native setter so React/Vue controlled inputs see the change.
// • Before clicking, elements are checked for actionability — visible, has size, not disabled,
//   and the top element at their centroid (not covered by a modal/overlay).
// • Captcha / Cloudflare Turnstile / human-verification is detected before each step; when it
//   fires, the replayer pauses with a resume button so the operator can solve it and continue.
// • Each failing step gets one soft retry after a short pause before being reported as a miss.
// • Interactive banner controls — Pause / Resume / Skip / Abort — survive the whole run.

function buildReplayerScript(actions, { runId = 'default', stepDelayMs = 900, lookupMaxMs = 12000 } = {}) {
  const payload = JSON.stringify({ actions, runId, stepDelayMs, lookupMaxMs });
  return `(async () => {
    const PAYLOAD = ${payload};
    if (window.__fleetReplayRun === PAYLOAD.runId) return; // same run already active
    window.__fleetReplayRun = PAYLOAD.runId;
    const RUN_STATE = window.__fleetReplayState = { paused: false, skip: false, aborted: false };

    // ------------------------------------------------------------- Banner + controls
    const existing = document.getElementById('__fleet-replay-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.id = '__fleet-replay-banner';
    banner.style.cssText = [
      'position:fixed','top:12px','right:12px','z-index:2147483647',
      'background:#1b45a3','color:#fff','font:600 12px/1.35 -apple-system,system-ui,sans-serif',
      'padding:10px 14px','border-radius:10px','box-shadow:0 10px 28px rgba(0,0,0,.45)',
      'max-width:440px','border:1px solid #0d2e74','pointer-events:auto',
    ].join(';');
    banner.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
        '<strong style="font-size:12.5px">Playbook running</strong>' +
        '<div style="margin-left:auto;display:flex;gap:4px">' +
          '<button data-fleet-act="pause"  style="all:unset;cursor:pointer;background:#ffcc00;color:#141821;padding:2px 8px;border-radius:5px;font-size:10.5px;font-weight:700">⏸</button>' +
          '<button data-fleet-act="skip"   style="all:unset;cursor:pointer;background:#2a303a;color:#fff;padding:2px 8px;border-radius:5px;font-size:10.5px;font-weight:700">↷ Skip</button>' +
          '<button data-fleet-act="abort"  style="all:unset;cursor:pointer;background:#c91c1c;color:#fff;padding:2px 8px;border-radius:5px;font-size:10.5px;font-weight:700">✕</button>' +
        '</div>' +
      '</div>' +
      '<div id="__fr-status" style="font-weight:500;opacity:.95">step 0 / ' + PAYLOAD.actions.length + '</div>';
    document.documentElement.appendChild(banner);

    const setStatus = (text, color) => {
      const span = banner.querySelector('#__fr-status');
      if (span) span.textContent = text;
      if (color) banner.style.background = color;
    };
    const setPauseButton = (label) => {
      const btn = banner.querySelector('[data-fleet-act="pause"]');
      if (btn) btn.textContent = label;
    };

    banner.addEventListener('click', (e) => {
      const act = e.target?.dataset?.fleetAct;
      if (act === 'pause')  { RUN_STATE.paused = !RUN_STATE.paused; setPauseButton(RUN_STATE.paused ? '▶' : '⏸'); }
      if (act === 'skip')   { RUN_STATE.skip = true; }
      if (act === 'abort')  { RUN_STATE.aborted = true; window.__fleetReplayRun = null; setStatus('aborted', '#6b7380'); setTimeout(() => banner.remove(), 1200); }
    });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitWhilePaused = async () => { while (RUN_STATE.paused && !RUN_STATE.aborted) await sleep(120); };
    const report = (step, status, detail) => window.postMessage({ __fleetReplay: true, runId: PAYLOAD.runId, step, status, detail }, '*');

    // ------------------------------------------------------------- Deep DOM traversal
    // Walk document + every same-origin iframe body + every open shadow root. Returns all matches
    // across every scope, so visibility/actionability can pick the best one.
    const everyRoot = () => {
      const roots = [document];
      const seen = new Set();
      const walk = (root) => {
        if (!root || seen.has(root)) return;
        seen.add(root);
        roots.push(root);
        const nodes = root.querySelectorAll('*');
        for (const node of nodes) {
          if (node.shadowRoot) walk(node.shadowRoot);
          if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
            try {
              const doc = node.contentDocument;
              if (doc) { roots.push(doc); walk(doc); }
            } catch (_) { /* cross-origin — unreachable */ }
          }
        }
      };
      walk(document);
      return roots;
    };

    const queryAll = (selector) => {
      const out = [];
      for (const root of everyRoot()) {
        try { for (const el of root.querySelectorAll(selector)) out.push(el); } catch (_) {}
      }
      return out;
    };

    // ------------------------------------------------------------- Actionability
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      const style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      return true;
    };

    const topAtCenter = (el) => {
      // Returns true if 'el' (or one of its descendants) is the top element at its centroid.
      // Protects against invisible overlays / cookie banners / full-screen modals eating clicks.
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      const doc = el.ownerDocument;
      let hit = doc.elementFromPoint(cx, cy);
      while (hit) {
        if (hit === el || el.contains(hit) || hit.contains(el)) return true;
        hit = hit.parentElement;
      }
      return false;
    };

    // Score candidates — prefer visible + actionable + in-viewport + top-of-stack.
    const pickBest = (candidates) => {
      let best = null, bestScore = -1;
      for (const c of candidates) {
        let score = 0;
        if (isVisible(c)) score += 10;
        const rect = c.getBoundingClientRect();
        if (rect.top >= 0 && rect.bottom <= innerHeight) score += 3;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      return best;
    };

    // ------------------------------------------------------------- Target resolution
    // Try (in order) data-attrs → aria-label → textContent → recorded CSS path. Each selector
    // runs across every root (document + iframes + shadow). Candidates are scored for
    // visibility; the best wins.
    const findTarget = (el) => {
      if (!el) return null;
      const tried = new Set();
      const run = (selector) => {
        if (!selector || tried.has(selector)) return null;
        tried.add(selector);
        try { return pickBest(queryAll(selector)); } catch (_) { return null; }
      };

      // 1. Stable data attributes.
      if (el.attrs) {
        const stable = ['data-section-name','data-row-name','data-seat-name','data-seat','data-tid',
                        'data-testid','data-bdd','name','id','href','type'];
        for (const k of stable) {
          const v = el.attrs[k];
          if (!v) continue;
          const hit = run('[' + k + '=' + JSON.stringify(v) + ']');
          if (hit) return hit;
        }
      }
      // 2. aria-label
      if (el.attrs?.['aria-label']) {
        const hit = run('[aria-label=' + JSON.stringify(el.attrs['aria-label']) + ']');
        if (hit) return hit;
      }
      // 3. Text match (across every root, scoped by tag).
      if (el.tag && el.text && el.text.length < 60) {
        const needle = el.text.slice(0, 40);
        const candidates = [];
        for (const root of everyRoot()) {
          try {
            for (const node of root.querySelectorAll(el.tag.toLowerCase())) {
              const t = (node.textContent || '').trim();
              if (t && (t.startsWith(needle) || t === el.text)) candidates.push(node);
            }
          } catch (_) {}
        }
        const hit = pickBest(candidates);
        if (hit) return hit;
      }
      // 4. CSS path as last resort.
      if (el.selector) {
        const hit = run(el.selector);
        if (hit) return hit;
      }
      return null;
    };

    // ------------------------------------------------------------- Captcha detection
    const CAPTCHA_SELECTORS = [
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      'iframe[src*="arkoselabs"]',
      'iframe[src*="geetest"]',
      'iframe[title*="challenge" i]',
      'iframe[title*="captcha" i]',
      '[class*="g-recaptcha"]',
      '[class*="h-captcha"]',
      '[id*="turnstile"]',
      '[data-sitekey]',
      '[class*="cf-turnstile"]',
      '[class*="px-captcha"]',    // PerimeterX
      '[id="px-captcha"]',
      '#distilCaptchaForm',       // Distil
      '[class*="shape-container"]', // Shape
    ];
    const detectCaptcha = () => {
      for (const sel of CAPTCHA_SELECTORS) {
        for (const el of queryAll(sel)) {
          if (isVisible(el)) return { element: el, selector: sel };
        }
      }
      // Textual tells on the current page.
      const bodyText = (document.body?.innerText || '').slice(0, 2000);
      if (/(^|\\n)(verify (you'?re|that you'?re) (a )?human|press and hold|checking your browser|please complete the security check|unusual traffic from your computer)/i.test(bodyText)) {
        return { element: document.body, selector: 'textual' };
      }
      return null;
    };

    const waitForCaptchaCleared = async (hit) => {
      RUN_STATE.paused = true;
      setPauseButton('▶');
      setStatus('⚠ captcha detected — solve it then press ▶', '#ffcc00');
      report(-1, 'captcha', hit.selector);
      // Hold until the operator presses resume AND the captcha is no longer visible.
      while (!RUN_STATE.aborted) {
        if (!RUN_STATE.paused && !detectCaptcha()) break;
        await sleep(400);
      }
      setStatus('resumed', '#1b45a3');
      report(-1, 'resumed');
    };

    // ------------------------------------------------------------- React-safe input
    const setNativeValue = (el, value) => {
      // React's synthetic event system tracks the native setter to detect real changes. Writing
      // el.value directly skips that tracker, so React ignores the change. Grab the prototype
      // setter and call it directly instead.
      try {
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
                    ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
      } catch (_) { el.value = value; }
    };

    // ------------------------------------------------------------- Clicking
    // Pointer+mouse+click triple at centroid; also dispatches touch for mobile-first UIs.
    const synthClick = (el) => {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: el.ownerDocument.defaultView || window, button: 0 };
      for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (_) {
          try { el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); } catch (__) {}
        }
      }
    };

    // ------------------------------------------------------------- DOM-settle wait
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

    // ------------------------------------------------------------- Find-with-wait + actionable
    // Polls every 200ms until a usable (visible + top-of-stack) element appears or we time out.
    // Also pauses for captchas and respects the pause/abort flags.
    const findWithWait = async (el, label, { requireActionable = true } = {}) => {
      const started = Date.now();
      let shownWaiting = false;
      while (Date.now() - started < PAYLOAD.lookupMaxMs) {
        if (RUN_STATE.aborted) return null;
        await waitWhilePaused();
        const captcha = detectCaptcha();
        if (captcha) { await waitForCaptchaCleared(captcha); continue; }

        const found = findTarget(el);
        if (found) {
          if (!requireActionable) return found;
          if (isVisible(found)) {
            // Try to scroll into view, then verify top-of-stack.
            try { found.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {
              try { found.scrollIntoView({ block: 'center', inline: 'center' }); } catch (__) {}
            }
            await sleep(80);
            if (topAtCenter(found)) return found;
          }
        }

        if (!shownWaiting && Date.now() - started > 1000) {
          setStatus('waiting for ' + label + '…', '#ffcc00');
          shownWaiting = true;
        }
        await sleep(200);
      }
      return null;
    };

    // ------------------------------------------------------------- Main loop
    for (let i = 0; i < PAYLOAD.actions.length; i++) {
      if (window.__fleetReplayRun !== PAYLOAD.runId || RUN_STATE.aborted) { report(i, 'cancelled'); break; }
      await waitWhilePaused();

      if (RUN_STATE.skip) { RUN_STATE.skip = false; report(i, 'skipped', 'user'); setStatus('skipped step ' + (i + 1), '#6b7380'); await sleep(300); continue; }

      const action = PAYLOAD.actions[i];
      const label = (action.el?.text || action.el?.attrs?.['data-section-name'] || action.el?.attrs?.['aria-label']
        || action.el?.attrs?.['data-seat-name'] || action.el?.tag || action.type || '').toString().slice(0, 60);
      setStatus('step ' + (i + 1) + ' / ' + PAYLOAD.actions.length + ' — ' + action.type + ': ' + label, '#1b45a3');

      // Each step gets one soft retry after a short delay before being reported as a miss.
      let attempt = 0, lastError = null, done = false;
      while (attempt < 2 && !done && !RUN_STATE.aborted) {
        attempt++;
        try {
          if (action.type === 'load') {
            if (location.href === action.url) { report(i, 'skip', 'already here'); done = true; break; }
            location.href = action.url;
            report(i, 'navigate', action.url);
            return; // navigation reloads the frame; the replayer re-injects on did-navigate
          }
          if (action.type === 'click') {
            const target = await findWithWait(action.el, label);
            if (!target) throw new Error('element not found after ' + Math.round(PAYLOAD.lookupMaxMs / 1000) + 's');
            synthClick(target);
            report(i, 'click', label);
            done = true;
          } else if (action.type === 'input') {
            const target = await findWithWait(action.el, label);
            if (!target) throw new Error('input not found');
            target.focus();
            setNativeValue(target, action.value ?? '');
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            report(i, 'input', '(len ' + (action.value?.length ?? 0) + ')');
            done = true;
          } else if (action.type === 'change') {
            const target = await findWithWait(action.el, label, { requireActionable: false });
            if (!target) throw new Error('select not found');
            setNativeValue(target, action.value ?? '');
            target.dispatchEvent(new Event('change', { bubbles: true }));
            report(i, 'change', action.value);
            done = true;
          } else if (action.type === 'submit') {
            const target = await findWithWait(action.el, label, { requireActionable: false });
            if (target && typeof target.submit === 'function') target.submit();
            else if (target) target.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            report(i, 'submit');
            return; // submit usually navigates
          } else if (action.type === 'keydown') {
            const target = findTarget(action.el) || document.activeElement || document.body;
            target.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true, cancelable: true }));
            report(i, 'keydown', action.key);
            done = true;
          } else {
            report(i, 'skip', action.type);
            done = true;
          }
        } catch (err) {
          lastError = err;
          if (attempt < 2) {
            setStatus('step ' + (i+1) + ': ' + (err?.message || 'retry') + ' — retrying…', '#ffcc00');
            await sleep(500);
            await waitForStable(300, 2000);
          }
        }
      }

      if (!done && lastError) {
        report(i, 'miss', String(lastError?.message || lastError));
        setStatus('step ' + (i+1) + ': ' + (lastError?.message || 'failed'), '#c91c1c');
        break;
      }

      // Pacing: wait for the DOM to settle, with the step-delay as the minimum pause.
      await Promise.all([
        sleep(PAYLOAD.stepDelayMs),
        waitForStable(PAYLOAD.stepDelayMs, PAYLOAD.lookupMaxMs),
      ]);
    }

    if (!RUN_STATE.aborted) {
      setStatus('✓ done', '#15803d');
      setTimeout(() => banner.remove(), 4000);
      report(PAYLOAD.actions.length, 'done');
    }
  })();`;
}

module.exports = { buildReplayerScript };

'use strict';

// Returns the JavaScript that runs in each page's main world while recording is active. It attaches
// capture-phase listeners for click, input (including text typing), change, submit, and page unload,
// then posts each event to the preload via window.postMessage. The preload forwards to main via IPC.
// Nothing is persisted inside the page; the main process is the authoritative recorder.
//
// Each captured element is described with enough identifiers to replay the action later:
// id, classes, text, aria-label, data-bdd / data-tid / data-section / data-row / data-seat, name,
// href, and a short CSS path. The CSS path only exists for cases where no stable attribute is on the
// element — a text + data-bdd match is more durable across TM A/B tests.

function buildRecorderScript() {
  return `(() => {
    if (window.__fleetRecorder) return;
    window.__fleetRecorder = true;

    const BANNER_ID = '__fleet-recorder-banner';
    const existing = document.getElementById(BANNER_ID);
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.style.cssText = [
      'position:fixed','top:12px','left:50%','transform:translateX(-50%)','z-index:2147483647',
      'background:#c91c1c','color:#fff','font:600 12px/1.3 -apple-system,system-ui,sans-serif',
      'padding:6px 14px','border-radius:999px','box-shadow:0 4px 12px rgba(0,0,0,.35)',
      'pointer-events:none','letter-spacing:.3px','text-transform:uppercase',
    ].join(';');
    banner.textContent = '● Recording';
    document.documentElement.appendChild(banner);

    const cssPath = (el) => {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 6) {
        let selector = node.tagName.toLowerCase();
        if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
        const parent = node.parentNode;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          if (siblings.length > 1) selector += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(selector);
        node = parent;
      }
      return parts.join(' > ');
    };

    const describe = (el) => {
      if (!el || el.nodeType !== 1) return null;
      const attrs = {};
      for (const attr of ['data-bdd','data-tid','data-testid','data-section','data-section-name',
        'data-row','data-seat','data-seat-number','aria-label','name','type','href','role','placeholder']) {
        const value = el.getAttribute(attr);
        if (value) attrs[attr] = value;
      }
      return {
        tag: el.tagName,
        id: el.id || null,
        classes: typeof el.className === 'string' ? el.className : null,
        text: (el.textContent || '').trim().slice(0, 120),
        attrs,
        selector: cssPath(el),
      };
    };

    const post = (payload) => {
      try {
        // Target the page's own origin so an ad iframe or third-party widget on the recorded page
        // can't receive the typed values via its own window.addEventListener('message', …).
        window.postMessage({
          __fleetRecord: true,
          ...payload,
          url: location.href,
          t: Date.now(),
        }, '/');
      } catch (_) {}
    };

    document.addEventListener('click', (event) => {
      // Trace the composed path so we also capture the clicked descendant inside a button.
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
      post({ type: 'click', el: describe(event.target), path: path.slice(0, 4).map(describe).filter(Boolean) });
    }, true);

    document.addEventListener('input', (event) => {
      const el = event.target;
      if (!el || !('value' in el)) return;
      // Sensitive fields are logged as [redacted] with length so replay can still fill something.
      const isSensitive = el.type === 'password' || /pass|cvv|cvc|card/i.test(el.name || '');
      post({
        type: 'input',
        el: describe(el),
        value: isSensitive ? '[redacted ' + String(el.value || '').length + ' chars]' : String(el.value || '').slice(0, 200),
      });
    }, true);

    document.addEventListener('change', (event) => {
      const el = event.target;
      if (!el || el.tagName !== 'SELECT') return;
      post({ type: 'change', el: describe(el), value: String(el.value || '').slice(0, 200) });
    }, true);

    document.addEventListener('submit', (event) => {
      post({ type: 'submit', el: describe(event.target) });
    }, true);

    document.addEventListener('keydown', (event) => {
      if (!['Enter', 'Tab', 'Escape'].includes(event.key)) return;
      post({ type: 'keydown', key: event.key, el: describe(document.activeElement) });
    }, true);

    post({ type: 'load', title: document.title });
    window.addEventListener('beforeunload', () => post({ type: 'unload' }), { once: true });
  })();`;
}

module.exports = { buildRecorderScript };

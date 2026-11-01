'use strict';

// Returns the injected JavaScript that runs on ticketmaster.com event pages. The script watches the
// seatmap DOM for seats whose section/row/seat-number match the order details handed in via a
// placeholder ({ORDER_JSON}), highlights them with a thick outline + banner, and binds ⌘Enter / Ctrl-Enter
// to click the first match. It never auto-purchases: the human stays in the loop at the add-to-cart step.
//
// Covers both primary and verified-resale seatmaps (same host, different React trees). The selectors
// here are intentionally forgiving (text match + several data-attribute paths) because Ticketmaster
// A/B tests the DOM — expect maintenance when a selector stops matching.

function buildSeatMatchScript(order) {
  const payload = JSON.stringify({
    section: String(order.section ?? '').trim(),
    row: String(order.row ?? '').trim(),
    lowSeat: Number(order.low_seat ?? order.lowSeat ?? 0) || null,
    highSeat: Number(order.high_seat ?? order.highSeat ?? order.low_seat ?? order.lowSeat ?? 0) || null,
    quantity: Number(order.quantity ?? 0) || null,
    orderId: String(order.order_id ?? order.orderId ?? ''),
    autoClick: Boolean(order.autoClick),
  });
  // The IIFE below runs in the page's main world via webContents.executeJavaScript.
  return `(() => {
    const ORDER = ${payload};
    if (window.__fleetSeatMatch === ORDER.orderId) return; // already installed for this order
    window.__fleetSeatMatch = ORDER.orderId;

    const norm = (s) => String(s ?? '').replace(/^(sec(tion)?\\s*|row\\s*|seat\\s*)/i, '').trim().toLowerCase();
    const targetSection = norm(ORDER.section);
    const targetRow = norm(ORDER.row);
    const seats = [];
    if (ORDER.lowSeat && ORDER.highSeat) {
      for (let s = ORDER.lowSeat; s <= ORDER.highSeat; s++) seats.push(String(s));
    } else if (ORDER.lowSeat) {
      seats.push(String(ORDER.lowSeat));
    }

    // ----- Banner --------------------------------------------------------------------------------
    const banner = document.createElement('div');
    banner.id = '__fleet-seat-banner';
    banner.style.cssText = [
      'position:fixed','top:12px','right:12px','z-index:2147483647',
      'background:#111','color:#fff','font:600 13px/1.3 -apple-system,system-ui,sans-serif',
      'padding:10px 14px','border-radius:8px','box-shadow:0 6px 20px rgba(0,0,0,.35)',
      'max-width:360px','pointer-events:auto','cursor:default','border:1px solid #333',
    ].join(';');
    // Build with createElement + textContent so a hostile order field (section, row, orderId, seat
     // range) can't break out of the HTML context and run JS in the ticketmaster.com origin.
    const header = document.createElement('div');
    header.style.cssText = 'opacity:.6;font-weight:500;font-size:11px;letter-spacing:.5px;text-transform:uppercase;margin-bottom:4px';
    header.textContent = \`TabSolo · Order #\${ORDER.orderId}\`;
    const status = document.createElement('div');
    status.id = '__fleet-seat-status';
    status.textContent = \`Scanning seatmap for Sec \${ORDER.section || '?'} Row \${ORDER.row || '?'} Seats \${seats.join('–') || '?'}…\`;
    const hint = document.createElement('div');
    hint.style.cssText = 'opacity:.7;font-size:11px;margin-top:6px';
    const kbd = document.createElement('kbd');
    kbd.style.cssText = 'background:#333;padding:1px 5px;border-radius:3px';
    kbd.textContent = '⌘ Enter';
    hint.append(kbd, ' jump to match');
    banner.append(header, status, hint);
    document.documentElement.appendChild(banner);
    const setStatus = (text, color = '#fff') => { status.textContent = text; banner.style.borderColor = color; };

    // ----- Section matching ----------------------------------------------------------------------
    // Primary (SVG seatmap on event pages): <g data-section-name="108"> wraps every seat in that
    // section. Fallback: quickpicks-style tiles seen on resale and some primary variants.
    const findSectionGroups = () => Array.from(document.querySelectorAll('[data-section-name]'));
    const findSectionTiles = () => Array.from(document.querySelectorAll(
      '[data-bdd="quickpick-section"], [data-bdd*="section-tile"], [aria-label*="Section"]'
    ));

    const matchSection = () => {
      if (!targetSection) return null;
      for (const el of findSectionGroups()) {
        const label = norm(el.getAttribute('data-section-name'));
        if (label === targetSection || label.endsWith(targetSection)) return el;
      }
      for (const el of findSectionTiles()) {
        const label = norm(el.getAttribute('data-section-name') || el.getAttribute('aria-label') || el.textContent);
        if (label === targetSection || label.includes(targetSection)) return el;
      }
      return null;
    };

    // ----- Seat matching ------------------------------------------------------------------------
    // Real TM seatmap DOM, confirmed from a live recording:
    //   <g data-section-name="108">
    //     <g data-component="svg__row" data-row-name="M">
    //       <circle data-component="svg__seat" data-seat-name="5" class="seat is-available ...">
    // Selected seats are wrapped in a <g data-component="svg__seat"> that contains a <circle>+<path>.
    // Only "is-available" seats are buyable; everything else is sold / held / filtered out.
    const isAvailableSeat = (el) => (el.getAttribute('class') || '').includes('is-available');

    const matchSeats = () => {
      const matches = [];
      // Scope to the target section when we know it so a Row M in another section can't match by accident.
      const scopes = targetSection
        ? findSectionGroups().filter((s) => {
            const label = norm(s.getAttribute('data-section-name'));
            return label === targetSection || label.endsWith(targetSection);
          })
        : [document];
      if (scopes.length === 0) return matches;

      for (const scope of scopes) {
        // Primary path: SVG seatmap on event pages.
        const rows = scope.querySelectorAll('[data-component="svg__row"]');
        for (const rowEl of rows) {
          const rowName = norm(rowEl.getAttribute('data-row-name'));
          if (targetRow && rowName !== targetRow) continue;
          for (const seat of rowEl.querySelectorAll('[data-component="svg__seat"]')) {
            const seatName = seat.getAttribute('data-seat-name');
            if (!seatName) continue;
            if (seats.length > 0 && !seats.includes(String(seatName))) continue;
            if (!isAvailableSeat(seat)) continue;
            matches.push(seat);
          }
        }
        if (matches.length > 0) continue;

        // Fallback (older primary + verified resale): offer-card list rendered as <div role="option">
        // or <li> with the full "Section X, Row Y, Seat Z" string in aria-label.
        for (const el of scope.querySelectorAll('[aria-label*="Row"], [role="option"]')) {
          const label = el.getAttribute('aria-label') || el.textContent || '';
          const m = /section\\s*([\\w\\-]+)[^a-z0-9]*row\\s*([\\w\\-]+)[^a-z0-9]*seat\\s*(\\d+)/i.exec(label);
          if (!m) continue;
          const sec = norm(m[1]), r = norm(m[2]), s = m[3];
          if (targetSection && sec !== targetSection && !sec.endsWith(targetSection)) continue;
          if (targetRow && r !== targetRow) continue;
          if (seats.length > 0 && !seats.includes(String(s))) continue;
          matches.push(el);
        }
      }
      return matches;
    };

    // SVG <circle> + React synthetic events: a plain el.click() often doesn't register. Dispatch a
    // full mousedown/mouseup/click triple centered on the element so React's root listener fires.
    const clickSeatElement = (el) => {
      try {
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 0 }));
        }
      } catch (_) {
        try { el.click(); } catch (_) {}
      }
    };

    // ----- Highlighter --------------------------------------------------------------------------
    const highlighted = new Set();
    const highlight = (el) => {
      if (highlighted.has(el)) return;
      highlighted.add(el);
      const prevOutline = el.style.outline;
      const prevShadow = el.style.boxShadow;
      el.style.outline = '3px solid #ff2d55';
      el.style.outlineOffset = '2px';
      el.style.boxShadow = '0 0 0 6px rgba(255,45,85,.25)';
      el.setAttribute('data-fleet-match', '1');
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      return () => { el.style.outline = prevOutline; el.style.boxShadow = prevShadow; };
    };

    let activeMatches = [];
    let activeSection = null;
    let seatClicked = false;
    let cartClicked = false;

    // ----- Add-to-cart / Reserve finder (auto-click branch) -------------------------------------
    // From a live TM recording the real labels on the event page are "Reserve Tickets" (post-seat)
    // and later "Proceed to Payment" on checkout. Keep a wider needle so other TM variants still
    // match. Visible + enabled + inside the document is required so we don't press hidden templates.
    const findAddToCart = () => {
      const candidates = Array.from(document.querySelectorAll(
        '[data-bdd="offer-card-cta"], [data-bdd*="add-to-cart"], [data-bdd*="reserve"], ' +
        '[data-bdd*="checkout"], button, [role="button"], a.btn-primary'
      ));
      const needle = /^(reserve tickets?|add to cart|proceed to payment|buy( tickets?)?|continue|checkout|get tickets?)$/i;
      return candidates.find((el) => {
        const label = (el.textContent || el.getAttribute('aria-label') || '').trim();
        return needle.test(label) && !el.disabled && el.offsetParent !== null;
      }) || null;
    };

    const scan = () => {
      if (activeMatches.length === 0 && targetSection) {
        const section = matchSection();
        if (section && section !== activeSection) {
          activeSection = section;
          highlight(section);
          setStatus(\`Section \${ORDER.section} found. Click it to open seats.\`, '#ffcc00');
          if (ORDER.autoClick) {
            try { section.click(); } catch {}
          }
        }
      }
      const found = matchSeats();
      if (found.length > 0) {
        activeMatches = found;
        found.forEach(highlight);
        setStatus(\`✓ Match: Sec \${ORDER.section} Row \${ORDER.row} Seat\${seats.length > 1 ? 's' : ''} \${seats.join(', ') || '?'} \${ORDER.autoClick ? '(auto-clicking)' : '(⌘ Enter)'}\`, '#30d158');
        if (ORDER.autoClick && !seatClicked) {
          seatClicked = true;
          // Click each matched seat in turn — matters when the order has a seat range (buddy pass):
          // TM lets you select each seat separately and the Reserve button activates once the quantity
          // in the cart matches. Space clicks ~120ms apart so React has time to accept each one.
          activeMatches.forEach((el, i) => setTimeout(() => clickSeatElement(el), i * 120));
          setStatus(\`Clicked \${activeMatches.length} seat(s). Waiting for Reserve…\`, '#30d158');
        }
      }
      if (ORDER.autoClick && seatClicked && !cartClicked) {
        const cta = findAddToCart();
        if (cta) {
          cartClicked = true;
          try { cta.click(); } catch {}
          setStatus(\`Clicked \"\${(cta.textContent || '').trim()}\". Finish checkout manually.\`, '#30d158');
        }
      }
    };

    // ----- Observer: rescan on DOM mutations ----------------------------------------------------
    const observer = new MutationObserver(() => scan());
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: false });
    scan();

    // ----- ⌘/Ctrl + Enter to click the first match ---------------------------------------------
    const keyHandler = (event) => {
      if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
      if (activeMatches.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      activeMatches.forEach((el, i) => setTimeout(() => clickSeatElement(el), i * 120));
      setStatus(\`Clicked \${activeMatches.length} seat(s) in \${ORDER.section ? 'Sec ' + ORDER.section : 'match'}. Finish the purchase manually.\`, '#30d158');
    };
    document.addEventListener('keydown', keyHandler, true);

    // ----- Teardown on navigation ---------------------------------------------------------------
    window.addEventListener('beforeunload', () => {
      observer.disconnect();
      document.removeEventListener('keydown', keyHandler, true);
      banner.remove();
    }, { once: true });
  })();`;
}

module.exports = { buildSeatMatchScript };

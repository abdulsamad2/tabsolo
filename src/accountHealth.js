'use strict';

// Background "is this account still logged in?" check per profile. Hits the account's homepage
// using its own session (so Chromium sends the account's cookies) and looks for a site-specific
// "signed in" marker in the response — usually the presence of a dashboard URL, a sign-out link,
// or a logged-in-only cookie. Returns one of: 'in', 'out', 'unknown'. Never navigates a tab or
// touches the renderer; purely a side-channel fetch via the profile's session.
//
// Per-site heuristics live in the HOST_RULES map. Add new sites by appending a rule — each one has
// a hostname pattern and either a `cookieHints` list (presence of named cookies) or a `textHints`
// list (substrings expected on the signed-in page). A hit on EITHER satisfies 'in'.

const HOST_RULES = [
  {
    host: /(^|\.)ticketmaster\.com$/i,
    probeURL: 'https://www.ticketmaster.com/member',
    cookieHints: ['BID', 'tmUser', 'tmff'],
    textHints: ['sign out', 'signout', 'my account', 'orders', '/member/orders'],
    loggedOutHints: ['sign in', 'create account', 'auth.ticketmaster.com'],
  },
  {
    host: /(^|\.)axs\.com$/i,
    probeURL: 'https://www.axs.com/mytickets',
    cookieHints: ['axs_user', 'auth_token'],
    textHints: ['sign out', 'my account'],
    loggedOutHints: ['sign in', 'account/login'],
  },
  {
    host: /(^|\.)seatgeek\.com$/i,
    probeURL: 'https://seatgeek.com/account',
    cookieHints: ['sg_user'],
    textHints: ['sign out', 'my tickets'],
    loggedOutHints: ['/login'],
  },
];

function pickRule(url) {
  try {
    const host = new URL(url).hostname;
    for (const r of HOST_RULES) if (r.host.test(host)) return r;
  } catch {}
  return null;
}

/**
 * Checks one profile against its homepage host (or the first rule whose host matches). Returns
 * { profileId, status: 'in' | 'out' | 'unknown', reason, at }. `session` is the Electron session
 * fromPartition for that profile so cookies flow naturally.
 */
async function checkAccount(profile, electronSession) {
  const now = Date.now();
  const rule = profile.url ? pickRule(profile.url) : null;
  if (!rule) return { profileId: profile.id, status: 'unknown', reason: 'no rule for this site', at: now };
  try {
    // Fetch cookies first — a logged-in marker here is cheap and avoids a network round-trip.
    const cookies = await electronSession.cookies.get({});
    const names = new Set(cookies.map((c) => c.name));
    if (rule.cookieHints?.some((n) => names.has(n))) {
      return { profileId: profile.id, status: 'in', reason: 'session cookie present', at: now };
    }
    // Second line: fetch the probe URL (short timeout) and sniff text markers.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await electronSession.fetch(rule.probeURL, {
        signal: controller.signal,
        credentials: 'include',
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timer);
    }
    const finalURL = String(response.url ?? '').toLowerCase();
    const text = (await response.text()).slice(0, 20000).toLowerCase();
    if (rule.loggedOutHints?.some((h) => finalURL.includes(h.toLowerCase()))) {
      return { profileId: profile.id, status: 'out', reason: 'redirected to login URL', at: now };
    }
    if (rule.textHints?.some((h) => text.includes(h.toLowerCase()))) {
      return { profileId: profile.id, status: 'in', reason: 'signed-in marker on page', at: now };
    }
    if (rule.loggedOutHints?.some((h) => text.includes(h.toLowerCase()))) {
      return { profileId: profile.id, status: 'out', reason: 'login prompt on page', at: now };
    }
    return { profileId: profile.id, status: 'unknown', reason: `HTTP ${response.status}`, at: now };
  } catch (error) {
    return { profileId: profile.id, status: 'unknown', reason: error?.message || 'request failed', at: now };
  }
}

/**
 * Checks every profile in parallel but bounded. The caller supplies a session resolver so this
 * module doesn't need to import electron directly (easier to test).
 */
async function checkAll(profiles, sessionFor, { concurrency = 4 } = {}) {
  const queue = profiles.slice();
  const results = [];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const profile = queue.shift();
      const ses = sessionFor(profile);
      if (!ses) { results.push({ profileId: profile.id, status: 'unknown', reason: 'no session', at: Date.now() }); continue; }
      results.push(await checkAccount(profile, ses));
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = { checkAccount, checkAll, HOST_RULES };

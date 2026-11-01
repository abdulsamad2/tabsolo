'use strict';

/** Lazy — profiles.js imports the parser pieces from here under Node (no Electron) too. */
const electronNet = () => require('electron').net;

/**
 * Jancy-compatible profile resolvers. A profile can carry one or more `Site:<pattern>` columns, each
 * holding a resolver string like `password=automatiq:TOKEN:92, smscode=textchest:APIKEY`. When
 * autofill runs on a page whose host matches the pattern (or whose main site label is the pattern),
 * the resolver is executed and its value fills the matching field.
 *
 * Reference: https://docs.jancy.io/docs/resolver-columns
 */

const FIELDS = ['password', 'smscode', 'emailcode', 'othercode'];
const DEFAULT_PARSER = 'ticketmaster';
// Longest first so "textchest-async" wins over "textchest" when auto-fixing a missing colon.
const KNOWN_RESOLVERS = [
  'textchest-async', 'textchest', 'automatiq', 'ticketsuite', 'victorylive1',
  'texttrove', 'seatheroes', 'seatheros', 'smsgateway', 'quick-text', 'lysted',
  '1ticket', 'wired', 'gmail', 'imap',
].sort((a, b) => b.length - a.length);

/** Parses one `Site:X` cell: `field=name:arg1:arg2, field=$literal, ...`. */
function parseResolverCell(cell) {
  const entries = [];
  const errors = [];
  const fixed = []; // resolver names whose missing colon was fixed
  const text = String(cell ?? '').trim();
  if (!text) return { entries, errors, fixed };
  for (const chunk of text.split(/\s*,\s*/)) {
    if (!chunk) continue;
    const eq = chunk.indexOf('=');
    if (eq === -1) { errors.push('A resolver has no field (expected field=resolver:args) and was skipped.'); continue; }
    const field = chunk.slice(0, eq).trim().toLowerCase();
    const value = chunk.slice(eq + 1).trim();
    if (!FIELDS.includes(field)) { errors.push(`Resolver field "${field}" is not one of ${FIELDS.join(', ')}.`); continue; }
    if (value.startsWith('$')) {
      entries.push({ field, resolver: 'static', value: value.slice(1) });
      continue;
    }
    const colon = value.indexOf(':');
    const rawName = colon === -1 ? value : value.slice(0, colon);
    let name = rawName.toLowerCase();
    let argsText = colon === -1 ? '' : value.slice(colon + 1);
    // Lenient: a cell like "smscode=textchestKEY" (missing colon) is a very common typo. If the
    // extracted "name" starts with a known resolver name, split it and warn.
    if (!KNOWN_RESOLVERS.includes(name)) {
      const prefix = KNOWN_RESOLVERS.find((known) => name.startsWith(known) && name.length > known.length);
      if (prefix) {
        const rest = rawName.slice(prefix.length); // an API key: keep its case
        // Not an error, and the value holds an API key: report only which resolver was fixed.
        fixed.push(prefix);
        argsText = argsText ? `${rest}:${argsText}` : rest;
        name = prefix;
      }
    }
    entries.push({ field, resolver: name, args: argsText ? argsText.split(':') : [] });
  }
  return { entries, errors, fixed };
}

/** True if `sitePattern` applies to the given tab URL or the profile's own site label. */
function matchesSite(sitePattern, tabUrl, profileSite) {
  const pattern = String(sitePattern ?? '').trim().toLowerCase();
  if (!pattern || pattern === '*') return true;
  if ((profileSite ?? '').trim().toLowerCase() === pattern) return true;
  try {
    const host = new URL(tabUrl).host.toLowerCase();
    if (host === pattern) return true;
    if (host.endsWith(`.${pattern}`) || host.endsWith(`.${pattern}.com`)) return true;
    if (host.includes(pattern)) return true;
  } catch {}
  return false;
}

/** First resolver entry whose Site column applies to this URL, for the given field. */
function pickResolver(profile, field, tabUrl) {
  const matches = pickAllResolvers(profile, field, tabUrl);
  return matches[0] ?? null;
}

/** Every entry whose Site column applies, in column-then-entry order — for try-until-it-works flow. */
function pickAllResolvers(profile, field, tabUrl) {
  const matches = [];
  for (const column of profile.resolvers ?? []) {
    if (!matchesSite(column.site, tabUrl, profile.site)) continue;
    for (const entry of column.entries) if (entry.field === field) matches.push(entry);
  }
  return matches;
}

// Jancy-documented site IDs for Automatiq.
const AUTOMATIQ_SITE_IDS = { ticketmaster: 92, axs: 276, seatgeek: 9 };
const AUTOMATIQ_HOST_TO_SITE = [
  ['ticketmaster.com', 92], ['ticketmaster.ca', 92], ['livenation.com', 92],
  ['axs.com', 276], ['axs.co.uk', 276],
  ['seatgeek.com', 9],
];

/** Runs a resolver entry. Returns { value } or { error } (never throws). */
async function runResolver(entry, profile, tabUrl) {
  try {
    if (entry.resolver === 'static') return { value: entry.value };
    if (entry.resolver === 'textchest' || entry.resolver === 'textchest-async') {
      return fetchTextChest(entry, profile);
    }
    if (entry.resolver === 'automatiq') {
      return fetchAutomatiq(entry, profile, tabUrl);
    }
    // Other Jancy resolvers (lysted, 1ticket, texttrove, wired, quick-text, smsgateway,
    // seatheroes, victorylive1, ticketsuite, gmail, imap) are recognised in the schema but have
    // provider-specific APIs; they return a clear "not wired up" error so autofill still runs.
    return { error: `#UNSUPPORTED resolver "${entry.resolver}"` };
  } catch (error) {
    return { error: `#RESOLVER ERROR: ${error.message}` };
  }
}

/**
 * TextChest REST API, per their docs:
 *   GET /sms?number=NUMBER                        — regular lines
 *   GET /sms?async_inbox=true&number=NUMBER       — async lines (textchest-async)
 * Auth is HTTP Basic with the API key as the username and an empty password:
 *   Authorization: Basic base64("API_KEY:")
 * Response is a JSON array sorted newest-first: [{ msg, ts, from }, …]
 */
const textChestActivated = new Set(); // `${apiKey}:${number}` entries we've already activated this run.

async function fetchTextChest(entry, profile) {
  const [apiKey, parser = DEFAULT_PARSER] = entry.args ?? [];
  if (!apiKey) return { error: '#NO API KEY' };
  const number = String(profile.smsNumber ?? '').replace(/\D/g, '');
  if (!number) return { error: '#NO SMS NUMBER' };

  const isAsync = entry.resolver === 'textchest-async';
  const basicHeader = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  // Async lines require a prior /activate call before messages arrive. Call it once per key+number
  // per run (TextChest returns the next number in the module so the user can activate the next slot
  // on the next cycle — that's a session concern we don't model here).
  if (isAsync) {
    const activationKey = `${apiKey}:${number}`;
    if (!textChestActivated.has(activationKey)) {
      try {
        const activateUrl = `https://api.textchest.com/activate?number=${encodeURIComponent(number)}`;
        const response = await electronNet().fetch(activateUrl, {
          headers: { Authorization: basicHeader, Accept: 'application/json' },
          redirect: 'follow',
        });
        if (response.ok) textChestActivated.add(activationKey);
        // Silence failures here — the /sms call will surface a clearer error if the number is dead.
      } catch { /* fall through to /sms */ }
    }
  }
  // Default URL from TextChest's own REST docs; env var still overrides.
  const base = process.env.TABSOLO_TEXTCHEST_URL || 'https://api.textchest.com/sms';
  const sep = base.includes('?') ? '&' : '?';
  const asyncParam = isAsync ? 'async_inbox=true&' : '';
  const url = `${base}${sep}${asyncParam}number=${encodeURIComponent(number)}&limit=10`;
  let host = '';
  try { host = new URL(url).host; } catch {}

  let response;
  try {
    response = await electronNet().fetch(url, {
      headers: { Authorization: basicHeader, Accept: 'application/json' },
      redirect: 'follow',
    });
  } catch (error) {
    return { error: `#API ERROR (${error.message}) → GET ${url}` };
  }
  if (response.status === 401 || response.status === 403) {
    return { error: `#API ERROR (HTTP ${response.status} from ${host} — key not accepted) → GET ${url}` };
  }
  if (!response.ok) return { error: `#API ERROR (HTTP ${response.status} from ${host}) → GET ${url}` };

  const text = (await response.text()).trim();
  if (!text) return { error: `#NO MSG (empty response from ${host} — no SMS on ${number} yet) → GET ${url}` };
  let data;
  try { data = JSON.parse(text); } catch { return { error: `#API ERROR (non-JSON from ${host}: ${text.slice(0, 80)}) → GET ${url}` }; }
  const messages = Array.isArray(data) ? data : (data?.data ?? data?.messages ?? []);
  if (!Array.isArray(messages) || messages.length === 0) {
    let why;
    if (Array.isArray(data) && data.length === 0) {
      why = `TextChest returned [] — no SMS received on ${number} yet (did you trigger the code? is the number correct?)`;
    } else if (data && typeof data === 'object') {
      const keys = Object.keys(data).slice(0, 5).join(', ');
      why = keys ? `response keys: ${keys}` : `TextChest returned {} — number likely needs activation or isn't yours`;
    } else {
      why = `unexpected response body: ${text.slice(0, 100)}`;
    }
    return { error: `#NO MSG (${why}) → GET ${url}` };
  }
  const sorted = [...messages].sort((a, b) => Number(b?.ts ?? 0) - Number(a?.ts ?? 0));
  for (const message of sorted) {
    const body = String(message?.msg ?? message?.message ?? message?.body ?? '');
    const code = extractCode(null, body);
    if (code) return { value: code };
  }
  const preview = String(sorted[0]?.msg ?? JSON.stringify(sorted[0] ?? {})).slice(0, 100).replace(/\s+/g, ' ');
  return { error: `#NO MSG (no digits in latest message: ${preview}) → GET ${url}` };
}

/** Finds the SMS body in a TextChest-style response. Walks arrays and wrappers like {data: [...]}. */
function pickMessageBody(data) {
  if (!data) return null;
  const candidates = ['message', 'body', 'text', 'sms', 'content'];
  const walk = (value) => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) { for (const item of value) { const found = walk(item); if (found) return found; } return null; }
    if (value && typeof value === 'object') {
      for (const key of candidates) if (typeof value[key] === 'string' && value[key]) return value[key];
      for (const nested of Object.values(value)) { const found = walk(nested); if (found) return found; }
    }
    return null;
  };
  return walk(data);
}

/**
 * Fetches a site-specific password for `profile.email` from Automatiq. The exact endpoint is not
 * documented publicly; override with TABSOLO_AUTOMATIQ_URL (placeholders: {token}, {email},
 * {company}, {site}). The default is a reasonable guess — users seeing "#API ERROR" should set
 * this to the URL from their Automatiq onboarding.
 */
async function fetchAutomatiq(entry, profile, tabUrl) {
  const [token, company, siteArg] = entry.args ?? [];
  if (!token) return { error: '#NO API TOKEN' };
  if (!company) return { error: '#NO COMPANY ID' };
  if (!profile.email) return { error: '#NO EMAIL' };
  // SITE-ID: -999 means "match by tab URL"; a known host maps to its documented id.
  let siteId = siteArg === undefined || siteArg === '' ? null : Number(siteArg);
  const byUrl = siteId === -999 || siteId === null;
  if (byUrl) {
    try {
      const host = new URL(tabUrl).host.toLowerCase();
      const match = AUTOMATIQ_HOST_TO_SITE.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
      if (!match) return { error: siteId === -999 ? '#NO ACCOUNT FOR URL' : '#NO SITE ID' };
      siteId = match[1];
    } catch {
      return { error: '#NO ACCOUNT FOR URL' };
    }
  }
  const template = process.env.TABSOLO_AUTOMATIQ_URL
    || 'https://api.automatiq.com/v1/accounts?email={email}&company_id={company}&site_id={site}';
  // {token} intentionally not substituted: the bearer goes in the Authorization header below.
  // Putting it in the URL would land it in access logs, proxy logs, and Chromium's net log.
  const url = template
    .replace('{email}', encodeURIComponent(profile.email))
    .replace('{company}', encodeURIComponent(company))
    .replace('{site}', encodeURIComponent(String(siteId)));
  const response = await electronNet().fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'follow',
  });
  if (!response.ok) return { error: '#API ERROR' };
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { return { error: '#API ERROR' }; }
  // Walk the response looking for an account whose site matches, then its password.
  const accounts = Array.isArray(data) ? data : (data.accounts ?? data.data ?? data.results ?? []);
  if (!Array.isArray(accounts) || accounts.length === 0) return { error: '#NO PASSWORD' };
  const matching = accounts.find((a) => Number(a.site_id ?? a.siteId ?? a.site) === siteId) ?? accounts[0];
  const password = matching?.password ?? matching?.pass ?? matching?.secret;
  if (!password) return { error: '#NO ACCOUNT' };
  return { value: String(password) };
}

function extractCode(data, raw) {
  const haystack = data ? JSON.stringify(data) : raw;
  const contextual = haystack.match(/(?:code|otp|pin|password)[^0-9]{0,8}(\d{4,8})/i);
  if (contextual) return contextual[1];
  const six = haystack.match(/\b\d{6}\b/);
  if (six) return six[0];
  const any = haystack.match(/\b\d{4,8}\b/);
  return any ? any[0] : '';
}

/** Returns { field: value } for every resolver that matches this tab URL. Errors are collected. */
async function resolveForTab(profile, tabUrl) {
  // If the profile carries a bare TextChest API key (no explicit resolver), synthesise one on
  // Site:* so autofill picks it up automatically.
  const resolvers = [...(profile.resolvers ?? [])];
  const hasTextchest = resolvers.some((c) => c.entries.some((e) => e.resolver === 'textchest' || e.resolver === 'textchest-async'));
  if (profile.textChestKey && !hasTextchest) {
    resolvers.push({ site: '*', entries: [{ field: 'smscode', resolver: 'textchest', args: [profile.textChestKey] }] });
  }
  const augmentedProfile = { ...profile, resolvers };

  const values = {};
  const errors = [];
  for (const field of FIELDS) {
    const entries = pickAllResolvers(augmentedProfile, field, tabUrl);
    for (const entry of entries) {
      const result = await runResolver(entry, augmentedProfile, tabUrl);
      if (result.value) { values[field] = result.value; break; }
      errors.push(`${field} (${entry.resolver}): ${result.error}`);
    }
  }
  return { values, errors };
}

/** Removes resolver secrets before sending the profile to the renderer. */
function sanitizeResolvers(resolvers) {
  return (resolvers ?? []).map((col) => ({
    site: col.site,
    entries: col.entries.map((e) => ({ field: e.field, resolver: e.resolver })),
  }));
}

/** Serialises resolvers to a user-editable, one-line-per-site format. Secrets are hidden. */
function resolversToText(resolvers) {
  return (resolvers ?? []).map((col) => {
    const entries = col.entries.map((e) => {
      if (e.resolver === 'static' && 'value' in e) return `${e.field}=$${e.value}`;
      return `${e.field}=${e.resolver}`;
    }).join(', ');
    return `Site:${col.site} → ${entries}`;
  }).join('\n');
}

/**
 * Parses the editor's resolver text back into resolvers, merging with the previous resolvers so
 * secrets survive when the user leaves the `:KEY` part blank.
 */
function resolversFromText(text, previous) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const previousByKey = new Map();
  for (const col of (previous ?? [])) {
    for (const entry of col.entries) {
      previousByKey.set(`${col.site.toLowerCase()}|${entry.field}`, entry);
    }
  }
  const resolvers = [];
  for (const line of lines) {
    const match = /^site\s*:\s*(.+?)\s*(?:→|=>|->|:\s{2,})\s*(.+)$/i.exec(line);
    if (!match) continue;
    const site = match[1].trim();
    const { entries } = parseResolverCell(match[2]);
    const merged = entries.map((entry) => {
      // If the user didn't supply args, keep the previously-saved ones (preserve the API key).
      if ((entry.args ?? []).length === 0 && entry.resolver !== 'static') {
        const prior = previousByKey.get(`${site.toLowerCase()}|${entry.field}`);
        if (prior && prior.resolver === entry.resolver && (prior.args ?? []).length > 0) {
          return { ...entry, args: prior.args };
        }
      }
      return entry;
    });
    if (merged.length) resolvers.push({ site, entries: merged });
  }
  return resolvers;
}

module.exports = {
  parseResolverCell, matchesSite, pickResolver, runResolver, resolveForTab, sanitizeResolvers,
  resolversToText, resolversFromText,
  FIELDS, AUTOMATIQ_SITE_IDS,
};

'use strict';

const { randomUUID } = require('node:crypto');

const SESSION_TOKEN = '{session}';
const COUNTRY_TOKEN = '{country}';

const DEFAULT_CONFIG = Object.freeze({
  startURL: 'https://www.google.com',
  tabCount: 4,
  isolation: 'perTab', // 'perTab' | 'shared'
  proxySource: 'none', // 'none' | 'list' | 'rotating' | 'remote'
  proxyList: '',
  startDirect: false, // start tabs on the local IP and switch them to a proxy later
  theme: 'system', // 'system' | 'light' | 'dark'
  rotating: { host: '', port: 8000, usernameTemplate: 'user-session-{session}', password: '', regions: 'us' },
  remote: { url: '', token: '' },
});

function normalizeConfig(raw = {}) {
  const theme = ['system', 'light', 'dark'].includes(raw.theme) ? raw.theme : DEFAULT_CONFIG.theme;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    tabCount: Math.min(50, Math.max(1, Number.parseInt(raw.tabCount ?? DEFAULT_CONFIG.tabCount, 10) || 1)),
    startDirect: Boolean(raw.startDirect),
    theme,
    rotating: { ...DEFAULT_CONFIG.rotating, ...(raw.rotating ?? {}) },
    remote: { ...DEFAULT_CONFIG.remote, ...(raw.remote ?? {}) },
  };
}

/** Splits a list like "us, ca gb" into lower-case region codes. */
function parseRegions(text) {
  return [...new Set(String(text ?? '').toLowerCase().split(/[\s,]+/).filter((code) => /^[a-z0-9_-]+$/.test(code)))];
}

/**
 * Parses `host:port`, `host:port:user:pass` or `user:pass@host:port`,
 * optionally prefixed with `http://` or `socks5://`, and optionally tagged
 * with a region first (`us host:port`).
 */
function splitRegion(text) {
  const tagged = /^([a-z0-9_-]+)\s+(\S+)$/i.exec(text);
  return tagged ? { region: tagged[1].toLowerCase(), text: tagged[2] } : { region: null, text };
}

function splitScheme(text) {
  const scheme = /^(socks5?|https?):\/\//i.exec(text);
  if (!scheme) return { kind: 'http', text };
  const kind = scheme[1].toLowerCase().startsWith('socks') ? 'socks5' : 'http';
  return { kind, text: text.slice(scheme[0].length) };
}

/** Returns `{ username, password, text }`, or null when credentials are malformed. */
function splitAtCredentials(text) {
  const at = text.lastIndexOf('@');
  if (at === -1) return { username: null, password: null, text };
  const credentials = text.slice(0, at);
  const colon = credentials.indexOf(':');
  if (colon === -1) return null;
  return {
    username: credentials.slice(0, colon),
    password: credentials.slice(colon + 1),
    text: text.slice(at + 1),
  };
}

/** Returns `{ host, port, username, password }`, or null when invalid. */
function parseEndpoint(text, username, password) {
  const parts = text.split(':');
  if (parts.length >= 4 && username === null) {
    // Password may contain colons.
    username = parts[2];
    password = parts.slice(3).join(':');
  } else if (parts.length !== 2) {
    return null;
  }
  const host = parts[0];
  const port = Number(parts[1]);
  const isValidPort = Number.isInteger(port) && port >= 1 && port <= 65535;
  if (!host || !isValidPort) return null;
  return { host, port, username, password };
}

function parseProxy(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const { region, text: untagged } = splitRegion(trimmed);
  const { kind, text: unschemed } = splitScheme(untagged);
  const creds = splitAtCredentials(unschemed);
  if (!creds) return null;
  const endpoint = parseEndpoint(creds.text, creds.username, creds.password);
  if (!endpoint) return null;
  return { kind, ...endpoint, region };
}

function parseProxyList(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(parseProxy)
    .filter(Boolean);
}

/** Downloads a plain-text, one-proxy-per-line list from an optional bearer-authenticated endpoint. */
function remoteProxyURL(remote) {
  const url = new URL(String(remote?.url ?? ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Proxy-list URL must use HTTP or HTTPS.');
  return url;
}

function remoteProxyHeaders(remote) {
  const headers = { accept: 'text/plain' };
  const token = String(remote?.token ?? '').trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function fetchRemoteProxyList(remote, fetchImpl = globalThis.fetch) {
  const url = remoteProxyURL(remote);
  if (typeof fetchImpl !== 'function') throw new Error('Remote proxy lists are unavailable in this runtime.');
  const response = await fetchImpl(url, { headers: remoteProxyHeaders(remote) });
  if (!response.ok) throw new Error(`Proxy-list request failed (${response.status}).`);
  const text = await response.text();
  if (parseProxyList(text).length === 0) throw new Error('The proxy-list endpoint returned no valid proxies.');
  return text;
}

function isValidPort(port) {
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber)) return false;
  return portNumber >= 1 && portNumber <= 65535;
}

/** Returns a user-facing problem with the config, or null when it can launch. */
function validateListConfig(config) {
  const proxies = parseProxyList(config.proxyList);
  if (proxies.length === 0) return 'Add at least one proxy (host:port or host:port:user:pass).';
  if (proxies.some((p) => p.kind === 'socks5' && p.username)) {
    return 'Chromium cannot authenticate to SOCKS5 proxies. Use HTTP proxies for user:pass lists.';
  }
  return null;
}

function validateRotatingConfig(config) {
  const { host, port, usernameTemplate, regions } = config.rotating;
  const template = String(usernameTemplate);
  if (!String(host).trim()) return 'Enter the gateway host.';
  if (!isValidPort(port)) return 'Port must be between 1 and 65535.';
  if (!template.includes(SESSION_TOKEN)) return `Username template must contain ${SESSION_TOKEN}.`;
  if (template.includes(COUNTRY_TOKEN) && parseRegions(regions).length === 0) {
    return `List at least one region code to fill ${COUNTRY_TOKEN}.`;
  }
  return null;
}

function validateRemoteConfig(config) {
  try {
    const url = new URL(String(config.remote.url));
    if (['http:', 'https:'].includes(url.protocol)) return null;
  } catch {
    // fall through
  }
  return 'Enter an HTTP or HTTPS proxy-list URL.';
}

const SOURCE_VALIDATORS = {
  list: validateListConfig,
  rotating: validateRotatingConfig,
  remote: validateRemoteConfig,
};

/** Returns a user-facing problem with the config, or null when it can launch. */
function validateConfig(config) {
  if (!toURL(config.startURL)) return 'Enter a start address.';
  const validator = SOURCE_VALIDATORS[config.proxySource];
  return validator ? validator(config) : null;
}

/**
 * Hands out proxies to sessions: list entries in round-robin order (per region when tagged),
 * or a fresh sticky session on a rotating gateway (each new session id is a new exit IP).
 */
// Default cooldown applied when a proxy misbehaves (connection refused, timeout, auth 407, 403 at
// the gateway, etc.). Short enough that a flaky proxy recovers naturally; long enough to avoid
// cycling through the same dead IP on every New IP click.
const COOLDOWN_MS = 5 * 60 * 1000;

function createPool(config) {
  const list = config.proxySource === 'list' ? parseProxyList(config.proxyList) : [];
  const template = config.rotating;
  const rotatingRegions = config.proxySource === 'rotating' && String(template.usernameTemplate).includes(COUNTRY_TOKEN)
    ? parseRegions(template.regions)
    : [];
  const nextIndex = new Map(); // region (or '' for all) -> position in its candidate list
  // key(proxy) → { until, reason } for the cooldown. Entries are pruned lazily on reads.
  const cooldown = new Map();
  const isCool = (proxy) => {
    const entry = cooldown.get(proxyKey(proxy));
    if (!entry) return false;
    if (entry.until <= Date.now()) { cooldown.delete(proxyKey(proxy)); return false; }
    return true;
  };
  const health = (candidates) => candidates.filter((p) => !isCool(p));

  return {
    enabled: config.proxySource === 'rotating' || list.length > 0,
    kind: config.proxySource === 'rotating' ? 'rotating' : 'list',
    list,
    // Identifies the gateway, so a proxy pinned to an account can be checked against the current pool.
    gatewayKey: config.proxySource === 'rotating' ? `${String(template.host).trim()}:${Number(template.port)}|${template.usernameTemplate}` : null,
    /** A proxy for one account: on a list, one that isn't in `taken` (other accounts' pins) if possible.
     * Rotates across free candidates so successive picks (e.g. repeated New IP on the same account)
     * walk the whole pool instead of toggling between the two lowest-index free proxies.
     * Skips any proxy currently in cooldown; falls back to a cooldown'd one only when nothing else
     * is available so we never hand back `null` just because the pool is temporarily hot. */
    pick(region = null, taken = new Set()) {
      if (config.proxySource === 'list') {
        const candidates = region ? list.filter((p) => p.region === region) : list;
        const freshFree = health(candidates.filter((p) => !taken.has(proxyKey(p))));
        if (freshFree.length > 0) {
          const key = `pick|${region ?? ''}`;
          const index = (nextIndex.get(key) ?? 0) % freshFree.length;
          nextIndex.set(key, index + 1);
          return freshFree[index];
        }
      }
      return this.next(region);
    },
    regions: config.proxySource === 'list' ? [...new Set(list.map((p) => p.region).filter(Boolean))] : rotatingRegions,
    nextFromList(region) {
      const candidates = region ? list.filter((p) => p.region === region) : list;
      if (candidates.length === 0) return null;
      const fresh = health(candidates);
      const hasFresh = fresh.length > 0;
      const pickFrom = hasFresh ? fresh : candidates; // last resort: everything is cool
      const key = (region ?? '') + (hasFresh ? '' : '|hot');
      const index = (nextIndex.get(key) ?? 0) % pickFrom.length;
      nextIndex.set(key, index + 1);
      return pickFrom[index];
    },
    nextRotating(region) {
      const chosen = rotatingRegions.includes(region) ? region : (rotatingRegions[0] ?? null);
      const session = randomUUID().replaceAll('-', '').slice(0, 10);
      return {
        kind: 'http',
        host: String(template.host).trim(),
        port: Number(template.port),
        username: template.usernameTemplate.replaceAll(SESSION_TOKEN, session).replaceAll(COUNTRY_TOKEN, chosen ?? ''),
        password: template.password || null,
        region: chosen,
      };
    },
    next(region = null) {
      if (config.proxySource === 'list') return this.nextFromList(region);
      if (config.proxySource === 'rotating') return this.nextRotating(region);
      return null;
    },
    /** Marks a proxy as misbehaving so pick()/next() skip it until the cooldown expires. Rotating
     * gateways share a key, so one bad session won't blacklist the whole gateway — on rotating,
     * markBad is a no-op (each next() produces a fresh session anyway). */
    markBad(proxy, reason, ms = COOLDOWN_MS) {
      if (!proxy || config.proxySource !== 'list') return;
      cooldown.set(proxyKey(proxy), { until: Date.now() + ms, reason: String(reason || 'bad') });
    },
    /** Returns { total, cool, cooldownEntries } so the UI can show "6 of 25 in cooldown". */
    coolStats() {
      // Prune expired entries first so counts are accurate.
      const now = Date.now();
      for (const [k, v] of cooldown) if (v.until <= now) cooldown.delete(k);
      return { total: list.length, cool: cooldown.size, entries: [...cooldown.entries()].map(([k, v]) => ({ key: k, until: v.until, reason: v.reason })) };
    },
    isCool,
  };
}

/** Identity of a proxy endpoint + login (not the password). */
function proxyKey(proxy) {
  return proxy ? `${proxy.kind}|${proxy.host}|${proxy.port}|${proxy.username ?? ''}` : '';
}

function proxyRule(proxy) {
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host;
  return `${proxy.kind === 'socks5' ? 'socks5' : 'http'}://${host}:${proxy.port}`;
}

/** Display text; never includes the password. */
function proxyLabel(proxy) {
  if (!proxy) return null;
  const address = `${proxy.kind === 'socks5' ? 'socks5://' : ''}${proxy.host}:${proxy.port}`;
  const label = proxy.username ? `${address} · ${proxy.username}` : address;
  return proxy.region ? `${proxy.region.toUpperCase()} · ${label}` : label;
}

/** Turns address-bar input into a URL: full URLs pass through, bare hosts get a scheme, anything else is a search. */
function toURL(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (/^(https?|about|file):/i.test(text)) return text;
  if (!/\s/.test(text)) {
    if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
    if (text.includes('.')) return `https://${text}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig,
  parseProxy,
  parseProxyList,
  fetchRemoteProxyList,
  parseRegions,
  validateConfig,
  createPool,
  proxyRule,
  proxyLabel,
  proxyKey,
  toURL,
};

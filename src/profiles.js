'use strict';

const { randomUUID } = require('node:crypto');
const { parseResolverCell, sanitizeResolvers, resolversFromText } = require('./resolvers');

/** RFC 4180 CSV: quoted fields, escaped quotes, CRLF or LF; also accepts tab- or semicolon-delimited files. */
function parseCSV(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const firstLine = source.split(/\r?\n/, 1)[0];
  const delimiter = [',', '\t', ';'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Excel's "keep as text" form ="012" (leading zeros, long numbers) becomes plain 012.
  return rows
    .map((r) => r.map((value) => value.replace(/^="(.*)"$/s, '$1')))
    .filter((r) => r.some((value) => value.trim() !== ''));
}

/**
 * Windows Excel saves "CSV" as UTF-8, UTF-8 with a BOM, ANSI (Windows-1252) or — for "Unicode Text" —
 * UTF-16 LE. Detect which so headers and values come through intact.
 */
function decodeTextFile(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  const text = buffer.toString('utf8');
  return text.includes('\uFFFD') ? buffer.toString('latin1') : text;
}

const normalizeHeader = (header) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

// Header aliases, matched after lower-casing and stripping spaces/punctuation.
const COLUMNS = {
  profile: ['profile', 'profilename', 'moniker'],
  name: ['name', 'fullname'],
  email: ['email', 'emailaddress'],
  password: ['password', 'loginpassword', 'accountpassword'],
  passwordUrl: ['passwordurl', 'passwordsync', 'passwordapi', 'passwordlink', 'passwordsyncurl'],
  passwordAuth: ['passwordauth', 'passwordauthorization', 'passwordtoken', 'passwordheader', 'passwordapikey'],
  otpUrl: ['otpurl', 'otpapi', 'otplink', 'otpsync', 'otpendpoint'],
  otpAuth: ['otpauth', 'otpauthorization', 'otptoken', 'otpheader', 'otpapikey'],
  textChestKey: ['textchest', 'textchestkey', 'textchesttoken', 'textchestapikey', 'textchestapi'],
  site: ['site', 'targetsite', 'website', 'domain', 'store'],
  group: ['group', 'profilegroup'],
  address1: ['address', 'address1', 'addressline1', 'street'],
  address2: ['address2', 'addressline2', 'apt', 'suite'],
  city: ['city'],
  state: ['state', 'province'],
  zip: ['zipcode', 'zip', 'postalcode', 'postcode'],
  country: ['country'],
  phone: ['phonenumber', 'phone', 'mobile'],
  smsNumber: ['smsnumber', 'sms', 'textchestnumber', 'number'],
  proxy: ['proxy'],
  // Jancy-compatible optional columns.
  favorite: ['favorite', 'favorites', 'star'],
  notes: ['notes', 'note'],
  url: ['url', 'homepage', 'targeturl'],
  dob: ['dob', 'dateofbirth', 'birthday', 'birthdate'],
  timeZone: ['timezone', 'tz'],
  buyer: ['buyer', 'buyers'],
  tabColor: ['tabcolor', 'color'],
  passcode: ['passcode', 'passcode1', 'passcodecc'],
  persistCookies: ['persistcookies'],
  persistSessions: ['persistsessions'],
};
const CARD_COLUMNS = {
  // "Passcode CC" holds a masked card (****1234) in Jancy sheets; its CVV / EXP sit in their own columns.
  number: ['cardnumber', 'ccnumber', 'creditcardnumber', 'ccnum', 'cardnum', 'cardno', 'creditcard', 'debitcardnumber',
    'passcodecc', 'ccpasscode', 'maskedcard', 'cardlast4', 'cclast4', 'last4'],
  name: ['cardname', 'nameoncard', 'cardholder', 'cardholdername', 'ccname'],
  expMonth: ['expmonth', 'expirationmonth', 'expirymonth', 'cardexpmonth', 'ccexpmonth', 'ccmonth', 'expmm'],
  expYear: ['expyear', 'expirationyear', 'expiryyear', 'cardexpyear', 'ccexpyear', 'ccyear', 'expyy', 'expyyyy'],
  // A single "MM/YY" column.
  expDate: ['expdate', 'expiry', 'expirydate', 'expiration', 'expirationdate', 'ccexp', 'ccexpdate', 'cardexp', 'cardexpiry', 'cardexpdate', 'exp', 'mmyy'],
  cvv: ['cvv', 'cvv2', 'cvc', 'cvc2', 'ccv', 'csc', 'cid', 'securitycode', 'cardsecuritycode', 'cardcvv', 'cardcvc', 'cccvv', 'cccvc', 'cvvcode', 'cvvnumber', 'cardcode', 'cardverificationcode'],
};

// Jancy's CC columns use "<field>:<set>" so one profile can carry several named cards.
// Headers are matched against the raw (pre-normalise) text so the ": <set>" survives.
const JANCY_CARD_FIELDS = {
  number: /^cc\s*number$/i,
  cvv: /^cc\s*cvv$/i,
  expDate: /^cc\s*exp\s*date$/i,
  name: /^cc\s*name$/i,
  address1: /^cc\s*address$/i,
  address2: /^cc\s*address\s*2$/i,
  city: /^cc\s*city$/i,
  state: /^cc\s*state$/i,
  zip: /^cc\s*zip$/i,
  note: /^cc\s*note$/i,
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function parseExpDate(text) {
  const value = String(text ?? '').trim();
  // Excel turns "03/28" into a date and saves it as "28-Mar" (or "Mar-28"): the number is the year.
  const excel = /^(\d{1,2})-([a-z]{3})$/i.exec(value) ?? /^([a-z]{3})-(\d{2})$/i.exec(value)?.slice().reverse();
  if (excel) {
    const month = MONTHS.indexOf(excel[2].toLowerCase()) + 1;
    if (month) return { expMonth: String(month).padStart(2, '0'), expYear: `20${excel[1].padStart(2, '0')}` };
  }
  const match = /^\s*(\d{1,2})\s*[\/-]\s*(\d{2,4})\s*$/.exec(value);
  if (!match) return { expMonth: '', expYear: '' };
  const expMonth = match[1].padStart(2, '0');
  const expYear = match[2].length === 2 ? `20${match[2]}` : match[2];
  return { expMonth, expYear };
}

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};
const CA_PROVINCES = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};
const isCanada = (country) => /^(ca|can|canada)$/i.test(String(country ?? '').trim());

/** States are kept as their 2-letter code ("virginia", "Va." → "VA"); anything unrecognised as typed. */
function normalizeState(value, country = '') {
  const text = String(value ?? '').trim().replace(/\.$/, '');
  if (!text) return '';
  const regions = isCanada(country) ? { ...CA_PROVINCES, ...US_STATES } : { ...US_STATES, ...CA_PROVINCES };
  if (/^[a-z]{2}$/i.test(text)) return text.toUpperCase();
  const lower = text.toLowerCase();
  const code = Object.keys(regions).find((c) => regions[c].toLowerCase() === lower);
  return code ?? text;
}

/** US ZIPs lose leading zeros in spreadsheets ("02134" → "2134"): pad them back to 5 digits. */
function normalizeZip(value, country = '') {
  const text = String(value ?? '').trim();
  const usa = !country || /^(us|usa|united states( of america)?)$/i.test(String(country).trim());
  if (usa && /^\d{3,4}$/.test(text)) return text.padStart(5, '0');
  if (usa && /^\d{3,4}-\d{4}$/.test(text)) return text.padStart(10, '0');
  return text;
}

/** Phone numbers are kept as 10 digits; a leading US country code is dropped. */
function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function normalizeMonth(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? digits.padStart(2, '0').slice(-2) : '';
}

function normalizeYear(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 2 ? `20${digits}` : digits;
}

/** Validates one card; returns `{ card }` or `{ error }`. Expiry is optional, but must be real when given. */
function normalizeCard(raw, fallbackName = '') {
  // A masked number ("****1234", "xxxx 1234") is a saved card known only by its last 4 digits: enough
  // to recognise it on a checkout page and fill its CVV.
  if (/^\s*\d(\.\d+)?e\+\d+\s*$/i.test(String(raw.number ?? ''))) {
    return { error: 'Card number was turned into scientific notation (like 4.11E+15) by Excel, which loses digits. Format the column as Text in Excel and export again.' };
  }
  const masked = MASKED_CARD.exec(String(raw.number ?? ''));
  const number = masked ? '' : String(raw.number ?? '').replace(/\D/g, '');
  const last4 = masked ? masked[1] : number.slice(-4);
  if (!masked && (number.length < 12 || number.length > 19)) return { error: 'Card number must be 12–19 digits.' };
  // Spreadsheets drop leading zeros ("012" → 12): pad back to the card's CVV length (Amex: 4).
  let cvv = String(raw.cvv ?? '').replace(/\D/g, '');
  if (cvv && cvv.length < 3) cvv = cvv.padStart(/^3[47]/.test(number) ? 4 : 3, '0');
  if (cvv && cvv.length > 4) return { error: 'CVV must be 3 or 4 digits.' };
  const expMonth = normalizeMonth(raw.expMonth);
  const expYear = normalizeYear(raw.expYear);
  if (expMonth && (Number(expMonth) < 1 || Number(expMonth) > 12)) return { error: 'Expiry month must be 01–12.' };
  if (expYear && expYear.length !== 4) return { error: 'Expiry year must be YY or YYYY.' };
  return { card: { number, last4, name: String(raw.name ?? '').trim() || fallbackName, expMonth, expYear, cvv } };
}

/**
 * Makes each CVV belong to its card. A "****1234" card from the Passcode columns is the same card as a
 * full number ending 1234 (its CVV and expiry go to that card); a CVV given on its own (the CVV column
 * with no card digits) belongs to the account's only card that has none. With several such cards it
 * can't be told which, so it stays on its own and the import says so.
 */
function attachCvvs(cards) {
  const result = [];
  const take = (into, from) => {
    if (!into.cvv && from.cvv) into.cvv = from.cvv;
    if (!into.expMonth && from.expMonth) Object.assign(into, { expMonth: from.expMonth, expYear: from.expYear });
  };
  for (const card of cards.filter((c) => c.number)) result.push(card);
  for (const card of cards.filter((c) => !c.number && c.last4)) {
    const same = result.find((c) => cardLast4(c) === card.last4);
    if (same) take(same, card);
    else result.push(card);
  }
  let warning = '';
  for (const card of cards.filter((c) => !c.number && !c.last4)) {
    const without = result.filter((c) => !c.cvv);
    if (without.length === 1) take(without[0], card);
    else if (result.length === 0 || without.length === 0) result.push(card);
    else {
      result.push(card);
      warning = `the CVV column can't be matched to one of its ${without.length} cards without a CVV; put each card's CVV next to its number.`;
    }
  }
  return { cards: result, warning };
}

/** A saved card known only by its CVV (and maybe expiry): no number or last 4. */
function cvvOnlyCard(raw, fallbackName = '') {
  const digits = String(raw.cvv ?? '').replace(/\D/g, '');
  if (!digits || digits.length > 4) return { error: 'CVV must be 3 or 4 digits.' };
  const expMonth = normalizeMonth(raw.expMonth);
  const expYear = normalizeYear(raw.expYear);
  return { card: { number: '', last4: '', name: String(raw.name ?? '').trim() || fallbackName, expMonth, expYear, cvv: digits.padStart(3, '0') } };
}

const MASKED_CARD = /^\s*[*•xX#.]+[\s*•xX#.-]*(\d{4})\s*$/;

/** Last 4 digits of a stored card (full-number cards and last-4-only cards alike). */
function cardLast4(card) {
  return card?.last4 || String(card?.number ?? '').slice(-4);
}

/**
 * Jancy sheets often keep a saved card in the Passcode columns: one cell "****1234", the next
 * "123" (its CVV). Turns each such pair into a last-4 card.
 */
function cardsFromPasscodes(values) {
  const cards = [];
  for (let i = 0; i < values.length; i++) {
    const masked = MASKED_CARD.exec(values[i] ?? '');
    if (!masked) continue;
    const next = String(values[i + 1] ?? '').trim();
    const cvv = /^\d{1,4}$/.test(next) ? next : '';
    cards.push({ number: values[i], cvv });
    if (cvv) i++;
  }
  return cards;
}

/**
 * Parses a profiles CSV (Jancy-compatible columns: Profile, Name, Email required; password, address,
 * phone and any number of cards as "Card Number", "Card Number 2", … optional).
 */
/** `defaultGroup` (e.g. the sheet's name) is used for rows whose Group column is empty. */
function parseProfilesCSV(text, { defaultGroup = '' } = {}) {
  const rows = parseCSV(text);
  if (rows.length === 0) return { profiles: [], errors: ['The file is empty.'] };

  const rawHeaders = rows[0].map((h) => String(h ?? '').trim());
  const headers = rawHeaders.map(normalizeHeader);
  const findColumn = (aliases, suffix = '') => headers.findIndex((h) => aliases.some((alias) => h === `${alias}${suffix}`));
  const columns = Object.fromEntries(Object.entries(COLUMNS).map(([key, aliases]) => [key, findColumn(aliases)]));
  // Jancy "Site:<pattern>" resolver columns are detected by their raw (pre-normalised) header.
  const siteColumns = rawHeaders
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => /^site\s*:/i.test(header))
    .map(({ header, index }) => ({ site: header.replace(/^site\s*:\s*/i, '').trim(), index }));

  // Jancy-style CC columns: "CC Number:<set>", "CC CVV:<set>", "CC Exp Date:<set>", etc. Each
  // unique <set> becomes a card. Headers are matched case-insensitively on the raw text so the
  // "<field>:<set>" structure survives (normaliser strips the colon).
  const jancyCardSets = new Map(); // setName -> { field -> index }
  for (let i = 0; i < rawHeaders.length; i++) {
    const colon = rawHeaders[i].indexOf(':');
    if (colon === -1) continue;
    const left = rawHeaders[i].slice(0, colon).trim();
    const setName = rawHeaders[i].slice(colon + 1).trim();
    if (!setName) continue;
    for (const [field, re] of Object.entries(JANCY_CARD_FIELDS)) {
      if (!re.test(left)) continue;
      if (!jancyCardSets.has(setName)) jancyCardSets.set(setName, {});
      jancyCardSets.get(setName)[field] = i;
      break;
    }
  }

  // Jancy-style repeating columns: Proxy / Proxy 2 / Proxy 3, Passcode / Passcode 2 / Passcode 3.
  const extraProxyIndexes = []; // additional proxy columns beyond the primary one
  const passcodeIndexes = [];
  if (columns.passcode !== -1) passcodeIndexes.push(columns.passcode);
  for (let n = 2; n <= 10; n++) {
    const p = findColumn(COLUMNS.proxy, String(n));
    if (p !== -1) extraProxyIndexes.push(p);
    const pc = findColumn(['passcode'], String(n));
    if (pc !== -1) passcodeIndexes.push(pc);
  }

  // Build a map of recognised columns + a list of ignored ones so the import report can show
  // "Recognised: Profile, Name, Email, TextChest … Ignored: My Mystery Column".
  const recognised = {};
  for (const [field, index] of Object.entries(columns)) {
    if (index !== -1) recognised[rawHeaders[index]] = field;
  }
  for (const sc of siteColumns) recognised[rawHeaders[sc.index]] = `Site:${sc.site}`;
  for (const [setName, byField] of jancyCardSets) {
    for (const [field, index] of Object.entries(byField)) recognised[rawHeaders[index]] = `card[${setName}].${field}`;
  }
  // Proxy columns are read only to say they're not used: accounts get proxies from the start-screen pool.
  for (const i of [columns.proxy, ...extraProxyIndexes].filter((i) => i !== -1)) {
    recognised[rawHeaders[i]] = 'not used: accounts get proxies from the start-screen pool';
  }
  for (const i of passcodeIndexes) recognised[rawHeaders[i]] = 'passcode / saved card (****1234 + CVV)';
  // Repeated card columns in our older format (Card Number 2, …) also count.
  for (let n = 1; n <= 10; n++) {
    for (const [field, aliases] of Object.entries(CARD_COLUMNS)) {
      const i = n === 1 ? (findColumn(aliases) !== -1 ? findColumn(aliases) : findColumn(aliases, '1')) : findColumn(aliases, String(n));
      if (i !== -1 && !(rawHeaders[i] in recognised)) recognised[rawHeaders[i]] = `card${n === 1 ? '' : n}.${field}`;
    }
  }
  const ignored = rawHeaders.filter((h) => h && !(h in recognised));

  const missing = ['profile', 'name', 'email'].filter((key) => columns[key] === -1);
  if (missing.length > 0) {
    return { profiles: [], errors: [`Missing required column(s): ${missing.map((k) => k[0].toUpperCase() + k.slice(1)).join(', ')}.`] };
  }

  // Card columns may repeat with a numeric suffix: "Card Number", "Card Number 2", ...
  const cardSets = [];
  for (let n = 1; n <= 10; n++) {
    const suffix = n === 1 ? '' : String(n);
    const set = Object.fromEntries(Object.entries(CARD_COLUMNS).map(([key, aliases]) => [
      key,
      findColumn(aliases, suffix) !== -1 || n !== 1 ? findColumn(aliases, suffix) : findColumn(aliases, '1'),
    ]));
    if (set.number !== -1) cardSets.push(set);
  }

  const profiles = [];
  const errors = [];
  const seen = new Set();
  const fixedResolvers = new Map(); // resolver name -> rows auto-fixed
  rows.slice(1).forEach((row, index) => {
    const line = index + 2;
    const get = (column) => (column === -1 ? '' : String(row[column] ?? '').trim());
    const profileName = get(columns.profile);
    // Rows with no profile, name or email (e.g. a list of spare proxies under the profiles) aren't profiles.
    if (!profileName && !get(columns.name) && !get(columns.email)) return;
    if (!profileName || !get(columns.name) || !get(columns.email)) {
      errors.push(`Line ${line}: Profile, Name and Email are required.`);
      return;
    }
    if (seen.has(profileName.toLowerCase())) {
      errors.push(`Line ${line}: duplicate profile "${profileName}" skipped.`);
      return;
    }
    seen.add(profileName.toLowerCase());

    const cards = [];
    // Our existing "Card Number", "Card Number 2" format.
    for (const set of cardSets) {
      const raw = {
        number: get(set.number), name: get(set.name), cvv: get(set.cvv),
        ...(get(set.expMonth) || get(set.expYear)
          ? { expMonth: get(set.expMonth), expYear: get(set.expYear) }
          : parseExpDate(get(set.expDate))),
      };
      // Only a CVV (the card is saved on the account, its digits aren't in the sheet): keep it for
      // the account's saved card at checkout.
      if (!raw.number && raw.cvv) {
        const { card, error } = cvvOnlyCard(raw, get(columns.name));
        if (error) errors.push(`Line ${line}: ${error} The CVV was skipped.`);
        else cards.push(card);
        continue;
      }
      if (!raw.number) continue;
      const { card, error } = normalizeCard(raw, get(columns.name));
      if (error) errors.push(`Line ${line}: ${error} The card was skipped.`);
      else cards.push(card);
    }
    // Jancy's "CC Number:<set>" format: build one card per named set.
    for (const [setName, byField] of jancyCardSets) {
      const number = byField.number !== undefined ? String(row[byField.number] ?? '').trim() : '';
      if (!number) continue;
      const { expMonth, expYear } = parseExpDate(byField.expDate !== undefined ? row[byField.expDate] : '');
      const cvv = byField.cvv !== undefined ? String(row[byField.cvv] ?? '').trim() : '';
      const name = byField.name !== undefined ? String(row[byField.name] ?? '').trim() : '';
      const { card, error } = normalizeCard({ number, cvv, expMonth, expYear, name }, get(columns.name));
      if (error) errors.push(`Line ${line}: ${error} The card "${setName}" was skipped.`);
      else cards.push(card);
    }

    // Jancy's repeating Proxy / Passcode columns.
    const passcodeCells = passcodeIndexes.map((i) => String(row[i] ?? '').trim());
    const passcodes = passcodeCells.filter(Boolean);
    for (const raw of cardsFromPasscodes(passcodeCells)) {
      const { card, error } = normalizeCard(raw, get(columns.name));
      if (error) { errors.push(`Line ${line}: ${error} The card in the Passcode columns was skipped.`); continue; }
      const same = cards.find((c) => cardLast4(c) === card.last4);
      if (!same) cards.push(card);
      else if (!same.cvv) same.cvv = card.cvv;
    }

    const paired = attachCvvs(cards);
    cards.splice(0, cards.length, ...paired.cards);
    if (paired.warning) errors.push(`Line ${line}: ${paired.warning}`);

    const resolvers = [];
    for (const sc of siteColumns) {
      const cell = String(row[sc.index] ?? '').trim();
      if (!cell) continue;
      const { entries, errors: rErrors, fixed } = parseResolverCell(cell);
      for (const err of rErrors) errors.push(`Line ${line}: ${err}`);
      for (const name of fixed) fixedResolvers.set(name, (fixedResolvers.get(name) ?? 0) + 1);
      if (entries.length > 0) resolvers.push({ site: sc.site, entries });
    }

    profiles.push({
      id: randomUUID(),
      profile: profileName,
      name: get(columns.name),
      email: get(columns.email),
      password: get(columns.password),
      passwordUrl: get(columns.passwordUrl),
      passwordAuth: get(columns.passwordAuth),
      otpUrl: get(columns.otpUrl),
      otpAuth: get(columns.otpAuth),
      site: get(columns.site),
      smsNumber: get(columns.smsNumber),
      textChestKey: get(columns.textChestKey),
      resolvers,
      passcodes,
      favorite: /^(1|true|yes|y)$/i.test(get(columns.favorite)),
      notes: String(row[columns.notes] ?? '').replace(/\\n/g, '\n').trim(),
      url: get(columns.url),
      dob: get(columns.dob),
      timeZone: get(columns.timeZone),
      buyer: get(columns.buyer),
      tabColor: get(columns.tabColor),
      passcode: get(columns.passcode),
      persistCookies: /^(1|true|yes|y)$/i.test(get(columns.persistCookies)),
      persistSessions: /^(1|true|yes|y)$/i.test(get(columns.persistSessions)),
      group: get(columns.group) || String(defaultGroup).trim(),
      address1: get(columns.address1),
      address2: get(columns.address2),
      city: get(columns.city),
      state: normalizeState(get(columns.state), get(columns.country)),
      zip: normalizeZip(get(columns.zip), get(columns.country)),
      country: get(columns.country),
      phone: normalizePhone(get(columns.phone)),
      cards,
    });
  });
  for (const [name, count] of fixedResolvers) {
    errors.push(`Fixed automatically: ${count} "${name}" resolver${count === 1 ? ' was' : 's were'} missing the colon after "${name}" (${name}:KEY).`);
  }
  return { profiles, errors, recognised, ignored };
}

/**
 * Creates or updates a profile from the editor. Secrets the window never sees are kept unless replaced:
 * an empty `password` keeps the saved one (`clearPassword` removes it), and `keepCards` lists the
 * indexes of saved cards to keep.
 */
function buildProfile(input, existing = null) {
  const text = (value) => String(value ?? '').trim();
  const errors = [];
  const profileName = text(input.profile);
  const name = text(input.name);
  const email = text(input.email);
  if (!profileName) errors.push('Profile name is required.');
  if (!name) errors.push('Full name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email address.');

  const keep = new Set(input.keepCards ?? []);
  const cards = (existing?.cards ?? []).filter((_, index) => keep.has(index));
  for (const raw of input.newCards ?? []) {
    const { card, error } = normalizeCard(raw, name);
    if (error) errors.push(`Card ending ${String(raw.number ?? '').replace(/\D/g, '').slice(-4) || '????'}: ${error}`);
    else cards.push(card);
  }

  let password = existing?.password ?? '';
  if (input.clearPassword) password = '';
  if (typeof input.password === 'string' && input.password !== '') password = input.password;

  // Sync URLs and their auth headers follow the same keep-unless-replaced rule as the password.
  const keepSecret = (name) => {
    let value = existing?.[name] ?? '';
    if (input[`clear${name[0].toUpperCase()}${name.slice(1)}`]) value = '';
    if (typeof input[name] === 'string' && input[name] !== '') value = input[name];
    return value;
  };
  const passwordUrl = keepSecret('passwordUrl');
  const passwordAuth = keepSecret('passwordAuth');
  const otpUrl = keepSecret('otpUrl');
  const otpAuth = keepSecret('otpAuth');
  const textChestKey = keepSecret('textChestKey');

  const profile = {
    id: existing?.id ?? randomUUID(),
    profile: profileName,
    name,
    email,
    password,
    passwordUrl,
    passwordAuth,
    otpUrl,
    otpAuth,
    site: text(input.site),
    smsNumber: text(input.smsNumber) || (existing?.smsNumber ?? ''),
    textChestKey,
    // Resolvers come from CSV/Sheet import by default; the editor can override via resolversText.
    resolvers: typeof input.resolversText === 'string'
      ? resolversFromText(input.resolversText, existing?.resolvers)
      : (existing?.resolvers ?? []),
    // The start-screen pool proxy pinned to this account (see main.js).
    pinnedProxy: existing?.pinnedProxy ?? null,
    // Names the account's saved session on disk; Clear all gives it a new one (see main.js).
    sessionKey: existing?.sessionKey ?? '',
    passcodes: existing?.passcodes ?? [],
    favorite: input.favorite !== undefined ? Boolean(input.favorite) : Boolean(existing?.favorite),
    notes: typeof input.notes === 'string' ? input.notes : (existing?.notes ?? ''),
    url: text(input.url) || (existing?.url ?? ''),
    dob: text(input.dob) || (existing?.dob ?? ''),
    timeZone: text(input.timeZone) || (existing?.timeZone ?? ''),
    buyer: text(input.buyer) || (existing?.buyer ?? ''),
    tabColor: text(input.tabColor) || (existing?.tabColor ?? ''),
    passcode: text(input.passcode) || (existing?.passcode ?? ''),
    persistCookies: input.persistCookies !== undefined ? Boolean(input.persistCookies) : Boolean(existing?.persistCookies),
    persistSessions: input.persistSessions !== undefined ? Boolean(input.persistSessions) : Boolean(existing?.persistSessions),
    group: text(input.group),
    address1: text(input.address1),
    address2: text(input.address2),
    city: text(input.city),
    state: normalizeState(text(input.state), text(input.country)),
    zip: normalizeZip(text(input.zip), text(input.country)),
    country: text(input.country),
    phone: normalizePhone(input.phone),
    cards,
  };
  return { profile, errors };
}

/**
 * What the window UI gets: everything except passwords, full card numbers, CVVs, proxies (all carry
 * passwords), passcodes (which can hold CVVs) and sync credentials.
 */
function publicProfile(profile) {
  const {
    cards, password, passwordAuth, otpAuth, textChestKey, resolvers,
    proxy: _sheetProxy, extraProxies: _sheetBackups, proxyIndex: _index, pinnedProxy, passcodes = [], passcode, ...rest
  } = profile;
  const host = (url) => { try { return new URL(url).host; } catch { return url || ''; } };
  return {
    ...rest,
    hasPassword: Boolean(password),
    hasPinnedProxy: Boolean(pinnedProxy),
    hasPasswordUrl: Boolean(profile.passwordUrl),
    hasOtpUrl: Boolean(profile.otpUrl),
    hasPasswordAuth: Boolean(passwordAuth),
    hasOtpAuth: Boolean(otpAuth),
    hasTextChestKey: Boolean(textChestKey),
    passwordUrlHost: host(profile.passwordUrl),
    otpUrlHost: host(profile.otpUrl),
    resolvers: sanitizeResolvers(resolvers),
    cards: cards.map((card) => ({
      last4: cardLast4(card), expMonth: card.expMonth, expYear: card.expYear, name: card.name,
      hasNumber: Boolean(card.number), hasCvv: Boolean(card.cvv),
    })),
  };
}

/**
 * Searches profiles by free text (profile/name/email/group/site/buyer/notes) with Jancy-style filter
 * operators: group:X, site:X, has:password, has:resolver, favorite (or fav).
 */
function searchProfiles(profiles, query) {
  const tokens = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return profiles;
  const terms = [];
  const requires = [];
  for (const token of tokens) {
    const [key, value] = token.includes(':') ? [token.slice(0, token.indexOf(':')), token.slice(token.indexOf(':') + 1)] : [null, token];
    if (!key) {
      if (token === 'favorite' || token === 'fav' || token === 'starred') {
        requires.push((p) => p.favorite);
      } else {
        terms.push(token);
      }
      continue;
    }
    if (key === 'group') requires.push((p) => (p.group ?? '').toLowerCase().includes(value));
    else if (key === 'site') requires.push((p) => (p.site ?? '').toLowerCase().includes(value)
      || (p.resolvers ?? []).some((c) => c.site.toLowerCase().includes(value)));
    else if (key === 'has') {
      if (value === 'password') requires.push((p) => p.hasPassword || Boolean(p.password));
      else if (value === 'resolver') requires.push((p) => (p.resolvers ?? []).length > 0);
      else if (value === 'card') requires.push((p) => (p.cards ?? []).length > 0);
    } else {
      terms.push(token); // Unknown operator: fall back to plain term.
    }
  }
  return profiles.filter((p) => {
    const haystack = `${p.profile} ${p.name} ${p.email} ${p.group ?? ''} ${p.site ?? ''} ${p.buyer ?? ''} ${p.notes ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term)) && requires.every((check) => check(p));
  });
}

/** Spreads profiles over tabs in order; with `repeat`, cycles them until every tab has one. */
function planAssignments(tabIds, profileIds, repeat) {
  if (profileIds.length === 0) return [];
  const count = repeat ? tabIds.length : Math.min(tabIds.length, profileIds.length);
  return tabIds.slice(0, count).map((tabId, i) => [tabId, profileIds[i % profileIds.length]]);
}

/**
 * Builds the page script that fills the visible form from a profile. It matches fields by their
 * `autocomplete` token first, then by name/id/placeholder/label text, and fires input/change events
 * so framework-driven forms (React, Vue, Angular) register the values. Returns the number of fields filled.
 */
function buildAutofillScript(profile, card, extras = {}) {
  const [first, ...rest] = profile.name.split(/\s+/);
  const values = {
    email: profile.email,
    password: extras.password ?? profile.password ?? '',
    otp: extras.otp ?? '',
    givenName: first ?? '',
    familyName: rest.join(' '),
    fullName: profile.name,
    tel: profile.phone,
    address1: profile.address1,
    address2: profile.address2,
    city: profile.city,
    state: normalizeState(profile.state, profile.country),
    zip: normalizeZip(profile.zip, profile.country),
    country: profile.country,
    // State / country dropdowns list names ("Virginia", "United States") as often as codes.
    stateName: (isCanada(profile.country) ? CA_PROVINCES : US_STATES)[normalizeState(profile.state, profile.country)]
      ?? US_STATES[normalizeState(profile.state)] ?? CA_PROVINCES[normalizeState(profile.state)] ?? '',
    ccName: card?.name ?? '',
    ccNumber: card?.number ?? '',
    ccExp: card?.expMonth ? `${card.expMonth}/${card.expYear.slice(-2)}` : '',
    ccExpMonth: card?.expMonth ?? '',
    ccExpYear: card?.expYear ?? '',
    ccCsc: card?.cvv ?? '',
    cardHasNumber: Boolean(card?.number),
    // Saved-card checkouts show "Visa ending in 4242" and ask only for its CVV: the page script
    // matches those digits to the profile's card and fills that card's CVV.
    cvvByLast4: cvvByLast4(profile.cards),
    cardHintLast4: extras.cardHintLast4 ?? '',
  };
  // OTP-only fill (the auto-OTP watcher): blank every value but the one-time code, so inserting the
  // arrived code never re-touches the rest of the form.
  if (extras.otpOnly) {
    for (const key of Object.keys(values)) {
      if (key === 'otp') continue;
      values[key] = typeof values[key] === 'boolean' ? false
        : (values[key] && typeof values[key] === 'object' ? {} : '');
    }
  }
  return `(${pageAutofill.toString()})(${JSON.stringify(values)})`;
}

function cvvByLast4(cards = []) {
  const map = {};
  for (const card of cards) {
    const last4 = cardLast4(card);
    if (last4.length === 4 && card.cvv && !(last4 in map)) map[last4] = card.cvv;
  }
  return map;
}

/**
 * Page script: the last-4 digits of masked cards shown on the page ("ending in 4242", "•••• 4242",
 * "**** 4242", "x4242"). `selected` lists those inside a checked radio / selected option, so a
 * saved-card list can tell which card is chosen. Used when the CVV box sits in a payment iframe that
 * can't see the card text itself.
 */
function pageCardDigits() {
  const MASKED = /(?:ending(?:\s+(?:in|with))?|ends?\s+(?:in|with)|last\s*(?:4|four)(?:\s*digits)?|[•*·xX#.]{2,}[\s-]*|\bx|\b(?:visa|master\s*card|amex|american\s+express|discover)\s*[-–—:]?)\s*[:-]?\s*(\d{4})(?!\d)/gi;
  const digits = (text) => [...new Set([...String(text ?? '').matchAll(MASKED)].map((m) => m[1]))];
  const selected = [];
  for (const el of document.querySelectorAll('input[type="radio"]:checked, [aria-checked="true"], [aria-selected="true"], option:checked')) {
    const scope = el.closest('label, li, tr, [role="radio"], [role="option"]') ?? el.parentElement;
    for (const d of digits(scope?.innerText ?? el.textContent)) if (!selected.includes(d)) selected.push(d);
  }
  return { all: digits(document.body?.innerText ?? ''), selected };
}

/** Picks the profile card the page is showing: a selected one first, else the only shown one that matches. */
function buildCardDigitsScript() {
  return `(${pageCardDigits.toString()})()`;
}

function chooseShownCard(shown, cards = []) {
  const ours = new Set(cards.map(cardLast4));
  const pick = (list) => {
    const matches = (list ?? []).filter((d) => ours.has(d));
    return matches.length === 1 ? matches[0] : '';
  };
  return pick(shown?.selected) || pick(shown?.all);
}

/* Runs inside the page; must be self-contained. */
function pageAutofill(values) {
  const CVV = /cvv|cvc|\bcsc\b|\bccv\b|\bcid\b|security.?code|card.?security|card.?code|card.?verif|verification.?(value|number)/;
  const RULES = [
    ['ccCsc', ['cc-csc'], CVV],
    ['otp', ['one-time-code'], /\botp\b|one.?time.?(code|password|pin)|\bverif(y|ication).?code\b|sms.?code|\bauth.?code\b|two.?factor|2fa|\bmfa\b|\btoken\b|confirmation.?code/],
    ['ccNumber', ['cc-number'], /card.?num|card.?no\b|cc.?num|cc.?no\b|cardnumber|credit.?card|debit.?card|\bpan\b|primary.?account/],
    ['ccExpMonth', ['cc-exp-month'], /exp\w*.?(month|mm\b)|cc.?month|\bmm\b/],
    ['ccExpYear', ['cc-exp-year'], /exp\w*.?(year|yy)|cc.?year|\byy(yy)?\b/],
    ['ccExp', ['cc-exp'], /exp(iry|iration)?.?(date)?|mm.?\/?.?yy/],
    ['ccName', ['cc-name'], /card.?holder|name.?on.?card|cc.?name|card.?name|holder.?name/],
    ['email', ['email', 'username'], /e-?mail|user.?name|\blog.?in(.?id)?\b|\baccount\b/],
    ['givenName', ['given-name'], /first.?name|fname|given|forename/],
    ['familyName', ['family-name'], /last.?name|lname|surname|family/],
    ['tel', ['tel', 'tel-national'], /phone|tel\b|mobile|cell/],
    // Postal code, country, state and city come before the street address: their fields are often
    // named "address.postalCode", "billingAddressState", "address-city"… which also say "address".
    ['zip', ['postal-code'], /\bzip|postal|post ?code/],
    ['country', ['country', 'country-name'], /country|\bnation\b/], // before state: "Country/Region"
    ['state', ['address-level1'], /\bstate\b|province|\bregion\b|\bcounty\b|address level ?1/],
    ['city', ['address-level2'], /\bcity\b|\btown\b|locality|suburb|address level ?2/],
    ['address2', ['address-line2'], /address ?(line)? ?2|\bline ?2\b|\bapt\b|apartment|suite|\bunit\b|floor/],
    ['address1', ['address-line1', 'street-address'], /address|street|\bline ?1\b/],
    ['fullName', ['name'], /full.?name|^name$|your.?name|^name[-_ ]?input$/],
  ];

  /** Reads every input, select and textarea in the document AND any open shadow roots. */
  const collectFields = (root) => {
    const out = [];
    const walk = (node) => {
      out.push(...node.querySelectorAll('input, select, textarea'));
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(root);
    return out;
  };

  const describe = (el) => {
    const forLabel = el.id && (el.getRootNode().querySelector?.(`label[for="${CSS.escape(el.id)}"]`)?.textContent ?? '');
    const wrapLabel = el.closest('label')?.textContent ?? '';
    const nearLabel = el.previousElementSibling?.tagName === 'LABEL' ? el.previousElementSibling.textContent : '';
    const parts = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('title'),
      el.getAttribute('data-testid'), el.getAttribute('data-qa'), el.getAttribute('autocomplete'),
      forLabel, wrapLabel, nearLabel];
    return parts.filter(Boolean).join(' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // billingAddressState → billing Address State
      .replace(/[_\-.[\]]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  };

  const visible = (el) => {
    if (el.disabled || el.readOnly) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  /** Sets a value in a way React/Vue controlled inputs accept, then fires the events a form expects. */
  const COUNTRY_NAMES = { us: ['united states', 'united states of america', 'usa', 'us'], ca: ['canada', 'can', 'ca'] };
  const setValue = (el, value, alternatives = []) => {
    if (el instanceof HTMLSelectElement) {
      const wanted = String(value).toLowerCase().trim();
      const names = [wanted, ...alternatives.map((a) => String(a).toLowerCase().trim()).filter(Boolean)];
      const option = [...el.options].find((o) => names.includes(o.value.toLowerCase().trim()) || names.includes(o.text.trim().toLowerCase()))
        || [...el.options].find((o) => /^\d+$/.test(wanted) && Number(o.value) === Number(wanted))
        || [...el.options].find((o) => wanted.length === 4 && o.text.trim() === wanted.slice(-2));
      if (!option) return false;
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    try { el.focus(); } catch {}
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  };

  const fields = collectFields(document).filter((el) => {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].includes(type) && visible(el);
  });
  const hasSplitName = fields.some((el) => /given-name|family-name/.test(el.autocomplete) || /first.?name|last.?name/.test(describe(el)));

  const result = { filled: 0, matched: 0, visible: fields.length, skipped: 0, iframes: document.querySelectorAll('iframe').length };

  // Masked card digits ("ending in 4242", "•••• 4242") in the CVV field's own surroundings: climb
  // the ancestors until some text shows a masked card, stopping before reaching page-sized blocks.
  const MASKED = /(?:ending(?:\s+(?:in|with))?|ends?\s+(?:in|with)|last\s*(?:4|four)(?:\s*digits)?|[•*·xX#.]{2,}[\s-]*|\bx|\b(?:visa|master\s*card|amex|american\s+express|discover)\s*[-–—:]?)\s*[:-]?\s*(\d{4})(?!\d)/gi;
  const maskedDigits = (text) => [...new Set([...String(text ?? '').matchAll(MASKED)].map((m) => m[1]))];
  const cvvMap = values.cvvByLast4 || {};
  const cardShownNear = (el) => {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const text = node.innerText || '';
      if (text.length > 4000) break;
      const found = maskedDigits(text);
      if (found.length === 1) return found[0];
      if (found.length > 1) {
        // A list of saved cards: use the checked one, else the only one that's on this profile.
        const checked = node.querySelector('input[type="radio"]:checked, [aria-checked="true"], [aria-selected="true"]');
        const scope = checked?.closest('label, li, tr, [role="radio"], [role="option"]') ?? checked?.parentElement;
        const chosen = maskedDigits(scope?.innerText ?? '');
        if (chosen.length === 1) return chosen[0];
        const ours = found.filter((d) => d in cvvMap);
        return ours.length === 1 ? ours[0] : '';
      }
    }
    return '';
  };
  /** CVV for this field: the card shown next to it, else the card shown on the page, else the chosen card. */
  // A frame with a card-number box is a new-card form: its CVV belongs to the card being typed, so
  // a saved card mentioned on the page must not override it.
  const newCardForm = fields.some((el) => (el.getAttribute('autocomplete') || '').toLowerCase().endsWith('cc-number')
    || /card.?num|card.?no\b|cc.?num|cc.?no\b|cardnumber/.test(describe(el)));
  const cvvFor = (el) => {
    // On a new-card form the CVV must belong to the number being typed in.
    if (newCardForm) return values.cardHasNumber ? values.ccCsc : '';
    if (Object.keys(cvvMap).length === 0) return values.ccCsc;
    const shown = cardShownNear(el) || values.cardHintLast4;
    if (!shown) return values.ccCsc;
    if (shown in cvvMap) {
      result.cvvCard = shown;
      return cvvMap[shown];
    }
    result.cvvMismatch = shown; // never type another card's CVV
    return '';
  };

  // Pre-pass: card number split across short-maxlength inputs (common in older checkouts). Fill one
  // slice per input so the main loop then skips them (they're no longer empty).
  const ccDigits = String(values.ccNumber || '').replace(/\D/g, '');
  if (ccDigits.length >= 12) {
    const run = [];
    for (const el of fields) {
      if (el instanceof HTMLSelectElement) continue;
      const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).pop();
      const text = describe(el);
      const isCcNum = autocomplete === 'cc-number'
        || /card.?num|card.?no\b|cc.?num|cc.?no\b|cardnumber|credit.?card|debit.?card|\bpan\b/.test(text);
      const maxLen = Number(el.getAttribute('maxlength')) || 0;
      if (isCcNum && maxLen >= 3 && maxLen <= 6) run.push({ el, maxLen });
    }
    if (run.length >= 3) {
      let offset = 0;
      for (const { el, maxLen } of run) {
        if (el.value) { offset += el.value.length; continue; }
        const chunk = ccDigits.slice(offset, offset + maxLen);
        if (chunk && setValue(el, chunk)) { offset += chunk.length; result.filled++; result.matched++; }
      }
    }
  }
  for (const el of fields) {
    if (el.value && !(el instanceof HTMLSelectElement)) { result.skipped++; continue; }
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).pop();
    const text = describe(el);
    let key;
    if (el.type === 'password') {
      if (autocomplete === 'cc-csc' || (autocomplete !== 'one-time-code' && CVV.test(text))) {
        key = 'ccCsc'; // some checkouts mask the CVV as a password field
      } else if (autocomplete === 'one-time-code' || /\botp\b|one.?time|verif(y|ication).?code|sms.?code|\bauth.?code\b|two.?factor|2fa/.test(text)) {
        key = 'otp'; // some sites mask the one-time code as a password field
      } else if (autocomplete === 'new-password' || /\bnew\b|confirm|repeat|retype/.test(text)) {
        continue; // login forms only: never fill a sign-up or change-password field
      } else {
        key = 'password';
      }
    } else {
      const rule = RULES.find(([, tokens]) => tokens.includes(autocomplete))
        || RULES.find(([, , pattern]) => pattern.test(text));
      if (!rule) continue;
      [key] = rule;
    }
    if (key === 'fullName' && hasSplitName) continue;
    if (key === 'email' && autocomplete === 'username' && !/@/.test(values.email)) continue;
    result.matched++;
    const value = key === 'ccCsc' ? cvvFor(el) : values[key];
    let alternatives = [];
    if (key === 'state') alternatives = [values.stateName];
    if (key === 'country') {
      const c = String(values.country).toLowerCase().trim();
      alternatives = Object.values(COUNTRY_NAMES).find((list) => list.includes(c)) ?? [];
    }
    // A 2-character state box gets the code; a wider one with a name-only hint gets the full name.
    const fitted = key === 'state' && !(el instanceof HTMLSelectElement) && el.maxLength > 2 && /\bstate name\b|full state/.test(text) && values.stateName
      ? values.stateName : value;
    if (fitted && setValue(el, fitted, alternatives)) result.filled++;
  }
  return result;
}

/** Script to run in-page: finds the best primary-action button and clicks it. */
function pageSubmit() {
  const EXPAND = /^\s*(\+\s*)?(add(\s+(new|another))?\s+(address|card|payment|contact)|new\s+(address|card))\s*$/i;
  const PRIMARY = /^(continue|next|save|submit|confirm|proceed|place\s+order|checkout|book|buy|pay|update|add|done)$/i;
  const LOGIN = /^(log\s*in|sign\s*in|signin|login)$/i;

  const visible = (el) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (el) => (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
  const allClickable = () => [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]')].filter(visible);

  // Any editable inputs visible? If not, try to expand an "Add new address" style section.
  const fields = [...document.querySelectorAll('input, select, textarea')].filter((el) => {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].includes(type) && visible(el);
  });
  if (fields.length === 0) {
    const expand = allClickable().find((el) => EXPAND.test(textOf(el)));
    if (expand) { expand.click(); return { expanded: textOf(expand) }; }
    return { expanded: null, submitted: null, reason: 'No form and no "Add new…" trigger found.' };
  }

  const score = (el) => {
    const text = textOf(el).toLowerCase();
    let s = 0;
    if (el.type === 'submit') s += 15;
    if (LOGIN.test(text)) s += 25;
    if (PRIMARY.test(text)) s += 20;
    if (/primary|cta|btn[-_ ]?primary|submit/i.test(el.className || '')) s += 5;
    if (/cancel|back|reset|close|skip/i.test(text)) s -= 50;
    // Nearest form's own submit beats a page-level one.
    if (el.form && el.form === fields[0]?.form) s += 8;
    return s;
  };
  const best = allClickable().filter((el) => score(el) > 0).sort((a, b) => score(b) - score(a))[0];
  if (!best) return { expanded: null, submitted: null, reason: `No primary action button among ${allClickable().length} visible buttons.` };
  best.click();
  return { expanded: null, submitted: textOf(best).slice(0, 40) };
}

/** Returns an IIFE script string that executes `pageSubmit` in the page. */
function buildSubmitScript() { return `(${pageSubmit.toString()})()`; }

/**
 * Serialises the saved profiles back to a CSV in the same column shape we accept on import, so a
 * user can edit in Excel and re-import. Secrets (card number, CVV, password, OTP auth, TextChest
 * key) are omitted — put them back by hand before importing.
 */
function profilesToCSV(profiles) {
  const headers = [
    'Profile', 'Group', 'Name', 'Email', 'Site', 'Phone Number', 'SMS Number',
    'Address', 'Address 2', 'City', 'State', 'Zip Code', 'Country',
    'DOB', 'Favorite', 'Notes', 'URL', 'Buyer',
  ];
  const siteSet = new Map();
  for (const p of profiles) {
    for (const col of (p.resolvers ?? [])) {
      const header = `Site:${col.site}`;
      if (!siteSet.has(header)) siteSet.set(header, true);
    }
  }
  const siteHeaders = [...siteSet.keys()];
  const maxCards = Math.max(0, ...profiles.map((p) => (p.cards ?? []).length));
  const cardHeaders = [];
  for (let n = 1; n <= maxCards; n++) {
    const suffix = n === 1 ? '' : ` ${n}`;
    cardHeaders.push(`Card Number${suffix}`, `Exp Month${suffix}`, `Exp Year${suffix}`);
  }
  const allHeaders = [...headers, ...siteHeaders, ...cardHeaders];

  const escape = (value) => {
    const text = String(value ?? '');
    return /["\n,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [allHeaders.map(escape).join(',')];
  for (const p of profiles) {
    const base = [
      p.profile, p.group, p.name, p.email, p.site, p.phone, p.smsNumber,
      p.address1, p.address2, p.city, p.state, p.zip, p.country,
      p.dob, p.favorite ? '1' : '', p.notes?.replace(/\n/g, '\\n'), p.url, p.buyer,
    ];
    const sites = siteHeaders.map((header) => {
      const site = header.slice('Site:'.length);
      const col = (p.resolvers ?? []).find((c) => c.site === site);
      if (!col) return '';
      return col.entries.map((e) => {
        if (e.resolver === 'static' && 'value' in e) return `${e.field}=$${e.value}`;
        return `${e.field}=${e.resolver}${(e.args ?? []).length ? ':' + e.args.join(':') : ''}`;
      }).join(', ');
    });
    const cards = [];
    for (let n = 0; n < maxCards; n++) {
      const card = (p.cards ?? [])[n];
      cards.push('', card?.expMonth ?? '', card?.expYear ?? ''); // Card Number intentionally blank for safety
    }
    rows.push([...base, ...sites, ...cards].map(escape).join(','));
  }
  return rows.join('\n');
}

/**
 * A profile as it may be written to disk without encryption: no cards, passwords, Sync credentials,
 * or passcodes (which can hold CVVs). The pinned pool proxy is kept whole, as its credentials are the
 * start-screen pool's (already in config.json).
 */
function withoutSecrets(profile) {
  return {
    ...profile,
    cards: [],
    password: '',
    passwordUrl: '',
    passwordAuth: '',
    otpUrl: '',
    otpAuth: '',
    textChestKey: '',
    passcode: '',
    passcodes: [],
  };
}

/**
 * Merges imported accounts into the saved ones. An account is its email (else its name and Profile
 * label): the match keeps its id, and so its cookies, logins, pinned proxy and tabs. A row whose Profile
 * label now holds a different person is a new account; the old one is kept, renamed "<label> (old)",
 * so no account ever takes over another's session. Returns the merged list and notes for the report.
 */
function mergeImported(existing, imported) {
  const merged = [...existing];
  const renamed = [];
  const used = new Set();
  const lower = (v) => String(v ?? '').trim().toLowerCase();
  const sameGroup = (a, b) => !a.group || lower(a.group) === lower(b.group);
  const free = (p) => !used.has(p.id);
  for (const profile of imported) {
    const email = lower(profile.email);
    let index = merged.findIndex((p) => free(p) && email && lower(p.email) === email && sameGroup(p, profile));
    if (index === -1) index = merged.findIndex((p) => free(p) && email && lower(p.email) === email);
    if (index === -1) {
      index = merged.findIndex((p) => free(p) && sameGroup(p, profile) && lower(p.profile) === lower(profile.profile) && lower(p.name) === lower(profile.name));
    }
    // The label now belongs to this account: another account still holding it is kept as "(old)".
    const holder = merged.find((p, i) => i !== index && free(p) && sameGroup(p, profile) && lower(p.profile) === lower(profile.profile));
    if (holder) {
      let label = `${holder.profile} (old)`;
      for (let n = 2; merged.some((p) => sameGroup(p, holder) && lower(p.profile) === lower(label)); n++) label = `${holder.profile} (old ${n})`;
      renamed.push({ holder, label: profile.profile, by: profile.email });
      holder.profile = label;
    }
    if (index !== -1) {
      // Keep each saved field unless the imported row carries a non-empty replacement. A CSV with
      // only Email/Name columns used to overwrite the saved password, cards, resolvers and address
      // with empty strings — silent data loss. Fields the editor UI explicitly clears go through
      // buildProfile, not through here.
      const existing = merged[index];
      const isPresent = (v) => Array.isArray(v) ? v.length > 0 : (typeof v === 'string' ? v !== '' : v != null);
      const next = { ...existing };
      for (const key of Object.keys(profile)) {
        if (isPresent(profile[key])) next[key] = profile[key];
      }
      next.id = existing.id;
      next.pinnedProxy = existing.pinnedProxy ?? null;
      next.sessionKey = existing.sessionKey ?? '';
      merged[index] = next;
      used.add(existing.id);
    } else {
      merged.push(profile);
      used.add(profile.id);
    }
  }
  // Accounts whose own row gave them a label later aren't "old": only report the ones that stayed renamed.
  const notes = renamed.filter(({ holder }) => !used.has(holder.id)).map(({ holder, label, by }) =>
    `"${label}" now belongs to ${by}; the previous account (${holder.email}) was kept as "${holder.profile}".`);
  return { profiles: merged, notes };
}

module.exports = {
  withoutSecrets,
  mergeImported,
  normalizeState, normalizeZip, decodeTextFile, parseCSV, parseProfilesCSV, buildProfile, normalizeCard, publicProfile, searchProfiles, planAssignments,
  buildAutofillScript, buildSubmitScript, buildCardDigitsScript, chooseShownCard, cardLast4, normalizePhone, profilesToCSV,
};

'use strict';

// Override for tests; always points at docs.google.com in production.
const SHEETS_BASE = process.env.TABSOLO_SHEETS_BASE || 'https://docs.google.com';
const BASE_HOST = new URL(SHEETS_BASE).host;

/**
 * Accepts a normal sheet URL (/spreadsheets/d/<id>/edit), a "Publish to the web" URL
 * (/spreadsheets/d/e/<pub-id>/pubhtml), or a bare spreadsheet id.
 * Returns { id, gid, published } — `published: true` means the sheet is read anonymously
 * through its public /pub endpoint instead of the owner-only /export endpoint.
 */
function parseSheetURL(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const publishedId = /\/spreadsheets\/d\/e\/([a-zA-Z0-9_-]+)/.exec(text)?.[1];
  if (publishedId) {
    const gid = /[#&?]gid=(\d+)/.exec(text)?.[1];
    return { id: publishedId, gid: gid === undefined ? null : Number(gid), published: true };
  }
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(text)?.[1]
    ?? (/^[a-zA-Z0-9_-]{25,}$/.test(text) ? text : null);
  if (!id) return null;
  const gid = /[#&?]gid=(\d+)/.exec(text)?.[1];
  return { id, gid: gid === undefined ? null : Number(gid), published: false };
}

/** The sheet's CSV endpoint; /pub for published sheets (no sign-in), /export for owner-visible sheets. */
function csvExportURL({ id, gid, published }) {
  if (published) {
    const params = new URLSearchParams({ output: 'csv' });
    if (gid !== null && gid !== undefined) {
      params.set('gid', String(gid));
      params.set('single', 'true');
    }
    return `${SHEETS_BASE}/spreadsheets/d/e/${id}/pub?${params}`;
  }
  const params = new URLSearchParams({ format: 'csv' });
  if (gid !== null && gid !== undefined) params.set('gid', String(gid));
  return `${SHEETS_BASE}/spreadsheets/d/${id}/export?${params}`;
}

/** The user-facing view URL for a sheet, so the window can open the right page. */
function viewURL({ id, gid, published }) {
  if (published) {
    return `${SHEETS_BASE}/spreadsheets/d/e/${id}/pubhtml${gid !== null && gid !== undefined ? `?gid=${gid}&single=true` : ''}`;
  }
  return `${SHEETS_BASE}/spreadsheets/d/${id}/edit${gid !== null && gid !== undefined ? `#gid=${gid}` : ''}`;
}

/** The page that lists a workbook's sheet tabs: /htmlview for owner-visible sheets, /pubhtml when published. */
function sheetListURL({ id, published }) {
  return published ? `${SHEETS_BASE}/spreadsheets/d/e/${id}/pubhtml` : `${SHEETS_BASE}/spreadsheets/d/${id}/htmlview`;
}

const decodeJS = (text) => text
  .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  .replace(/\\(.)/g, '$1');
const decodeHTML = (text) => text
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * The sheet tabs ({ name, gid }) of a workbook, read from its /htmlview page
 * (`items.push({name: "WiLL", …, gid: "0"…`) or its /pubhtml page (`<li id="sheet-button-0"><a…>WiLL</a>`).
 */
function parseSheetList(html) {
  const text = String(html ?? '');
  const sheets = [];
  for (const m of text.matchAll(/items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)",[^}]*?gid:\s*"(\d+)"/g)) {
    sheets.push({ name: decodeJS(m[1]).trim(), gid: Number(m[2]) });
  }
  if (sheets.length === 0) {
    for (const m of text.matchAll(/id="sheet-button-(\d+)"[^>]*>\s*<a[^>]*>([^<]*)<\/a>/g)) {
      sheets.push({ name: decodeHTML(m[2]).trim(), gid: Number(m[1]) });
    }
  }
  return sheets.filter((sheet, i) => sheets.findIndex((other) => other.gid === sheet.gid) === i);
}

/** True when the URL points at a Google Sheets page (ignoring query strings and fragments). */
function isSheetsURL(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.host === BASE_HOST && /\/spreadsheets\/d\/(?:e\/)?[a-zA-Z0-9_-]+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

module.exports = {
  sheetListURL, parseSheetList, parseSheetURL, csvExportURL, viewURL, isSheetsURL, SHEETS_BASE };

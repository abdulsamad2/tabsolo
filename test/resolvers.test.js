'use strict';

// resolvers.js lazy-requires Electron; parser functions here never trigger the require.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResolverCell, matchesSite, pickResolver, resolversFromText, resolversToText, FIELDS } = require('../src/resolvers');

test('exposes the Jancy field names', () => {
  assert.deepEqual(FIELDS, ['password', 'smscode', 'emailcode', 'othercode']);
});

test('parses a resolver cell with multiple entries', () => {
  const { entries, errors } = parseResolverCell('password=automatiq:TOKEN:92, smscode=textchest:APIKEY');
  assert.deepEqual(errors, []);
  assert.deepEqual(entries, [
    { field: 'password', resolver: 'automatiq', args: ['TOKEN', '92'] },
    { field: 'smscode', resolver: 'textchest', args: ['APIKEY'] },
  ]);
});

test('parses TextChest with and without a parser', () => {
  assert.deepEqual(parseResolverCell('smscode=textchest:KEY').entries, [
    { field: 'smscode', resolver: 'textchest', args: ['KEY'] },
  ]);
  assert.deepEqual(parseResolverCell('smscode=textchest:KEY:axs').entries, [
    { field: 'smscode', resolver: 'textchest', args: ['KEY', 'axs'] },
  ]);
});

test('parses the rent-a-number OTP providers (5sim, sms-activate)', () => {
  assert.deepEqual(parseResolverCell('smscode=5sim:TOKEN:11631253').entries, [
    { field: 'smscode', resolver: '5sim', args: ['TOKEN', '11631253'] },
  ]);
  assert.deepEqual(parseResolverCell('smscode=smsactivate:KEY:987654').entries, [
    { field: 'smscode', resolver: 'smsactivate', args: ['KEY', '987654'] },
  ]);
  assert.deepEqual(parseResolverCell('smscode=sms-activate:KEY:987654').entries, [
    { field: 'smscode', resolver: 'sms-activate', args: ['KEY', '987654'] },
  ]);
});

test('parses Automatiq with and without a SITE-ID', () => {
  assert.deepEqual(parseResolverCell('password=automatiq:TOKEN:42').entries, [
    { field: 'password', resolver: 'automatiq', args: ['TOKEN', '42'] },
  ]);
  assert.deepEqual(parseResolverCell('password=automatiq:TOKEN:42:-999').entries, [
    { field: 'password', resolver: 'automatiq', args: ['TOKEN', '42', '-999'] },
  ]);
});

test('parses static ($-prefixed) literal values', () => {
  assert.deepEqual(parseResolverCell('password=$hunter2').entries, [
    { field: 'password', resolver: 'static', value: 'hunter2' },
  ]);
});

test('rejects unknown fields and malformed cells', () => {
  const { entries, errors } = parseResolverCell('foo=bar:baz, password');
  assert.equal(entries.length, 0);
  assert.equal(errors.length, 2);
});

test('matchesSite handles *, hostname, and profile.site label', () => {
  assert.equal(matchesSite('*', 'https://example.com', ''), true);
  assert.equal(matchesSite('ticketmaster', 'https://www.ticketmaster.com/x', ''), true);
  assert.equal(matchesSite('ticketmaster.com', 'https://presale.ticketmaster.com', ''), true);
  assert.equal(matchesSite('AXS', 'https://nowhere.example', 'axs'), true);
  assert.equal(matchesSite('AXS', 'https://nowhere.example', ''), false);
});

test('resolversToText serialises without exposing secrets', () => {
  const text = resolversToText([
    { site: 'Ticketmaster', entries: [
      { field: 'password', resolver: 'automatiq', args: ['TOKEN', '92'] },
      { field: 'smscode', resolver: 'textchest', args: ['KEY'] },
    ]},
    { site: 'AXS', entries: [{ field: 'password', resolver: 'static', value: 'hunter2' }] },
  ]);
  // Secrets are stripped; static values are shown with the $ prefix (not a secret per se).
  assert.ok(text.includes('Site:Ticketmaster → password=automatiq, smscode=textchest'));
  assert.ok(text.includes('Site:AXS → password=$hunter2'));
  assert.ok(!text.includes('TOKEN'));
  assert.ok(!text.includes('KEY'));
});

test('resolversFromText keeps saved args when the user types the resolver name only', () => {
  const previous = [{ site: 'Ticketmaster', entries: [
    { field: 'smscode', resolver: 'textchest', args: ['SECRET'] },
  ]}];
  // User types the resolver with no args — should preserve SECRET.
  const parsed = resolversFromText('Site:Ticketmaster → smscode=textchest', previous);
  assert.deepEqual(parsed, [{ site: 'Ticketmaster', entries: [
    { field: 'smscode', resolver: 'textchest', args: ['SECRET'] },
  ]}]);
});

test('resolversFromText accepts arrow, colon, and equals separators between site and entries', () => {
  for (const sep of [' → ', ' => ', ' -> ']) {
    const parsed = resolversFromText(`Site:AXS${sep}smscode=textchest:K`, []);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].site, 'AXS');
    assert.deepEqual(parsed[0].entries[0].args, ['K']);
  }
});

test('pickResolver picks the first matching Site column for the field', () => {
  const profile = {
    site: 'Ticketmaster',
    resolvers: [
      { site: 'AXS', entries: [{ field: 'smscode', resolver: 'textchest', args: ['K1'] }] },
      { site: 'Ticketmaster', entries: [{ field: 'smscode', resolver: 'textchest', args: ['K2'] }] },
    ],
  };
  const entry = pickResolver(profile, 'smscode', 'https://www.ticketmaster.com/event');
  assert.deepEqual(entry, { field: 'smscode', resolver: 'textchest', args: ['K2'] });
  assert.equal(pickResolver(profile, 'password', 'https://www.ticketmaster.com'), null);
});

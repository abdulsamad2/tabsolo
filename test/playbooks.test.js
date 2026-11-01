'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fillRedacted } = require('../src/playbooks');
const { buildReplayerScript } = require('../src/replayer-script');

test('redacted password steps take the profile password instead of the placeholder text', () => {
  const step = { type: 'input', value: '[redacted 9 chars]', el: { attrs: { type: 'password', name: 'pw' } } };
  assert.equal(fillRedacted(step, { password: 's3cret' }).value, 's3cret');
  // No password on the profile, or a redacted card/CVV field: skip rather than type garbage.
  assert.equal(fillRedacted(step, {}).type, 'skip');
  assert.equal(fillRedacted({ type: 'input', value: '[redacted 3 chars]', el: { attrs: { name: 'cvv' } } }, { password: 'x' }).type, 'skip');
  // Ordinary values pass through untouched.
  const email = { type: 'input', value: 'fan@example.com', el: { attrs: { name: 'email' } } };
  assert.equal(fillRedacted(email, { password: 'x' }), email);
});

test('the generated replay script is valid JavaScript', () => {
  const script = buildReplayerScript([
    { type: 'click', el: { tag: 'BUTTON', id: 'go', text: 'Continue', attrs: { placeholder: 'x' } } },
    { type: 'wait', ms: 200 },
  ]);
  // Parses without running: catches escaping mistakes inside the template literal.
  assert.doesNotThrow(() => new Function(script));
});

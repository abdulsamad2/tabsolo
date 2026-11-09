'use strict';
/* global document, licenseApi */

const form = document.getElementById('form');
const input = document.getElementById('key');
const btn = document.getElementById('submit');
const status = document.getElementById('status');
const deviceLine = document.getElementById('device');
const buy = document.getElementById('buy');

(async () => {
  try {
    const info = await licenseApi.deviceInfo();
    deviceLine.textContent = `Device: ${info.deviceId.slice(0, 8)}… · ${info.deviceLabel}`;
  } catch { /* ignore */ }
})();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = (input.value || '').trim();
  if (!key) return;
  btn.disabled = true;
  btn.textContent = 'Activating…';
  status.className = 'status';
  status.textContent = '';
  const result = await licenseApi.activate(key);
  btn.disabled = false;
  btn.textContent = 'Activate';
  if (result?.ok) {
    status.className = 'status ok';
    status.textContent = `✓ Activated on the ${result.plan.toUpperCase()} plan.`;
    setTimeout(() => licenseApi.proceed(), 700);
  } else {
    status.className = 'status err';
    status.textContent = humanize(result?.error) || 'Activation failed. Check the key and try again.';
  }
});

const subscribe = document.getElementById('subscribe');
subscribe.addEventListener('click', async () => {
  subscribe.disabled = true;
  subscribe.textContent = 'Waiting for checkout…';
  status.className = 'status';
  status.textContent = 'Finish the checkout in your browser. TabSolo unlocks by itself when it is done.';
  const result = await licenseApi.subscribe();
  subscribe.disabled = false;
  subscribe.textContent = 'Start free trial';
  if (result?.ok) {
    status.className = 'status ok';
    status.textContent = '✓ Subscription active.';
    setTimeout(() => licenseApi.proceed(), 700);
  } else {
    status.className = 'status err';
    status.textContent = humanize(result?.error) || 'Can\'t open the checkout right now. Check your internet connection and try again.';
  }
});

buy.addEventListener('click', (event) => {
  event.preventDefault();
  licenseApi.openExternal('https://www.tabsolo.com/sign-up');
});

function humanize(code) {
  const map = {
    invalid_key: 'That key doesn\'t match any license on file.',
    revoked: 'This license has been revoked. Contact support.',
    expired: 'This license has expired. Renew to continue.',
    checkout_timeout: 'No payment arrived yet. If you finished the checkout, paste the license key shown on its last page.',
    billing_unavailable: 'Subscriptions aren\'t available yet.',
    plan_ended: 'Your free license has ended. Start a subscription or enter a license key to keep using TabSolo.',
    device_limit_reached: 'This key is already active on the maximum number of computers. Contact support to free one up.',
    network_error: 'Can\'t reach the license server. Check your internet connection.',
    empty_key: 'Please enter a license key.',
  };
  return map[code] || null;
}

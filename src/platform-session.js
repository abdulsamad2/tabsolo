'use strict';

/**
 * Windows auth-switches for Chromium. On an AD-joined machine Chromium otherwise answers Negotiate /
 * NTLM challenges silently with the signed-in DOMAIN\user. A list that matches no real host replaces
 * that default. Must be applied before the app is ready.
 */
function windowsAuthSwitches(platform) {
  if (platform !== 'win32') return [];
  const nowhere = '*.tabsolo.invalid';
  return [
    ['auth-server-allowlist', nowhere],
    ['auth-negotiate-delegate-allowlist', nowhere],
  ];
}

module.exports = { windowsAuthSwitches };

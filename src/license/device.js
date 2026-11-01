'use strict';

// Stable per-machine device fingerprint. Derived from hardware identifiers that survive OS
// reinstalls on the same box: the primary MAC address + hostname + first physical disk serial on
// Windows / the hardware UUID on macOS. Not perfect — a user can swap network cards, or wipe +
// change hostname — but good enough for enforcing "one license, one PC" against a casual user.
// Not meant to defeat a determined attacker: we're licensing, not DRM.

const { execFileSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');

let cached = null;

function readMacOsUuid() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 2000 }).toString();
    const match = /IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/.exec(out);
    return match ? match[1] : null;
  } catch { return null; }
}

function readWindowsMachineGuid() {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { timeout: 2000 }).toString();
    const match = /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/.exec(out);
    return match ? match[1] : null;
  } catch { return null; }
}

function primaryMacAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const info of nets[name] || []) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') return info.mac;
    }
  }
  return null;
}

function getDeviceId() {
  if (cached) return cached;
  // Omits os.hostname(): the ioreg UUID / MachineGuid is already per-machine, and folding in a
  // user-editable hostname made a rename look like a new device and burn a license slot.
  const parts = [os.platform(), os.arch()];
  if (process.platform === 'darwin') parts.push(readMacOsUuid() || '');
  else if (process.platform === 'win32') parts.push(readWindowsMachineGuid() || '');
  parts.push(primaryMacAddress() || '');
  const raw = parts.filter(Boolean).join('|');
  cached = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return cached;
}

function getDeviceLabel() {
  return `${os.platform()} ${os.release()} · ${os.hostname()}`.slice(0, 128);
}

module.exports = { getDeviceId, getDeviceLabel };

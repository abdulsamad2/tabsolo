'use strict';

// Stable per-machine id, used to count a license's computers: the hardware UUID on macOS, MachineGuid
// on Windows. Stops casual sharing; not meant to defeat a determined attacker.

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
  const hardwareId = process.platform === 'darwin' ? readMacOsUuid()
    : process.platform === 'win32' ? readWindowsMachineGuid()
    : null;
  cached = fingerprint(os.platform(), os.arch(), hardwareId, primaryMacAddress());
  return cached;
}

// Each new id uses up a license slot, so it must not change for the same computer: no hostname
// (user-editable), and the MAC only as a last resort (VPNs and docks add or reorder adapters).
function fingerprint(platform, arch, hardwareId, mac) {
  const raw = [platform, arch, hardwareId || mac].filter(Boolean).join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function getDeviceLabel() {
  return `${os.platform()} ${os.release()} · ${os.hostname()}`.slice(0, 128);
}

module.exports = { getDeviceId, getDeviceLabel, fingerprint };

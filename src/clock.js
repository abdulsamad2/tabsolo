'use strict';

// Windows timezone ids, used only to put back a computer timezone an older TabSolo build changed.
// Page clocks follow each proxy inside the browser now (see main.js "Clock") and do not use this.

// IANA timezone → Windows timezone id (from CLDR's windowsZones), for `tzutil /s`.
const WINDOWS_ZONES = {
  'Eastern Standard Time': ['America/New_York', 'America/Detroit', 'America/Toronto', 'America/Kentucky/Louisville',
    'America/Kentucky/Monticello', 'America/Nassau', 'America/Montreal'],
  'US Eastern Standard Time': ['America/Indiana/Indianapolis', 'America/Indianapolis', 'America/Indiana/Marengo',
    'America/Indiana/Vevay'],
  'Central Standard Time': ['America/Chicago', 'America/Winnipeg', 'America/Menominee', 'America/Indiana/Knox',
    'America/Indiana/Tell_City', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem',
    'America/North_Dakota/Beulah', 'America/Rankin_Inlet'],
  'Canada Central Standard Time': ['America/Regina', 'America/Swift_Current'],
  'Mountain Standard Time': ['America/Denver', 'America/Edmonton', 'America/Boise', 'America/Cambridge_Bay', 'America/Inuvik'],
  'US Mountain Standard Time': ['America/Phoenix', 'America/Creston'],
  'Pacific Standard Time': ['America/Los_Angeles', 'America/Vancouver'],
  'Alaskan Standard Time': ['America/Anchorage', 'America/Juneau', 'America/Nome', 'America/Sitka', 'America/Yakutat'],
  'Aleutian Standard Time': ['America/Adak'],
  'Hawaiian Standard Time': ['Pacific/Honolulu'],
  'Atlantic Standard Time': ['America/Halifax', 'America/Moncton', 'America/Glace_Bay', 'America/Goose_Bay', 'Atlantic/Bermuda'],
  'Newfoundland Standard Time': ['America/St_Johns'],
  'SA Western Standard Time': ['America/Puerto_Rico', 'America/Santo_Domingo'],
  'Central Standard Time (Mexico)': ['America/Mexico_City', 'America/Monterrey', 'America/Merida'],
  'SA Pacific Standard Time': ['America/Bogota', 'America/Lima'],
  'E. South America Standard Time': ['America/Sao_Paulo'],
  'GMT Standard Time': ['Europe/London', 'Europe/Dublin', 'Europe/Lisbon'],
  'W. Europe Standard Time': ['Europe/Berlin', 'Europe/Amsterdam', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Vienna',
    'Europe/Zurich', 'Europe/Oslo'],
  'Romance Standard Time': ['Europe/Paris', 'Europe/Brussels', 'Europe/Madrid', 'Europe/Copenhagen'],
  'Central European Standard Time': ['Europe/Warsaw', 'Europe/Zagreb'],
  'Central Europe Standard Time': ['Europe/Prague', 'Europe/Budapest', 'Europe/Belgrade'],
  'GTB Standard Time': ['Europe/Athens', 'Europe/Bucharest'],
  'FLE Standard Time': ['Europe/Helsinki', 'Europe/Kiev', 'Europe/Kyiv', 'Europe/Riga', 'Europe/Vilnius', 'Europe/Tallinn'],
  'AUS Eastern Standard Time': ['Australia/Sydney', 'Australia/Melbourne'],
  'E. Australia Standard Time': ['Australia/Brisbane'],
  'Cen. Australia Standard Time': ['Australia/Adelaide'],
  'W. Australia Standard Time': ['Australia/Perth'],
  'New Zealand Standard Time': ['Pacific/Auckland'],
  'Korea Standard Time': ['Asia/Seoul'],
  'Tokyo Standard Time': ['Asia/Tokyo'],
  'India Standard Time': ['Asia/Kolkata', 'Asia/Calcutta'],
  'Singapore Standard Time': ['Asia/Singapore', 'Asia/Kuala_Lumpur'],
  'Arabian Standard Time': ['Asia/Dubai'],
  'Pakistan Standard Time': ['Asia/Karachi'],
  'China Standard Time': ['Asia/Shanghai', 'Asia/Hong_Kong'],
};
const WINDOWS_BY_IANA = Object.fromEntries(Object.entries(WINDOWS_ZONES).flatMap(([win, zones]) => zones.map((z) => [z, win])));

/** The Windows timezone id for an IANA zone, or null when it isn't known. */
function windowsZoneFor(zone) {
  return WINDOWS_BY_IANA[zone] ?? null;
}

/** The zone most of the looked-up proxies are in (first seen wins a tie); null when none is known. */
function majorityZone(zones) {
  const counts = new Map();
  for (const zone of zones) if (zone) counts.set(zone, (counts.get(zone) ?? 0) + 1);
  let best = null;
  for (const [zone, count] of counts) if (!best || count > counts.get(best)) best = zone;
  return best;
}

module.exports = { windowsZoneFor, majorityZone };

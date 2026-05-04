// Opening-hours utility — pure function, no I/O.
//
// Schedule-shape (mirrors stores.opening_schedule JSONB column in Supabase):
//   {
//     "Monday":    { "enabled": true,  "hours": [{"open": "09:00", "close": "18:00"}] },
//     "Tuesday":   { "enabled": true,  "hours": [{"open": "09:00", "close": "12:30"}, {"open": "13:30", "close": "18:00"}] },
//     "Wednesday": { "enabled": false, "hours": [] },
//     ...
//   }
//
// Day keys are full English weekday names — same as the existing peak_schedule
// convention in the webapp (constants.ts DAYS).
//
// Special cases:
//   * schedule == null → "no schedule configured" → ALWAYS OPEN.
//     Backwards-compat: stores that never set hours stay 24/7 like before.
//   * day missing OR enabled=false → CLOSED that day.
//   * empty hours[] with enabled=true → CLOSED (defensive: better than 24h open).
//   * close <= open within the same slot → invalid; treat the slot as missing.
//
// Times are interpreted in the store's local timezone — caller passes `tz`.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getStoreLocalParts(tz, atUtc) {
  // Use Intl to format the timestamp in the store's TZ, then parse back into
  // numeric parts. h23 keeps midnight as 00 (some locales return 24).
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(atUtc);
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? 'Monday';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return { weekday, hour, minute, minutesIntoDay: hour * 60 + minute };
}

function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Returns true if `atUtc` (Date) falls inside any open slot for the given
 * schedule + tz. Defaults to "now".
 */
export function isWithinOpeningHours(schedule, tz, atUtc = new Date()) {
  if (schedule == null) return true; // no schedule → always open

  const { weekday, minutesIntoDay } = getStoreLocalParts(tz || 'Europe/Amsterdam', atUtc);
  const day = schedule[weekday];
  if (!day || !day.enabled) return false;

  const slots = Array.isArray(day.hours) ? day.hours : [];
  if (slots.length === 0) return false;

  for (const slot of slots) {
    const open = parseHHMM(slot.open);
    const close = parseHHMM(slot.close);
    if (open == null || close == null) continue;
    if (close <= open) continue;
    // [open, close): inclusive of open minute, exclusive of close minute.
    if (minutesIntoDay >= open && minutesIntoDay < close) return true;
  }
  return false;
}

/**
 * Returns ISO string of the next "open" minute after `atUtc`, or null if the
 * schedule never opens. Used for log messaging — "auto-pause until <when>".
 * Looks 7 days ahead; gives up after that.
 */
export function nextOpeningAfter(schedule, tz, atUtc = new Date()) {
  if (schedule == null) return null;
  // Walk minute-by-minute is wasteful; check at every slot edge instead.
  // But for simplicity + small N (max 14 slots/week), brute-force scan in
  // 1-hour increments is fast enough and easy to reason about.
  const tzSafe = tz || 'Europe/Amsterdam';
  const start = new Date(atUtc);
  for (let m = 1; m <= 7 * 24 * 60; m += 1) {
    const t = new Date(start.getTime() + m * 60_000);
    if (isWithinOpeningHours(schedule, tzSafe, t)) return t.toISOString();
  }
  return null;
}

// Re-exposed for tests / dashboards.
export const _DAY_NAMES = DAY_NAMES;

import { z } from 'zod';

/**
 * Time, in exactly one canonical form.
 *
 * Every timestamp in this system is UTC, millisecond precision, `Z` suffix,
 * fixed width: `2026-08-25T14:30:00.000Z`.
 *
 * That constraint is load-bearing rather than cosmetic. ISO-8601 permits
 * offsets, and once offsets are in play a lexicographic comparison of two
 * timestamps is silently wrong:
 *
 *   '2026-08-25T20:30:00+00:00' < '2026-08-26T01:00:00+05:30'   // true as strings
 *   new Date(a)                 < new Date(b)                   // false in fact
 *
 * Those two instants are 19:30Z and 20:30Z respectively, so the string compare
 * inverts them. A retry scheduler sorting by string would fire in the wrong
 * order and nothing would look broken. Pinning the format to fixed-width UTC
 * makes lexicographic order and chronological order provably identical, which
 * is what `compareTs` relies on.
 *
 * India never observes DST, so IST is a constant +05:30 — but the local-time
 * helpers still go through Intl with a configurable zone, because the contact
 * hours rule reads its timezone from the rules registry.
 */

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const TimestampSchema = z
  .string()
  .regex(TS_RE, 'must be canonical UTC, e.g. 2026-08-25T14:30:00.000Z')
  .brand<'Timestamp'>();
export type Timestamp = z.infer<typeof TimestampSchema>;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function toTimestamp(input: Date | number | string): Timestamp {
  const d = input instanceof Date ? input : new Date(input);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`not a valid instant: ${String(input)}`);
  return d.toISOString() as Timestamp;
}

/** Epoch milliseconds. Cheap because the format is fixed. */
export function epochMs(ts: Timestamp): number {
  return Date.parse(ts);
}

export function addMs(ts: Timestamp, ms: number): Timestamp {
  return toTimestamp(epochMs(ts) + ms);
}

export function addHours(ts: Timestamp, hours: number): Timestamp {
  return addMs(ts, Math.round(hours * HOUR_MS));
}

export function addDays(ts: Timestamp, days: number): Timestamp {
  return addMs(ts, Math.round(days * DAY_MS));
}

export function hoursBetween(a: Timestamp, b: Timestamp): number {
  return (epochMs(b) - epochMs(a)) / HOUR_MS;
}

export function daysBetween(a: Timestamp, b: Timestamp): number {
  return (epochMs(b) - epochMs(a)) / DAY_MS;
}

/**
 * Chronological comparison. Safe as a string compare only because the format
 * is pinned above; do not relax TS_RE without revisiting this.
 */
export function compareTs(a: Timestamp, b: Timestamp): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isBefore(a: Timestamp, b: Timestamp): boolean {
  return a < b;
}

export function isAfter(a: Timestamp, b: Timestamp): boolean {
  return a > b;
}

export function minTs(...xs: Timestamp[]): Timestamp {
  if (xs.length === 0) throw new RangeError('minTs needs at least one timestamp');
  return xs.reduce((a, b) => (a <= b ? a : b));
}

export function maxTs(...xs: Timestamp[]): Timestamp {
  if (xs.length === 0) throw new RangeError('maxTs needs at least one timestamp');
  return xs.reduce((a, b) => (a >= b ? a : b));
}

// ------------------------------------------------------------ local time

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  /** Day of month, 1-31. Drives the salary-refill model in the simulator. */
  day: number;
  /** Hour 0-23, for the contact-hours rule. */
  hour: number;
  minute: number;
  weekday: string;
}

export function localParts(ts: Timestamp, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs(ts)));
  const get = (t: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === t);
    if (!p) throw new Error(`missing ${t} formatting ${ts} in ${timeZone}`);
    return p.value;
  };
  // en-GB renders midnight as "24" rather than "00" in some engines.
  const rawHour = Number(get('hour'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(get('minute')),
    weekday: get('weekday'),
  };
}

export function localHour(ts: Timestamp, timeZone: string): number {
  return localParts(ts, timeZone).hour;
}

export function localDayOfMonth(ts: Timestamp, timeZone: string): number {
  return localParts(ts, timeZone).day;
}

/**
 * The next instant at or after `ts` whose local hour falls inside
 * [startHour, endHour). Used to defer a contact into permitted hours rather
 * than dropping it, which is what a real dunning scheduler does.
 */
export function nextWithinHours(
  ts: Timestamp,
  timeZone: string,
  startHour: number,
  endHour: number,
): Timestamp {
  if (startHour >= endHour) throw new RangeError(`bad window ${startHour}-${endHour}`);
  let cursor = ts;
  // At most two hops: forward to today's window, else to tomorrow's.
  for (let i = 0; i < 3; i++) {
    const { hour } = localParts(cursor, timeZone);
    if (hour >= startHour && hour < endHour) return cursor;
    cursor = addHours(cursor, hour < startHour ? startHour - hour : 24 - hour + startHour);
    // Land on the hour boundary rather than carrying stray minutes.
    const p = localParts(cursor, timeZone);
    cursor = addMs(cursor, -p.minute * 60_000 - (epochMs(cursor) % 60_000));
  }
  return cursor;
}

export function isWithinHours(
  ts: Timestamp,
  timeZone: string,
  startHour: number,
  endHour: number,
): boolean {
  const h = localParts(ts, timeZone).hour;
  return h >= startHour && h < endHour;
}

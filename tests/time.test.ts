import { describe, expect, it } from 'vitest';
import {
  TimestampSchema,
  addDays,
  addHours,
  compareTs,
  daysBetween,
  isWithinHours,
  localDayOfMonth,
  localHour,
  nextWithinHours,
  toTimestamp,
  type Timestamp,
} from '../src/domain/time.js';

const IST = 'Asia/Kolkata';
const ts = (s: string): Timestamp => TimestampSchema.parse(s);

describe('timestamp format', () => {
  it('accepts canonical UTC', () => {
    expect(() => ts('2026-08-25T14:30:00.000Z')).not.toThrow();
  });

  it('rejects an offset form, which is the whole point', () => {
    // Permitting offsets is what makes lexicographic comparison unsound.
    expect(() => ts('2026-08-25T20:30:00+05:30')).toThrow();
    expect(() => ts('2026-08-25T20:30:00Z')).toThrow(); // no millis
    expect(() => ts('2026-08-25')).toThrow();
  });

  it('normalises any instant into the canonical form', () => {
    expect(toTimestamp('2026-08-25T20:30:00+05:30')).toBe('2026-08-25T15:00:00.000Z');
  });
});

describe('ordering', () => {
  it('makes string order and chronological order identical', () => {
    // The exact pair that compares wrong when offsets are allowed:
    // 20:30+00:00 is 20:30Z; 01:00+05:30 next day is 19:30Z, so a is LATER.
    const a = toTimestamp('2026-08-25T20:30:00+00:00');
    const b = toTimestamp('2026-08-26T01:00:00+05:30');

    expect(a < b).toBe(false);
    expect(new Date(a) < new Date(b)).toBe(false);
    expect(compareTs(a, b)).toBe(1);
  });

  it('sorts a schedule correctly with a plain string sort', () => {
    const times = [
      toTimestamp('2026-08-26T01:00:00+05:30'),
      toTimestamp('2026-08-25T20:30:00+00:00'),
      toTimestamp('2026-08-25T09:00:00+05:30'),
    ];
    const sorted = [...times].sort();
    const byInstant = [...times].sort((x, y) => Date.parse(x) - Date.parse(y));
    expect(sorted).toEqual(byInstant);
  });
});

describe('arithmetic', () => {
  const base = ts('2026-08-25T14:30:00.000Z');

  it('adds hours and days', () => {
    expect(addHours(base, 24)).toBe('2026-08-26T14:30:00.000Z');
    expect(addDays(base, 3)).toBe('2026-08-28T14:30:00.000Z');
  });

  it('measures days between', () => {
    expect(daysBetween(base, addDays(base, 7))).toBeCloseTo(7, 9);
  });
});

describe('local time in IST', () => {
  it('reads the IST hour, not the UTC hour', () => {
    // 20:30Z is 02:00 IST the next day - outside contact hours, though the
    // UTC hour would look like a perfectly reasonable evening.
    expect(localHour(ts('2026-08-25T20:30:00.000Z'), IST)).toBe(2);
    expect(localHour(ts('2026-08-25T05:00:00.000Z'), IST)).toBe(10);
  });

  it('reads the IST day of month, which drives the salary model', () => {
    // 19:00Z on the 6th is already the 7th in IST - the refill day.
    expect(localDayOfMonth(ts('2026-08-06T19:00:00.000Z'), IST)).toBe(7);
  });

  it('judges the contact window in local time', () => {
    expect(isWithinHours(ts('2026-08-25T05:00:00.000Z'), IST, 9, 19)).toBe(true); // 10:00
    expect(isWithinHours(ts('2026-08-25T20:30:00.000Z'), IST, 9, 19)).toBe(false); // 02:00
    expect(isWithinHours(ts('2026-08-25T14:00:00.000Z'), IST, 9, 19)).toBe(false); // 19:30
  });
});

describe('deferring into permitted hours', () => {
  it('leaves a time already inside the window alone', () => {
    const inside = ts('2026-08-25T05:00:00.000Z'); // 10:30 IST
    expect(nextWithinHours(inside, IST, 9, 19)).toBe(inside);
  });

  it('moves a pre-dawn contact forward to the same morning', () => {
    const early = ts('2026-08-25T20:30:00.000Z'); // 02:00 IST on the 26th
    const moved = nextWithinHours(early, IST, 9, 19);
    expect(isWithinHours(moved, IST, 9, 19)).toBe(true);
    expect(moved > early).toBe(true);
    expect(localDayOfMonth(moved, IST)).toBe(26);
  });

  it('moves a late-evening contact to the next morning', () => {
    const late = ts('2026-08-25T16:00:00.000Z'); // 21:30 IST
    const moved = nextWithinHours(late, IST, 9, 19);
    expect(isWithinHours(moved, IST, 9, 19)).toBe(true);
    expect(localDayOfMonth(moved, IST)).toBe(26);
  });
});

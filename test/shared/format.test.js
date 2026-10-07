/* format.js: time, runtime and date strings.
 *
 * The documented regression: hm() rounds to whole minutes *before* splitting
 * off the hours — rounding the minute part alone printed 1:59:40 as "1h 60m".
 * At least 1m, never "0m". */
import { describe, it, expect } from 'vitest';
import { MON, ticksToSec, fmtTime, fmtRuntime, timeLeft, yearOf, fmtDate } from '../../src/lib/format.js';
import { TICKS } from '../../src/lib/api.js';
import { sec, TICKS_PER_SECOND } from '../helpers/time.js';

const hms = (h, m, s) => h * 3600 + m * 60 + s;

describe('ticksToSec', () => {
  it('10^7 ticks per second; falsy → 0', () => {
    expect(TICKS).toBe(TICKS_PER_SECOND);
    expect(ticksToSec(sec(1))).toBe(1);
    expect(ticksToSec(sec(90.5))).toBe(90.5);
    expect(ticksToSec(0)).toBe(0);
    expect(ticksToSec(null)).toBe(0);
    expect(ticksToSec(undefined)).toBe(0);
    expect(ticksToSec(NaN)).toBe(0);
  });
});

describe('fmtTime', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [59.99, '0:59'],
    [60, '1:00'],
    [605, '10:05'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [hms(1, 2, 3), '1:02:03'],
    [hms(2, 30, 0), '2:30:00'],
    [hms(12, 0, 9), '12:00:09'],
    [hms(100, 1, 1), '100:01:01']
  ])('%s s → %s', (s, out) => {
    expect(fmtTime(s)).toBe(out);
  });

  it('negatives, NaN and missing values → 0:00', () => {
    for (const v of [-1, -3600, NaN, undefined, null, '', Infinity * 0]) expect(fmtTime(v)).toBe('0:00');
  });

  it('floors fractional seconds (never rounds up to the next second)', () => {
    expect(fmtTime(3599.9)).toBe('59:59');
    expect(fmtTime(0.999)).toBe('0:00');
  });
});

describe('fmtRuntime', () => {
  it("'' for no runtime", () => {
    expect(fmtRuntime(0)).toBe('');
    expect(fmtRuntime(undefined)).toBe('');
    expect(fmtRuntime(null)).toBe('');
    expect(fmtRuntime(sec(0.9))).toBe('');
  });

  it.each([
    [1, '1m'],
    [29, '1m'],
    [89, '1m'],
    [90, '2m'],
    [45 * 60, '45m'],
    [59 * 60 + 29, '59m'],
    [59 * 60 + 30, '1h 0m'],
    [hms(1, 0, 0), '1h 0m'],
    [hms(1, 59, 29), '1h 59m'],
    [hms(1, 59, 40), '2h 0m'],
    [hms(2, 28, 0), '2h 28m'],
    [hms(3, 1, 31), '3h 2m']
  ])('%s s → %s', (s, out) => {
    expect(fmtRuntime(sec(s))).toBe(out);
  });

  it('never "60m" and never "0m"', () => {
    for (let s = 1; s < 4 * 3600; s += 7) {
      const out = fmtRuntime(sec(s));
      expect(out).not.toMatch(/(^|\s)60m$/);
      expect(out).not.toBe('0m');
      expect(out).toMatch(/^(\d+h )?\d{1,2}m$/);
    }
  });
});

describe('timeLeft', () => {
  const item = (runSec, posSec, ud = true) => ({ RunTimeTicks: sec(runSec), ...(ud ? { UserData: { PlaybackPositionTicks: sec(posSec) } } : {}) });

  it('runtime minus position, as "… left"', () => {
    expect(timeLeft(item(hms(2, 0, 0), hms(0, 30, 0)))).toBe('1h 30m left');
    expect(timeLeft(item(45 * 60, 44 * 60))).toBe('1m left');
    expect(timeLeft(item(45 * 60, 45 * 60 - 10))).toBe('1m left');
    expect(timeLeft(item(hms(2, 0, 20), 0))).toBe('2h 0m left');
  });

  it('without UserData: the whole runtime is left', () => {
    expect(timeLeft(item(45 * 60, 0, false))).toBe('45m left');
    expect(timeLeft({ RunTimeTicks: sec(600), UserData: null })).toBe('10m left');
  });

  it("nothing left (or past the end, or no runtime) → ''", () => {
    expect(timeLeft(item(600, 600))).toBe('');
    expect(timeLeft(item(600, 700))).toBe('');
    expect(timeLeft({})).toBe('');
    expect(timeLeft({ UserData: { PlaybackPositionTicks: sec(10) } })).toBe('');
  });
});

describe('yearOf', () => {
  it('ProductionYear first, else the PremiereDate year, else ""', () => {
    expect(yearOf({ ProductionYear: 1999, PremiereDate: '2001-05-01T00:00:00.0000000Z' })).toBe(1999);
    expect(yearOf({ PremiereDate: '2001-05-01T00:00:00.0000000Z' })).toBe('2001');
    expect(yearOf({ ProductionYear: 0, PremiereDate: '1987-01-01' })).toBe('1987');
    expect(yearOf({})).toBe('');
    expect(yearOf({ PremiereDate: '' })).toBe('');
  });
});

describe('fmtDate', () => {
  it('day, short month, year (local time)', () => {
    expect(fmtDate('2024-03-05T12:00:00')).toBe('5 Mar 2024');
    expect(fmtDate('1999-12-31T12:00:00')).toBe('31 Dec 1999');
    expect(fmtDate(new Date(2026, 0, 1, 12).toISOString())).toBe('1 Jan 2026');
  });

  it('every month name', () => {
    expect(MON).toStrictEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
    for (let m = 0; m < 12; m++) expect(fmtDate(new Date(2025, m, 15, 12).toISOString())).toBe('15 ' + MON[m] + ' 2025');
  });

  it('accepts a timestamp too', () => {
    expect(fmtDate(new Date(2020, 1, 29, 12).getTime())).toBe('29 Feb 2020');
  });

  it('an unparseable value → "" (callers drop falsy values) (V-F6)', () => {
    expect(fmtDate('not a date')).toBe('');
    expect(fmtDate('2024-13-45')).toBe('');
  });

  it("a date-only string (Sonarr's air_date) is that calendar day west of UTC too (V-F6)", () => {
    const tz = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      expect(new Date('2024-03-05').getDate()).toBe(4);   // the trap: parsed as UTC midnight
      expect(fmtDate('2024-03-05')).toBe('5 Mar 2024');
      expect(fmtDate('2024-12-31')).toBe('31 Dec 2024');
      process.env.TZ = 'Asia/Tokyo';
      expect(fmtDate('2024-03-05')).toBe('5 Mar 2024');
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('a value whose conversion throws → ""', () => {
    const evil = { [Symbol.toPrimitive]() { throw new Error('nope'); } };
    expect(fmtDate(evil)).toBe('');
  });
});

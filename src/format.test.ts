import { describe, expect, test } from 'bun:test';
import { elapsedFraction, expiringShare, forecastOf } from './format';
import { progress } from './providers/types';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const quota = (used: number, limit = 100) => progress('Weekly', used, limit, {
  resetsAt: new Date(NOW + 3.5 * DAY).toISOString(), periodDurationMs: 7 * DAY,
});

describe('forecast arithmetic', () => {
  test.each([100, 25, 500])('normalizes usage against a limit of %s', (limit) => {
    const fast = quota(0.8 * limit, limit);
    expect(forecastOf(fast, NOW)).toEqual({ kind: 'runsOut', inMs: 21 * HOUR });
    expect(expiringShare(quota(0.25 * limit, limit), NOW)).toBe(0.5);
    expect(expiringShare(quota(0.5 * limit, limit), NOW)).toBe(0);
  });

  test('keeps the projected balance stable and counts down from the observation', () => {
    const later = NOW + 5 * 60_000;
    expect(expiringShare(quota(25), later, NOW)).toBe(0.5);
    expect(forecastOf(quota(80), later, NOW)).toEqual({ kind: 'runsOut', inMs: 21 * HOUR - 5 * 60_000 });
    // Once the estimate passes, only a new reading can confirm exhaustion.
    expect(forecastOf(quota(80), NOW + 22 * HOUR, NOW)).toEqual({ kind: 'runsOut', inMs: 0 });
  });

  test('does not infer a new rate before a fresh reading arrives', () => {
    const early = progress('Session', 3, 100, { periodDurationMs: 5 * HOUR, resetsAt: new Date(NOW + 4.9 * HOUR).toISOString() });
    expect(forecastOf(early, NOW + HOUR, NOW)).toBeNull();
  });

  test('rejects invalid, future and expired windows', () => {
    for (const resetsAt of ['invalid', new Date(NOW).toISOString(), new Date(NOW - 1).toISOString(), new Date(NOW + 8 * DAY).toISOString()]) {
      const line = { ...quota(25), resetsAt };
      expect(elapsedFraction(line, NOW)).toBeNull();
      expect(forecastOf(line, NOW)).toBeNull();
      expect(expiringShare(line, NOW)).toBeNull();
    }
    expect(forecastOf({ ...quota(100), resetsAt: new Date(NOW - 1).toISOString() }, NOW)).toBeNull();
    for (const periodDurationMs of [null, 0, -1, NaN, Infinity]) {
      expect(forecastOf({ ...quota(25), periodDurationMs }, NOW)).toBeNull();
    }
  });

  test('does not turn invalid usage into a forecast', () => {
    for (const used of [-1, NaN, Infinity]) expect(forecastOf(quota(used), NOW)).toBeNull();
    for (const limit of [0, -1, NaN, Infinity]) expect(forecastOf(quota(25, limit), NOW)).toBeNull();
    expect(forecastOf(quota(0), NOW)).toBeNull();
    expect(forecastOf(quota(110), NOW)).toEqual({ kind: 'exhausted' });
  });
});

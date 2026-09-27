import { describe, expect, test } from 'bun:test';
import { fastBurnOf, forecastOf } from './format';
import type { Sample } from './history';
import { activeMs, activeUntil, activityProfile, recentPace, slotOf, type ActivityProfile } from './pace';
import { progress } from './providers/types';

const HOUR = 3600_000;
const MINUTE = 60_000;

// local times, so the hour-of-day logic holds in any time zone
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const reading = (t: number, v: number, l = 'Weekly'): Sample => ({ t, p: 'a', l, v });

describe('recent pace', () => {
  const now = at(21, 12);

  test('measures the last hour in points per hour', () => {
    const history = [reading(now - 50 * MINUTE, 0.4), reading(now - 30 * MINUTE, 0.46), reading(now - 10 * MINUTE, 0.52)];
    const pace = recentPace(history, 'a', 'Weekly', now);
    expect(pace?.spanMs).toBe(40 * MINUTE);
    expect(pace!.perHour).toBeCloseTo(0.18, 5);
  });

  test('starts from the reading held just before the window', () => {
    const history = [reading(now - 70 * MINUTE, 0.4), reading(now - 5 * MINUTE, 0.5)];
    expect(recentPace(history, 'a', 'Weekly', now)!.perHour).toBeCloseTo(0.1 / (65 / 60), 5);
  });

  test('a reset starts the count over and a rounding step is no pace', () => {
    const reset = [reading(now - 55 * MINUTE, 0.9), reading(now - 45 * MINUTE, 0.02), reading(now - 5 * MINUTE, 0.1)];
    expect(recentPace(reset, 'a', 'Weekly', now)!.perHour).toBeCloseTo(0.12, 5);

    const flat = [reading(now - 50 * MINUTE, 0.4), reading(now - 5 * MINUTE, 0.41)];
    expect(recentPace(flat, 'a', 'Weekly', now)?.perHour).toBe(0);
  });

  test('too short a span says nothing', () => {
    expect(recentPace([reading(now - 10 * MINUTE, 0.4), reading(now - 2 * MINUTE, 0.5)], 'a', 'Weekly', now)).toBeNull();
  });
});

describe('fast burn', () => {
  const now = at(21, 12);
  const weekly = (used: number, daysLeft: number) =>
    progress('Weekly', used, 100, { periodDurationMs: 7 * 24 * HOUR, resetsAt: new Date(now + daysLeft * 24 * HOUR).toISOString() });

  test('flags a burst that runs the quota out before its reset', () => {
    // 20% used halfway through the week looks calm, but 15 points an hour empties it in ~5h
    const line = weekly(20, 3.5);
    const forecast = forecastOf(line, now);
    expect(forecast?.kind).toBe('atReset');
    const fast = fastBurnOf(line, { perHour: 0.15, spanMs: HOUR }, now, now, forecast);
    expect(Math.round(fast!.inMs / MINUTE)).toBe(320);
  });

  test('with a profile the pace only continues through the usual hours', () => {
    // busy 9-18 on weekdays: 15 points an hour at 12:00 on Monday lasts into the afternoon either way,
    // but 3 points an hour, 27 hours of work away, only runs out on Wednesday, still before the reset
    const factors = Array.from({ length: 48 }, (_, slot) => (slot < 24 && slot >= 9 && slot < 18 ? 3 : 0.2));
    const profile: ActivityProfile = { factors, days: 14 };
    const line = weekly(20, 3.5);
    const clock = fastBurnOf(line, { perHour: 0.03, spanMs: HOUR }, now, now, null)!;
    const learned = fastBurnOf(line, { perHour: 0.03, spanMs: HOUR }, now, now, null, profile)!;
    expect(Math.round(clock.inMs / HOUR)).toBe(27);
    expect(learned.inMs).toBeGreaterThan(clock.inMs);
    expect(fastBurnOf(line, { perHour: 0.01, spanMs: HOUR }, now, now, null, profile)).toBeNull();
  });

  test('stays quiet when the pace fits before the reset or the average already warns', () => {
    const calm = weekly(20, 3.5);
    expect(fastBurnOf(calm, { perHour: 0.005, spanMs: HOUR }, now, now, forecastOf(calm, now))).toBeNull();

    const hot = weekly(90, 3.5);
    // the average already runs out in ~9h; a pace only a bit above it adds nothing
    expect(fastBurnOf(hot, { perHour: 0.012, spanMs: HOUR }, now, now, forecastOf(hot, now))).toBeNull();
  });
});

describe('activity profile', () => {
  // 1 point an hour from 9 to 18 on weekdays, nothing otherwise, read every 30 minutes
  function workWeeks(days: number): Sample[] {
    const samples: Sample[] = [];
    let value = 0;
    for (let t = at(7, 0); t < at(7 + days, 0); t += 30 * MINUTE) {
      const date = new Date(t);
      const weekday = date.getDay() !== 0 && date.getDay() !== 6;
      if (weekday && date.getHours() >= 9 && date.getHours() < 18) value += 0.005;
      samples.push(reading(t, value));
    }
    return samples;
  }

  test('learns busy weekday hours, quiet nights and weekends', () => {
    const profile = activityProfile(workWeeks(10))!;
    expect(profile.days).toBe(10);
    expect(profile.factors[slotOf(new Date(at(9, 11)))]).toBeGreaterThan(2);
    expect(profile.factors[slotOf(new Date(at(9, 3)))]).toBeLessThan(0.3);
    expect(profile.factors[slotOf(new Date(at(12, 11)))]).toBeLessThan(0.3);
  });

  test('a quota watched for an hour does not outvote weeks of readings', () => {
    const now = at(17, 16);
    const burst = [0, 1, 2, 3].map((i) => reading(now - (40 - i * 13) * MINUTE, 0.1 + i * 0.08, 'Session'));
    const profile = activityProfile([...workWeeks(10), ...burst].sort((a, b) => a.t - b.t))!;
    expect(profile.factors[slotOf(new Date(at(9, 11)))]).toBeGreaterThan(2);
    expect(profile.factors[slotOf(new Date(at(9, 3)))]).toBeLessThan(0.3);
  });

  test('waits for a few days of history', () => {
    expect(activityProfile(workWeeks(2))).toBeNull();
  });

  test('weights time by the profile and finds when enough of it passed', () => {
    const flat: ActivityProfile = { factors: new Array(48).fill(1), days: 7 };
    expect(activeMs(flat, at(21, 10), at(21, 13, 30))).toBe(3.5 * HOUR);
    expect(activeUntil(flat, at(21, 10), 90 * MINUTE, at(22, 0))).toBe(at(21, 11, 30));
    expect(activeUntil(flat, at(21, 10), 90 * HOUR, at(22, 0))).toBe(at(22, 0));
  });

  test('a forecast over quiet hours projects less use than the clock average', () => {
    const factors = Array.from({ length: 48 }, (_, slot) => (slot < 24 && slot >= 9 && slot < 18 ? 3 : 0.2));
    const profile: ActivityProfile = { factors, days: 14 };
    // Friday 20:00 with a reset on Monday 03:00: the rest of the week is evenings and a weekend
    const now = at(25, 20);
    const line = progress('Weekly', 50, 100, { periodDurationMs: 7 * 24 * HOUR, resetsAt: new Date(at(28, 3)).toISOString() });

    const uniform = forecastOf(line, now);
    const learned = forecastOf(line, now, now, profile);
    expect(uniform?.kind === 'atReset' && uniform.fraction).toBeCloseTo(0.743, 2);
    expect(learned?.kind).toBe('atReset');
    expect(learned?.kind === 'atReset' && learned.fraction).toBeLessThan(0.6);
  });

  test('a forecast that runs out lands inside the busy hours', () => {
    const factors = Array.from({ length: 48 }, (_, slot) => (slot < 24 && slot >= 9 && slot < 18 ? 3 : 0.2));
    const profile: ActivityProfile = { factors, days: 14 };
    // Monday 18:00, 60% used since Monday 09:00 of the week's start
    const now = at(21, 18);
    const line = progress('Weekly', 90, 100, { periodDurationMs: 7 * 24 * HOUR, resetsAt: new Date(at(28, 3)).toISOString() });
    const forecast = forecastOf(line, now, now, profile);
    expect(forecast?.kind).toBe('runsOut');
    const runsOutAt = new Date(now + (forecast?.kind === 'runsOut' ? forecast.inMs : 0));
    expect(runsOutAt.getDate()).toBe(22);
    expect(runsOutAt.getHours()).toBeGreaterThanOrEqual(9);
    expect(runsOutAt.getHours()).toBeLessThan(18);
  });
});

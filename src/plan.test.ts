import { describe, expect, test } from 'bun:test';
import type { Sample } from './history';
import { planVerdict, quotaFit, type QuotaFit } from './plan';
import { progress } from './providers/types';

const HOUR = 3600_000;
const WEEK = 7 * 24 * HOUR;
const START = Date.parse('2026-08-03T00:00:00Z');

/** One weekly quota climbing to each peak, read every 6 hours, resetting weekly. */
function weeks(peaks: number[], closingGap = 6 * HOUR): Sample[] {
  const samples: Sample[] = [];
  for (const [week, peak] of peaks.entries()) {
    const start = START + week * WEEK;
    for (let t = 0; t < WEEK; t += 6 * HOUR) {
      const at = start + t;
      // the reading before the reset can come late, like after a closed laptop
      if (week < peaks.length - 1 && t > WEEK - closingGap) continue;
      samples.push({ t: at, p: 'claude', l: 'Weekly', v: (peak * t) / (WEEK - 6 * HOUR) });
    }
  }
  return samples;
}

const weekly = progress('Weekly', 10, 100, { periodDurationMs: WEEK, resetsAt: new Date(START + 10 * WEEK).toISOString() });

function fit(overrides: Partial<QuotaFit>): QuotaFit {
  return { label: 'Weekly', periodDurationMs: WEEK, periods: 4, medianPeak: 0.3, maxPeak: 0.4, ranOut: 0, ranOutDays: 0, ...overrides };
}

describe('plan fit', () => {
  test('reads each finished period up to its peak', () => {
    const result = quotaFit(weeks([0.3, 0.5, 1, 0.2]), 'claude', weekly)!;
    expect(result.periods).toBe(3);
    expect(result.maxPeak).toBe(1);
    expect(result.medianPeak).toBeCloseTo(0.5, 5);
    expect(result.ranOut).toBe(1);
  });

  test('skips a period whose end the app did not see', () => {
    // two days without readings before each reset can hide the peak
    expect(quotaFit(weeks([0.3, 0.5, 0.2], 54 * HOUR), 'claude', weekly)!.periods).toBe(0);
  });

  test('learns until two periods of the longest quota ended', () => {
    expect(planVerdict('codex', 'Plus', [fit({ periods: 1 })])).toEqual({ kind: 'learning', label: 'Weekly', seen: 1, needed: 2 });
  });

  test('running out often calls for a bigger plan', () => {
    const session = fit({ label: 'Session', periodDurationMs: 5 * HOUR, periods: 20, ranOut: 9, ranOutDays: 6, maxPeak: 1 });
    expect(planVerdict('codex', 'Plus', [fit({}), session])).toEqual({ kind: 'upgrade', label: 'Session', ranOut: 6, periods: 20, days: true });
  });

  test('names the smaller Claude tier that still leaves headroom', () => {
    expect(planVerdict('claude', 'Max 20x', [fit({ maxPeak: 0.15 })])).toMatchObject({ kind: 'downsize', plan: 'Max 5x', ratio: 4 });
    expect(planVerdict('claude', 'Max 20x', [fit({ maxPeak: 0.03 })])).toMatchObject({ kind: 'downsize', plan: 'Pro', ratio: 20 });
    expect(planVerdict('claude', 'Max 5x', [fit({ maxPeak: 0.3 })])).toMatchObject({ kind: 'fits' });
  });

  test('falls back to a half-size plan elsewhere and never downsizes after running out', () => {
    expect(planVerdict('cursor', 'Pro', [fit({ maxPeak: 0.3 })])).toMatchObject({ kind: 'downsize', plan: null, ratio: 2 });
    expect(planVerdict('cursor', 'Pro', [fit({ maxPeak: 0.3 }), fit({ label: 'Session', periodDurationMs: 5 * HOUR, periods: 30, ranOut: 1, maxPeak: 1 })]))
      .toMatchObject({ kind: 'fits' });
  });
});

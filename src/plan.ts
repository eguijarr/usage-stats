import { resetGroupOf } from './format';
import type { Sample } from './history';
import { RESET_DROP, seriesOf } from './pace';
import type { ProgressLine } from './providers/types';

/**
 * How one quota fared over the periods the history saw end, from their
 * peaks: the use each period reached right before its reset.
 */
export interface QuotaFit {
  label: string;
  periodDurationMs: number;
  /** Periods seen from their last readings to the reset after them. */
  periods: number;
  medianPeak: number;
  maxPeak: number;
  /** Periods that reached the limit. */
  ranOut: number;
  /** Local days on which the quota ran out, for sessions and daily quotas. */
  ranOutDays: number;
}

/**
 * A quota counts as used up at 99.5%, the whole percents providers report.
 */
const FULL = 0.995;

/**
 * A period's last reading must fall this close to its reset, or its peak
 * may have been missed while the app was closed.
 */
function maxClosingGap(periodMs: number): number {
  return Math.max(30 * 60_000, 0.15 * periodMs);
}

/**
 * Splits a quota's readings at its resets and keeps the periods whose end
 * the history saw. A period's peak is its highest reading, since use only
 * grows inside a period.
 */
export function quotaFit(history: Sample[], providerId: string, line: ProgressLine): QuotaFit | null {
  const period = line.periodDurationMs;
  if (period === null || !(period > 0)) return null;

  const samples = seriesOf(history, providerId, line.label);
  const peaks: number[] = [];
  const days = new Set<string>();
  let peak = 0;
  let fullAt: number | null = null;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    const previous = samples[i - 1];

    if (previous !== undefined && sample.v < previous.v - RESET_DROP) {
      // the first period starts wherever the history does, but its end is known
      if (sample.t - previous.t <= maxClosingGap(period)) {
        peaks.push(peak);
        if (fullAt !== null) {
          const date = new Date(fullAt);
          days.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
        }
      }
      peak = 0;
      fullAt = null;
    }

    peak = Math.max(peak, sample.v);
    if (sample.v >= FULL && fullAt === null) fullAt = sample.t;
  }

  const sorted = [...peaks].sort((a, b) => a - b);

  return {
    label: line.label,
    periodDurationMs: period,
    periods: peaks.length,
    medianPeak: sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)]!,
    maxPeak: sorted.at(-1) ?? 0,
    ranOut: peaks.filter((value) => value >= FULL).length,
    ranOutDays: days.size,
  };
}

export type PlanVerdict =
  | { kind: 'learning'; label: string; seen: number; needed: number }
  | { kind: 'upgrade'; label: string; ranOut: number; periods: number; days: boolean }
  | { kind: 'downsize'; label: string; maxPeak: number; ratio: number; plan: string | null }
  | { kind: 'fits'; label: string; maxPeak: number };

/**
 * Plan tiers whose limits are known multiples of each other, lowest
 * first. Claude's Max plans are sold as 5x and 20x the use of Pro.
 */
const LADDERS: Record<string, { plan: RegExp; name: string; scale: number }[]> = {
  claude: [
    { plan: /^pro$/i, name: 'Pro', scale: 1 },
    { plan: /^max 5x$/i, name: 'Max 5x', scale: 5 },
    { plan: /^max 20x$/i, name: 'Max 20x', scale: 20 },
  ],
};

/**
 * Use must stay under this share of a smaller plan's limit to call the
 * plan too big, leaving room for a heavier week than any seen so far.
 */
const DOWNSIZE_HEADROOM = 0.85;

/**
 * Running out in this share of periods or more calls for more room.
 */
const UPGRADE_SHARE = 0.25;

/**
 * The quota whose periods decide, needs this many periods seen through.
 */
const MIN_PERIODS = 2;

/**
 * Names the smaller plan a user's peak use would fit into, or the
 * generic half-size plan when the provider's tiers are not known.
 */
function smallerPlan(providerId: string, plan: string | null, maxPeak: number): { ratio: number; plan: string | null } | null {
  const ladder = LADDERS[providerId];
  const current = ladder?.findIndex((tier) => plan !== null && tier.plan.test(plan.trim())) ?? -1;

  if (ladder !== undefined && current >= 0) {
    // the smallest tier that still leaves headroom
    for (let i = 0; i < current; i++) {
      const ratio = ladder[current]!.scale / ladder[i]!.scale;
      if (maxPeak * ratio <= DOWNSIZE_HEADROOM) return { ratio, plan: ladder[i]!.name };
    }
    return null;
  }

  return maxPeak * 2 <= DOWNSIZE_HEADROOM ? { ratio: 2, plan: null } : null;
}

/**
 * Weighs a provider's quotas over the history into one plan verdict. The
 * longest quota, the budget everything else draws from, decides whether
 * the plan fits; shorter windows running out often call for more room.
 */
export function planVerdict(providerId: string, plan: string | null, fits: QuotaFit[]): PlanVerdict | null {
  if (fits.length === 0) return null;

  const longest = [...fits].sort((a, b) => b.periodDurationMs - a.periodDurationMs)[0]!;

  if (longest.periods < MIN_PERIODS) {
    return { kind: 'learning', label: longest.label, seen: longest.periods, needed: MIN_PERIODS };
  }

  const pressed = fits
    .filter((fit) => fit.periods >= MIN_PERIODS && fit.ranOut / fit.periods >= UPGRADE_SHARE)
    .sort((a, b) => b.ranOut / b.periods - a.ranOut / a.periods)[0];

  if (pressed !== undefined) {
    const daily = resetGroupOf({ periodDurationMs: pressed.periodDurationMs, label: pressed.label } as ProgressLine) === 'session';
    return { kind: 'upgrade', label: pressed.label, ranOut: daily ? pressed.ranOutDays : pressed.ranOut, periods: pressed.periods, days: daily };
  }

  const seen = fits.filter((fit) => fit.periods > 0);
  const maxPeak = Math.max(...seen.map((fit) => fit.maxPeak));
  const smaller = fits.some((fit) => fit.ranOut > 0) ? null : smallerPlan(providerId, plan, maxPeak);

  if (smaller !== null) {
    return { kind: 'downsize', label: longest.label, maxPeak: longest.maxPeak, ratio: smaller.ratio, plan: smaller.plan };
  }

  return { kind: 'fits', label: longest.label, maxPeak: longest.maxPeak };
}

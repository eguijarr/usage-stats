import { activeMs, activeUntil, slotOf, type ActivityProfile, type RecentPace } from './pace';
import type { ProgressLine } from './providers/types';

/**
 * Formats a duration compactly the way pr-stats does, like 45s, 12m,
 * 2h 15m, or 3d 4h.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }

  const days = Math.floor(hours / 24);
  const rest = hours % 24;

  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/**
 * Formats the used amount of a line in its own unit, like 47%, $3.10 of
 * $25.00, or 120 / 500 req.
 */
export function formatUsed(line: ProgressLine): string {
  switch (line.format.kind) {
    case 'percent':
      return `${Math.round(line.used)}%`;
    case 'dollars':
      return `$${line.used.toFixed(2)} / $${line.limit.toFixed(2)}`;
    case 'count': {
      const suffix = line.format.suffix ? ` ${line.format.suffix}` : '';
      return `${formatNumber(line.used)} / ${formatNumber(line.limit)}${suffix}`;
    }
  }
}

export function formatNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }

  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function fraction(line: ProgressLine): number {
  return line.limit > 0 ? Math.min(1, Math.max(0, line.used / line.limit)) : 0;
}

/**
 * Share of the current period that already elapsed, or null when the
 * plugin does not report the period or its reset.
 */
export function elapsedFraction(line: ProgressLine, now: number): number | null {
  if (line.resetsAt === null || line.periodDurationMs === null || !Number.isFinite(line.periodDurationMs) || line.periodDurationMs <= 0) {
    return null;
  }

  const remaining = Date.parse(line.resetsAt) - now;

  // An expired window or a reset beyond the period cannot define a rate.
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > line.periodDurationMs) return null;

  return 1 - remaining / line.periodDurationMs;
}

export type Forecast =
  | { kind: 'runsOut'; inMs: number }
  | { kind: 'atReset'; fraction: number }
  | { kind: 'exhausted' };

/**
 * Extrapolates the current burn rate to the reset. A quota that would hit
 * its limit first reports how long until it runs out, otherwise the share
 * it would reach at the reset. Early in a period the rate says little, so
 * nothing is forecast before 5% of it passed. The rate belongs to the
 * observation time, not the UI clock: between polls only the countdown
 * changes, never the projected total.
 *
 * With an activity profile the rate is spread over the user's usual
 * hours instead of the clock: a weekly quota whose remaining days are
 * mostly nights and a weekend will see less use than its average says.
 */
export function forecastOf(line: ProgressLine, now: number, observedAt = now, profile: ActivityProfile | null = null): Forecast | null {
  if (!Number.isFinite(now) || !Number.isFinite(observedAt) || !Number.isFinite(line.used) || line.used < 0 ||
    !Number.isFinite(line.limit) || line.limit <= 0) return null;
  if (line.resetsAt !== null && !(Date.parse(line.resetsAt) > now)) return null;

  const used = fraction(line);

  if (used >= 1) {
    return { kind: 'exhausted' };
  }

  // A just-completed poll can be ahead of the UI's one-second clock.
  const sampledAt = Math.min(now, observedAt);
  const elapsed = elapsedFraction(line, sampledAt);

  if (elapsed === null || elapsed < 0.05 || used <= 0 || line.periodDurationMs === null) {
    return null;
  }

  if (profile !== null && line.resetsAt !== null) {
    const reset = Date.parse(line.resetsAt);
    const past = activeMs(profile, reset - line.periodDurationMs, sampledAt);

    // a period that so far fell on hours the profile calls idle has no usable rate
    if (past >= 0.01 * line.periodDurationMs) {
      const projected = (used * (past + activeMs(profile, sampledAt, reset))) / past;

      if (projected <= 1) {
        return { kind: 'atReset', fraction: projected };
      }

      const runsOutAt = activeUntil(profile, sampledAt, ((1 - used) * past) / used, reset);
      return { kind: 'runsOut', inMs: Math.max(0, runsOutAt - now) };
    }
  }

  const projected = used / elapsed;

  if (projected <= 1) {
    return { kind: 'atReset', fraction: projected };
  }

  const elapsedMs = elapsed * line.periodDurationMs;

  return { kind: 'runsOut', inMs: Math.max(0, sampledAt + ((1 - used) * elapsedMs) / used - now) };
}

export interface FastBurn {
  inMs: number;
  perHour: number;
}

/**
 * Flags a burst the period average hides: at the last hour's pace the
 * quota would run out before its reset. Nothing is flagged when the
 * average forecast already tells about as much.
 *
 * With an activity profile the pace only continues through the user's
 * usual hours, not around the clock: a busy afternoon on a weekly quota
 * lasts as many afternoons as the budget allows. The hour being measured
 * counts as at least an average one, since the user is working in it.
 */
export function fastBurnOf(
  line: ProgressLine,
  pace: RecentPace | null,
  now: number,
  observedAt: number,
  forecast: Forecast | null,
  profile: ActivityProfile | null = null,
): FastBurn | null {
  if (pace === null || !(pace.perHour > 0) || line.resetsAt === null || forecast?.kind === 'exhausted') return null;

  const used = fraction(line);
  if (used >= 1) return null;

  const sampledAt = Math.min(now, observedAt);
  const reset = Date.parse(line.resetsAt);
  const hoursLeft = (1 - used) / pace.perHour;
  const outAt = profile === null
    ? sampledAt + hoursLeft * 3600_000
    : activeUntil(profile, sampledAt, hoursLeft * 3600_000 * Math.max(1, profile.factors[slotOf(new Date(sampledAt))]!), reset);
  if (!(outAt < reset)) return null;

  const inMs = Math.max(0, outAt - now);
  if (forecast?.kind === 'runsOut' && forecast.inMs <= 1.5 * inMs) return null;

  return { inMs, perHour: pace.perHour };
}

/**
 * Formats a share as a percent, with one decimal below 10% so small
 * quotas like 4.6% do not round into each other.
 */
export function formatPercent(value: number): string {
  const pct = value * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';

  return pct > 0 && pct < 10 && Math.round(pct * 10) % 10 !== 0 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

export function padEnd(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

export function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

export type ResetGroup = 'session' | 'weekly' | 'monthly' | 'other';

/**
 * Sorts a quota into the reset cadence it belongs to: five-hour sessions
 * and daily quotas, weekly windows, and monthly billing cycles like
 * Cursor's. The period length decides, the label is the fallback.
 */
export function resetGroupOf(line: ProgressLine): ResetGroup {
  const period = line.periodDurationMs;

  if (period !== null && period > 0) {
    if (period <= 26 * 3600_000) {
      return 'session';
    }

    if (period <= 8 * 24 * 3600_000) return 'weekly';
    return period >= 28 * 24 * 3600_000 && period <= 31 * 24 * 3600_000 ? 'monthly' : 'other';
  }

  if (/session|daily|hour/i.test(line.label)) {
    return 'session';
  }

  return /week/i.test(line.label) ? 'weekly' : /month/i.test(line.label) ? 'monthly' : 'other';
}

/**
 * Share of a quota likely left unused when it resets, the credits that
 * would be left. Missing or early-period forecasts stay unknown; the
 * currently unused share is not a prediction of what will remain.
 */
export function expiringShare(line: ProgressLine, now: number, observedAt = now, profile: ActivityProfile | null = null): number | null {
  const forecast = forecastOf(line, now, observedAt, profile);

  if (forecast === null) {
    return null;
  }

  if (forecast.kind === 'atReset') {
    return Math.max(0, 1 - forecast.fraction);
  }

  return 0;
}

/**
 * Quotas worth steering work to before they reset: at least this share
 * would otherwise expire unused.
 */
export const FOCUS_MIN_EXPIRING = 0.15;

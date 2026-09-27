import type { Sample } from './history';

const HOUR = 3600_000;

/**
 * A reading this far below the previous one of its quota means the quota
 * reset. Providers report whole percents, so a smaller dip is rounding.
 */
export const RESET_DROP = 0.02;

/**
 * Readings of one quota in time order. The history is sorted on load and
 * appended in order, so a filter keeps it sorted.
 */
export function seriesOf(history: Sample[], providerId: string, label: string): Sample[] {
  return history.filter((sample) => sample.p === providerId && sample.l === label);
}

/**
 * How fast a quota moved lately, as a share of its limit per hour. The
 * period average hides a burst: a heavy hour barely moves a weekly
 * average, but it is what decides whether the week lasts.
 */
export interface RecentPace {
  perHour: number;
  spanMs: number;
}

export const RECENT_WINDOW_MS = HOUR;

/**
 * Shorter spans carry a single rounding step and read as a burst that is
 * not there.
 */
const MIN_RECENT_SPAN_MS = 20 * 60_000;

/**
 * Two whole-percent steps at least, for the same reason.
 */
const MIN_RECENT_DELTA = 0.02;

/**
 * A reading just before the window still marks where it started, up to
 * the history's 5-minute heartbeat plus a slow poll.
 */
const BASELINE_MS = 15 * 60_000;

/**
 * Index of the first sample at or after t in a time-sorted history.
 */
function firstAtOrAfter(history: Sample[], t: number): number {
  let low = 0;
  let high = history.length;

  while (low < high) {
    const mid = (low + high) >>> 1;
    if (history[mid]!.t < t) low = mid + 1;
    else high = mid;
  }

  return low;
}

/**
 * Measures the pace over the last hour. It runs on every UI tick for every
 * quota, so it only walks the tail of the time-sorted history.
 */
export function recentPace(history: Sample[], providerId: string, label: string, now: number): RecentPace | null {
  const start = now - RECENT_WINDOW_MS;
  let window: Sample[] = [];
  let before: Sample | null = null;

  for (let i = firstAtOrAfter(history, start - BASELINE_MS); i < history.length; i++) {
    const sample = history[i]!;
    if (sample.p !== providerId || sample.l !== label || sample.t > now) continue;
    if (sample.t < start) {
      before = sample;
      continue;
    }
    // a reset inside the window starts the count over
    const last = window.at(-1) ?? before;
    if (last !== null && sample.v < last.v - RESET_DROP) {
      window = [];
      before = null;
    }
    window.push(sample);
  }

  if (before !== null && window.length > 0 && start - before.t <= BASELINE_MS && !(window[0]!.v < before.v - RESET_DROP)) {
    window.unshift(before);
  }

  if (window.length < 2) return null;

  const first = window[0]!;
  const last = window.at(-1)!;
  const spanMs = last.t - first.t;

  if (spanMs < MIN_RECENT_SPAN_MS) return null;

  const delta = last.v - first.v;

  return { perHour: delta < MIN_RECENT_DELTA ? 0 : (delta / spanMs) * HOUR, spanMs };
}

/**
 * Usual intensity of use by hour of day, separately for weekdays and
 * weekends, relative to the average hour of a week: 0.2 at night means a
 * night hour sees a fifth of an average hour's use. Forecasts integrate
 * it instead of assuming the same pace around the clock.
 */
export interface ActivityProfile {
  /** 24 weekday hours, then 24 weekend hours. */
  factors: number[];
  /** Local days the profile learned from. */
  days: number;
}

const SLOTS = 48;

/**
 * Share of a week's hours in each slot: five weekdays and two weekend days.
 */
const SLOT_WEIGHT = Array.from({ length: SLOTS }, (_, slot) => (slot < 24 ? 5 : 2) / (7 * 24));

export function slotOf(date: Date): number {
  const day = date.getDay();

  return (day === 0 || day === 6 ? 24 : 0) + date.getHours();
}

/**
 * The start of the local hour after t, which DST shifts can make shorter
 * or longer than an hour.
 */
function nextHour(t: number): number {
  const date = new Date(t);
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1).getTime();

  return next > t ? next : t + HOUR;
}

/**
 * Splits a stretch of time at local hour boundaries and hands each piece
 * to visit with its slot.
 */
function eachSlot(from: number, to: number, visit: (slot: number, ms: number) => void): void {
  let t = from;

  while (t < to) {
    const next = Math.min(to, nextHour(t));
    visit(slotOf(new Date(t)), next - t);
    t = next;
  }
}

/**
 * A gap longer than a day says too little about when the use happened.
 */
const MAX_SPREAD_MS = 24 * HOUR;

/**
 * A reset between two readings further apart than this hides how much was
 * used before it.
 */
const MAX_RESET_GAP_MS = 30 * 60_000;

/**
 * Below this a quota barely moved, and its readings say nothing about the
 * hours of use.
 */
const MIN_SERIES_USE = 0.03;

const MIN_PROFILE_DAYS = 4;
const MIN_PROFILE_SPAN_MS = 3 * 24 * HOUR;

/**
 * Every slot starts as if half an hour of it had been seen at the average
 * pace, so a slot seen once or twice stays near the average instead of
 * trusting one idle or busy evening.
 */
const PRIOR_MS = 30 * 60_000;
const MIN_FACTOR = 0.05;
const MAX_FACTOR = 6;

/**
 * Learns the profile from the history. Each quota spreads the use between
 * two readings evenly over the hours between them and counts those hours
 * as observed; a slot's factor is its use over its observed time. Each
 * quota's use is rescaled to an average pace of one per observed hour, so
 * a fast five-hour session and a slow monthly budget speak with the same
 * voice, and a quota weighs as much as the time it was watched: an hour
 * of readings does not outvote weeks. Returns null until the history
 * covers a few days.
 */
export function activityProfile(history: Sample[]): ActivityProfile | null {
  if (history.length < 2) return null;

  const series = new Map<string, Sample[]>();
  const days = new Set<string>();

  for (const sample of history) {
    const key = `${sample.p}\n${sample.l}`;
    let list = series.get(key);
    if (list === undefined) series.set(key, (list = []));
    list.push(sample);
    const date = new Date(sample.t);
    days.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
  }

  const span = history.at(-1)!.t - history[0]!.t;
  if (days.size < MIN_PROFILE_DAYS || span < MIN_PROFILE_SPAN_MS) return null;

  const use = new Array<number>(SLOTS).fill(0);
  const time = new Array<number>(SLOTS).fill(0);
  let quotas = 0;

  for (const samples of series.values()) {
    const seriesUse = new Array<number>(SLOTS).fill(0);
    const seriesTime = new Array<number>(SLOTS).fill(0);
    let totalUse = 0;
    let totalTime = 0;

    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      const gap = b.t - a.t;
      if (gap <= 0 || gap > MAX_SPREAD_MS) continue;

      let used = b.v - a.v;
      if (used < -RESET_DROP) {
        if (gap > MAX_RESET_GAP_MS) continue;
        // what the new period used since the reset
        used = b.v;
      }
      used = Math.max(0, used);

      eachSlot(a.t, b.t, (slot, ms) => {
        seriesTime[slot]! += ms;
        seriesUse[slot]! += (used * ms) / gap;
      });
      totalUse += used;
      totalTime += gap;
    }

    if (totalUse < MIN_SERIES_USE || totalTime <= 0) continue;

    quotas++;
    for (let slot = 0; slot < SLOTS; slot++) {
      use[slot]! += (seriesUse[slot]! * totalTime) / totalUse;
      time[slot]! += seriesTime[slot]!;
    }
  }

  if (quotas === 0) return null;

  const prior = PRIOR_MS * quotas;
  const raw = use.map((u, slot) => Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, (u + prior) / (time[slot]! + prior))));
  const mean = raw.reduce((sum, factor, slot) => sum + factor * SLOT_WEIGHT[slot]!, 0);

  return { factors: raw.map((factor) => factor / mean), days: days.size };
}

/**
 * Time between from and to weighted by the profile, in average-hour
 * milliseconds: eight quiet night hours at 0.1 count as 48 minutes.
 */
export function activeMs(profile: ActivityProfile, from: number, to: number): number {
  let total = 0;

  eachSlot(from, to, (slot, ms) => {
    total += ms * profile.factors[slot]!;
  });

  return total;
}

/**
 * The moment after from when target average-hour milliseconds have
 * passed, or limit when they do not fit before it.
 */
export function activeUntil(profile: ActivityProfile, from: number, target: number, limit: number): number {
  let t = from;
  let left = target;

  while (t < limit) {
    const next = Math.min(limit, nextHour(t));
    const factor = profile.factors[slotOf(new Date(t))]!;
    const piece = (next - t) * factor;

    if (piece >= left) {
      return t + left / factor;
    }

    left -= piece;
    t = next;
  }

  return limit;
}

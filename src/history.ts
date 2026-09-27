import { chmodSync, closeSync, constants, existsSync, fchmodSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProviderSnapshot } from './providers/types';
import { publicText } from './privacy';

/**
 * One stored reading of a progress line, as a fraction of its limit so
 * percent, dollar, and count quotas share one scale.
 */
export interface Sample {
  t: number;
  p: string;
  l: string;
  v: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Keeps two months of samples by default: two monthly billing cycles for
 * the plan fit, and plenty of weeks for the activity profile.
 * USAGE_STATS_HISTORY_DAYS changes it, from a week (the trend window)
 * to about a year.
 */
export function retentionMs(env: Record<string, string | undefined> = process.env): number {
  const days = Number.parseInt(env.USAGE_STATS_HISTORY_DAYS ?? '', 10);

  return (Number.isFinite(days) ? Math.min(400, Math.max(7, days)) : 62) * DAY_MS;
}

/**
 * Readings older than this are only needed for the 7-day chart, the plan
 * fit, and the activity profile, none of which needs every poll.
 */
const FULL_DETAIL_MS = 2 * DAY_MS;

/**
 * Older readings keep one per quota and half hour: the highest, so a
 * period's peak and a quota that ran out survive the compaction.
 */
const COMPACT_BUCKET_MS = 30 * 60_000;

export function compact(samples: Sample[], before: number): Sample[] {
  const buckets = new Map<string, Sample>();
  const recent: Sample[] = [];

  for (const sample of samples) {
    if (sample.t >= before) {
      recent.push(sample);
      continue;
    }
    const key = `${sample.p}\n${sample.l}\n${Math.floor(sample.t / COMPACT_BUCKET_MS)}`;
    const kept = buckets.get(key);
    // the bucket's last time, so a reset inside it still shows in the next one
    buckets.set(key, kept === undefined ? sample : { ...(sample.v > kept.v ? sample : kept), t: Math.max(kept.t, sample.t) });
  }

  return [...buckets.values(), ...recent].sort((a, b) => a.t - b.t);
}

/**
 * A reading equal to the last stored one for its quota is only kept once
 * this much time passed, so a steady quota costs a row every few minutes
 * instead of one per poll. The charts carry the previous value forward,
 * so skipping repeats draws the same lines.
 */
const HEARTBEAT_MS = 5 * 60 * 1000;

type LastStored = Map<string, { t: number; v: number }>;

const lastStored = new Map<string, LastStored>();

function thin(samples: Sample[], last: LastStored): Sample[] {
  return samples.filter((sample) => {
    const key = `${sample.p}\n${sample.l}`;
    const previous = last.get(key);

    if (previous && previous.v === sample.v && sample.t - previous.t < HEARTBEAT_MS) {
      return false;
    }

    last.set(key, { t: sample.t, v: sample.v });
    return true;
  });
}

export const HISTORY_FILE = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
  'usage-stats',
  'history.jsonl',
);

/**
 * Loads the stored samples and rewrites the file without the expired ones
 * and with the old ones compacted, so the history never grows past the
 * retention window.
 */
export function loadHistory(file = HISTORY_FILE, now = Date.now(), retention = retentionMs()): Sample[] {
  if (!existsSync(file)) {
    return [];
  }

  const cutoff = now - retention;
  const samples: Sample[] = [];

  const fd = openPrivateHistory(file, false);
  try {
    for (const row of readFileSync(fd, 'utf8').split('\n')) {
      if (row === '') {
        continue;
      }

      try {
        const sample = JSON.parse(row) as Sample;
        if (sample && Number.isFinite(sample.t) && sample.t >= cutoff && Number.isFinite(sample.v) &&
          typeof sample.p === 'string' && /^[a-z][a-z0-9-]*$/.test(sample.p) && typeof sample.l === 'string') {
          samples.push({ t: sample.t, p: sample.p, l: publicText(sample.l), v: sample.v });
        }
      } catch {
        // a torn write from a killed process only loses that one row
      }
    }
  } finally {
    closeSync(fd);
  }
  // Two running instances can interleave their appends; the charts expect time order.
  samples.sort((a, b) => a.t - b.t);
  const last: LastStored = new Map();
  const kept = compact(thin(samples, last), now - FULL_DETAIL_MS);
  writePrivateHistory(file, kept, false);
  lastStored.set(file, last);

  return kept;
}

/**
 * Turns a snapshot's progress lines into samples and appends them to the
 * history file.
 */
export function recordSnapshot(snapshot: ProviderSnapshot, at: number, file = HISTORY_FILE): Sample[] {
  const samples: Sample[] = [];

  for (const line of snapshot.lines) {
    if (line.type === 'progress' && Number.isFinite(line.used) && Number.isFinite(line.limit) && line.limit > 0) {
      samples.push({ t: at, p: snapshot.providerId, l: publicText(line.label), v: line.used / line.limit });
    }
  }

  const last: LastStored = new Map(lastStored.get(file));
  const kept = thin(samples, last);

  if (kept.length > 0) {
    writePrivateHistory(file, kept, true);
  }
  lastStored.set(file, last);

  return kept;
}

function openPrivateHistory(file: string, append: boolean): number {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (file === HISTORY_FILE && process.platform !== 'win32') chmodSync(dir, 0o700);
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | noFollow | (append ? constants.O_APPEND : 0), 0o600);
  try {
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function writePrivateHistory(file: string, samples: Sample[], append: boolean): void {
  const fd = openPrivateHistory(file, append);
  try {
    if (!append) {
      // Truncate only after checking permissions and rejecting symlinks.
      ftruncateSync(fd, 0);
    }
    writeFileSync(fd, samples.map((sample) => JSON.stringify(sample) + '\n').join(''));
  } finally {
    closeSync(fd);
  }
}

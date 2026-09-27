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

/**
 * Keeps two weeks of samples, enough for the 7-day trend window plus a
 * full weekly period before it.
 */
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

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
 * Loads the stored samples and rewrites the file without the expired ones,
 * so the history never grows past the retention window.
 */
export function loadHistory(file = HISTORY_FILE): Sample[] {
  if (!existsSync(file)) {
    return [];
  }

  const cutoff = Date.now() - RETENTION_MS;
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
  const kept = thin(samples, last);
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

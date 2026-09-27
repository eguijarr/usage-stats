import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHistory, recordSnapshot } from './history';
import { progress, type ProviderSnapshot } from './providers/types';
import { writeFileAtomic } from './providers/env';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'usage-private-history-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('private local storage', () => {
  test('stores only quota readings, appends them and loads them without credential fields', () => {
    const file = join(dir, 'history.jsonl');
    const snapshot = (used: number) => ({ providerId: 'codex', displayName: 'Codex', plan: 'Plus', warning: null,
      access_token: 'private-test-value', email: 'person@example.invalid',
      lines: [progress('Session', used, 100), { type: 'text', label: 'Token', value: 'private-test-value' }],
    } as ProviderSnapshot);
    const now = Date.now();
    recordSnapshot(snapshot(25), now, file);
    recordSnapshot(snapshot(30), now + 1, file);
    const samples = loadHistory(file);
    expect(samples).toEqual([
      { t: now, p: 'codex', l: 'Session', v: 0.25 },
      { t: now + 1, p: 'codex', l: 'Session', v: 0.3 },
    ]);
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toContain('private-test-value');
    expect(saved).not.toContain('email');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('removes expired readings, unexpected fields and personal labels from existing history', () => {
    const file = join(dir, 'history.jsonl');
    const now = Date.now();
    writeFileSync(file, [
      { t: now, p: 'codex', l: 'contact person@example.invalid', v: 0.14, refresh_token: 'private-test-value' },
      { t: now - 15 * 86400_000, p: 'codex', l: 'Weekly', v: 0.3 },
      { t: now, p: 'person@example.invalid', l: 'Weekly', v: 0.3 },
    ].map((sample) => JSON.stringify(sample)).join('\n') + '\nbroken row\n');
    chmodSync(file, 0o644);
    expect(loadHistory(file)).toEqual([{ t: now, p: 'codex', l: 'contact [redacted email]', v: 0.14 }]);
    expect(readFileSync(file, 'utf8')).not.toContain('private-test-value');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('keeps a repeated reading only every few minutes, both in old files and new polls', () => {
    const file = join(dir, 'history.jsonl');
    const minute = 60_000;
    const start = Date.now() - 3600_000;
    const row = (m: number, v: number, l = 'Weekly') => JSON.stringify({ t: start + m * minute, p: 'codex', l, v });
    // out of order, like two instances appending to one file
    writeFileSync(file, [row(0, 0.3), row(2, 0.3), row(1, 0.3), row(6, 0.3), row(7, 0.3), row(8, 0.31), row(1, 0.5, 'Session')].join('\n') + '\n');

    expect(loadHistory(file).map((s) => [s.l, (s.t - start) / minute, s.v])).toEqual([
      ['Weekly', 0, 0.3], ['Session', 1, 0.5], ['Weekly', 6, 0.3], ['Weekly', 8, 0.31],
    ]);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(4);

    const poll = (used: number, m: number) => recordSnapshot({ providerId: 'codex', displayName: 'Codex', plan: null, warning: null,
      lines: [progress('Weekly', used, 100)] }, start + m * minute, file);
    expect(poll(31, 9)).toEqual([]);
    expect(poll(32, 10)).toHaveLength(1);
    expect(poll(32, 14)).toEqual([]);
    expect(poll(32, 15)).toHaveLength(1);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(6);
  });

  test.skipIf(process.platform === 'win32')('refuses to write history through a symlink', () => {
    const target = join(dir, 'other-file');
    const file = join(dir, 'history.jsonl');
    writeFileSync(target, 'unchanged');
    symlinkSync(target, file);
    expect(() => recordSnapshot({ providerId: 'codex', displayName: 'Codex', plan: null, warning: null,
      lines: [progress('Session', 25, 100)] }, Date.now(), file)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('unchanged');
  });

  test('writes rotated credentials privately and leaves no temporary file on success or failure', () => {
    const file = join(dir, 'auth.json');
    writeFileAtomic(file, 'private-test-value');
    expect(readFileSync(file, 'utf8')).toBe('private-test-value');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['auth.json']);
    expect(() => writeFileAtomic(dir, 'private-test-value')).toThrow();
    expect(readdirSync(dir)).toEqual(['auth.json']);
  });
});

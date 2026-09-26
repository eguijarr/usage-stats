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
    const snapshot = { providerId: 'codex', displayName: 'Codex', plan: 'Plus', warning: null,
      access_token: 'private-test-value', email: 'person@example.invalid',
      lines: [progress('Session', 25, 100), { type: 'text', label: 'Token', value: 'private-test-value' }],
    } as ProviderSnapshot;
    const now = Date.now();
    recordSnapshot(snapshot, now, file);
    recordSnapshot(snapshot, now + 1, file);
    const samples = loadHistory(file);
    expect(samples).toEqual([
      { t: now, p: 'codex', l: 'Session', v: 0.25 },
      { t: now + 1, p: 'codex', l: 'Session', v: 0.25 },
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

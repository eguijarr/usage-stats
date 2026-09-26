import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'usage-private-cli-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function cli(mode: 'success' | 'error') {
  const credentials = join(dir, 'login');
  mkdirSync(credentials);
  const token = `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({
    exp: Date.now() / 1000 + 3600, email: 'person@example.invalid', name: 'Private Sample Person',
  })).toString('base64url')}.synthetic-signature`;
  writeFileSync(join(credentials, 'auth.json'), JSON.stringify({ tokens: { access_token: token } }), { mode: 0o600 });
  const preload = join(dir, 'fetch.ts');
  writeFileSync(preload, `globalThis.fetch = async () => {
    ${mode === 'error' ? 'throw new Error("fetch failed /home/private-person/auth.json refresh_token=opaque-private-credential");' : `return new Response(JSON.stringify({
      plan_type: "plus", email: "person@example.invalid", access_token: "opaque-private-credential",
      account_id: "private-account-identifier", user: { name: "Private Sample Person" },
      rate_limit: { primary_window: { used_percent: 89, limit_window_seconds: 18000, reset_after_seconds: 3600 } },
      additional_rate_limits: [{ limit_name: "Private Sample Person", rate_limit: {
        primary_window: { used_percent: 14, limit_window_seconds: 604800, reset_after_seconds: 3600 }
      } }]
    }), { status: 200 });`}
  };`, { mode: 0o600 });
  return spawnSync(process.execPath, ['--preload', preload, resolve('src/main.tsx'), '--json', '--providers', 'codex'], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, CODEX_HOME: credentials, USAGE_STATS_HOME: dir, USAGE_STATS_WINDOWS_HOME: dir },
  });
}

describe('public CLI output', () => {
  test('JSON keeps quotas but excludes account fields and registered identities', () => {
    const result = cli('success');
    expect(result.status).toBe(0);
    const output = result.stdout + result.stderr;
    for (const value of ['person@example.invalid', 'Private Sample Person', 'opaque-private-credential',
      'private-account-identifier', 'synthetic-signature', 'access_token', 'account_id']) expect(output).not.toContain(value);
    const report = JSON.parse(result.stdout);
    expect(report[0].lines[0]).toMatchObject({ label: 'Session', used: 89 });
  });

  test('JSON errors never echo request credentials or local paths', () => {
    const result = cli('error');
    expect(result.status).toBe(0);
    const output = result.stdout + result.stderr;
    for (const value of ['private-person', 'opaque-private-credential', 'refresh_token', dir]) expect(output).not.toContain(value);
    expect(JSON.parse(result.stdout)[0].error).toContain('Check your connection');
  });
});

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgyPayload, parseSummary } from './antigravity';
import { claude } from './claude';
import { codex } from './codex';
import { cursor } from './cursor';
import { devin } from './devin';
import { decodeBlob } from './secrets';
import type { ProgressLine } from './types';

/**
 * Every test runs against a throwaway home with fake credentials and a
 * stubbed fetch, so nothing touches real logins or the network.
 */

let home: string;
const realFetch = globalThis.fetch;
const env = { ...process.env };
let calls: { url: string; init?: RequestInit }[] = [];

function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body, headers } = handler(url, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
}

function jwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
}

const progressLines = (lines: { type: string }[]) => lines.filter((l): l is ProgressLine => l.type === 'progress');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'usage-stats-test-'));
  process.env.USAGE_STATS_HOME = home;
  process.env.USAGE_STATS_WINDOWS_HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.CURSOR_STATE_DB;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...env };
  rmSync(home, { recursive: true, force: true });
});

describe('secrets', () => {
  test('ignores invalid numeric timestamps instead of failing a provider probe', async () => {
    const { toIso } = await import('./env');
    for (const value of [Infinity, NaN, 1e30, '999999999999999999999999999999']) expect(toIso(value)).toBeNull();
    expect(toIso(1790460879)).toBe('2026-09-26T22:14:39.000Z');
  });

  test('decodes UTF-8 and UTF-16LE blobs', () => {
    expect(decodeBlob(Buffer.from('{"a":1}', 'utf8'))).toBe('{"a":1}');
    expect(decodeBlob(Buffer.from('tok', 'utf16le'))).toBe('tok');
  });

  test('parses the payload shapes agy stores', () => {
    expect(parseAgyPayload('raw-token').accessToken).toBe('raw-token');
    expect(parseAgyPayload('Bearer abc').accessToken).toBe('abc');

    const json = JSON.stringify({ token: { access_token: 'at', refresh_token: 'rt', expiry: '2030-01-01T00:00:00Z' } });
    const wrapped = `go-keyring-base64:${Buffer.from(json).toString('base64')}`;

    expect(parseAgyPayload(wrapped)).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.parse('2030-01-01T00:00:00Z') });
  });
});

describe('claude', () => {
  test('reads ~/.claude/.credentials.json and maps the usage windows', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(
      join(home, '.claude/.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scopes: ['user:profile'], subscriptionType: 'pro' } }),
    );
    stubFetch((url) =>
      url.endsWith('/usage')
        ? { body: { five_hour: { utilization: 12, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 40, resets_at: '2030-01-05T00:00:00Z' } } }
        : { body: { organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x' } } },
    );

    const result = await claude.probe();

    expect(result.plan).toBe('Max 5x');
    expect(progressLines(result.lines).map((l) => [l.label, l.used])).toEqual([
      ['Session', 12],
      ['Weekly', 40],
    ]);
    expect(progressLines(result.lines).map((l) => l.dependsOn)).toEqual([['Weekly'], ['Session']]);
  });

  test('refreshes an expired token and writes the rotated pair back', async () => {
    const dir = join(home, 'claude-config');
    mkdirSync(dir);
    process.env.CLAUDE_CONFIG_DIR = dir;
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'rt-old', expiresAt: 0 }, other: 1 }));
    stubFetch((url) =>
      url.includes('oauth/token')
        ? { body: { access_token: 'new', refresh_token: 'rt-new', expires_in: 3600 } }
        : url.endsWith('/usage')
          ? { body: { five_hour: { utilization: 1 } } }
          : { status: 404, body: {} },
    );

    await claude.probe();

    const saved = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8'));
    expect(saved.claudeAiOauth.accessToken).toBe('new');
    expect(saved.claudeAiOauth.refreshToken).toBe('rt-new');
    expect(saved.other).toBe(1);
    expect(calls.find((c) => c.url.endsWith('/usage'))?.init?.headers).toMatchObject({ Authorization: 'Bearer new' });
  });

  test('reports a missing login', async () => {
    expect(claude.probe()).rejects.toThrow('Not logged in');
  });
});

describe('codex', () => {
  beforeEach(() => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex/auth.json'), JSON.stringify({
      tokens: { access_token: jwt({ exp: Date.now() / 1000 + 3600 }) },
    }));
  });

  test.each([false, true])('keeps the quota values and resets together when slots are reversed: %s', async (reverse) => {
    const session = { used_percent: 89, limit_window_seconds: 18000, reset_at: 1790460879 };
    const weekly = { used_percent: 14, limit_window_seconds: 604800, reset_at: 1791047679 };
    stubFetch(() => ({ body: { rate_limit: {
      primary_window: reverse ? weekly : session, secondary_window: reverse ? session : weekly,
    } } }));
    const lines = progressLines((await codex.probe()).lines);
    expect(lines.map((line) => [line.label, line.used, line.periodDurationMs, line.resetsAt])).toEqual([
      ['Session', 89, 18000000, '2026-09-26T22:14:39.000Z'],
      ['Weekly', 14, 604800000, '2026-10-03T17:14:39.000Z'],
    ]);
    expect(lines.map((line) => line.dependsOn)).toEqual([['Weekly'], ['Session']]);
  });

  test('preserves fractional consumption immediately after a reset', async () => {
    stubFetch(() => ({ body: { rate_limit: { primary_window: {
      used_percent: 0.6, limit_window_seconds: 18000, reset_after_seconds: 17990,
    } } } }));
    expect(progressLines((await codex.probe()).lines)[0]!.used).toBe(0.6);
  });

  test('classifies daily and custom windows without dropping them', async () => {
    stubFetch(() => ({ body: { rate_limit: {
      primary_window: { used_percent: 14, limit_window_seconds: 604800 },
      secondary_window: { used_percent: 62, limit_window_seconds: 86400 },
    }, additional_rate_limits: [{ limit_name: 'GPT-5.3-Codex-Spark', rate_limit: {
      primary_window: { used_percent: 0.2, limit_window_seconds: 7200 },
      secondary_window: { used_percent: 4.6, limit_window_seconds: 604800 },
    } }] } }));
    const lines = progressLines((await codex.probe()).lines);
    expect(lines.map((line) => [line.label, line.used])).toEqual([
      ['Daily', 62], ['Weekly', 14], ['Spark 2h limit', 0.2], ['Spark Weekly', 4.6],
    ]);
    expect(lines.map((line) => line.dependsOn)).toEqual([
      ['Weekly'], ['Daily'], ['Spark Weekly'], ['Spark 2h limit'],
    ]);
  });

  test('uses explicit duration headers and leaves missing durations unknown', async () => {
    stubFetch(() => ({ body: {}, headers: {
      'x-codex-primary-used-percent': '14', 'x-codex-primary-window-minutes': '10080',
      'x-codex-secondary-used-percent': '89', 'x-codex-secondary-window-minutes': '300',
    } }));
    expect(progressLines((await codex.probe()).lines).map((line) => [line.label, line.used, line.periodDurationMs])).toEqual([
      ['Session', 89, 18000000], ['Weekly', 14, 604800000],
    ]);
    stubFetch(() => ({ body: { rate_limit: { primary_window: { used_percent: 25, reset_after_seconds: 3600 } } } }));
    const line = progressLines((await codex.probe()).lines)[0]!;
    expect(line.label).toBe('Primary limit');
    expect(line.periodDurationMs).toBeNull();
    const { forecastOf } = await import('../format');
    expect(forecastOf(line, Date.now())).toBeNull();
  });

  test('preserves windows with the same duration and decimal credits', async () => {
    stubFetch(() => ({ body: { rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 18000 },
    }, credits: { balance: '25.75' } } }));
    const result = await codex.probe();
    expect(progressLines(result.lines).map((line) => [line.label, line.used])).toEqual([
      ['Session (primary)', 10], ['Session (secondary)', 20],
    ]);
    expect(result.lines.at(-1)).toMatchObject({ label: 'Credits', value: '25.75 credits' });
  });

  test('classifies windows by duration and reads credits', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex/auth.json'),
      JSON.stringify({ tokens: { access_token: jwt({ exp: Date.now() / 1000 + 3600 }), refresh_token: 'rt', account_id: 'acc' } }),
    );
    stubFetch(() => ({
      body: {
        plan_type: 'plus',
        // weekly limit reported in the primary slot
        rate_limit: { primary_window: { used_percent: 47, limit_window_seconds: 604800, reset_after_seconds: 3600 } },
        credits: { balance: 25 },
      },
    }));

    const result = await codex.probe();

    expect(result.plan).toBe('Plus');
    expect(progressLines(result.lines).map((l) => l.label)).toEqual(['Weekly']);
    expect(progressLines(result.lines)[0]!.dependsOn).toEqual([]);
    expect(result.lines.find((l) => l.type === 'text' && l.label === 'Credits')).toMatchObject({ value: '25 credits' });
    expect(calls[0]?.init?.headers).toMatchObject({ 'ChatGPT-Account-Id': 'acc' });
  });
});

describe('cursor', () => {
  test('reads tokens from state.vscdb read-only and maps plan usage', async () => {
    const dbPath = join(home, 'state.vscdb');
    const db = new Database(dbPath);
    db.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    db.run("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', ?), ('cursorAuth/refreshToken', 'rt')", [
      jwt({ exp: Date.now() / 1000 + 3600, sub: 'auth0|user_1' }),
    ]);
    db.close();
    process.env.CURSOR_STATE_DB = dbPath;

    stubFetch((url) => {
      if (url.endsWith('GetCurrentPeriodUsage')) {
        const start = Date.parse('2026-09-01T00:00:00Z');
        return { body: { billingCycleStart: String(start), billingCycleEnd: String(start + 30 * 86400_000), planUsage: { limit: 2000, totalPercentUsed: 14, autoPercentUsed: 15, apiPercentUsed: 4.6 } } };
      }
      if (url.endsWith('GetPlanInfo')) return { body: { planInfo: { planName: 'pro' } } };
      if (url.endsWith('GetCreditGrantsBalance')) return { body: { hasCreditGrants: true, totalCents: '2500', usedCents: '310' } };
      return { status: 404, body: {} };
    });

    const result = await cursor.probe();

    expect(result.plan).toBe('Pro');
    expect(progressLines(result.lines).map((l) => [l.label, l.used, l.limit])).toEqual([
      ['Cursor Models', 15, 100],
      ['Other Models', 4.6, 100],
      ['Total usage', 14, 100],
      ['Credits', 3.1, 25],
    ]);
    expect(progressLines(result.lines).map((l) => l.dependsOn)).toEqual([['Total usage'], ['Total usage'], undefined, undefined]);
    expect(progressLines(result.lines)[0]!.periodDurationMs).toBe(30 * 86400_000);
  });

  test('uses calendar cycles in seconds, milliseconds or ISO dates; missing starts stay unknown', async () => {
    const dbPath = join(home, 'state.vscdb');
    const db = new Database(dbPath);
    db.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    db.run("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', ?)", [jwt({ exp: Date.now() / 1000 + 3600 })]);
    db.close();
    process.env.CURSOR_STATE_DB = dbPath;

    const from = Date.parse('2026-02-01T00:00:00Z');
    for (const days of [28, 29, 30, 31]) {
      const to = from + days * 86400_000;
      for (const encode of [(t: number) => String(t), (t: number) => t / 1000, (t: number) => new Date(t).toISOString()]) {
        for (const includeStart of [true, false]) {
          stubFetch((url) => url.endsWith('GetCurrentPeriodUsage')
            ? { body: { billingCycleStart: includeStart ? encode(from) : undefined, billingCycleEnd: encode(to), planUsage: { totalPercentUsed: 25 } } }
            : { status: 404, body: {} });
          const line = progressLines((await cursor.probe()).lines)[0]!;
          expect(line.resetsAt).toBe(new Date(to).toISOString());
          expect(line.periodDurationMs).toBe(includeStart ? days * 86400_000 : null);
        }
      }
    }
  });
});

describe('antigravity forecasts', () => {
  test('keeps fractional usage and pairs only matching model pools', () => {
    const lines = progressLines(parseSummary({ groups: [{ buckets: [
      { bucketId: 'gemini-5h', remainingFraction: 0.998, resetTime: '2026-09-26T15:00:00Z' },
      { bucketId: 'gemini-weekly', remainingFraction: 0.954, resetTime: '2026-09-29T12:00:00Z' },
    ] }] }));
    expect(lines[0]!.used).toBeCloseTo(0.2);
    expect(lines[1]!.used).toBeCloseTo(4.6);
    expect(lines[0]!.dependsOn).toEqual([lines[1]!.label]);
    expect(lines[1]!.dependsOn).toEqual([lines[0]!.label]);
  });
});

describe('devin', () => {
  test('reads the CLI credentials.toml and converts remaining to used', async () => {
    mkdirSync(join(home, '.local/share/devin'), { recursive: true });
    writeFileSync(join(home, '.local/share/devin/credentials.toml'), 'windsurf_api_key = "key-1"\n');
    stubFetch(() => ({
      body: { userStatus: { planStatus: { planInfo: { planName: 'Pro' }, weeklyQuotaRemainingPercent: 70, dailyQuotaRemainingPercent: '90', overageBalanceMicros: '2500000' } } },
    }));

    const result = await devin.probe();

    expect(progressLines(result.lines).map((l) => [l.label, l.used])).toEqual([
      ['Daily quota', 10],
      ['Weekly quota', 30],
    ]);
    expect(progressLines(result.lines).map((l) => l.dependsOn)).toEqual([['Weekly quota'], ['Daily quota']]);
    expect(result.lines.at(-1)).toMatchObject({ label: 'Extra usage balance', value: '$2.50' });
    expect(JSON.parse(String(calls[0]?.init?.body)).metadata.apiKey).toBe('key-1');
  });

  test('reads an omitted daily percentage with a reset as an exhausted day', async () => {
    mkdirSync(join(home, '.local/share/devin'), { recursive: true });
    writeFileSync(join(home, '.local/share/devin/credentials.toml'), 'windsurf_api_key = "key-1"\n');
    const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
    // proto3 JSON leaves out the 0% remaining of a used-up day
    stubFetch(() => ({
      body: { userStatus: { planStatus: { planInfo: { planName: 'Pro' }, weeklyQuotaRemainingPercent: 40,
        dailyQuotaResetAtUnix: String(reset), weeklyQuotaResetAtUnix: String(reset + 2 * 86400) } } },
    }));

    const result = await devin.probe();

    expect(progressLines(result.lines).map((l) => [l.label, l.used])).toEqual([
      ['Daily quota', 100],
      ['Weekly quota', 60],
    ]);
  });

  test('asks to log in when no key exists', async () => {
    expect(devin.probe()).rejects.toThrow('devin auth login');
  });
});

import { Database } from 'bun:sqlite';
import {
  decodeJwtPayload,
  firstExistingAppData,
  http,
  isAuthStatus,
  num,
  planLabel,
  toIso,
  WEEK_MS,
  type HttpResponse,
} from './env';
import { readSecret } from './secrets';
import { progress, ProviderError, text, type MetricLine, type Provider } from './types';

/**
 * Cursor plan usage from the dashboard Connect API, authenticated with the
 * Cursor app login stored in its state.vscdb. Ported from the
 * OpenUsage/CrossUsage cursor plugin. The database is only ever opened
 * read-only, and a refreshed access token stays in memory.
 */

const BASE = 'https://api2.cursor.sh';
const USAGE_URL = `${BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
const PLAN_URL = `${BASE}/aiserver.v1.DashboardService/GetPlanInfo`;
const CREDITS_URL = `${BASE}/aiserver.v1.DashboardService/GetCreditGrantsBalance`;
const GROK_URL = `${BASE}/aiserver.v1.DashboardService/GetSandUsageStatus`;
const REFRESH_URL = `${BASE}/oauth/token`;
const STRIPE_URL = 'https://cursor.com/api/auth/stripe';
const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const LOGIN_HINT = 'Sign in via the Cursor app or run `agent login`.';
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let refreshed: { from: string; token: string } | null = null;

function stateDbPath(): string | null {
  const custom = process.env.CURSOR_STATE_DB;

  return custom ? custom : firstExistingAppData('Cursor/User/globalStorage/state.vscdb');
}

/**
 * Reads keys from Cursor's state database. Cursor writes to it constantly,
 * so a read can hit a busy lock, and a few short retries ride that out.
 */
async function readState(path: string, keys: string[]): Promise<Record<string, string>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const db = new Database(path, { readonly: true });

      try {
        db.run('PRAGMA busy_timeout = 2000');
        const rows = db
          .query(`SELECT key, value FROM ItemTable WHERE key IN (${keys.map(() => '?').join(',')})`)
          .all(...keys) as { key: string; value: string }[];

        return Object.fromEntries(rows.map((row) => [row.key, String(row.value)]));
      } finally {
        db.close();
      }
    } catch {
      await Bun.sleep(250 * (attempt + 1));
    }
  }

  throw new ProviderError("Could not read Cursor's state database. Retrying next cycle.");
}

async function loadAuth(): Promise<{ accessToken: string | null; refreshToken: string | null }> {
  const path = stateDbPath();

  if (path !== null) {
    const state = await readState(path, ['cursorAuth/accessToken', 'cursorAuth/refreshToken']);
    const accessToken = state['cursorAuth/accessToken'] ?? null;
    const refreshToken = state['cursorAuth/refreshToken'] ?? null;

    if (accessToken || refreshToken) {
      return { accessToken, refreshToken };
    }
  }

  // the Cursor CLI keeps its login in the macOS Keychain
  if (process.platform === 'darwin') {
    return { accessToken: readSecret('cursor-access-token'), refreshToken: readSecret('cursor-refresh-token') };
  }

  return { accessToken: null, refreshToken: null };
}

function expiresSoon(token: string | null): boolean {
  const exp = decodeJwtPayload(token)?.exp;

  return typeof exp !== 'number' || exp * 1000 <= Date.now() + 5 * 60_000;
}

async function refresh(refreshToken: string | null): Promise<string | null> {
  if (!refreshToken) {
    return null;
  }

  const response = await http(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken }),
  });
  const body = response.json<{ access_token?: string; shouldLogout?: boolean }>();

  if (body?.shouldLogout === true) {
    throw new ProviderError(`Session expired. ${LOGIN_HINT}`);
  }

  if (response.status === 400 || response.status === 401) {
    throw new ProviderError(`Token expired. ${LOGIN_HINT}`);
  }

  if (response.status < 200 || response.status >= 300 || !body?.access_token) {
    return null;
  }

  refreshed = { from: refreshToken, token: body.access_token };

  return body.access_token;
}

function connectPost(url: string, token: string): Promise<HttpResponse> {
  return http(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      Accept: 'application/json',
      'User-Agent': 'Cursor/1.0.0',
    },
    body: '{}',
    timeoutMs: 10_000,
  });
}

async function optionalJson<T>(request: Promise<HttpResponse>): Promise<T | null> {
  try {
    const response = await request;
    return response.status >= 200 && response.status < 300 ? response.json<T>() : null;
  } catch {
    return null;
  }
}

/**
 * Reads the prepaid balance from cursor.com, which Stripe keeps as a
 * negative customer balance in cents.
 */
async function stripeBalanceCents(token: string): Promise<number> {
  const sub = decodeJwtPayload(token)?.sub;

  if (typeof sub !== 'string') {
    return 0;
  }

  const userId = sub.split('|').at(-1)?.trim();
  const stripe = await optionalJson<{ customerBalance?: number }>(
    http(STRIPE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${token}`,
        Accept: 'application/json',
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard',
        'User-Agent': WEB_UA,
      },
      timeoutMs: 10_000,
    }),
  );
  const balance = num(stripe?.customerBalance);

  return balance !== null && balance < 0 ? Math.abs(balance) : 0;
}

interface PlanUsage {
  limit?: number;
  remaining?: number;
  totalSpend?: number;
  bonusSpend?: number;
  totalPercentUsed?: number;
  autoPercentUsed?: number;
  apiPercentUsed?: number;
}

interface Usage {
  enabled?: boolean;
  billingCycleStart?: string | number;
  billingCycleEnd?: string | number;
  planUsage?: PlanUsage;
  spendLimitUsage?: {
    limitType?: string;
    individualLimit?: number;
    individualRemaining?: number;
    pooledLimit?: number;
    pooledRemaining?: number;
  };
}

function coerce<T extends object>(obj: T | undefined): void {
  if (!obj) {
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    const n = typeof value === 'string' ? num(value) : null;

    if (n !== null) {
      (obj as Record<string, unknown>)[key] = n;
    }
  }
}

export const cursor: Provider = {
  id: 'cursor',
  name: 'Cursor',

  async probe() {
    const auth = await loadAuth();

    if (!auth.accessToken && !auth.refreshToken) {
      throw new ProviderError(`Not logged in. ${LOGIN_HINT}`);
    }

    let token = refreshed !== null && refreshed.from === auth.refreshToken && !expiresSoon(refreshed.token) ? refreshed.token : auth.accessToken;

    if (expiresSoon(token)) {
      token = (await refresh(auth.refreshToken).catch((error) => (token ? null : Promise.reject(error)))) ?? token;
    }

    if (!token) {
      throw new ProviderError(`Not logged in. ${LOGIN_HINT}`);
    }

    let response = await connectPost(USAGE_URL, token);

    if (isAuthStatus(response.status)) {
      const next = await refresh(auth.refreshToken);

      if (next) {
        token = next;
        response = await connectPost(USAGE_URL, token);
      }
    }

    if (isAuthStatus(response.status)) {
      throw new ProviderError(`Token expired. ${LOGIN_HINT}`);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new ProviderError(`Usage request failed (HTTP ${response.status}). Try again later.`);
    }

    const usage = response.json<Usage>();

    if (usage === null) {
      throw new ProviderError('Usage response invalid. Try again later.');
    }

    const [planInfo, grants, stripeCents, grok] = await Promise.all([
      optionalJson<{ planInfo?: { planName?: string } }>(connectPost(PLAN_URL, token)),
      optionalJson<{ hasCreditGrants?: boolean; totalCents?: string | number; usedCents?: string | number }>(connectPost(CREDITS_URL, token)),
      stripeBalanceCents(token).catch(() => 0),
      optionalJson<Record<string, unknown>>(connectPost(GROK_URL, token)),
    ]);

    coerce(usage);
    coerce(usage.planUsage);

    if (usage.enabled === false || !usage.planUsage) {
      throw new ProviderError('No active Cursor subscription, or a request-based plan this tool does not read yet.');
    }

    const planName = planInfo?.planInfo?.planName ?? '';
    const pu = usage.planUsage;
    const lines: MetricLine[] = [];
    // shown after the per-model lines, which the dashboard lists first
    const totals: MetricLine[] = [];

    const grantTotal = grants?.hasCreditGrants ? Number.parseInt(String(grants.totalCents), 10) : 0;
    const grantUsed = grants?.hasCreditGrants ? Number.parseInt(String(grants.usedCents), 10) : 0;
    const validGrants = Number.isFinite(grantTotal) && grantTotal > 0 && Number.isFinite(grantUsed);
    const creditTotal = (validGrants ? grantTotal : 0) + stripeCents;

    if (creditTotal > 0) {
      totals.push(progress('Credits', (validGrants ? grantUsed : 0) / 100, creditTotal / 100, { format: { kind: 'dollars' } }));
    }

    const start = toIso(usage.billingCycleStart);
    const end = toIso(usage.billingCycleEnd);
    // Calendar cycles vary in length. Without a start, the reset is known
    // but the elapsed share (and hence the burn rate) is not.
    const period = start !== null && end !== null && Date.parse(end) > Date.parse(start)
      ? Date.parse(end) - Date.parse(start) : null;
    const cycle = { resetsAt: end, periodDurationMs: period };
    const hasLimit = typeof pu.limit === 'number';
    const spent = hasLimit ? (pu.totalSpend ?? pu.limit! - (pu.remaining ?? 0)) : 0;
    const su = usage.spendLimitUsage;
    const isTeam = planName.toLowerCase() === 'team' || su?.limitType === 'team' || (su?.pooledLimit ?? 0) > 0;

    if (isTeam && hasLimit) {
      totals.unshift(progress('Total usage', spent / 100, pu.limit! / 100, { ...cycle, format: { kind: 'dollars' } }));

      if ((pu.bonusSpend ?? 0) > 0) {
        totals.splice(1, 0, text('Bonus spend', `$${(pu.bonusSpend! / 100).toFixed(2)}`));
      }
    } else if (typeof pu.totalPercentUsed === 'number' || hasLimit) {
      const percent = pu.totalPercentUsed ?? (hasLimit && pu.limit! > 0 ? (spent / pu.limit!) * 100 : 0);
      totals.unshift(progress('Total usage', percent, 100, cycle));
    } else {
      throw new ProviderError('Total usage limit missing from the Cursor API response.');
    }

    if (typeof pu.autoPercentUsed === 'number') {
      lines.push(progress('Cursor Models', pu.autoPercentUsed, 100, { ...cycle, dependsOn: ['Total usage'] }));
    }

    if (typeof pu.apiPercentUsed === 'number') {
      lines.push(progress('Other Models', pu.apiPercentUsed, 100, { ...cycle, dependsOn: ['Total usage'] }));
    }

    const grokPercent = num(grok?.usagePercent);

    if (grok && grokPercent !== null && grokPercent >= 0 && grok.usesPooledEnterpriseAllowance !== true && grok.hasNonZeroIncludedLimit !== false && grok.includedLimitZero !== true) {
      const reset = toIso(grok.nextResetTimestampUtc);
      const startIso = toIso(grok.currentPeriodStart);
      const grokPeriod = reset && startIso && Date.parse(reset) > Date.parse(startIso) ? Date.parse(reset) - Date.parse(startIso) : WEEK_MS;
      // the Grok bot allowance is not a coding model, so it stays out of cross-provider planning
      lines.push(
        progress('Grok Bot usage', Math.min(100, grokPercent), 100, { resetsAt: reset, periodDurationMs: grokPeriod, auxiliary: true }),
      );
    }

    lines.push(...totals);

    if (su) {
      const limit = su.individualLimit ?? su.pooledLimit ?? 0;
      const remaining = su.individualRemaining ?? su.pooledRemaining ?? 0;

      if (limit > 0) {
        lines.push(progress('On-demand', (limit - remaining) / 100, limit / 100, { format: { kind: 'dollars' } }));
      }
    }

    return { plan: planLabel(planName), lines };
  },
};

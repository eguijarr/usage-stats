import { userInfo } from 'node:os';
import { join } from 'node:path';
import {
  firstExisting,
  http,
  isAuthStatus,
  planLabel,
  readJsonFile,
  toIso,
  WEEK_MS,
  writeFileAtomic,
  HOUR_MS,
} from './env';
import { readSecret, writeMacKeychain } from './secrets';
import { progress, ProviderError, text, type MetricLine, type Provider } from './types';

/**
 * Claude subscription limits from the OAuth usage endpoint Claude Code
 * itself uses, authenticated with Claude Code's own login. Ported from the
 * OpenUsage/CrossUsage claude plugin.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const REFRESH_BUFFER_MS = 5 * 60_000;
const USER_AGENT = 'claude-code/2.1.69';
const LOGIN_HINT = 'Run `claude` to log in again.';

interface OAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface Credentials {
  oauth: OAuth;
  full: { claudeAiOauth: OAuth } & Record<string, unknown>;
  source: { kind: 'file'; path: string } | { kind: 'keychain' };
}

interface Window {
  utilization?: number;
  resets_at?: string | null;
}

interface UsageResponse {
  five_hour?: Window;
  seven_day?: Window;
  seven_day_sonnet?: Window;
  seven_day_opus?: Window;
  seven_day_omelette?: Window;
  extra_usage?: { is_enabled?: boolean; used_credits?: number; monthly_limit?: number };
  limits?: { kind?: string; percent?: number; resets_at?: string; scope?: { model?: { display_name?: string } } }[];
}

let rateLimitedUntil = 0;
let cached: UsageResponse | null = null;
let planForToken: { token: string; plan: string | null } | null = null;

function loadCredentials(): Credentials | null {
  if (process.platform === 'darwin') {
    const raw = readSecret(KEYCHAIN_SERVICE);
    const full = raw ? safeParse(raw) : null;

    if (full?.claudeAiOauth?.accessToken) {
      return { oauth: full.claudeAiOauth, full, source: { kind: 'keychain' } };
    }
  }

  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const path = configDir ? join(configDir, '.credentials.json') : firstExisting(['.claude/.credentials.json']);

  if (path === null) {
    return null;
  }

  const full = readJsonFile<Credentials['full']>(path);

  return full?.claudeAiOauth?.accessToken ? { oauth: full.claudeAiOauth, full, source: { kind: 'file', path } } : null;
}

function safeParse(raw: string): Credentials['full'] | null {
  try {
    return JSON.parse(raw) as Credentials['full'];
  } catch {
    return null;
  }
}

/**
 * Refreshes the access token and writes the rotated pair back where it
 * came from. Claude rotates refresh tokens, so keeping the new pair only
 * in memory would log Claude Code out.
 */
async function refresh(creds: Credentials): Promise<string | null> {
  if (!creds.oauth.refreshToken) {
    return null;
  }

  const response = await http(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: creds.oauth.refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPES,
    }),
  });

  if (response.status === 400 || response.status === 401) {
    const body = response.json<{ error?: string }>();
    throw new ProviderError(body?.error === 'invalid_grant' ? `Session expired. ${LOGIN_HINT}` : `Token expired. ${LOGIN_HINT}`);
  }

  const body = response.json<{ access_token?: string; refresh_token?: string; expires_in?: number }>();

  if (response.status < 200 || response.status >= 300 || !body?.access_token) {
    return null;
  }

  creds.oauth.accessToken = body.access_token;

  if (body.refresh_token) {
    creds.oauth.refreshToken = body.refresh_token;
  }

  if (typeof body.expires_in === 'number') {
    creds.oauth.expiresAt = Date.now() + body.expires_in * 1000;
  }

  creds.full.claudeAiOauth = creds.oauth;

  if (creds.source.kind === 'file') {
    writeFileAtomic(creds.source.path, JSON.stringify(creds.full));
  } else {
    // minified, `security -w` hex-encodes values with newlines
    if (!writeMacKeychain(KEYCHAIN_SERVICE, userInfo().username, JSON.stringify(creds.full))) {
      throw new ProviderError(`Could not save refreshed credentials to Keychain. ${LOGIN_HINT}`);
    }
  }

  return body.access_token;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token.trim()}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': USER_AGENT,
  };
}

function formatPlan(subscriptionType: unknown, rateLimitTier: unknown): string | null {
  const base = planLabel(typeof subscriptionType === 'string' ? subscriptionType.replace(/^claude_/, '') : null);

  if (base === null) {
    return null;
  }

  const tier = /(\d+)x/.exec(String(rateLimitTier ?? ''));

  return tier ? `${base} ${tier[1]}x` : base;
}

async function livePlan(token: string, oauth: OAuth): Promise<string | null> {
  if (planForToken?.token === token) {
    return planForToken.plan;
  }

  let plan: string | null = null;

  try {
    const response = await http(PROFILE_URL, { headers: authHeaders(token), timeoutMs: 10_000 });
    const org = response.json<{ organization?: { organization_type?: string; rate_limit_tier?: string } }>()?.organization;

    if (org) {
      plan = formatPlan(org.organization_type ?? oauth.subscriptionType, org.rate_limit_tier ?? oauth.rateLimitTier);
    }
  } catch {
    // the plan label is optional
  }

  planForToken = { token, plan };

  return plan;
}

function windowLine(label: string, window: Window | undefined, periodMs: number): MetricLine | null {
  if (typeof window?.utilization !== 'number') {
    return null;
  }

  return progress(label, window.utilization, 100, { resetsAt: toIso(window.resets_at), periodDurationMs: periodMs });
}

export const claude: Provider = {
  id: 'claude',
  name: 'Claude',
  minIntervalMs: 5 * 60_000,

  async probe() {
    const creds = loadCredentials();

    if (creds === null) {
      throw new ProviderError('Not logged in. Run `claude` to authenticate.');
    }

    if (creds.oauth.scopes && !creds.oauth.scopes.includes('user:profile')) {
      return {
        plan: formatPlan(creds.oauth.subscriptionType, creds.oauth.rateLimitTier),
        lines: [],
        warning: 'Token missing user:profile scope, live limits unavailable (API key login?)',
      };
    }

    let token = creds.oauth.accessToken;
    let warning: string | null = null;
    let data: UsageResponse | null;

    if (Date.now() < rateLimitedUntil) {
      data = cached;
      warning = `Rate limited by Anthropic, retry in ~${Math.ceil((rateLimitedUntil - Date.now()) / 60_000)}m`;
    } else {
      if (typeof creds.oauth.expiresAt === 'number' && creds.oauth.expiresAt - REFRESH_BUFFER_MS <= Date.now()) {
        token = (await refresh(creds)) ?? token;
      }

      let response = await http(USAGE_URL, { headers: authHeaders(token), timeoutMs: 10_000 });

      if (isAuthStatus(response.status)) {
        const refreshed = await refresh(creds);

        if (refreshed) {
          token = refreshed;
          response = await http(USAGE_URL, { headers: authHeaders(token), timeoutMs: 10_000 });
        }
      }

      if (isAuthStatus(response.status)) {
        throw new ProviderError(`Token expired. ${LOGIN_HINT}`);
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        rateLimitedUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5 * 60_000);
        data = cached;
        warning = 'Rate limited by Anthropic, showing the last known values';
      } else if (response.status < 200 || response.status >= 300) {
        throw new ProviderError(`Usage request failed (HTTP ${response.status}). Try again later.`);
      } else {
        data = response.json<UsageResponse>();

        if (data === null) {
          throw new ProviderError('Usage response invalid. Try again later.');
        }

        cached = data;
      }
    }

    const plan = (await livePlan(token, creds.oauth)) ?? formatPlan(creds.oauth.subscriptionType, creds.oauth.rateLimitTier);
    const lines: MetricLine[] = [];

    if (data) {
      const fable = data.limits?.find(
        (entry) => entry.kind === 'weekly_scoped' && entry.scope?.model?.display_name?.trim() === 'Fable' && typeof entry.percent === 'number',
      );

      const candidates = [
        windowLine('Session', data.five_hour, 5 * HOUR_MS),
        windowLine('Weekly', data.seven_day, WEEK_MS),
        fable ? progress('Fable', fable.percent!, 100, { resetsAt: toIso(fable.resets_at), periodDurationMs: WEEK_MS }) : null,
        windowLine('Opus', data.seven_day_opus, WEEK_MS),
        windowLine('Sonnet', data.seven_day_sonnet, WEEK_MS),
        windowLine('Claude Design', data.seven_day_omelette, WEEK_MS),
      ];

      for (const line of candidates) {
        if (line !== null) {
          if (line.type === 'progress' && ['Session', 'Weekly', 'Opus', 'Sonnet', 'Fable'].includes(line.label)) {
            line.dependsOn = ['Session', 'Weekly'].filter((label) => label !== line.label);
          }
          lines.push(line);
        }
      }

      const extra = data.extra_usage;

      if (extra?.is_enabled && typeof extra.used_credits === 'number') {
        if (typeof extra.monthly_limit === 'number' && extra.monthly_limit > 0) {
          lines.push(progress('Extra usage spent', extra.used_credits / 100, extra.monthly_limit / 100, { format: { kind: 'dollars' } }));
        } else if (extra.used_credits > 0) {
          lines.push(text('Extra usage spent', `$${(extra.used_credits / 100).toFixed(2)}`));
        }
      }
    }

    return { plan, lines, warning };
  },
};

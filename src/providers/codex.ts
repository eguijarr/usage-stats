import { join } from 'node:path';
import {
  decodeJwtPayload,
  firstExisting,
  HOUR_MS,
  http,
  isAuthStatus,
  num,
  planLabel,
  readJsonFile,
  toIso,
  WEEK_MS,
  writeFileAtomic,
  type HttpResponse,
} from './env';
import { readSecret } from './secrets';
import { formatDuration } from '../format';
import { progress, ProviderError, text, type MetricLine, type Provider } from './types';

/**
 * ChatGPT/Codex rate limits from the endpoint the Codex CLI uses,
 * authenticated with the Codex CLI login in auth.json. Ported from the
 * OpenUsage/CrossUsage codex plugin.
 */

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SESSION_MS = 5 * HOUR_MS;
const REFRESH_AGE_MS = 8 * 24 * HOUR_MS;
const REFRESH_WINDOW_MS = 5 * 60_000;

interface Auth {
  OPENAI_API_KEY?: string | null;
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string };
  last_refresh?: string;
}

interface AuthState {
  auth: Auth;
  path: string | null;
}

interface RateWindow {
  used_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
}

interface RateLimit {
  primary_window?: RateWindow | null;
  secondary_window?: RateWindow | null;
}

interface UsageResponse {
  plan_type?: string;
  rate_limit?: RateLimit | null;
  additional_rate_limits?: { limit_name?: string; rate_limit?: RateLimit }[];
  credits?: { balance?: number | string; has_credits?: boolean };
  rate_limit_reset_credits?: { available_count?: number };
}

function loadAuth(): AuthState | null {
  const path = process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, 'auth.json')
    : firstExisting(['.config/codex/auth.json', '.codex/auth.json']);

  if (path !== null) {
    const auth = readJsonFile<Auth>(path);

    if (auth?.tokens?.access_token || auth?.OPENAI_API_KEY) {
      return { auth, path };
    }
  }

  if (process.platform === 'darwin') {
    const raw = readSecret('Codex Auth');

    if (raw) {
      try {
        return { auth: JSON.parse(raw) as Auth, path: null };
      } catch {
        // not JSON, ignore
      }
    }
  }

  return null;
}

function needsRefresh(auth: Auth): boolean {
  const exp = decodeJwtPayload(auth.tokens?.access_token)?.exp;

  if (typeof exp === 'number') {
    return exp * 1000 <= Date.now() + REFRESH_WINDOW_MS;
  }

  const last = auth.last_refresh ? Date.parse(auth.last_refresh) : NaN;

  return Number.isFinite(last) && Date.now() - last > REFRESH_AGE_MS;
}

/**
 * Refreshes the tokens and writes them back to auth.json. OpenAI rotates
 * refresh tokens, so the Codex CLI must see the new pair.
 */
async function refresh(state: AuthState): Promise<string | null> {
  const refreshToken = state.auth.tokens?.refresh_token;

  if (!refreshToken) {
    return null;
  }

  const response = await http(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&client_id=${encodeURIComponent(CLIENT_ID)}&refresh_token=${encodeURIComponent(refreshToken)}`,
  });

  if (response.status === 400 || response.status === 401) {
    const body = response.json<{ error?: { code?: string } | string; code?: string }>();
    const code = typeof body?.error === 'object' ? body.error.code : (body?.error ?? body?.code);
    const messages: Record<string, string> = {
      refresh_token_expired: 'Session expired.',
      refresh_token_reused: 'Token conflict.',
      refresh_token_invalidated: 'Token revoked.',
    };
    throw new ProviderError(`${messages[String(code)] ?? 'Token expired.'} Run \`codex\` to log in again.`);
  }

  const body = response.json<{ access_token?: string; refresh_token?: string; id_token?: string }>();

  if (response.status < 200 || response.status >= 300 || !body?.access_token) {
    return null;
  }

  const tokens = state.auth.tokens!;
  tokens.access_token = body.access_token;

  if (body.refresh_token) {
    tokens.refresh_token = body.refresh_token;
  }

  if (body.id_token) {
    tokens.id_token = body.id_token;
  }

  state.auth.last_refresh = new Date().toISOString();

  if (state.path !== null) {
    writeFileAtomic(state.path, JSON.stringify(state.auth, null, 2));
  }

  return body.access_token;
}

function fetchUsage(token: string, accountId: string | undefined): Promise<HttpResponse> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'usage-stats' };

  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId;
  }

  return http(USAGE_URL, { headers, timeoutMs: 10_000 });
}

function resetIso(window: RateWindow, nowSec: number): string | null {
  if (typeof window.reset_at === 'number') {
    return toIso(window.reset_at);
  }

  return typeof window.reset_after_seconds === 'number' ? toIso(nowSec + window.reset_after_seconds) : null;
}

/**
 * Keep each percentage, reset and duration together. Slot position is
 * not a cadence: Codex can return the weekly window first.
 */
function windowLines(rateLimit: RateLimit | null | undefined, labels: { session: string; weekly: string }, headers: [number | null, number | null], nowSec: number, headerMinutes: [number | null, number | null] = [null, null]): MetricLine[] {
  const candidates = [
    { window: rateLimit?.primary_window ?? {}, header: headers[0] },
    { window: rateLimit?.secondary_window ?? {}, header: headers[1] },
  ];
  const windows = candidates.flatMap((candidate, index) => {
    const used = num(candidate.window.used_percent) ?? candidate.header;
    if (used === null || used < 0) return [];
    const seconds = num(candidate.window.limit_window_seconds);
    const minutes = headerMinutes[index];
    const periodMs = seconds !== null && seconds > 0 ? seconds * 1000 : minutes !== null && minutes !== undefined && minutes > 0 ? minutes * 60_000 : null;
    const model = labels.session === 'Session' ? '' : `${labels.session} `;
    const label = periodMs === SESSION_MS ? labels.session : periodMs === WEEK_MS ? labels.weekly :
      periodMs === 24 * HOUR_MS ? `${model}Daily` : periodMs !== null ? `${model}${formatDuration(periodMs)} limit` :
      `${model}${index === 0 ? 'Primary' : 'Secondary'} limit`;
    return [{ label, used, periodMs, resetsAt: resetIso(candidate.window, nowSec), slot: index }];
  }).sort((a, b) => (a.periodMs ?? Infinity) - (b.periodMs ?? Infinity) || a.slot - b.slot);
  const names = windows.map((window) => windows.filter((other) => other.label === window.label).length > 1
    ? `${window.label} (${window.slot === 0 ? 'primary' : 'secondary'})` : window.label);
  return windows.map((window, index) => progress(names[index]!, window.used, 100, {
    resetsAt: window.resetsAt, periodDurationMs: window.periodMs,
    dependsOn: names.filter((_, other) => other !== index),
  }));
}

function formatPlan(planType: unknown): string | null {
  const raw = typeof planType === 'string' ? planType.trim().toLowerCase() : '';
  const known: Record<string, string> = { prolite: 'Pro 5x', pro: 'Pro 20x', self_serve_business_prolite: 'Business Premium' };

  return known[raw] ?? planLabel(planType);
}

export const codex: Provider = {
  id: 'codex',
  name: 'Codex',

  async probe() {
    let state = loadAuth();

    if (state === null) {
      throw new ProviderError('Not logged in. Run `codex` to authenticate.');
    }

    if (!state.auth.tokens?.access_token) {
      throw new ProviderError('Usage not available for API key login.');
    }

    if (needsRefresh(state.auth)) {
      // the Codex CLI may have refreshed on its own since the last read
      state = loadAuth() ?? state;

      if (needsRefresh(state.auth)) {
        await refresh(state);
      }
    }

    const accountId = state.auth.tokens!.account_id;
    let response = await fetchUsage(state.auth.tokens!.access_token!, accountId);

    if (isAuthStatus(response.status)) {
      const token = await refresh(state);

      if (token) {
        response = await fetchUsage(token, accountId);
      }
    }

    if (isAuthStatus(response.status)) {
      throw new ProviderError('Token expired. Run `codex` to log in again.');
    }

    if (response.status < 200 || response.status >= 300) {
      throw new ProviderError(`Usage request failed (HTTP ${response.status}). Try again later.`);
    }

    const data = response.json<UsageResponse>();

    if (data === null) {
      throw new ProviderError('Usage response invalid. Try again later.');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const lines = windowLines(
      data.rate_limit,
      { session: 'Session', weekly: 'Weekly' },
      [num(response.headers.get('x-codex-primary-used-percent')), num(response.headers.get('x-codex-secondary-used-percent'))],
      nowSec,
      [num(response.headers.get('x-codex-primary-window-minutes')), num(response.headers.get('x-codex-secondary-window-minutes'))],
    );

    for (const entry of data.additional_rate_limits ?? []) {
      if (!entry?.rate_limit) {
        continue;
      }

      const name = entry.limit_name ?? '';
      const short = name.replace(/^GPT-[\d.]+-Codex-/, '') || name || 'Model';
      lines.push(...windowLines(entry.rate_limit, { session: short, weekly: `${short} Weekly` }, [null, null], nowSec));
    }

    const resets = num(data.rate_limit_reset_credits?.available_count);

    if (resets !== null && resets >= 0) {
      lines.push(text('Rate Limit Resets', `${Math.floor(resets)} available`));
    }

    const balance = num(data.credits?.balance) ?? (data.credits?.has_credits === false ? 0 : num(response.headers.get('x-codex-credits-balance')));

    if (balance !== null) {
      lines.push(text('Credits', `${Math.max(0, balance)} credits`));
    }

    return { plan: formatPlan(data.plan_type), lines };
  },
};

import { readFileSync } from 'node:fs';
import { firstExisting, HOUR_MS, http, isAuthStatus, toIso, WEEK_MS } from './env';
import { readSecret } from './secrets';
import { progress, ProviderError, type MetricLine, type Provider } from './types';

/**
 * Google Antigravity CLI (`agy`) quotas from the Cloud Code quota summary
 * API, authenticated with the OAuth token agy keeps in the OS credential
 * store (service "gemini", account "antigravity"), or in the token file agy
 * falls back to when no credential store is available (e.g. WSL without
 * a Secret Service). Ported from the
 * OpenUsage/CrossUsage antigravity-cli plugin. A refreshed access token
 * stays in memory, since Google does not rotate refresh tokens.
 */

const SERVICE = 'gemini';
const ACCOUNT = 'antigravity';
const OAUTH_URL = 'https://oauth2.googleapis.com/token';
// public installed-app client of agy, as shipped in the CLI
const CLIENT_ID = process.env.AGY_CLIENT_ID ?? ['1071006060591-tmhssin2h21', 'lcre235vtolojh4g403ep', '.apps.googleusercontent.com'].join('');
const CLIENT_SECRET = process.env.AGY_CLIENT_SECRET ?? ['GOCSPX', '-K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('');
// where agy writes the token when there is no OS credential store
const TOKEN_FILE = '.gemini/antigravity-cli/antigravity-oauth-token';
const BASES = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
const SUMMARY_PATH = '/v1internal:retrieveUserQuotaSummary';
const LOGIN = 'Not logged in. Run `agy` and complete Google sign-in first.';
const EXPIRED = 'Google sign-in expired. Run `agy` and complete Google sign-in again.';

const BUCKETS = [
  { id: 'gemini-5h', label: 'Session', periodMs: 5 * HOUR_MS },
  { id: 'gemini-weekly', label: 'Weekly', periodMs: WEEK_MS },
  // agy's allowance for older Claude and GPT models, not worth weighing
  // against current ones: kept on the Antigravity tab, out of the overview.
  // Revisit if agy starts offering current third-party models here.
  { id: '3p-5h', label: 'Session — Claude and GPT Models', periodMs: 5 * HOUR_MS, detailOnly: true },
  { id: '3p-weekly', label: 'Weekly — Claude and GPT Models', periodMs: WEEK_MS, detailOnly: true },
];

const NESTED = ['token', 'tokens', 'oauth', 'oauth2', 'credentials', 'auth'];

let memoryToken: { token: string; expiresAt: number } | null = null;

function readTokenFile(): string | null {
  const path = firstExisting([TOKEN_FILE]);

  if (path === null) {
    return null;
  }

  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function findDeep(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const obj = value as Record<string, unknown>;

  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '' && typeof obj[key] !== 'object') {
      return obj[key];
    }
  }

  for (const key of NESTED) {
    const found = findDeep(obj[key], keys);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

export interface AgyAuth {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

/**
 * Parses what agy stores, which can be a raw token, a "Bearer" string, a
 * JSON payload like {"token":{"access_token":...}}, or any of those
 * wrapped as "go-keyring-base64:...".
 */
export function parseAgyPayload(raw: string | null): AgyAuth {
  let value = raw?.trim() ?? '';

  if (value.startsWith('go-keyring-base64:')) {
    value = Buffer.from(value.slice('go-keyring-base64:'.length), 'base64').toString('utf8').trim();
  }

  if (!value) {
    return { accessToken: null, refreshToken: null, expiresAt: null };
  }

  let parsed: unknown = null;

  try {
    parsed = JSON.parse(value);
  } catch {
    // not JSON, a bare token
  }

  if (typeof parsed === 'string') {
    return { accessToken: parsed.trim(), refreshToken: null, expiresAt: null };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { accessToken: value.replace(/^Bearer\s+/, ''), refreshToken: null, expiresAt: null };
  }

  const access = findDeep(parsed, ['access_token', 'accessToken', 'token', 'id_token', 'idToken', 'bearerToken', 'auth_token', 'authToken']);
  const refresh = findDeep(parsed, ['refresh_token', 'refreshToken']);
  const expiry = findDeep(parsed, ['expiry', 'expires_at', 'expiresAt', 'expires', 'exp']);
  const expiryIso = toIso(expiry);

  return {
    accessToken: typeof access === 'string' ? access : null,
    refreshToken: typeof refresh === 'string' ? refresh : null,
    expiresAt: expiryIso ? Date.parse(expiryIso) : null,
  };
}

async function refresh(refreshToken: string | null): Promise<string | null> {
  if (!refreshToken) {
    return null;
  }

  const response = await http(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}&refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token`,
  });
  const body = response.json<{ access_token?: string; expires_in?: number }>();

  if (response.status < 200 || response.status >= 300 || !body?.access_token) {
    return null;
  }

  memoryToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };

  return body.access_token;
}

export function parseSummary(data: unknown): MetricLine[] {
  const root = data as { response?: { groups?: unknown }; groups?: unknown } | null;
  const groups = root?.response?.groups ?? root?.groups;

  if (!Array.isArray(groups)) {
    return [];
  }

  const byId = new Map<string, { remainingFraction: number; resetTime?: string }>();

  for (const group of groups as { buckets?: { bucketId?: string; remainingFraction?: number; resetTime?: string }[] }[]) {
    for (const bucket of group?.buckets ?? []) {
      if (bucket?.bucketId && !byId.has(bucket.bucketId) && typeof bucket.remainingFraction === 'number') {
        byId.set(bucket.bucketId, { remainingFraction: bucket.remainingFraction, resetTime: bucket.resetTime });
      }
    }
  }

  return BUCKETS.flatMap((spec) => {
    const bucket = byId.get(spec.id);

    if (!bucket) {
      return [];
    }

    // Keep the API's precision for forecasting; round only when displaying.
    const used = (1 - Math.min(1, Math.max(0, bucket.remainingFraction))) * 100;

    const pairedId = spec.id.endsWith('-5h') ? spec.id.replace(/-5h$/, '-weekly') : spec.id.replace(/-weekly$/, '-5h');
    const paired = BUCKETS.find((other) => other.id === pairedId);
    return [progress(spec.label, used, 100, {
      resetsAt: toIso(bucket.resetTime), periodDurationMs: spec.periodMs,
      dependsOn: paired ? [paired.label] : [],
      detailOnly: 'detailOnly' in spec && spec.detailOnly === true,
    })];
  });
}

async function fetchSummary(token: string): Promise<{ status: number; data: unknown }> {
  let last = { status: 0, data: null as unknown };

  for (const base of BASES) {
    const response = await http(base + SUMMARY_PATH, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity',
      },
      body: '{}',
    });

    last = { status: response.status, data: response.json() };

    if (response.status >= 200 && response.status < 300 && parseSummary(last.data).length > 0) {
      return last;
    }

    if (isAuthStatus(response.status)) {
      return last;
    }
  }

  return last;
}

export const antigravity: Provider = {
  id: 'antigravity-cli',
  name: 'Antigravity CLI',

  async probe() {
    const stored = parseAgyPayload(readSecret(SERVICE, ACCOUNT) ?? readSecret(SERVICE) ?? readTokenFile());
    let token: string | null = stored.accessToken;
    const expired = stored.expiresAt !== null && stored.expiresAt <= Date.now() + 60_000;

    if (expired) {
      token = memoryToken && memoryToken.expiresAt > Date.now() + 60_000 ? memoryToken.token : await refresh(stored.refreshToken);

      if (token === null) {
        throw new ProviderError(stored.accessToken ? EXPIRED : LOGIN);
      }
    }

    if (!token) {
      throw new ProviderError(LOGIN);
    }

    let result = await fetchSummary(token);

    if (isAuthStatus(result.status)) {
      const next = await refresh(stored.refreshToken);

      if (next === null) {
        throw new ProviderError(EXPIRED);
      }

      result = await fetchSummary(next);
    }

    if (isAuthStatus(result.status)) {
      throw new ProviderError(EXPIRED);
    }

    const lines = parseSummary(result.data);

    if (lines.length === 0) {
      throw new ProviderError(
        result.status >= 200 && result.status < 300
          ? 'No quota data in the Antigravity response.'
          : `Antigravity CLI quota request failed (HTTP ${result.status}). Try again later.`,
      );
    }

    return { plan: null, lines };
  },
};

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { DAY_MS, firstExisting, firstExistingAppData, http, isAuthStatus, num, toIso, WEEK_MS } from './env';
import { progress, ProviderError, text, type MetricLine, type Provider } from './types';

/**
 * Devin (formerly Windsurf) quotas from the Codeium seat management API,
 * authenticated with the API key of the Devin CLI or the Devin desktop
 * app. Ported from the OpenUsage/CrossUsage devin plugin. Read-only.
 */

const SERVICE = 'exa.seat_management_pb.SeatManagementService';
const DEFAULT_API = 'https://server.codeium.com';
const COMPAT_VERSION = '1.108.2';
const LOGIN_HINT = 'Run `devin auth login` or sign in to Devin and try again.';
const QUOTA_HINT = 'Devin quota data unavailable. Try again later.';

const CREDENTIAL_FILES = [
  '.local/share/devin/credentials.toml',
  'AppData/Local/devin/credentials.toml',
  '.local/share/cognition/credentials.toml',
];

const APP_STATE_DBS = ['Devin', 'Devin - Next', 'Windsurf'].map((app) => `${app}/User/globalStorage/state.vscdb`);

interface DevinAuth {
  apiKey: string;
  apiServerUrl: string;
}

function tomlString(textValue: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(["'])(.*?)\\1`, 'm').exec(textValue) ?? new RegExp(`^\\s*${key}\\s*=\\s*([^#\\s]+)`, 'm').exec(textValue);

  return match ? (match[2] ?? match[1] ?? '').trim() || null : null;
}

function candidates(): DevinAuth[] {
  const found: DevinAuth[] = [];
  const file = firstExisting(CREDENTIAL_FILES);

  if (file !== null) {
    try {
      const content = readFileSync(file, 'utf8');
      const apiKey = tomlString(content, 'windsurf_api_key');
      const server = tomlString(content, 'api_server_url')?.replace(/\/+$/, '');

      if (apiKey) {
        if (server && server !== DEFAULT_API) {
          throw new ProviderError('Devin API destination is not trusted. Use the official server.');
        }
        found.push({ apiKey, apiServerUrl: DEFAULT_API });
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // unreadable, fall through to the app state
    }
  }

  for (const rel of APP_STATE_DBS) {
    const path = firstExistingAppData(rel);

    if (path === null) {
      continue;
    }

    try {
      const db = new Database(path, { readonly: true });
      const row = db.query("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus' LIMIT 1").get() as { value: string } | null;
      db.close();

      const apiKey = row ? (JSON.parse(String(row.value)) as { apiKey?: string }).apiKey : undefined;

      if (apiKey && !found.some((auth) => auth.apiKey === apiKey)) {
        found.push({ apiKey, apiServerUrl: DEFAULT_API });
      }
    } catch {
      // locked or not JSON
    }
  }

  return found;
}

interface PlanStatus {
  planInfo?: { planName?: string; hideDailyQuota?: boolean };
  dailyQuotaRemainingPercent?: number | string;
  weeklyQuotaRemainingPercent?: number | string;
  dailyQuotaResetAtUnix?: number | string;
  weeklyQuotaResetAtUnix?: number | string;
  overageBalanceMicros?: number | string;
}

function buildResult(status: PlanStatus): { plan: string; lines: MetricLine[] } {
  const hideDaily = status.planInfo?.hideDailyQuota === true;
  const daily = num(status.dailyQuotaRemainingPercent);
  let weekly = num(status.weeklyQuotaRemainingPercent);
  const dailyReset = hideDaily ? null : toIso(status.dailyQuotaResetAtUnix);
  const weeklyReset = toIso(status.weeklyQuotaResetAtUnix);

  // proto3 JSON drops zeros, so a weekly reset without a percentage is an exhausted window
  if (weekly === null && weeklyReset) {
    weekly = 0;
  }

  const clampUsed = (remaining: number) => Math.min(100, Math.max(0, 100 - remaining));
  const lines: MetricLine[] = [];

  if (!hideDaily && daily !== null) {
    lines.push(progress('Daily quota', clampUsed(daily), 100, { resetsAt: dailyReset, periodDurationMs: DAY_MS, dependsOn: ['Weekly quota'] }));
  }

  const weeklyRemaining = weekly ?? (hideDaily ? daily : null);

  if (weeklyRemaining !== null) {
    lines.push(progress('Weekly quota', clampUsed(weeklyRemaining), 100, { resetsAt: weeklyReset, periodDurationMs: WEEK_MS, dependsOn: ['Daily quota'] }));
  }

  const micros = num(status.overageBalanceMicros);

  if (micros !== null) {
    lines.push(text('Extra usage balance', `$${(Math.max(0, micros) / 1e6).toFixed(2)}`));
  }

  if (lines.length === 0) {
    throw new ProviderError(QUOTA_HINT);
  }

  return { plan: status.planInfo?.planName?.trim() || 'Unknown', lines };
}

export const devin: Provider = {
  id: 'devin',
  name: 'Devin',

  async probe() {
    const auths = candidates();
    let authFailed = false;

    for (const auth of auths) {
      const response = await http(`${auth.apiServerUrl}/${SERVICE}/GetUserStatus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
        body: JSON.stringify({
          metadata: {
            apiKey: auth.apiKey,
            ideName: 'devin',
            ideVersion: COMPAT_VERSION,
            extensionName: 'devin',
            extensionVersion: COMPAT_VERSION,
            locale: 'en',
          },
        }),
      });

      if (isAuthStatus(response.status)) {
        authFailed = true;
        continue;
      }

      const status = response.json<{ userStatus?: { planStatus?: PlanStatus } }>()?.userStatus;

      if (response.status >= 200 && response.status < 300 && status) {
        return buildResult(status.planStatus ?? {});
      }
    }

    throw new ProviderError(authFailed || auths.length === 0 ? LOGIN_HINT : QUOTA_HINT);
  },
};

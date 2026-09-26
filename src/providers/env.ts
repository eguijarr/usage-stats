import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProviderError } from './types';
import { rememberPrivateData, rememberPrivateValue } from '../privacy';

export const HOUR_MS = 3600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/**
 * Reports whether the process runs inside WSL, where the AI tools often
 * live on the Windows side and keep their credentials in the Windows
 * profile instead of the Linux home.
 */
export const isWsl =
  process.platform === 'linux' &&
  (process.env.WSL_DISTRO_NAME !== undefined ||
    (existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'))));

let windowsHomeCache: string | null | undefined;

/**
 * Drive mounts WSL exposes, like /mnt/c, the system drive first.
 */
function driveMounts(): string[] {
  try {
    return readdirSync('/mnt')
      .filter((name) => /^[a-z]$/.test(name))
      .sort((a, b) => (a === 'c' ? -1 : b === 'c' ? 1 : a.localeCompare(b)))
      .map((name) => `/mnt/${name}`);
  } catch {
    return [];
  }
}

/**
 * Locates a Windows executable from inside WSL. WSL can run with the
 * Windows PATH turned off (appendWindowsPath=false), so the well-known
 * System32 locations are checked when PATH has no match.
 */
export function windowsExe(name: string, relative: string): string | null {
  const onPath = Bun.which(name);

  if (onPath !== null) {
    return onPath;
  }

  for (const drive of driveMounts()) {
    const candidate = `${drive}/${relative}`;

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

const SHARED_PROFILES = new Set(['Public', 'Default', 'Default User', 'All Users', 'defaultuser0', 'WDAGUtilityAccount']);

/**
 * Finds the Windows user profile as a WSL path, like /mnt/c/Users/alice.
 * USAGE_STATS_WINDOWS_HOME overrides the lookup. Otherwise Windows is
 * asked for %USERPROFILE%, and when it cannot be asked, the only personal
 * profile folder under a drive's Users directory is taken.
 */
export function windowsHome(): string | null {
  if (windowsHomeCache !== undefined) {
    return windowsHomeCache;
  }

  windowsHomeCache = null;

  if (process.env.USAGE_STATS_WINDOWS_HOME) {
    windowsHomeCache = process.env.USAGE_STATS_WINDOWS_HOME;
    return windowsHomeCache;
  }

  if (!isWsl) {
    return windowsHomeCache;
  }

  const cmd = windowsExe('cmd.exe', 'Windows/System32/cmd.exe');

  if (cmd !== null) {
    const profile = spawnSync(cmd, ['/c', 'echo %USERPROFILE%'], { encoding: 'utf8', timeout: 5000, cwd: '/' });
    const winPath = profile.stdout?.trim();
    const match = winPath ? /^([A-Za-z]):\\(.*)$/.exec(winPath) : null;

    if (match) {
      const unixPath = `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/')}`;

      if (existsSync(unixPath)) {
        windowsHomeCache = unixPath;
        return windowsHomeCache;
      }
    }
  }

  for (const drive of driveMounts()) {
    try {
      const profiles = readdirSync(`${drive}/Users`, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !SHARED_PROFILES.has(entry.name))
        .map((entry) => `${drive}/Users/${entry.name}`)
        .filter((path) => existsSync(`${path}/AppData`));

      if (profiles.length === 1) {
        windowsHomeCache = profiles[0]!;
        return windowsHomeCache;
      }
    } catch {
      // no Users directory on this drive
    }
  }

  return windowsHomeCache;
}

/**
 * Home directories to search for credentials, the native one first and,
 * inside WSL, the Windows profile after it. USAGE_STATS_HOME overrides the
 * native one.
 */
export function homes(): string[] {
  const list = [process.env.USAGE_STATS_HOME || homedir()];
  const win = windowsHome();

  if (win !== null && !list.includes(win)) {
    list.push(win);
  }

  return list;
}

/**
 * Returns the first existing path among the relative paths under every
 * home. Absolute paths are checked as they are.
 */
export function firstExisting(relPaths: string[]): string | null {
  for (const home of homes()) {
    for (const rel of relPaths) {
      const path = rel.startsWith('/') ? rel : join(home, rel);

      if (existsSync(path)) {
        return path;
      }
    }
  }

  return null;
}

/**
 * Per-user application data roots relative to a home, covering Linux,
 * macOS, and Windows (roaming and local).
 */
export const APP_DATA_ROOTS = ['.config', 'Library/Application Support', 'AppData/Roaming', 'AppData/Local'];

export function firstExistingAppData(rel: string): string | null {
  return firstExisting(APP_DATA_ROOTS.map((root) => join(root, rel)));
}

export function readJsonFile<T>(path: string): T | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as T;
    rememberPrivateData(value);
    return value;
  } catch {
    return null;
  }
}

/**
 * Replaces a file through a temp file and a rename, so the tool that owns
 * the credentials never reads a half-written file.
 */
export function writeFileAtomic(path: string, content: string): void {
  const temp = `${path}.usage-stats-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch { /* already renamed, or never created */ }
  }
}

export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  const part = token?.split('.')[1];

  if (!part) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: string;
  json<T = unknown>(): T | null;
}

const API_HOSTS = new Set([
  'api.anthropic.com', 'platform.claude.com', 'chatgpt.com', 'auth.openai.com',
  'api2.cursor.sh', 'cursor.com', 'oauth2.googleapis.com',
  'daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com', 'server.codeium.com',
]);

/**
 * Small fetch wrapper with a timeout that never throws on HTTP status, so
 * providers can branch on 401, 429, and friends. Network failures raise.
 */
export async function http(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<HttpResponse> {
  const destination = new URL(url);
  if (destination.protocol !== 'https:' || destination.username || destination.password ||
    destination.port || !API_HOSTS.has(destination.hostname)) {
    throw new ProviderError('Provider API destination is not trusted. Check your configuration.');
  }
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    if (/^authorization$/i.test(key)) rememberPrivateValue(value.replace(/^Bearer\s+/i, ''));
    if (/^chatgpt-account-id$/i.test(key)) rememberPrivateValue(value);
    if (/^cookie$/i.test(key)) rememberPrivateValue(value);
  }
  if (init.body) {
    try { rememberPrivateData(JSON.parse(init.body)); }
    catch { rememberPrivateData(Object.fromEntries(new URLSearchParams(init.body))); }
  }
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    // POST redirects can forward refresh tokens or API keys in their body.
    redirect: 'error',
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
  });
  const body = await response.text();

  return {
    status: response.status,
    headers: response.headers,
    body,
    json<T>() {
      try {
        return JSON.parse(body) as T;
      } catch {
        return null;
      }
    },
  };
}

export const isAuthStatus = (status: number) => status === 401 || status === 403;

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) {
    const n = Number(value);
    // seconds vs milliseconds
    const date = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  const ms = Date.parse(String(value));

  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function num(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Title-cases a plan id the way the plugins do, so "pro" reads "Pro".
 */
export function planLabel(value: unknown): string | null {
  const textValue = typeof value === 'string' ? value.trim() : '';

  return textValue ? textValue.replace(/(^|[\s_])([a-z])/g, (_, space: string, letter: string) => `${space === '_' ? ' ' : space}${letter.toUpperCase()}`) : null;
}

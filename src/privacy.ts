import { stripVTControlCharacters } from 'node:util';
import { ProviderError, type MetricLine, type ProviderSnapshot } from './providers/types';

const privateValues = new Set<string>();

/** Exact redaction also covers opaque tokens without a recognizable vendor prefix. */
export function rememberPrivateValue(value: string): void {
  if (value.length < 8) return;
  privateValues.add(value);
  const payload = value.split('.')[1];
  if (value.startsWith('eyJ') && payload) {
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      rememberPrivateData(claims);
      if (typeof claims.name === 'string' && claims.name.length >= 8) privateValues.add(claims.name);
    } catch { /* an opaque token, not a JWT */ }
  }
}

export function rememberPrivateData(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && /^(?:(?:access|refresh|id|auth|bearer)[_-]?token|token|api[_-]?key|windsurf_api_key|password|client[_-]?secret|email|(?:account|user)[_-]?id|(?:user|full|first|last)[_-]?name|sub)$/i.test(key)) {
      rememberPrivateValue(entry);
    } else if (entry && typeof entry === 'object') rememberPrivateData(entry);
  }
}

/** Redact provider-controlled text before it reaches the terminal, JSON or history. */
export function publicText(value: string): string {
  for (const secret of [...privateValues].sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, '[redacted]');
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/(?:\b[A-Z]:[\\/]Users[\\/]|\/mnt\/[a-z]\/Users\/|\/Users\/|\/home\/)(?:[^/\\\r\n"'<>]+[/\\])?[^\s"'<>]+/gi, '[redacted path]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ya29\.[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{30,})\b/g, '[redacted token]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/\b((?:access|refresh|id)[_-]?token|api[_-]?key|password|client[_-]?secret|account[_-]?id|user[_-]?id)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]');
}

/** Unexpected errors can include file paths, request bodies or full credentials. */
export function publicErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) return publicText(error.message);
  const message = error instanceof Error ? error.message : '';
  return /fetch|network|timed? ?out|ECONN|ENOTFOUND|abort/i.test(message)
    ? 'Request failed. Check your connection and try again.'
    : 'Could not read usage data. Try again or sign in to the provider again.';
}

/** Copy only documented output fields; never spread a provider's raw response. */
export function publicSnapshot(snapshot: ProviderSnapshot): ProviderSnapshot {
  const lines: MetricLine[] = snapshot.lines.map((line) => {
    const label = publicText(line.label);
    switch (line.type) {
      case 'progress':
        return {
          type: 'progress', label, used: line.used, limit: line.limit,
          format: line.format.kind === 'count'
            ? { kind: 'count', ...(line.format.suffix ? { suffix: publicText(line.format.suffix) } : {}) }
            : { kind: line.format.kind },
          resetsAt: line.resetsAt, periodDurationMs: line.periodDurationMs,
          ...(line.dependsOn ? { dependsOn: line.dependsOn.map(publicText) } : {}),
          ...(line.auxiliary ? { auxiliary: true } : {}),
          ...(line.detailOnly ? { detailOnly: true } : {}),
        };
      case 'text':
        return { type: 'text', label, value: publicText(line.value), ...(line.subtitle ? { subtitle: publicText(line.subtitle) } : {}) };
      case 'badge':
        return { type: 'badge', label, text: publicText(line.text) };
      case 'barChart':
        return { type: 'barChart', label, points: line.points.map((point) => ({
          label: publicText(point.label), value: point.value,
          ...(point.valueLabel ? { valueLabel: publicText(point.valueLabel) } : {}),
        })), ...(line.note ? { note: publicText(line.note) } : {}) };
    }
  });
  return {
    providerId: snapshot.providerId, displayName: publicText(snapshot.displayName),
    plan: snapshot.plan === null ? null : publicText(snapshot.plan),
    warning: snapshot.warning === null ? null : publicText(snapshot.warning), lines,
  };
}

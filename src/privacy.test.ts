import { describe, expect, test } from 'bun:test';
import { publicErrorMessage, publicSnapshot, publicText, rememberPrivateData } from './privacy';
import { ProviderError } from './providers/types';

describe('privacy and redaction', () => {
  test('redacts emails', () => {
    expect(publicText('Contact user@example.com for help')).toBe('Contact [redacted email] for help');
    expect(publicText('dev.test+alias@domain.co.uk')).toBe('[redacted email]');
  });

  test('redacts filesystem paths', () => {
    expect(publicText('Error at /home/john/project/file.ts')).toBe('Error at [redacted path]');
    expect(publicText('Found in /Users/maria/data.db')).toBe('Found in [redacted path]');
    expect(publicText('C:\\Users\\admin\\config.json')).toBe('[redacted path]');
    expect(publicText('/mnt/c/Users/developer/file.txt')).toBe('[redacted path]');
  });

  test('redacts JWTs and API tokens', () => {
    const fakeJwt = `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'demo-subject' })).toString('base64url')}.test-signature`;
    expect(publicText(`Token: ${fakeJwt}`)).toBe('Token: [redacted token]');
    expect(publicText('sk-ant-api03-abcdef12345678901234567890')).toBe('[redacted token]');
    expect(publicText('Bearer secret_bearer_value_123')).toBe('Bearer [redacted]');
    expect(publicText('api_key=my_secret_key_123; other')).toBe('api_key=[redacted]; other');
  });

  test('strips ANSI and control characters', () => {
    expect(publicText('\x1b[31mRed text\x1b[0m')).toBe('Red text');
  });

  test('sanitizes error messages', () => {
    expect(publicErrorMessage(new ProviderError('Specific /home/user/error with user@domain.com'))).toBe('Specific [redacted path] with [redacted email]');
    expect(publicErrorMessage(new Error('fetch failed: ECONNREFUSED'))).toBe('Request failed. Check your connection and try again.');
    expect(publicErrorMessage(new Error('Unexpected syntax error in /var/log/secret.txt'))).toBe('Could not read usage data. Try again or sign in to the provider again.');
  });

  test('sanitizes snapshots', () => {
    const clean = publicSnapshot({
      providerId: 'claude',
      displayName: 'Claude /home/user',
      plan: 'Pro Plan',
      warning: 'Warning with admin@company.com',
      lines: [
        { type: 'text', label: 'Path', value: '/Users/test/dir' },
      ],
    });

    expect(clean.displayName).toBe('Claude [redacted path]');
    expect(clean.warning).toBe('Warning with [redacted email]');
    expect((clean.lines[0] as { value: string }).value).toBe('[redacted path]');
  });

  test('removes opaque credential values even without token prefixes', () => {
    const secret = 'opaque-private-credential-for-this-test';
    rememberPrivateData({ tokens: { refresh_token: secret } });
    expect(publicText(`Server echoed ${secret}`)).toBe('Server echoed [redacted]');
  });

  test('strips unexpected identity and credential fields from every exported metric type', () => {
    const snapshot = {
      providerId: 'codex', displayName: 'Codex', plan: 'Plus', warning: null, email: 'person@example.invalid',
      lines: [
        { type: 'progress', label: 'Weekly', used: 14, limit: 100, format: { kind: 'percent', token: 'hidden-value' },
          resetsAt: null, periodDurationMs: null, refresh_token: 'hidden-value' },
        { type: 'text', label: 'Credits', value: '25 credits', account: { email: 'person@example.invalid' } },
        { type: 'badge', label: 'Status', text: 'active', user_id: 'hidden-value' },
        { type: 'barChart', label: 'Usage', points: [{ label: 'Model', value: 5, password: 'hidden-value' }], token: 'hidden-value' },
      ],
    } as unknown as Parameters<typeof publicSnapshot>[0];
    const json = JSON.stringify(publicSnapshot(snapshot));
    for (const privateField of ['hidden-value', 'person@example.invalid', 'refresh_token', 'password', 'user_id']) {
      expect(json).not.toContain(privateField);
    }
    expect(json).toContain('25 credits');
  });
});

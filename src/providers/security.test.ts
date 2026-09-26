import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { http } from './env';
import { writeMacKeychain } from './secrets';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('authenticated requests', () => {
  test('rejects untrusted hosts, HTTP, URL credentials and custom ports before any network request', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{}'); }) as unknown as typeof fetch;
    for (const url of [
      'https://example.invalid/usage', 'http://chatgpt.com/usage', 'https://chatgpt.com.example.invalid/usage',
      'https://private:password@chatgpt.com/usage', 'https://chatgpt.com:8443/usage',
    ]) await expect(http(url, { headers: { Authorization: 'Bearer private-test-value' } })).rejects.toThrow('not trusted');
    expect(calls).toBe(0);
  });

  test('does not forward an authenticated POST body after a redirect', async () => {
    let leaked = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      if (new URL(request.url).pathname === '/collect') { leaked++; return new Response('{}'); }
      return new Response(null, { status: 307, headers: { Location: '/collect' } });
    } });
    globalThis.fetch = ((_, init) => realFetch(new URL('/redirect', server.url), init)) as typeof fetch;
    try {
      await expect(http('https://chatgpt.com/backend-api/wham/usage', {
        method: 'POST', headers: { Authorization: 'Bearer private-test-value' }, body: 'private-test-value',
      })).rejects.toThrow();
      expect(leaked).toBe(0);
    } finally { server.stop(true); }
  });
});

describe('macOS credential writes', () => {
  test('sends refreshed credentials over stdin and keeps them out of process arguments', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const spawn = spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 0, stdout: '', stderr: '' } as never);
    const secret = JSON.stringify({ token: 'private-test-value', note: 'quotes " and backslash \\' });
    try {
      expect(writeMacKeychain('Test service', 'Test account', secret)).toBe(true);
      const [command, args, options] = spawn.mock.calls[0]!;
      expect(command).toBe('/usr/bin/security');
      expect(args).toEqual(['-q', '-i']);
      expect(JSON.stringify([command, args])).not.toContain('private-test-value');
      expect((options as { input: string }).input).toContain('private-test-value');
      expect(writeMacKeychain('Test service', 'Test account', 'private-test-value\nother-command')).toBe(false);
      expect(writeMacKeychain('Test service', 'Test account', 'x'.repeat(4096))).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      spawn.mockRestore();
      Object.defineProperty(process, 'platform', descriptor);
    }
  });
});

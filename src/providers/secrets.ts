import { spawnSync } from 'node:child_process';
import { isWsl, windowsExe } from './env';
import { rememberPrivateData, rememberPrivateValue } from '../privacy';

/**
 * Reads one entry from the OS credential store without any native addon:
 *
 * - macOS: the login Keychain through `security`.
 * - Linux: the Secret Service through `secret-tool` (libsecret-tools), with
 *   the attribute names zalando/go-keyring uses.
 * - Windows, and WSL talking to its Windows host: Credential Manager
 *   through a PowerShell CredRead call. go-keyring stores the target as
 *   "service:account" in UTF-8, the Rust keyring crate as
 *   "account.service" in UTF-16LE, so both layouts are tried.
 *
 * Returns null when the entry or the helper tool is missing.
 */
export function readSecret(service: string, account?: string): string | null {
  if (process.platform === 'darwin') {
    const args = ['find-generic-password', '-s', service, '-w'];

    if (account) {
      args.splice(3, 0, '-a', account);
    }

    return run('security', args);
  }

  if (process.platform === 'win32' || isWsl) {
    const targets = account ? [`${service}:${account}`, `${account}.${service}`, service] : [service];
    const fromWindows = readWindowsCredential(targets);

    if (fromWindows !== null || process.platform === 'win32') {
      return fromWindows;
    }
  }

  const args = ['lookup', 'service', service];

  if (account) {
    args.push('username', account);
  }

  return run('secret-tool', args);
}

/**
 * Writes an entry back to the macOS Keychain. Other stores are never
 * written, the providers that need it only keep refreshed tokens in memory
 * there.
 */
export function writeMacKeychain(service: string, account: string, value: string): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }

  // `security -w <value>` exposes the credential in the process arguments.
  // Its interactive parser accepts quoted commands over a private stdin pipe.
  const parts = ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value];
  if (parts.some((part) => /[\r\n\0]/.test(part))) return false;
  const input = parts.map((part) => `"${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' ') + '\n';
  // Apple's interactive reader has a 4096-byte buffer. Fail without a partial write.
  if (Buffer.byteLength(input) >= 4096) return false;
  try {
    const result = spawnSync('/usr/bin/security', ['-q', '-i'], { input, encoding: 'utf8', timeout: 10_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function run(command: string, args: string[]): string | null {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });

    if (result.status !== 0 || !result.stdout) {
      return null;
    }

    const value = result.stdout.replace(/\r?\n$/, '');
    rememberPrivateValue(value);
    try { rememberPrivateData(JSON.parse(value)); } catch { /* raw credential */ }
    return value || null;
  } catch {
    return null;
  }
}

const CRED_READ_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class UsageStatsCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      var b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return Convert.ToBase64String(b);
    } finally { CredFree(p); }
  }
}
"@
foreach ($t in $args) { $v = [UsageStatsCred]::Read($t); if ($v) { Write-Output $v; exit 0 } }
exit 1
`;

function readWindowsCredential(targets: string[]): string | null {
  const encoded = Buffer.from(
    `& {${CRED_READ_SCRIPT}} ${targets.map((t) => `'${t.replace(/'/g, "''")}'`).join(' ')}`,
    'utf16le',
  ).toString('base64');
  const shell =
    process.platform === 'win32'
      ? 'powershell'
      : windowsExe('powershell.exe', 'Windows/System32/WindowsPowerShell/v1.0/powershell.exe');

  if (shell === null) {
    return null;
  }

  const base64 = run(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);

  return base64 === null ? null : decodeBlob(Buffer.from(base64.trim(), 'base64'));
}

/**
 * Decodes a credential blob, UTF-8 first as go-keyring writes it, then
 * UTF-16LE as the Windows APIs and the Rust keyring crate write it.
 */
export function decodeBlob(bytes: Buffer): string | null {
  const utf8 = bytes.toString('utf8');

  if (utf8.trim() !== '' && !utf8.includes('\0')) {
    rememberPrivateValue(utf8);
    try { rememberPrivateData(JSON.parse(utf8)); } catch { /* raw credential */ }
    return utf8;
  }

  if (bytes.length % 2 === 0) {
    const utf16 = bytes.toString('utf16le');

    if (utf16.trim() !== '' && !utf16.includes('\0')) {
      rememberPrivateValue(utf16);
      try { rememberPrivateData(JSON.parse(utf16)); } catch { /* raw credential */ }
      return utf16;
    }
  }

  return null;
}

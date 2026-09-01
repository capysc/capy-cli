/**
 * Exact Bun/non-TTY regression for the parent -> grant-daemon material pipe.
 *
 * Claude Code's Bash tool launches commands without a controlling terminal.
 * Bun 1.3.11 silently discarded stdin sent immediately to a child created
 * with both `detached: true` and `stdio[0]: 'pipe'`, so pairing reached human
 * approval and then failed before publishing runtime custody. The launcher
 * below has stdin explicitly ignored and must still complete the readiness
 * handshake, transfer material, exit, and leave its detached daemon serving
 * the grant.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchGrantedKLocal } from '../../../src/auth/deviceKey/grantHolder';

const CLI_ROOT = join(import.meta.dir, '../../..');
const INDEX_SOURCE = join(CLI_ROOT, 'src', 'index.ts');
const USER_ID = 'user_bun_non_tty';
const CREDENTIAL_ID = 'credential_bun_non_tty';
const K_LOCAL_BYTE = 0x6b;

function requestAcknowledgedGrantShutdown(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const finish = (outcome: { readonly ok: true } | { readonly ok: false; readonly error: Error }): void => {
      clearTimeout(timeout);
      socket.destroy();
      if (outcome.ok) resolve();
      else reject(outcome.error);
    };
    const timeout = setTimeout(
      () => finish({ ok: false, error: new Error(`grant daemon did not acknowledge shutdown: ${socketPath}`) }),
      2_000,
    );
    timeout.unref?.();
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: 'shutdown' })}\n`));
    socket.once('data', (chunk) => {
      const acknowledged = (() => {
        try {
          return (JSON.parse(chunk.toString('utf8').trim()) as Readonly<{ ok?: unknown }>).ok === true;
        } catch {
          return false;
        }
      })();
      finish(acknowledged
        ? { ok: true }
        : { ok: false, error: new Error(`grant daemon returned an invalid shutdown response: ${socketPath}`) });
    });
    socket.once('error', (error) => finish({ ok: false, error }));
    socket.once('end', () => finish({
      ok: false,
      error: new Error(`grant daemon closed without acknowledging shutdown: ${socketPath}`),
    }));
  });
}

async function expectExactSocketToDisappear(socketPath: string, deadline = Date.now() + 2_000): Promise<void> {
  if (!existsSync(socketPath)) return;
  if (Date.now() >= deadline) throw new Error(`grant daemon socket still exists after shutdown: ${socketPath}`);
  await Bun.sleep(10);
  return expectExactSocketToDisappear(socketPath, deadline);
}

function nonTtyLauncherSource(): string {
  return [
    "import { spawnGrantDaemon } from './src/auth/deviceKey/grantHolder.ts';",
    `const handle = await spawnGrantDaemon({ userId: '${USER_ID}', credentialId: '${CREDENTIAL_ID}', kLocal: Buffer.alloc(32, ${K_LOCAL_BYTE}) }, {`,
    `  execPath: process.execPath, scriptPath: ${JSON.stringify(INDEX_SOURCE)}, ttlMs: null,`,
    '});',
    // Keep the exact socket as a separate first line. Cleanup can be armed
    // before parsing or asserting anything about the richer announcement.
    'console.log(handle.socketPath);',
    'console.log(JSON.stringify(handle));',
  ].join('\n');
}

async function runNonTtyLauncher(home: string, tempDirectory: string): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, ['-e', nonTtyLauncherSource()], {
    cwd: CLI_ROOT,
    env: { ...process.env, HOME: home, TMPDIR: tempDirectory, CAPY_WEB_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const status = new Promise<number | null>((resolve) => child.once('close', resolve));
  const stdout = child.stdout
    ? new Response(child.stdout as unknown as ReadableStream).text()
    : Promise.resolve('');
  const stderr = child.stderr
    ? new Response(child.stderr as unknown as ReadableStream).text()
    : Promise.resolve('');
  const result = await Promise.all([status, stdout, stderr]);
  return { status: result[0], stdout: result[1], stderr: result[2] };
}

describe('Bun grant daemon launch without a TTY', () => {
  test('transfers material and remains live after the non-TTY launcher exits', async () => {
    const home = mkdtempSync(join(tmpdir(), 'capy-grant-bun-non-tty-'));
    const tempDirectory = join(home, 'claude-state', 'runtime', 'tmp');
    mkdirSync(tempDirectory, { recursive: true, mode: 0o700 });
    const wouldBeSocket = join(
      tempDirectory,
      'capy-grant-XXXXXX',
      '0000000000000000.sock',
    );
    expect(Buffer.byteLength(wouldBeSocket)).toBeGreaterThan(103);

    const result = await runNonTtyLauncher(home, tempDirectory);
    const [announcedSocketPath = '', handleJson = ''] = result.stdout.trimEnd().split('\n');

    try {
      expect(announcedSocketPath.length).toBeGreaterThan(0);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      const handle = JSON.parse(handleJson) as Readonly<{ socketPath: string; expiresAt: number; pid: number }>;
      expect(handle.socketPath).toBe(announcedSocketPath);
      const fetched = await fetchGrantedKLocal(handle.socketPath, USER_ID);
      expect(fetched).toMatchObject({
        userId: USER_ID,
        credentialId: CREDENTIAL_ID,
        expiresAt: 0,
      });
      expect(fetched.kLocal).toEqual(Buffer.alloc(32, K_LOCAL_BYTE));
      expect(Buffer.byteLength(handle.socketPath)).toBeLessThanOrEqual(103);
      expect(handle.socketPath.startsWith(`${tempDirectory}/`)).toBe(false);
    } finally {
      // Successful launch always announces this raw first line before any
      // parse/assert boundary. Teardown owns only that exact socket and must
      // observe both {ok:true} and unlink before deleting the test home.
      if (announcedSocketPath.length > 0) {
        await requestAcknowledgedGrantShutdown(announcedSocketPath);
        await expectExactSocketToDisappear(announcedSocketPath);
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});

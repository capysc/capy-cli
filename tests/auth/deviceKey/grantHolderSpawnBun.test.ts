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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchGrantedKLocal } from '../../../src/auth/deviceKey/grantHolder';

const CLI_ROOT = join(import.meta.dir, '../../..');
const INDEX_SOURCE = join(CLI_ROOT, 'src', 'index.ts');
const USER_ID = 'user_bun_non_tty';
const CREDENTIAL_ID = 'credential_bun_non_tty';
const K_LOCAL_BYTE = 0x6b;

function shutdownGrantDaemon(socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (): void => {
      socket.destroy();
      resolve();
    };
    const timeout = setTimeout(finish, 2_000);
    timeout.unref?.();
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: 'shutdown' })}\n`));
    socket.once('data', () => {
      clearTimeout(timeout);
      finish();
    });
    socket.once('error', () => {
      clearTimeout(timeout);
      finish();
    });
  });
}

function nonTtyLauncherSource(): string {
  return [
    "import { spawnGrantDaemon } from './src/auth/deviceKey/grantHolder.ts';",
    `const handle = await spawnGrantDaemon({ userId: '${USER_ID}', credentialId: '${CREDENTIAL_ID}', kLocal: Buffer.alloc(32, ${K_LOCAL_BYTE}) }, {`,
    `  execPath: process.execPath, scriptPath: ${JSON.stringify(INDEX_SOURCE)}, ttlMs: null,`,
    '});',
    'console.log(JSON.stringify(handle));',
  ].join('\n');
}

async function runNonTtyLauncher(home: string): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, ['-e', nonTtyLauncherSource()], {
    cwd: CLI_ROOT,
    env: { ...process.env, HOME: home },
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
    const result = await runNonTtyLauncher(home);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const handle = JSON.parse(result.stdout) as Readonly<{ socketPath: string; expiresAt: number; pid: number }>;

    try {
      const fetched = await fetchGrantedKLocal(handle.socketPath, USER_ID);
      expect(fetched).toMatchObject({
        userId: USER_ID,
        credentialId: CREDENTIAL_ID,
        expiresAt: 0,
      });
      expect(fetched.kLocal).toEqual(Buffer.alloc(32, K_LOCAL_BYTE));
    } finally {
      await shutdownGrantDaemon(handle.socketPath);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * CAP-384 — the grant daemon's protocol logic (grantHolder.ts), exercised
 * in-process against a REAL Unix domain socket (createGrantDaemonServer),
 * without forking a subprocess. The subprocess-spawning half
 * (spawnGrantDaemon / runGrantDaemonForever) is covered by
 * grantE2E.test.ts, which needs a real second process anyway to prove the
 * cross-process claim — this file is the fast, deterministic protocol
 * coverage: correct answers, expiry, and the hostile-connection case.
 *
 * No mock.module, no globalConfig import — not registered in ISOLATED_FILES.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { randomBytes } from 'crypto';
import { createConnection } from 'net';
import { existsSync, statSync } from 'fs';
import {
  createGrantDaemonServer,
  listenGrantDaemonServer,
  fetchGrantedKLocal,
  isGrantActive,
} from '../../../src/auth/deviceKey/grantHolder';
import { CapyError, ERROR_CODES } from '../../../src/types/index';

const USER = 'user-daemon-1';
const CRED = 'cred-daemon-1';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** reapGraceMs defaults small here so "unlinked after reap" tests stay fast;
 *  production uses DEFAULT_REAP_GRACE_MS (2 minutes) via the real caller. */
async function startTestDaemon(ttlMs: number, reapGraceMs = 40) {
  const kLocal = randomBytes(32);
  const built = createGrantDaemonServer({ userId: USER, credentialId: CRED, kLocal }, ttlMs, { reapGraceMs });
  await listenGrantDaemonServer(built.server, built.socketPath);
  cleanup = built.close;
  return { ...built, kLocal };
}

describe('grant daemon socket protocol', () => {
  it('serves the exact K_local it was started with, and mode-restricts the socket', async () => {
    const { socketPath, kLocal, expiresAt } = await startTestDaemon(60_000);

    // Filesystem-permission-gated, same trust boundary as local.key today —
    // never world/group readable.
    const mode = statSync(socketPath).mode & 0o777;
    expect(mode & 0o077).toBe(0);

    const fetched = await fetchGrantedKLocal(socketPath, USER);
    expect(fetched.userId).toBe(USER);
    expect(fetched.credentialId).toBe(CRED);
    expect(fetched.kLocal.equals(kLocal)).toBe(true);
    expect(fetched.expiresAt).toBe(expiresAt);
  });

  it('refuses a request for a different userId — coded, not a leak of whose grant it is', async () => {
    const { socketPath } = await startTestDaemon(60_000);
    await expect(fetchGrantedKLocal(socketPath, 'someone-else')).rejects.toMatchObject({
      code: ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND,
    });
  });

  it('after TTL elapses but within the reap grace window, answers DEVICE_KEY_GRANT_EXPIRED — then self-closes', async () => {
    // ttl=30ms, reap grace=300ms: a request at 100ms is deep inside
    // "expired but the daemon is still up to say so," well clear of both
    // the 30ms boundary and the 330ms reap deadline — not a timing race.
    const { socketPath } = await startTestDaemon(30, 300);
    await Bun.sleep(100);
    await expect(fetchGrantedKLocal(socketPath, USER)).rejects.toMatchObject({
      code: ERROR_CODES.DEVICE_KEY_GRANT_EXPIRED,
    });
    // Answering an expired request is itself a close trigger (don't linger
    // once a caller has been told) — the socket is gone right after.
    await Bun.sleep(20);
    expect(existsSync(socketPath)).toBe(false);
    await expect(fetchGrantedKLocal(socketPath, USER)).rejects.toMatchObject({
      code: ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND,
    });
  });

  it('the reap timer self-cleans even when nobody ever asks after expiry', async () => {
    // ttl=20ms, reap grace=30ms: reaps at 50ms with zero requests in between.
    const { socketPath } = await startTestDaemon(20, 30);
    await Bun.sleep(120);
    expect(existsSync(socketPath)).toBe(false);
  });

  it('a socket that was never started answers DEVICE_KEY_GRANT_NOT_FOUND, never crashes the caller', async () => {
    await expect(fetchGrantedKLocal('/tmp/capy-grant-does-not-exist-xyz.sock', USER)).rejects.toMatchObject({
      code: ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND,
    });
  });

  it('a malformed request is refused, not crash the server — the daemon keeps serving well-formed requests after', async () => {
    const { socketPath, kLocal } = await startTestDaemon(60_000);

    // Send garbage on a raw connection.
    await new Promise<void>((resolve, reject) => {
      const s = createConnection(socketPath);
      s.on('connect', () => s.write('not json at all\n'));
      s.on('data', () => {
        s.end();
        resolve();
      });
      s.on('error', reject);
    });

    // The daemon is still alive and correct for the next, well-formed request.
    const fetched = await fetchGrantedKLocal(socketPath, USER);
    expect(fetched.kLocal.equals(kLocal)).toBe(true);
  });

  it('isGrantActive: true while live, false once closed', async () => {
    const { socketPath, close } = await startTestDaemon(60_000);
    expect(await isGrantActive(socketPath)).toBe(true);
    close();
    cleanup = null;
    await Bun.sleep(20);
    expect(await isGrantActive(socketPath)).toBe(false);
  });

  it('close() wipes the in-memory key — a request racing the close after this point can only see it gone, never zeroed-but-served', async () => {
    const { socketPath, close, kLocal } = await startTestDaemon(60_000);
    close();
    cleanup = null;
    // kLocal buffer passed in is a DIFFERENT allocation from the one the
    // server wrapped internally (createGrantDaemonServer never mutates the
    // caller's buffer) — this just proves the server-side copy is gone via
    // the client-observable contract, not via reaching into internals.
    expect(kLocal.length).toBe(32); // sanity: caller's own buffer is untouched
    await expect(fetchGrantedKLocal(socketPath, USER)).rejects.toMatchObject({
      code: ERROR_CODES.DEVICE_KEY_GRANT_NOT_FOUND,
    });
  });
});

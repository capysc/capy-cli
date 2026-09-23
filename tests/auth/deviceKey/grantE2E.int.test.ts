/**
 * CAP-384 — THE invariant-2 proof.
 *
 * Spawns the REAL built CLI as separate OS processes, exactly the way
 * CAP-383's capyRunEquivalence.e2e.test.ts proves the transport vs
 * device-key trees are equivalent:
 *
 *   1. `dist/index.js device-key grant --json` — runs a real WebAuthn-shaped
 *      ceremony against a mocked broker + wrapper service (real envelope
 *      crypto, `tests/helpers/sealEnvelope.ts`), starts the in-memory grant
 *      daemon (a THIRD real process, detached), and prints
 *      `{socketPath, expiresAt}`.
 *   2. `dist/index.js run -- node -e '...'` — a SEPARATE process, with
 *      CAPY_DEVICE_KEY_GRANT_SOCKET pointed at that socket and no prior
 *      local.key/key.enc anywhere — decrypts a real secret using ONLY the
 *      granted material.
 *
 * Then walks the ENTIRE temp home directory tree and asserts no file named
 * `local.key` or `key.enc` exists anywhere under it — the literal, unmissable
 * proof that invariant 2 holds: a sandbox using a grant never durably writes
 * key material, unlike an ordinary `unlock` (onboarding.ts's
 * installOrgFromServer, which this test's HOME never touches).
 *
 * A second test proves expiry is observable end-to-end: a `capy run`
 * against an EXPIRED grant exits with EXIT_NEEDS_INPUT (3) — a coded,
 * non-string signal an orchestrator can branch on — and still writes no key
 * material.
 *
 * Needs `dist/index.js` built first (`bun run build`) — same precondition
 * as capyRunEquivalence.e2e.test.ts.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { spawn } from 'child_process';
import { createConnection } from 'net';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import {
  startFakeWrapperService,
  kmsWrap,
  type FakeWrapperService,
  type WrapperRow,
} from '../../helpers/fakeWrapperService';
import { sealEnvelopePageSide } from '../../helpers/sealEnvelope';
import { deriveDeviceKeyKek, deviceKeyWrapAAD, wrapKLocal, DEVICE_KEY_KDF_VERSION } from '../../../src/auth/deviceKey/crypto';
import { encryptMasterKey, masterKeyAAD, deriveProjectKey } from '../../../src/crypto/keyManager';
import { deriveLocalInnerKey } from '../../../src/crypto/localKeyRoot';
import { Encryptor } from '../../../src/crypto/encryptor';
import { spawnGrantDaemon } from '../../../src/auth/deviceKey/grantHolder';

const USER_ID = 'user_grant_e2e_1';
const CRED_ID = 'cred-grant-e2e-1';
const WORKOS_ORG_ID = 'wos_grant_e2e_1';
const ORG_ID = 'org_grant_e2e_1';
const ORG_NAME = 'Grant E2E Org';
const PROJECT_ID = 'proj_grant_e2e_1';
const CLI_PATH = join(__dirname, '../../../dist/index.js');

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Spawn the real built CLI as a subprocess, with a live stdout accumulator the caller can poll mid-flight (needed to drive a ceremony while the process is still running). */
function spawnCli(
  args: string[],
  cwd: string,
  home: string,
  serviceUrl: string,
  extraEnv: Record<string, string | undefined> = {},
): { child: ReturnType<typeof spawn>; stdoutSoFar: () => string; done: Promise<SpawnResult> } {
  mkdirSync(join(home, '.capy'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, '.capy', 'config.json'),
    JSON.stringify({ default: 'test', profiles: { test: { url: serviceUrl } } }),
    { mode: 0o600 },
  );
  const outputId = randomBytes(8).toString('hex');
  const stdoutPath = join(home, `.grant-child-${outputId}.stdout`);
  const stderrPath = join(home, `.grant-child-${outputId}.stderr`);
  const stdoutFd = openSync(stdoutPath, 'wx', 0o600);
  const stderrFd = openSync(stderrPath, 'wx', 0o600);
  const child = spawn('node', [CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      CAPY_API_URL: serviceUrl,
      CAPY_GLOBAL_DIR_NAME: undefined,
      CAPY_DEVICE_KEYS: '1',
      ...extraEnv,
      // Test-local and deliberately last: no caller can override this and
      // make a focused run open the developer's real browser.
      CAPY_WEB_NO_OPEN: '1',
    } as Record<string, string>,
    stdio: ['pipe', stdoutFd, stderrFd],
  });
  const exitCode = new Promise<number | null>((resolve) => {
    child.once('close', resolve);
    child.once('error', () => resolve(1));
  });
  const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const stdoutSoFar = (): string => readFileSync(stdoutPath, 'utf8');
  const done = exitCode.then((code): SpawnResult => {
    clearTimeout(killer);
    closeSync(stdoutFd);
    closeSync(stderrFd);
    return {
      stdout: stdoutSoFar(),
      stderr: readFileSync(stderrPath, 'utf8'),
      exitCode: code,
    };
  });
  return { child, stdoutSoFar, done };
}

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
    const readFrom = (buffer: string): void => {
      socket.once('data', (chunk) => {
        const next = buffer + chunk.toString('utf8');
        const newline = next.indexOf('\n');
        if (newline === -1) {
          readFrom(next);
          return;
        }
        const acknowledged = (() => {
          try {
            return (JSON.parse(next.slice(0, newline)) as Readonly<{ ok?: unknown }>).ok === true;
          } catch {
            return false;
          }
        })();
        finish(acknowledged
          ? { ok: true }
          : { ok: false, error: new Error(`grant daemon returned an invalid shutdown response: ${socketPath}`) });
      });
    };
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: 'shutdown' })}\n`));
    socket.once('error', (error) => finish({ ok: false, error }));
    socket.once('end', () => finish({
      ok: false,
      error: new Error(`grant daemon closed without acknowledging shutdown: ${socketPath}`),
    }));
    readFrom('');
  });
}

async function expectExactSocketToDisappear(socketPath: string, deadline = Date.now() + 2_000): Promise<void> {
  if (!existsSync(socketPath)) return;
  if (Date.now() >= deadline) throw new Error(`grant daemon socket still exists after shutdown: ${socketPath}`);
  await Bun.sleep(10);
  return expectExactSocketToDisappear(socketPath, deadline);
}

async function cleanupExactGrant(socketPath: string, requireAcknowledgement: boolean): Promise<void> {
  if (!requireAcknowledgement && !existsSync(socketPath)) {
    await expectExactSocketToDisappear(socketPath);
    return;
  }
  const shutdown = await (async (): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: Error & { readonly code?: string } }
  > => {
    try {
      await requestAcknowledgedGrantShutdown(socketPath);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: (error instanceof Error ? error : new Error(String(error))) as Error & { readonly code?: string },
      };
    }
  })();
  if (!shutdown.ok && (requireAcknowledgement || shutdown.error.code !== 'ENOENT')) throw shutdown.error;
  await expectExactSocketToDisappear(socketPath);
}

/**
 * Watches a spawned `device-key grant`'s stdout for the relayed ceremony
 * URL (printed exactly like every other browser-opening CLI flow), decodes
 * the fragment, seals a real WebCrypto answer, and delivers it via the fake
 * broker's own connection registry — the subprocess equivalent of
 * tests/helpers/fakeCeremonyPage.ts's driveCeremony (which only works
 * in-process, via a console.log spy a child process cannot share).
 */
async function driveGrantCeremonyOverSubprocess(
  stdoutSoFar: () => string,
  service: FakeWrapperService,
  connectionAnswerDirectory: string,
  answer: (candidates: { credentialId: string; prfSalt: string }[]) =>
    | { ok: true; credentialId: string; prfOutput: string }
    | { ok: false; code: string },
): Promise<void> {
  const urlDeadline = Date.now() + 10_000;
  const url = await waitForValue(() => {
    const match = stdoutSoFar().match(/https:\/\/keep\.capy\.sc\/flow\/device-key\?c=[^\s]+/);
    return match?.[0];
  }, urlDeadline, 20);
  if (!url) throw new Error(`driveGrantCeremonyOverSubprocess: no ceremony URL seen in stdout: ${stdoutSoFar()}`);

  const u = new URL(url);
  const connectionId = u.searchParams.get('c')!;
  const hashIdx = url.indexOf('#r=');
  const b64url = url.slice(hashIdx + 3);
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const request = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
    v: 1;
    ceremony: 'grant';
    candidates: { credentialId: string; prfSalt: string }[];
  };
  expect(request.ceremony).toBe('grant');

  const connDeadline = Date.now() + 5_000;
  const conn = await waitForValue(() => service.connections.get(connectionId), connDeadline, 10);
  if (!conn) throw new Error(`connection ${connectionId} never registered with the fake broker`);

  const result = answer(request.candidates);
  const payload = { v: 1, flow: 'device-key', ceremony: 'grant', ...result };
  const sealed = await sealEnvelopePageSide({
    plaintext: JSON.stringify(payload),
    connectionId,
    clientPubkeyB64: conn.clientPubkeyB64,
  });
  writeFileSync(
    join(connectionAnswerDirectory, encodeURIComponent(connectionId)),
    JSON.stringify({ status: 200, body: { status: 'answered', ciphertext: sealed } }),
    { flag: 'wx', mode: 0o600 },
  );
}

async function waitForValue<T>(
  read: () => T | undefined,
  deadline: number,
  intervalMs: number,
): Promise<T | undefined> {
  const value = read();
  if (value !== undefined || Date.now() >= deadline) return value;
  await Bun.sleep(intervalMs);
  return waitForValue(read, deadline, intervalMs);
}

function readConnectionResult(
  connectionAnswerDirectory: string,
  connectionId: string,
): Readonly<{ status: number; body: unknown }> | undefined {
  try {
    return JSON.parse(
      readFileSync(join(connectionAnswerDirectory, encodeURIComponent(connectionId)), 'utf8'),
    ) as Readonly<{ status: number; body: unknown }>;
  } catch {
    return undefined;
  }
}

function exactAnnouncedSocketFromOutput(output: string): string | undefined {
  const encodedPath = Array.from(
    output.matchAll(/"socketPath"\s*:\s*("(?:\\.|[^"\\])*")/g),
    (match) => match[1],
  ).at(-1);
  if (!encodedPath) return undefined;
  try {
    const path: unknown = JSON.parse(encodedPath);
    return typeof path === 'string' && path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Recursively find every file named exactly `name` under `root`. */
function findFilesNamed(root: string, name: string): string[] {
  const walk = (dir: string): string[] => {
    const entries = (() => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    })();
    return entries.flatMap((entry) => {
      const full = join(dir, entry);
      const stat = (() => {
        try {
          return statSync(full);
        } catch {
          return undefined;
        }
      })();
      if (!stat) return [];
      if (stat.isDirectory()) return walk(full);
      return entry === name ? [full] : [];
    });
  };
  return walk(root);
}

describe('CAP-384 grant E2E: no durable key material, over real subprocesses', () => {
  const masterKey = randomBytes(32);
  const kLocal = randomBytes(32);
  const prfSalt = randomBytes(32);
  const prfOutput = randomBytes(32);
  // A pre-enrolled live door, as if enrolled from some OTHER, already-
  // unlocked machine — this test never runs an enroll ceremony.
  const kek = deriveDeviceKeyKek(prfOutput, prfSalt, DEVICE_KEY_KDF_VERSION);
  const wrapped = wrapKLocal(kLocal, kek, deviceKeyWrapAAD(USER_ID, CRED_ID));
  // The org's key_enc row, already server-held — exactly what a grant-mode
  // `capy run` fetches fresh instead of reading a local key.enc file.
  const innerWrapped = encryptMasterKey(masterKey, deriveLocalInnerKey(kLocal), masterKeyAAD(USER_ID, ORG_ID));
  const createdAt = new Date().toISOString();
  const initialRows = [
    {
      id: 'door-e2e-1',
      type: 'wrapped_k_local',
      credential_id: CRED_ID,
      kdf_version: DEVICE_KEY_KDF_VERSION,
      is_seed: true,
      verified_at: createdAt,
      organization_id: null,
      created_at: createdAt,
      deleted_at: null,
      mirror_state: 'pending',
      wrapped_k_local: wrapped.wrappedKLocal,
      iv: wrapped.iv,
      prf_salt: prfSalt.toString('base64'),
    },
    {
      id: 'keyenc-e2e-1',
      type: 'key_enc',
      credential_id: null,
      kdf_version: 1,
      is_seed: false,
      verified_at: null,
      organization_id: ORG_ID,
      created_at: createdAt,
      deleted_at: null,
      mirror_state: 'pending',
      key_enc: kmsWrap(innerWrapped),
    },
  ] satisfies readonly WrapperRow[];
  const connectionAnswerDirectory = mkdtempSync(join(tmpdir(), 'capy-grant-e2e-answers-'));
  const fakeService: FakeWrapperService = startFakeWrapperService({
    initialRows,
    connectionResult: (connectionId) => readConnectionResult(connectionAnswerDirectory, connectionId),
  });

  afterAll(() => {
    fakeService.close();
    rmSync(connectionAnswerDirectory, { recursive: true, force: true });
  });

  function freshHomeWithSession(): string {
    const home = mkdtempSync(join(tmpdir(), 'capy-grant-e2e-home-'));
    const sessionDir = join(home, '.capy', 'auth', 'sessions');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ org_id: WORKOS_ORG_ID, capy_org_id: ORG_ID })).toString('base64url');
    const accessToken = `${header}.${payload}.sig`;
    const session = {
      version: 2,
      user_id: USER_ID,
      user_email: 'grant-e2e@example.com',
      refresh_token: 'test-refresh-token',
      organizations: [{ id: ORG_ID, workos_org_id: WORKOS_ORG_ID, name: ORG_NAME }],
      sessions: { [ORG_ID]: { access_token: accessToken, expires_at: Date.now() + 3_600_000 } },
    };
    writeFileSync(join(sessionDir, `${USER_ID}.json`), JSON.stringify(session, null, 2), { mode: 0o600 });
    return home;
  }

  function projectDirWithSecret(secretValue: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'capy-grant-e2e-project-'));
    writeFileSync(
      join(dir, 'keep.lock'),
      JSON.stringify({ version: '3.0', org_id: ORG_ID, project_id: PROJECT_ID, project_name: 'demo', variables: {} }),
    );
    const projectKeyHex = deriveProjectKey(masterKey, PROJECT_ID, ORG_ID);
    const ciphertext = Encryptor.encrypt(secretValue, projectKeyHex);
    writeFileSync(join(dir, '.env'), `SECRET_VAR=capy:res123:${ciphertext}\n`);
    return dir;
  }

  function answerWithRealCredential(candidates: { credentialId: string; prfSalt: string }[]) {
    const c = candidates.find((cand) => cand.credentialId === CRED_ID);
    if (!c) return { ok: false as const, code: 'no_credential' };
    return { ok: true as const, credentialId: CRED_ID, prfOutput: prfOutput.toString('base64') };
  }

  it('grant -> capy run resolves the real secret, and NO local.key/key.enc file exists anywhere under HOME', async () => {
    const home = freshHomeWithSession();
    try {
      const grant = spawnCli(['device-key', 'grant', '--json', '--label', 'sandbox:e2e-test'], home, home, fakeService.url);
      try {
        await driveGrantCeremonyOverSubprocess(
          grant.stdoutSoFar,
          fakeService,
          connectionAnswerDirectory,
          answerWithRealCredential,
        );
        const grantResult = await grant.done;

        // stdout also carries the relayed ceremony URL text before the final
        // pretty-printed JSON block — the JSON's own opening brace is the LAST
        // `{` in the whole stream (the relay text contains none).
        const jsonStart = grantResult.stdout.lastIndexOf('{');
        const announced = JSON.parse(grantResult.stdout.slice(jsonStart)) as Readonly<{
          socketPath?: unknown;
          envVar?: unknown;
        }>;
        const announcedSocketPath = announced.socketPath;
        expect(grantResult.exitCode).toBe(0);
        expect(typeof announcedSocketPath).toBe('string');
        expect(announced.envVar).toBe('CAPY_DEVICE_KEY_GRANT_SOCKET');
        if (typeof announcedSocketPath !== 'string') throw new Error('grant did not announce a socket path');

        const projectDir = projectDirWithSecret('shh-grant-e2e-secret');
        try {
          const run = spawnCli(
            ['run', '--', 'node', '-e', 'console.log(process.env.SECRET_VAR)'],
            projectDir,
            home,
            fakeService.url,
            { CAPY_DEVICE_KEY_GRANT_SOCKET: announcedSocketPath },
          );
          const runResult = await run.done;

          expect(runResult.exitCode).toBe(0);
          expect(runResult.stdout.trim()).toBe('shh-grant-e2e-secret');

          // THE PROOF: walk the entire HOME tree, find zero durable key files —
          // in particular, none of the org-key-material files unlock's
          // installOrgFromServer would have written (key.enc, local.key).
          expect(findFilesNamed(home, 'local.key')).toEqual([]);
          expect(findFilesNamed(home, 'key.enc')).toEqual([]);
        } finally {
          rmSync(projectDir, { recursive: true, force: true });
        }
      } finally {
        // This boundary is armed immediately after spawning the exact child,
        // before ceremony waits, assertions, or final-object parsing. Even a
        // malformed final JSON object cannot bypass teardown once that child
        // has emitted its own socket announcement.
        const announcedSocketPath = exactAnnouncedSocketFromOutput(grant.stdoutSoFar());
        try {
          if (announcedSocketPath) await cleanupExactGrant(announcedSocketPath, true);
        } finally {
          grant.child.kill('SIGKILL');
          await grant.done;
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('an EXPIRED grant makes capy run exit EXIT_NEEDS_INPUT (3) — coded, not string-matched — and still writes nothing', async () => {
    const home = freshHomeWithSession();
    try {
      // Bypasses the ceremony (already proven above) to get a deterministic,
      // millisecond-precise expiry without waiting on the CLI's whole-minute
      // --ttl-minutes granularity. spawnGrantDaemon itself still forks a
      // REAL, separate daemon process — only the ceremony step is skipped.
      // execPath/scriptPath are overridden because this call runs directly
      // under the `bun test` runner, whose own argv[1] is not the CLI
      // entrypoint the daemon subcommand must re-exec — production callers
      // (DeviceKeyGrantCommand) rely on the defaults derived from `capy`'s
      // own argv, which this override intentionally does not exercise here.
      const handle = await spawnGrantDaemon(
        { userId: USER_ID, credentialId: CRED_ID, kLocal },
        { ttlMs: 30, execPath: 'node', scriptPath: CLI_PATH },
      );
      try {
        await Bun.sleep(150); // past ttl, still inside the reap grace window

        const projectDir = projectDirWithSecret('should-never-be-read');
        try {
          const run = spawnCli(
            ['run', '--', 'node', '-e', 'console.log(process.env.SECRET_VAR)'],
            projectDir,
            home,
            fakeService.url,
            { CAPY_DEVICE_KEY_GRANT_SOCKET: handle.socketPath },
          );
          const runResult = await run.done;

          expect(runResult.exitCode).toBe(3); // EXIT_NEEDS_INPUT — a coded signal, not prose
          expect(runResult.stderr).toContain('DEVICE_KEY_GRANT_EXPIRED');
          expect(findFilesNamed(home, 'local.key')).toEqual([]);
          expect(findFilesNamed(home, 'key.enc')).toEqual([]);
        } finally {
          rmSync(projectDir, { recursive: true, force: true });
        }
      } finally {
        // The expired get normally closes its own daemon. If an earlier
        // failure left it live, require a shutdown acknowledgement; either
        // way, prove this exact announced socket has disappeared.
        await cleanupExactGrant(handle.socketPath, false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

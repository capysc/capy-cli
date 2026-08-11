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
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { startFakeWrapperService, kmsWrap, type FakeWrapperService } from '../../helpers/fakeWrapperService';
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
  const child = spawn('node', [CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      CAPY_API_URL: serviceUrl,
      CAPY_GLOBAL_DIR_NAME: undefined,
      CAPY_DEVICE_KEYS: '1',
      ...extraEnv,
    } as Record<string, string>,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => (stdout += d.toString()));
  child.stderr?.on('data', (d) => (stderr += d.toString()));
  const done = new Promise<SpawnResult>((resolve) => {
    const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on('error', () => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
  return { child, stdoutSoFar: () => stdout, done };
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
  answer: (candidates: { credentialId: string; prfSalt: string }[]) =>
    | { ok: true; credentialId: string; prfOutput: string }
    | { ok: false; code: string },
): Promise<void> {
  const urlDeadline = Date.now() + 10_000;
  let url: string | undefined;
  while (Date.now() < urlDeadline) {
    const match = stdoutSoFar().match(/https:\/\/keep\.capy\.sc\/flow\/device-key\?c=[^\s]+/);
    if (match) {
      url = match[0];
      break;
    }
    await Bun.sleep(20);
  }
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

  let conn = service.connections.get(connectionId);
  const connDeadline = Date.now() + 5_000;
  while (!conn && Date.now() < connDeadline) {
    await Bun.sleep(10);
    conn = service.connections.get(connectionId);
  }
  if (!conn) throw new Error(`connection ${connectionId} never registered with the fake broker`);

  const result = answer(request.candidates);
  const payload = { v: 1, flow: 'device-key', ceremony: 'grant', ...result };
  const sealed = await sealEnvelopePageSide({
    plaintext: JSON.stringify(payload),
    connectionId,
    clientPubkeyB64: conn.clientPubkeyB64,
  });
  conn.resultQueue.push({ status: 200, body: { status: 'answered', ciphertext: sealed } });
}

/** Recursively find every file named exactly `name` under `root`. */
function findFilesNamed(root: string, name: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (entry === name) hits.push(full);
    }
  };
  walk(root);
  return hits;
}

describe('CAP-384 grant E2E: no durable key material, over real subprocesses', () => {
  let fakeService: FakeWrapperService;
  let masterKey: Buffer;
  let kLocal: Buffer;
  let prfSalt: Buffer;
  let prfOutput: Buffer;

  beforeAll(() => {
    fakeService = startFakeWrapperService();
    masterKey = randomBytes(32);
    kLocal = randomBytes(32);
    prfSalt = randomBytes(32);
    prfOutput = randomBytes(32);

    // A pre-enrolled live door, as if enrolled from some OTHER, already-
    // unlocked machine — this test never runs an enroll ceremony.
    const kek = deriveDeviceKeyKek(prfOutput, prfSalt, DEVICE_KEY_KDF_VERSION);
    const wrapped = wrapKLocal(kLocal, kek, deviceKeyWrapAAD(USER_ID, CRED_ID));
    fakeService.rows.push({
      id: 'door-e2e-1',
      type: 'wrapped_k_local',
      credential_id: CRED_ID,
      kdf_version: DEVICE_KEY_KDF_VERSION,
      is_seed: true,
      verified_at: new Date().toISOString(),
      organization_id: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
      mirror_state: 'pending',
      wrapped_k_local: wrapped.wrappedKLocal,
      iv: wrapped.iv,
      prf_salt: prfSalt.toString('base64'),
    });

    // The org's key_enc row, already server-held — exactly what a grant-mode
    // `capy run` fetches fresh instead of reading a local key.enc file.
    const innerWrapped = encryptMasterKey(masterKey, deriveLocalInnerKey(kLocal), masterKeyAAD(USER_ID, ORG_ID));
    fakeService.rows.push({
      id: 'keyenc-e2e-1',
      type: 'key_enc',
      credential_id: null,
      kdf_version: 1,
      is_seed: false,
      verified_at: null,
      organization_id: ORG_ID,
      created_at: new Date().toISOString(),
      deleted_at: null,
      mirror_state: 'pending',
      key_enc: kmsWrap(innerWrapped),
    });
  });

  afterAll(() => {
    fakeService.close();
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
    let projectDir: string | undefined;
    try {
      const grant = spawnCli(['device-key', 'grant', '--json', '--label', 'sandbox:e2e-test'], home, home, fakeService.url);
      await driveGrantCeremonyOverSubprocess(grant.stdoutSoFar, fakeService, answerWithRealCredential);
      const grantResult = await grant.done;

      expect(grantResult.exitCode).toBe(0);
      // stdout also carries the relayed ceremony URL text before the final
      // pretty-printed JSON block — the JSON's own opening brace is the LAST
      // `{` in the whole stream (the relay text contains none).
      const jsonStart = grantResult.stdout.lastIndexOf('{');
      const announced = JSON.parse(grantResult.stdout.slice(jsonStart));
      expect(typeof announced.socketPath).toBe('string');
      expect(announced.envVar).toBe('CAPY_DEVICE_KEY_GRANT_SOCKET');

      projectDir = projectDirWithSecret('shh-grant-e2e-secret');
      const run = spawnCli(
        ['run', '--', 'node', '-e', 'console.log(process.env.SECRET_VAR)'],
        projectDir,
        home,
        fakeService.url,
        { CAPY_DEVICE_KEY_GRANT_SOCKET: announced.socketPath },
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
      if (projectDir) rmSync(projectDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('an EXPIRED grant makes capy run exit EXIT_NEEDS_INPUT (3) — coded, not string-matched — and still writes nothing', async () => {
    const home = freshHomeWithSession();
    let projectDir: string | undefined;
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
      await Bun.sleep(150); // past ttl, still inside the reap grace window

      projectDir = projectDirWithSecret('should-never-be-read');
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
      if (projectDir) rmSync(projectDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

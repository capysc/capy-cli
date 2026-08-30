/**
 * CAP-409 — THE acceptance-criterion proof for `capy pair`, repointed at the
 * CAP-566 device-grant seam (#328): `capy pair` no longer installs a session
 * an approving browser seals and hands over. It authenticates the MACHINE
 * itself via an RFC 8628 device grant, then runs the ordinary CAP-384 grant
 * ceremony over that machine's own session. This test proves the FULL
 * two-phase dance works end to end against real subprocesses and a real
 * (loopback) door fetch:
 *
 * Spawns the REAL BUILT CLI as separate OS processes, mirroring
 * `grantE2E.int.test.ts`'s technique exactly:
 *
 *   1. `dist/index.js pair --json` — runs the real device authorization
 *      (`POST /auth/device/authorize` then polling `POST
 *      /auth/device/token`, `src/auth/pairing/deviceAuth.ts`) against a
 *      mocked service, prints the user code, and installs the resulting
 *      session through the CLI's one session writer
 *      (`installPairedSession.ts`) the instant the poll reports `complete`.
 *      With the session on disk, it runs the CAP-384 grant ceremony
 *      (`pairDeviceGrant.ts` -> `runGrantCeremony` over a
 *      `BrokerCeremonyTransport`) against the SAME mocked service's
 *      AUTHENTICATED connection-broker surface (real envelope crypto via
 *      `tests/helpers/sealEnvelope.ts`) for a door this test pre-seeds
 *      (`service.doorRows`), wrapped with the SAME production crypto
 *      (`deriveDeviceKeyKek`/`wrapKLocal`) a real enrollment would use.
 *      `pair` fetches that door's own prf_salt/kdf_version over
 *      `/wrappers*` using the just-installed session and unwraps K_local
 *      locally, then starts the in-memory grant daemon (a THIRD real,
 *      detached process) and prints `{socketPath, ...}`.
 *   2. `dist/index.js run -- node -e '...'` — a SEPARATE process, with
 *      CAPY_DEVICE_KEY_GRANT_SOCKET pointed at that socket and no prior
 *      local.key/key.enc anywhere — decrypts a real secret using ONLY the
 *      unwrapped K_local and the session `pair` just wrote.
 *
 * Then walks the ENTIRE temp HOME tree and asserts no file named `local.key`
 * or `key.enc` exists anywhere under it — the literal proof that pairing a
 * headless machine never leaves recovery-equivalent material on disk.
 *
 * A second test proves an unanswered/expired device code expires end to end:
 * exit EXIT_NEEDS_INPUT (3), coded PAIR_CODE_EXPIRED in the --json output,
 * and still writes no session or key material anywhere.
 *
 * Needs `dist/index.js` built first (`bun run build`).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { startFakePairingService, kmsWrap, type FakePairingService } from '../../helpers/fakePairingService';
import { sealEnvelopePageSide } from '../../helpers/sealEnvelope';
import { deriveDeviceKeyKek, deviceKeyWrapAAD, wrapKLocal, DEVICE_KEY_KDF_VERSION } from '../../../src/auth/deviceKey/crypto';
import { encryptMasterKey, masterKeyAAD, deriveProjectKey } from '../../../src/crypto/keyManager';
import { deriveLocalInnerKey } from '../../../src/crypto/localKeyRoot';
import { Encryptor } from '../../../src/crypto/encryptor';

const USER_ID = 'user_pair_e2e_1';
const USER_EMAIL = 'pair-e2e@example.com';
const WORKOS_ORG_ID = 'wos_pair_e2e_1';
const ORG_ID = 'org_pair_e2e_1';
const ORG_NAME = 'Pair E2E Org';
const PROJECT_ID = 'proj_pair_e2e_1';
const CRED_ID = 'cred-pair-e2e-1';
const CLI_PATH = join(__dirname, '../../../dist/index.js');

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function spawnCli(
  args: string[],
  cwd: string,
  home: string,
  serviceUrl: string,
  extraEnv: Record<string, string | undefined> = {},
): { stdoutSoFar: () => string; done: Promise<SpawnResult> } {
  const child = spawn('node', [CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      CAPY_API_URL: serviceUrl,
      CAPY_GLOBAL_DIR_NAME: undefined,
      // `capy pair` gates on the same flag `capy device-key grant` does —
      // see pairCommand.ts's module doc for why (runCommand.ts's grant-
      // consuming branch is itself nested inside this same flag check, so a
      // grant obtained without it is unusable by a later `capy run` either
      // way).
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
  return { stdoutSoFar: () => stdout, done };
}

/**
 * PHASE 1 of the drive sequence. Watches a spawned `pair`'s stdout for the
 * printed bold user_code (the exact spec §4.2 block, now sourced from the
 * device-authorize response rather than Keep's own connection: "... and
 * enter:  <CODE>" — `printPairingBlock` in pairCommand.ts), looks up the
 * matching device-authorization row in the fake service's registry, and
 * pushes a caller-supplied completion onto that device's poll queue —
 * standing in for a human completing the identity provider's device page.
 */
async function waitForDeviceUserCode(stdoutSoFar: () => string): Promise<string> {
  const codeDeadline = Date.now() + 10_000;
  while (Date.now() < codeDeadline) {
    const match = stdoutSoFar().match(/enter:\s+\x1b\[1m([^\x1b]+)\x1b\[0m/);
    if (match) return match[1];
    await Bun.sleep(20);
  }
  throw new Error(`waitForDeviceUserCode: no user_code seen in stdout: ${stdoutSoFar()}`);
}

/** Polls `stdoutSoFar()` for the relayed ceremony URL until it appears or
 *  `deadlineMs` elapses. Recursive rather than a mutable loop — no `let`,
 *  nothing reassigned (codebase immutability rule). */
async function waitForCeremonyUrl(stdoutSoFar: () => string, deadlineMs: number): Promise<string | undefined> {
  const deadline = Date.now() + deadlineMs;
  const poll = async (): Promise<string | undefined> => {
    const match = stdoutSoFar().match(/https:\/\/keep\.capy\.sc\/flow\/device-key\?c=[^\s]+/);
    if (match) return match[0];
    if (Date.now() >= deadline) return undefined;
    await Bun.sleep(20);
    return poll();
  };
  return poll();
}

/** Polls the fake broker's connection registry for `connectionId` until it
 *  appears or `deadlineMs` elapses. Recursive rather than a mutable loop —
 *  same reasoning as {@link waitForCeremonyUrl}. */
async function waitForBrokerConnection(
  service: FakePairingService,
  connectionId: string,
  deadlineMs: number,
): Promise<ReturnType<FakePairingService['connections']['get']>> {
  const deadline = Date.now() + deadlineMs;
  const poll = async (): Promise<ReturnType<FakePairingService['connections']['get']>> => {
    const conn = service.connections.get(connectionId);
    if (conn) return conn;
    if (Date.now() >= deadline) return undefined;
    await Bun.sleep(10);
    return poll();
  };
  return poll();
}

/**
 * PHASE 2 of the drive sequence, once the device grant has installed the
 * machine's own session. `runGrantCeremony` (src/auth/deviceKey/grant.ts)
 * relays a ceremony URL over the AUTHENTICATED connection-broker surface
 * exactly as CAP-384's own `device-key grant` does — this is the identical
 * driving idiom `grantE2E.int.test.ts`'s `driveGrantCeremonyOverSubprocess`
 * uses, adapted to this file's fake service.
 */
async function driveGrantCeremonyOverSubprocess(
  stdoutSoFar: () => string,
  service: FakePairingService,
  answer: (candidates: { credentialId: string; prfSalt: string }[]) =>
    | { ok: true; credentialId: string; prfOutput: string }
    | { ok: false; code: string },
): Promise<void> {
  const url = await waitForCeremonyUrl(stdoutSoFar, 10_000);
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

  const conn = await waitForBrokerConnection(service, connectionId, 5_000);
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

function fakeAccessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ org_id: WORKOS_ORG_ID, capy_org_id: ORG_ID }),
  ).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

function projectDirWithSecret(masterKey: Buffer, secretValue: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'capy-pair-e2e-project-'));
  const keepLockPath = join(dir, 'keep.lock');
  Bun.write(keepLockPath, JSON.stringify({ version: '3.0', org_id: ORG_ID, project_id: PROJECT_ID, project_name: 'demo', variables: {} }));
  const projectKeyHex = deriveProjectKey(masterKey, PROJECT_ID, ORG_ID);
  const ciphertext = Encryptor.encrypt(secretValue, projectKeyHex);
  Bun.write(join(dir, '.env'), `SECRET_VAR=capy:res123:${ciphertext}\n`);
  return dir;
}

describe('CAP-409 pair E2E: real session + no durable key material, over real subprocesses', () => {
  let home: string | undefined;
  let projectDir: string | undefined;
  let service: FakePairingService | undefined;

  afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
    service?.close();
    home = undefined;
    projectDir = undefined;
    service = undefined;
  });

  it('pair -> capy run resolves the real secret, session lands correctly, and NO local.key/key.enc file exists anywhere under HOME', async () => {
    home = mkdtempSync(join(tmpdir(), 'capy-pair-e2e-home-'));
    service = startFakePairingService();

    const masterKey = randomBytes(32);
    const kLocal = randomBytes(32);
    const innerWrapped = encryptMasterKey(masterKey, deriveLocalInnerKey(kLocal), masterKeyAAD(USER_ID, ORG_ID));
    service.keyEncRows.push({ organizationId: ORG_ID, keyEnc: kmsWrap(innerWrapped) });

    // A pre-enrolled live door, as if enrolled from some OTHER,
    // already-unlocked machine — this test never runs an enroll ceremony.
    // The grant ceremony's sealed answer carries only {credentialId,
    // prfOutput} (the same CAP-372 minimal contract every device-key
    // ceremony uses); `pair` fetches THIS row itself, over the authenticated
    // API, after installing its own device-grant session, reads
    // prf_salt/kdf_version from the fetched wrapper, and unwraps it locally
    // to arrive at the same kLocal.
    const prfSalt = randomBytes(32);
    const prfOutput = randomBytes(32);
    const kek = deriveDeviceKeyKek(prfOutput, prfSalt, DEVICE_KEY_KDF_VERSION);
    const wrapped = wrapKLocal(kLocal, kek, deviceKeyWrapAAD(USER_ID, CRED_ID));
    service.doorRows.push({
      credentialId: CRED_ID,
      wrappedKLocal: wrapped.wrappedKLocal,
      iv: wrapped.iv,
      prfSalt: prfSalt.toString('base64'),
      kdfVersion: DEVICE_KEY_KDF_VERSION,
    });

    const pair = spawnCli(['pair', '--json'], home, home, service.url);

    // PHASE 1: the machine authenticates itself via the device grant. Find
    // the printed user_code, look up its device-authorization row, and
    // complete it exactly as a human finishing the identity provider's
    // device page would — issuing tokens to THIS machine, not copying a
    // session from whoever approved it.
    const userCode = await waitForDeviceUserCode(pair.stdoutSoFar);
    const device = service.findDeviceByUserCode(userCode);
    if (!device) throw new Error(`no device-authorization row for user_code ${userCode}`);
    device.completionQueue.push({
      status: 200,
      body: {
        status: 'complete',
        token: { access_token: fakeAccessToken(), refresh_token: 'refresh-e2e-1', expires_in: 3600 },
        user: { id: USER_ID, email: USER_EMAIL, first_name: null, last_name: null },
        organizations: [{ id: ORG_ID, workos_org_id: WORKOS_ORG_ID, name: ORG_NAME }],
      },
    });

    // PHASE 2: with the machine's own session installed, `pair` runs the
    // ordinary CAP-384 grant ceremony over it — drive it exactly as
    // grantE2E.int.test.ts's own subprocess variant does.
    await driveGrantCeremonyOverSubprocess(pair.stdoutSoFar, service, (candidates) => {
      const c = candidates.find((cand) => cand.credentialId === CRED_ID);
      if (!c) return { ok: false as const, code: 'no_credential' };
      return { ok: true as const, credentialId: CRED_ID, prfOutput: prfOutput.toString('base64') };
    });
    const pairResult = await pair.done;

    expect(pairResult.exitCode).toBe(0);
    const jsonStart = pairResult.stdout.lastIndexOf('{');
    const announced = JSON.parse(pairResult.stdout.slice(jsonStart));
    expect(announced.ok).toBe(true);
    expect(announced.userId).toBe(USER_ID);
    expect(announced.orgId).toBe(ORG_ID);
    expect(announced.orgTokenReady).toBe(true);
    expect(typeof announced.socketPath).toBe('string');
    expect(announced.envVar).toBe('CAPY_DEVICE_KEY_GRANT_SOCKET');

    // The session half: a normal ~/.capy session file, readable by every
    // other command exactly as a real OAuth login would leave it.
    const sessionPath = join(home, '.capy', 'auth', 'sessions', `${USER_ID}.json`);
    expect(existsSync(sessionPath)).toBe(true);
    const session = JSON.parse(await Bun.file(sessionPath).text());
    expect(session.user_email).toBe(USER_EMAIL);
    expect(session.organizations).toEqual([{ id: ORG_ID, workos_org_id: WORKOS_ORG_ID, name: ORG_NAME }]);

    projectDir = projectDirWithSecret(masterKey, 'shh-pair-e2e-secret');
    const run = spawnCli(
      ['run', '--', 'node', '-e', 'console.log(process.env.SECRET_VAR)'],
      projectDir,
      home,
      service.url,
      { CAPY_DEVICE_KEY_GRANT_SOCKET: announced.socketPath },
    );
    const runResult = await run.done;

    expect(runResult.exitCode).toBe(0);
    expect(runResult.stdout.trim()).toBe('shh-pair-e2e-secret');

    // THE PROOF: walk the entire HOME tree, find zero durable key files —
    // pairing a headless machine must never write local.key/key.enc.
    expect(findFilesNamed(home, 'local.key')).toEqual([]);
    expect(findFilesNamed(home, 'key.enc')).toEqual([]);
  }, 30_000);

  it('an unanswered pairing code expires: exit EXIT_NEEDS_INPUT (3), coded PAIR_CODE_EXPIRED, no session or key material written anywhere', async () => {
    home = mkdtempSync(join(tmpdir(), 'capy-pair-e2e-expiry-home-'));
    service = startFakePairingService();

    // The device-authorize response's `expires_in` (300s) is the CLIENT's
    // own clock deadline, already proven with millisecond precision against
    // injected time in tests/auth/deviceAuth.test.ts — this test's job is
    // narrower and complementary: drive expiry the way the SERVER itself
    // signals it (RFC 8628's `expired_token` poll error) and prove that,
    // however `pair` learns about it, an incomplete device grant NEVER
    // leaves session or key material on disk.
    const pair = spawnCli(['pair', '--json'], home, home, service.url);

    const userCode = await waitForDeviceUserCode(pair.stdoutSoFar);
    const device = service.findDeviceByUserCode(userCode);
    expect(device).toBeTruthy();
    device!.completionQueue.push({ status: 400, body: { error: 'expired_token' } });

    const pairResult = await pair.done;

    expect(pairResult.exitCode).toBe(3);
    // Spawned with --json: the coded outcome rides stdout's JSON block
    // (PairCommand's --json branch uses console.log, matching every other
    // --json command in this CLI), not stderr.
    expect(pairResult.stdout).toContain('PAIR_CODE_EXPIRED');
    expect(findFilesNamed(home, 'local.key')).toEqual([]);
    expect(findFilesNamed(home, 'key.enc')).toEqual([]);
    expect(existsSync(join(home, '.capy', 'auth'))).toBe(false);
  }, 20_000);
});

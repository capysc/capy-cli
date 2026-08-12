/**
 * CAP-409 — THE acceptance-criterion proof for `capy pair`, now hardened per
 * CAP-372's restored invariant: the sealed answer carries only the raw PRF
 * output (never K_local — see `pairContract.ts`'s header). This test proves
 * the FULL two-step dance works end to end against real subprocesses and a
 * real (loopback) door fetch:
 *
 * Spawns the REAL BUILT CLI as separate OS processes, mirroring
 * `grantE2E.e2e.test.ts`'s technique exactly:
 *
 *   1. `dist/index.js pair --json` — runs the real anonymous bootstrap +
 *      poll ceremony against a mocked broker (real envelope crypto via
 *      tests/helpers/sealEnvelope.ts). The sealed answer carries only
 *      {prfOutput, credentialId} (no prf_salt/kdf_version echoed on the
 *      wire) for a door this test pre-seeds into the fake service
 *      (`service.doorRows`), wrapped with the SAME production crypto
 *      (`deriveDeviceKeyKek`/`wrapKLocal`) a real enrollment would use.
 *      `pair` installs the session FIRST, then fetches that door's own
 *      prf_salt/kdf_version over `/wrappers*` using the just-installed
 *      session and unwraps K_local locally (`pairKeyMaterial.ts`) — exactly
 *      the CAP-384 grant ceremony's own door-fetch dance — before starting
 *      the in-memory grant daemon (a THIRD real, detached process) and
 *      printing `{socketPath, ...}`.
 *   2. `dist/index.js run -- node -e '...'` — a SEPARATE process, with
 *      CAPY_DEVICE_KEY_GRANT_SOCKET pointed at that socket and no prior
 *      local.key/key.enc anywhere — decrypts a real secret using ONLY the
 *      unwrapped K_local and the session `pair` just wrote.
 *
 * Then walks the ENTIRE temp HOME tree and asserts no file named `local.key`
 * or `key.enc` exists anywhere under it — the literal proof that pairing a
 * headless machine never leaves recovery-equivalent material on disk.
 *
 * A second test proves an unanswered pairing code expires end to end: exit
 * EXIT_NEEDS_INPUT (3), coded PAIR_CODE_EXPIRED in stderr, and still writes
 * no session or key material anywhere.
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
import { PAIR_FLOW, PAIR_CEREMONY } from '../../../src/auth/pairing/pairContract';
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
 * Watches a spawned `pair`'s stdout for the printed bold user_code (the
 * exact spec §4.2 block: "... and enter:  <CODE>"), looks up the matching
 * connection in the fake service's registry (standing in for the real
 * service's attach-by-code lookup, which is out of this ticket's scope —
 * see fakePairingService.ts's header), seals a real answer to it, and
 * pushes it into that connection's result queue.
 */
async function driveCeremonyOverSubprocess(
  stdoutSoFar: () => string,
  service: FakePairingService,
  buildAnswerBody: (userCode: string) => unknown,
): Promise<void> {
  const codeDeadline = Date.now() + 10_000;
  let userCode: string | undefined;
  while (Date.now() < codeDeadline) {
    const match = stdoutSoFar().match(/enter:\s+\x1b\[1m([^\x1b]+)\x1b\[0m/);
    if (match) {
      userCode = match[1];
      break;
    }
    await Bun.sleep(20);
  }
  if (!userCode) throw new Error(`driveCeremonyOverSubprocess: no user_code seen in stdout: ${stdoutSoFar()}`);

  const connDeadline = Date.now() + 5_000;
  let conn = service.findByUserCode(userCode);
  while (!conn && Date.now() < connDeadline) {
    await Bun.sleep(10);
    conn = service.findByUserCode(userCode);
  }
  if (!conn) throw new Error(`no connection registered for user_code ${userCode}`);

  const sealed = await sealEnvelopePageSide({
    plaintext: JSON.stringify(buildAnswerBody(userCode)),
    connectionId: conn.id,
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
    // The sealed answer below carries only {prfOutput, credentialId} (never
    // kLocal, never prf_salt/kdf_version — CAP-372, restored); `pair` must
    // fetch THIS row itself, over the authenticated API, after installing
    // the session, reading prf_salt/kdf_version from the fetched wrapper,
    // and unwrap it locally to arrive at the same kLocal.
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
    await driveCeremonyOverSubprocess(pair.stdoutSoFar, service, (userCode) => ({
      v: 1,
      flow: PAIR_FLOW,
      ceremony: PAIR_CEREMONY,
      session: {
        user: { id: USER_ID, email: USER_EMAIL },
        refresh_token: 'refresh-e2e-1',
        organizations: [{ id: ORG_ID, name: ORG_NAME, workos_org_id: WORKOS_ORG_ID }],
        sessions: { [ORG_ID]: { access_token: fakeAccessToken(), expires_at: Date.now() + 3_600_000 } },
      },
      keyMaterial: {
        orgId: ORG_ID,
        prfOutput: prfOutput.toString('base64'),
        credentialId: CRED_ID,
      },
    }));
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

    // The CLI has no flag to shorten the connection TTL (deliberate — see
    // pairCommand.ts's docblock), so this test drives expiry via the fake
    // service answering 410 directly rather than waiting out the real
    // PAIR_TTL_SECONDS default. The clock-driven path (no server signal at
    // all, just the client's own deadline) is already proven with
    // millisecond precision against a real HTTP stub in
    // pairCeremony.test.ts; this test's job is narrower and complementary:
    // prove that however `pair` learns about expiry, an incomplete
    // ceremony NEVER leaves session or key material on disk.
    const pair = spawnCli(['pair', '--json'], home, home, service.url);

    // Give the ceremony a moment to bootstrap and print the code, then kill
    // it — the expiry *logic* (both server 410 and the client's own clock)
    // is already proven with millisecond precision against a real HTTP
    // stub in pairCeremony.test.ts; this test's job is narrower: prove that
    // however `pair` ends up learning about expiry, an incomplete ceremony
    // NEVER leaves session or key material on disk. Simulate a fast expiry
    // by having the fake service answer with 410 immediately.
    const codeDeadline = Date.now() + 10_000;
    let userCode: string | undefined;
    while (Date.now() < codeDeadline) {
      const match = pair.stdoutSoFar().match(/enter:\s+\x1b\[1m([^\x1b]+)\x1b\[0m/);
      if (match) {
        userCode = match[1];
        break;
      }
      await Bun.sleep(20);
    }
    expect(userCode).toBeTruthy();
    const conn = service.findByUserCode(userCode!);
    expect(conn).toBeTruthy();
    conn!.resultQueue.push({ status: 410, body: { error: 'expired', code: 'CONNECTION_EXPIRED' } });

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

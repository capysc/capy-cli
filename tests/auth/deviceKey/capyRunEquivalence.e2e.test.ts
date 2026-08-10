/**
 * CAP-383 — THE CENTERPIECE regression: CAP-372's own acceptance test for
 * "is portability actually done."
 *
 * Provisions the SAME (org, user, master key) two ways —
 *   (1) the transport path: `wrapAndSaveMasterKey`, exactly what
 *       `capy redeem` / plain org creation write today (no device key
 *       involved at all)
 *   (2) device-key onboarding, Case A ("brand-new user"): the REAL
 *       production stack — `AuthService` + `ServiceClient` +
 *       `createDeviceKeyServiceOps` + CAP-380's `onboarding.ts` — driven
 *       over a REAL loopback HTTP server (`tests/helpers/fakeWrapperService.ts`),
 *       with only the ceremony's browser+authenticator faked
 *       (`FakeAuthenticator`, deterministic PRF; every crypto primitive
 *       between it and disk is the real one from `src/auth/deviceKey/crypto.ts`)
 * — into two ENTIRELY SEPARATE `~/.capy` trees (separate temp homes, not
 * merely separate `CAPY_GLOBAL_DIR_NAME` suffixes under one home, so a real
 * `capy run` subprocess can point `HOME` at either one).
 *
 * Then: (a) asserts the two trees are structurally identical where CAP-372
 * demands it (same paths, same file modes, same byte sizes — content
 * differs only in the random key bytes themselves), (b) asserts
 * `keyResolver.unwrapMasterKey` — UNTOUCHED by this whole project, invariant
 * 4's own load-bearing fact — recovers the identical master key from both,
 * and (c) spawns the REAL BUILT CLI (`dist/index.js run`, same subprocess
 * technique `tests/commands/runCommand.test.ts` uses) against BOTH trees and
 * proves both decrypt-and-inject a real secret identically. (c) is the
 * literal "full existing `capy run` suite passes against the passkey tree"
 * proof: no existing `runCommand.test.ts` scenario exercises real
 * local-mode decryption (they're all plaintext-only or deployed-mode), so
 * this test builds the realistic scenario and runs it — via the actual
 * built binary, not an in-process shortcut — against both the transport
 * control and the device-key subject.
 *
 * Never touches the real `~/.capy` — `os.homedir()` is mocked for this
 * process's own writes, and every spawned subprocess gets an explicit `HOME`
 * pointed at one of this test's own temp directories.
 */
import { mock, describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { startFakeWrapperService, kmsWrap, kmsStrip, type FakeWrapperService } from '../../helpers/fakeWrapperService';
import { writeFakeSession } from '../../helpers/fakeSession';
import type { CeremonyTransport, CeremonyFailureCode, EnrollmentRequest, UnlockRequest } from '../../../src/auth/deviceKey/ceremonyTransport';

// --- homedir control: two SEPARATE trees, switched via `currentHome` -------

let currentHome = '';
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => currentHome };
});

afterAll(() => {
  mock.restore();
});

// Dynamic imports so every module observes the mocked homedir.
let onboarding: typeof import('../../../src/auth/deviceKey/onboarding');
let keyResolver: typeof import('../../../src/crypto/keyResolver');
let keyManager: typeof import('../../../src/crypto/keyManager');
let gc: typeof import('../../../src/config/globalConfig');
let serviceOpsMod: typeof import('../../../src/auth/deviceKey/serviceOps');
let AuthServiceMod: typeof import('../../../src/auth/authService');
let ServiceClientMod: typeof import('../../../src/service/serviceClient');
let EncryptorMod: typeof import('../../../src/crypto/encryptor');

beforeAll(async () => {
  onboarding = await import('../../../src/auth/deviceKey/onboarding');
  keyResolver = await import('../../../src/crypto/keyResolver');
  keyManager = await import('../../../src/crypto/keyManager');
  gc = await import('../../../src/config/globalConfig');
  serviceOpsMod = await import('../../../src/auth/deviceKey/serviceOps');
  AuthServiceMod = await import('../../../src/auth/authService');
  ServiceClientMod = await import('../../../src/service/serviceClient');
  EncryptorMod = await import('../../../src/crypto/encryptor');
});

/** Deterministic-PRF fake authenticator — only the browser+hardware half of the ceremony. */
class FakeAuthenticator implements CeremonyTransport {
  private prf = new Map<string, Buffer>();
  credentialId = 'cred-equiv-1';

  async requestEnrollment(req: EnrollmentRequest) {
    const output = randomBytes(32);
    this.prf.set(`${this.credentialId}:${req.prfSalt}`, output);
    return {
      ok: true as const,
      credentialId: this.credentialId,
      prfOutput: output.toString('base64'),
      backupEligible: true,
      backupState: true,
    };
  }

  async requestUnlock(req: UnlockRequest) {
    for (const cand of req.candidates) {
      const output = this.prf.get(`${cand.credentialId}:${cand.prfSalt}`);
      if (output) return { ok: true as const, credentialId: cand.credentialId, prfOutput: output.toString('base64') };
    }
    return { ok: false as const, code: 'no_credential' as CeremonyFailureCode };
  }
}

const USER_ID = 'user_equiv_1';
const ORG_ID = 'org_equiv_1';
const WORKOS_ORG_ID = 'wos_equiv_1';
const ORG_NAME = 'Equivalence Org';
const PROJECT_ID = 'proj_equiv_1';

const kmsOps = {
  coDecrypt: async (_orgId: string, ct: string) => kmsStrip(ct),
  wrapOuterLayer: async (_orgId: string, pt: string) => kmsWrap(pt),
};

function orgUserDir(home: string): string {
  return join(home, '.capy', 'orgs', ORG_ID, 'users', USER_ID);
}

/** {relative filename -> mode+size}, so content (which legitimately differs) never enters the comparison. */
function snapshotDir(dir: string): Record<string, { mode: number; size: number }> {
  const out: Record<string, { mode: number; size: number }> = {};
  for (const f of readdirSync(dir)) {
    const st = statSync(join(dir, f));
    out[f] = { mode: st.mode & 0o777, size: st.size };
  }
  return out;
}

/** Spawn the REAL built CLI, exactly like tests/commands/runCommand.test.ts's own helper. */
function capyRun(
  cwd: string,
  home: string,
  serviceUrl: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(__dirname, '../../../dist/index.js');
  return new Promise((resolve) => {
    const child = spawn('node', [cliPath, 'run', ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        CAPY_API_URL: serviceUrl,
        CAPY_GLOBAL_DIR_NAME: undefined,
      } as Record<string, string>,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.on('error', () => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

describe('CAP-383 equivalence: transport-provisioned vs device-key-provisioned ~/.capy', () => {
  let tempHomeTransport: string;
  let tempHomeDeviceKey: string;
  let fakeService: FakeWrapperService;
  let masterKey: Buffer;

  beforeAll(async () => {
    tempHomeTransport = mkdtempSync(join(tmpdir(), 'capy-equiv-transport-'));
    tempHomeDeviceKey = mkdtempSync(join(tmpdir(), 'capy-equiv-devicekey-'));
    fakeService = startFakeWrapperService();
    masterKey = randomBytes(32);

    // --- Tree 1: transport-provisioned (today's redeem / plain org creation) ---
    currentHome = tempHomeTransport;
    writeFakeSession({
      userId: USER_ID,
      userEmail: 'equiv@example.com',
      organizations: [{ id: ORG_ID, workos_org_id: WORKOS_ORG_ID, name: ORG_NAME }],
    });
    await keyResolver.wrapAndSaveMasterKey(masterKey, ORG_ID, USER_ID, kmsOps);

    // --- Tree 2: device-key-provisioned (Case A), full production stack over real HTTP ---
    currentHome = tempHomeDeviceKey;
    writeFakeSession({
      userId: USER_ID,
      userEmail: 'equiv@example.com',
      organizations: [{ id: ORG_ID, workos_org_id: WORKOS_ORG_ID, name: ORG_NAME }],
    });
    const authService = new AuthServiceMod.AuthService(fakeService.url, false);
    const serviceClient = new ServiceClientMod.ServiceClient(fakeService.url, false);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    const pinned = await authService.authenticateSilent(ORG_ID);
    expect(pinned.success).toBe(true);

    const { ops, opsForOrg } = serviceOpsMod.createDeviceKeyServiceOps(serviceClient, authService);
    const ceremony = new FakeAuthenticator();
    const deps: import('../../../src/auth/deviceKey/onboarding').OnboardingDeps = {
      userId: USER_ID,
      userEmail: 'equiv@example.com',
      organizations: [{ id: ORG_ID, workos_org_id: WORKOS_ORG_ID, name: ORG_NAME }],
      activeOrgId: ORG_ID,
      ceremony,
      ops,
      opsForOrg,
    };
    const result = await onboarding.runNewUserEnrollment(deps, { orgId: ORG_ID, masterKey });
    if (!result.ok) throw new Error(`setup: device-key enrollment unexpectedly declined: ${JSON.stringify(result)}`);
    expect(result.orgs).toEqual([{ orgId: ORG_ID, status: 'uploaded' }]);
  });

  afterAll(() => {
    fakeService.close();
    rmSync(tempHomeTransport, { recursive: true, force: true });
    rmSync(tempHomeDeviceKey, { recursive: true, force: true });
  });

  it('steady state has no transient sync marker (device-key tree)', () => {
    currentHome = tempHomeDeviceKey;
    expect(gc.isKeyEncSyncPending(ORG_ID, USER_ID)).toBe(false);
  });

  it('the two trees hold the exact same file set, with the exact same modes and sizes', () => {
    const transportSnap = snapshotDir(orgUserDir(tempHomeTransport));
    const deviceKeySnap = snapshotDir(orgUserDir(tempHomeDeviceKey));

    // Same paths: no extra file (e.g. a leftover sync-pending marker) on
    // either side — this IS invariant 4 ("steady state is byte-identical").
    expect(Object.keys(deviceKeySnap).sort()).toEqual(Object.keys(transportSnap).sort());
    expect(Object.keys(transportSnap).sort()).toEqual(['key.enc', 'local.key']);

    // Same modes, same byte sizes for every file. Sizes are legitimately
    // deterministic here (fixed-length base64 of a 32-byte root; key.enc's
    // JSON has fixed-length fields throughout — see file header) — this is
    // not a coincidence of these particular random keys.
    for (const name of Object.keys(transportSnap)) {
      expect(deviceKeySnap[name]).toEqual(transportSnap[name]);
    }
  });

  it('key.enc has the identical JSON shape on both trees (content differs only in the encrypted bytes)', () => {
    const transport = JSON.parse(require('fs').readFileSync(join(orgUserDir(tempHomeTransport), 'key.enc'), 'utf-8'));
    const deviceKey = JSON.parse(require('fs').readFileSync(join(orgUserDir(tempHomeDeviceKey), 'key.enc'), 'utf-8'));

    expect(Object.keys(deviceKey).sort()).toEqual(Object.keys(transport).sort());
    expect(deviceKey.version).toBe(transport.version);
    expect(deviceKey.org_id).toBe(transport.org_id);
    expect(deviceKey.wrapping_method).toBe(transport.wrapping_method);
    expect(typeof deviceKey.encrypted_master_key).toBe('string');
    expect(typeof deviceKey.created_at).toBe('string');
    // The one place content LEGITIMATELY differs: each tree minted its own
    // random K_local, so the same M wraps to different ciphertext bytes.
    expect(deviceKey.encrypted_master_key).not.toBe(transport.encrypted_master_key);
  });

  it('the untouched keyResolver recovers the identical master key from both trees (invariant 4)', async () => {
    currentHome = tempHomeTransport;
    const fromTransport = await keyResolver.unwrapMasterKey(ORG_ID, USER_ID, kmsOps);
    currentHome = tempHomeDeviceKey;
    const fromDeviceKey = await keyResolver.unwrapMasterKey(ORG_ID, USER_ID, kmsOps);

    expect(fromTransport.equals(masterKey)).toBe(true);
    expect(fromDeviceKey.equals(masterKey)).toBe(true);
  });

  describe('a real `capy run` subprocess against each tree', () => {
    async function proveCapyRunWorks(home: string, label: string) {
      const projectDir = mkdtempSync(join(tmpdir(), `capy-equiv-project-${label}-`));
      try {
        writeFileSync(
          join(projectDir, 'keep.lock'),
          JSON.stringify({ version: '3.0', org_id: ORG_ID, project_id: PROJECT_ID, project_name: 'demo', variables: {} }),
        );
        const projectKeyHex = keyManager.deriveProjectKey(masterKey, PROJECT_ID, ORG_ID);
        const secretValue = `shh-${label}-secret`;
        const ciphertext = EncryptorMod.Encryptor.encrypt(secretValue, projectKeyHex);
        writeFileSync(join(projectDir, '.env'), `SECRET_VAR=capy:res123:${ciphertext}\n`);

        const result = await capyRun(projectDir, home, fakeService.url, [
          '--', 'node', '-e', 'console.log(process.env.SECRET_VAR)',
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(secretValue);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }

    it('control: passes against the transport-provisioned tree', async () => {
      await proveCapyRunWorks(tempHomeTransport, 'transport');
    });

    it('THE PROOF: passes identically against the device-key-provisioned tree', async () => {
      await proveCapyRunWorks(tempHomeDeviceKey, 'devicekey');
    });
  });
});

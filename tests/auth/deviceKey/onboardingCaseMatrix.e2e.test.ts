/**
 * CAP-383 — e2e per case-matrix row (A, B, B′, C, C′), each driven through
 * the REAL production entry points `capyCommand.ts`/`redeemCommand.ts` call
 * (`src/auth/deviceKey/wiring.ts`'s `attemptCaseAEnrollment` /
 * `runDeviceKeyEnrollment` / `attemptCaseCUnlock`), each TERMINATING in a
 * real `capy run` subprocess against the resulting tree (or, for B′, the
 * documented clean failure of `capy run` when there is genuinely no key
 * material yet — B′ is a routing verdict, not a provisioning path).
 *
 * The ceremony rides CAP-382's actual transport (`BrokerCeremonyTransport`,
 * unmodified) against a mocked broker + mocked page
 * (`tests/helpers/fakeWrapperService.ts` + `tests/helpers/fakeCeremonyPage.ts`)
 * with REAL envelope crypto — per the ticket's instruction, "the crypto must
 * be real." Only the human/authenticator decision is scripted.
 *
 * C vs C′ (a local platform authenticator vs. hybrid/QR transport) are
 * indistinguishable to the CLI by design — `detect.ts`'s own header comment:
 * "whether the credential lives in a local authenticator or arrives via
 * QR/hybrid transport is the ceremony's own discovery ... invisible to the
 * CLI. Both are `unlock`." The C and C′ rows below therefore exercise the
 * IDENTICAL code path; C′ is framed as a second, independent new device
 * unlocking the same account (the actual portability property under test —
 * "any new surface, not just the first"), not a second proof of the same
 * branch. The manual ceremony matrix (this ticket's item 5,
 * `docs/device-key-ceremony-qa-checklist.md`) is where Safari/iCloud vs
 * Chrome/GPM vs hybrid QR are actually told apart — that distinction lives
 * entirely inside the browser ceremony, below this seam.
 */
import { mock, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { startFakeWrapperService, kmsWrap, kmsStrip, type FakeWrapperService } from '../../helpers/fakeWrapperService';
import { writeFakeSession } from '../../helpers/fakeSession';
import { driveCeremony, SharedAuthenticator } from '../../helpers/fakeCeremonyPage';
import { capyRun, writeEncryptedProject } from '../../helpers/capyRunSubprocess';
import { ERROR_CODES } from '../../../src/types/index';

let currentHome = '';
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => currentHome };
});

afterAll(() => {
  mock.restore();
});

let keyResolver: typeof import('../../../src/crypto/keyResolver');
let keyManager: typeof import('../../../src/crypto/keyManager');
let gc: typeof import('../../../src/config/globalConfig');
let wiring: typeof import('../../../src/auth/deviceKey/wiring');
let AuthServiceMod: typeof import('../../../src/auth/authService');
let ServiceClientMod: typeof import('../../../src/service/serviceClient');

beforeAll(async () => {
  keyResolver = await import('../../../src/crypto/keyResolver');
  keyManager = await import('../../../src/crypto/keyManager');
  gc = await import('../../../src/config/globalConfig');
  wiring = await import('../../../src/auth/deviceKey/wiring');
  AuthServiceMod = await import('../../../src/auth/authService');
  ServiceClientMod = await import('../../../src/service/serviceClient');
});

const USER_ID = 'user_matrix_1';
const kmsOps = {
  coDecrypt: async (_orgId: string, ct: string) => kmsStrip(ct),
  wrapOuterLayer: async (_orgId: string, pt: string) => kmsWrap(pt),
};

/** Real AuthService + ServiceClient, pinned to every listed org, for a fresh home. */
async function buildCtx(
  fakeService: FakeWrapperService,
  orgs: Array<{ id: string; workos_org_id: string; name: string }>,
  activeOrgId: string | null,
): Promise<import('../../../src/auth/deviceKey/wiring').DeviceKeyWiringContext> {
  writeFakeSession({ userId: USER_ID, userEmail: 'matrix@example.com', organizations: orgs });
  const authService = new AuthServiceMod.AuthService(fakeService.url, false);
  const serviceClient = new ServiceClientMod.ServiceClient(fakeService.url, false);
  serviceClient.setTokenProvider(() => authService.getValidToken());
  for (const org of orgs) {
    const pinned = await authService.authenticateSilent(org.id);
    if (!pinned.success) throw new Error(`setup: could not pin org ${org.id}: ${pinned.error}`);
  }
  return {
    authService,
    serviceClient,
    devMode: false,
    userId: USER_ID,
    userEmail: 'matrix@example.com',
    organizations: orgs,
    activeOrgId,
  } as any;
}

describe('CAP-383 onboarding case matrix (A, B, B′, C, C′)', () => {
  let fakeService: FakeWrapperService;
  let homes: string[];
  let projectDirs: string[];
  const prevApiUrl = process.env.CAPY_API_URL;

  beforeEach(() => {
    fakeService = startFakeWrapperService();
    process.env.CAPY_API_URL = fakeService.url;
    homes = [];
    projectDirs = [];
  });

  afterEach(() => {
    fakeService.close();
    if (prevApiUrl === undefined) delete process.env.CAPY_API_URL;
    else process.env.CAPY_API_URL = prevApiUrl;
    for (const h of [...homes, ...projectDirs]) rmSync(h, { recursive: true, force: true });
  });

  function freshHome(): string {
    const h = mkdtempSync(join(tmpdir(), 'capy-matrix-home-'));
    homes.push(h);
    return h;
  }
  function freshProjectDir(): string {
    const p = mkdtempSync(join(tmpdir(), 'capy-matrix-project-'));
    projectDirs.push(p);
    return p;
  }

  it('Case A — brand-new user: org creation + device-key enrollment, then a real capy run', async () => {
    currentHome = freshHome();
    const org = { id: 'orgA', workos_org_id: 'wos_orgA', name: 'Org A' };
    const masterKey = randomBytes(32);

    const ctx = await buildCtx(fakeService, [org], org.id);
    // Mirrors capyCommand.ts's own order (CAP-380 decision 4): the
    // org-creation flow's writes happen FIRST (wrapAndSaveMasterKey, here
    // standing in for the untouched org-creation flow this call sits after).
    await keyResolver.wrapAndSaveMasterKey(masterKey, org.id, USER_ID, kmsOps);

    const auth = new SharedAuthenticator('cred-caseA');
    await driveCeremony(
      fakeService,
      (req) => (req.ceremony === 'enroll' ? auth.enrollResponse(req.prfSalt) : auth.unlockResponse(req.candidates)),
      () => wiring.attemptCaseAEnrollment({ ctx, orgId: org.id, orgName: org.name, masterKey, orglessToken: 'fake-orgless-token' }),
    );

    // Enrollment landed a live door + key.enc, and left no transient marker.
    expect(fakeService.rows.some((r) => r.type === 'wrapped_k_local' && !r.deleted_at)).toBe(true);
    expect(fakeService.rows.some((r) => r.type === 'key_enc' && !r.deleted_at && r.organization_id === org.id)).toBe(true);
    expect(gc.isKeyEncSyncPending(org.id, USER_ID)).toBe(false);

    const projectDir = freshProjectDir();
    writeEncryptedProject(projectDir, {
      orgId: org.id,
      projectId: 'projA',
      masterKey,
      secretValue: 'secret-case-a',
      deriveProjectKey: keyManager.deriveProjectKey,
    });
    const result = await capyRun(projectDir, currentHome, fakeService.url, ['--', 'node', '-e', 'console.log(process.env.SECRET_VAR)']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('secret-case-a');
  });

  it('Case B — existing user, existing machine: capy device-key enroll, then a real capy run', async () => {
    currentHome = freshHome();
    const org = { id: 'orgB', workos_org_id: 'wos_orgB', name: 'Org B' };
    const masterKey = randomBytes(32);

    // Transport-provisioned already (this machine has local.key/key.enc for
    // orgB from a plain redeem/org-creation, no device key yet).
    await keyResolver.wrapAndSaveMasterKey(masterKey, org.id, USER_ID, kmsOps);
    const ctx = await buildCtx(fakeService, [org], org.id);

    const auth = new SharedAuthenticator('cred-caseB');
    const outcome = await driveCeremony(
      fakeService,
      (req) => (req.ceremony === 'enroll' ? auth.enrollResponse(req.prfSalt) : auth.unlockResponse(req.candidates)),
      () => wiring.runDeviceKeyEnrollment(ctx),
    );
    expect(outcome.kind).toBe('enrolled');

    const projectDir = freshProjectDir();
    writeEncryptedProject(projectDir, {
      orgId: org.id,
      projectId: 'projB',
      masterKey,
      secretValue: 'secret-case-b',
      deriveProjectKey: keyManager.deriveProjectKey,
    });
    const result = await capyRun(projectDir, currentHome, fakeService.url, ['--', 'node', '-e', 'console.log(process.env.SECRET_VAR)']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('secret-case-b');
  });

  it('Case B′ — account has orgs but this machine has neither local root nor a live door: routes to recovery/transport, and capy run fails the documented clean way (no key material exists to fabricate)', async () => {
    currentHome = freshHome();
    const org = { id: 'orgBprime', workos_org_id: 'wos_orgBprime', name: 'Org Bprime' };
    // Deliberately NOT provisioning anything on this machine — the org is
    // only known via the (fake) authenticated session, matching a teammate
    // who has never run `capy`/`capy redeem` here.
    const ctx = await buildCtx(fakeService, [org], org.id);

    const outcome = await wiring.runDeviceKeyEnrollment(ctx);
    expect(outcome).toEqual({ kind: 'not_ready', verdictKind: 'recovery_or_transport' });
    // No ceremony was ever reachable — nothing relayed, nothing minted.
    expect(fakeService.connections.size).toBe(0);
    expect(fakeService.rows.length).toBe(0);
    expect(existsSync(gc.getLocalRootPath(org.id, USER_ID))).toBe(false);

    // Terminating in a real capy run: with no keep.lock and no key at all,
    // it fails the exact same clean, actionable way it always has — B′
    // correctly refuses to fabricate access, it doesn't crash or hang. An
    // encrypted .env forces the code path that actually needs the key (a
    // pure-plaintext .env would spawn the child successfully with nothing
    // to decrypt, proving nothing about B′).
    const projectDir = freshProjectDir();
    const { Encryptor } = await import('../../../src/crypto/encryptor');
    require('fs').writeFileSync(join(projectDir, '.env'), `SECRET_VAR=capy:res1:${Encryptor.encrypt('x', 'irrelevant-key')}\n`);
    const result = await capyRun(projectDir, currentHome, fakeService.url, ['--', 'echo', 'should-not-run']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/keep\.lock/);
  });

  it('Case C — enrolled user, fresh machine: unlock ceremony installs every org, then a real capy run', async () => {
    const org1 = { id: 'orgC1', workos_org_id: 'wos_orgC1', name: 'Org C1' };
    const org2 = { id: 'orgC2', workos_org_id: 'wos_orgC2', name: 'Org C2' };
    const m1 = randomBytes(32);
    const m2 = randomBytes(32);
    const auth = new SharedAuthenticator('cred-caseC');

    // Machine 1: provision both orgs the transport way, then enroll (Case B).
    currentHome = freshHome();
    await keyResolver.wrapAndSaveMasterKey(m1, org1.id, USER_ID, kmsOps);
    await keyResolver.wrapAndSaveMasterKey(m2, org2.id, USER_ID, kmsOps);
    const ctx1 = await buildCtx(fakeService, [org1, org2], org1.id);
    const enrolled = await driveCeremony(
      fakeService,
      (req) => (req.ceremony === 'enroll' ? auth.enrollResponse(req.prfSalt) : auth.unlockResponse(req.candidates)),
      () => wiring.runDeviceKeyEnrollment(ctx1),
    );
    expect(enrolled.kind).toBe('enrolled');

    // Machine 2 (THE marquee scenario): empty home, same account, same
    // physical authenticator (SharedAuthenticator remembers the PRF).
    currentHome = freshHome();
    const ctx2 = await buildCtx(fakeService, [org1, org2], org1.id);
    expect(gc.hasLocalRoot(org1.id, USER_ID)).toBe(false);

    const unlock = await driveCeremony(
      fakeService,
      (req) => (req.ceremony === 'enroll' ? auth.enrollResponse(req.prfSalt) : auth.unlockResponse(req.candidates)),
      () => wiring.attemptCaseCUnlock(ctx2),
    );
    expect(unlock).toEqual({ ok: true, installedCurrentOrg: true });
    expect(gc.readLocalRoot(org1.id, USER_ID)).not.toBeNull();
    expect(gc.readLocalRoot(org2.id, USER_ID)).not.toBeNull();

    const projectDir = freshProjectDir();
    writeEncryptedProject(projectDir, {
      orgId: org2.id,
      projectId: 'projC2',
      masterKey: m2,
      secretValue: 'secret-case-c-org2',
      deriveProjectKey: keyManager.deriveProjectKey,
    });
    const result = await capyRun(projectDir, currentHome, fakeService.url, ['--', 'node', '-e', 'console.log(process.env.SECRET_VAR)']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('secret-case-c-org2');
  });

  it('Case C′ — a SECOND independent new machine unlocks the same account (identical CLI code path to C by design; the portability property is “any new surface,” not just the first)', async () => {
    const org = { id: 'orgCprime', workos_org_id: 'wos_orgCprime', name: 'Org Cprime' };
    const m = randomBytes(32);
    const auth = new SharedAuthenticator('cred-caseCprime');

    currentHome = freshHome();
    await keyResolver.wrapAndSaveMasterKey(m, org.id, USER_ID, kmsOps);
    const ctx1 = await buildCtx(fakeService, [org], org.id);
    await driveCeremony(
      fakeService,
      (req) => (req.ceremony === 'enroll' ? auth.enrollResponse(req.prfSalt) : auth.unlockResponse(req.candidates)),
      () => wiring.runDeviceKeyEnrollment(ctx1),
    );

    // Two MORE machines, independently, both starting from nothing.
    for (const label of ['machine2', 'machine3']) {
      currentHome = freshHome();
      const ctx = await buildCtx(fakeService, [org], org.id);
      const unlock = await driveCeremony(
        fakeService,
        (req) => (req.ceremony === 'enroll' ? auth.enrollResponse(req.prfSalt) : auth.unlockResponse(req.candidates)),
        () => wiring.attemptCaseCUnlock(ctx),
      );
      expect(unlock).toEqual({ ok: true, installedCurrentOrg: true });

      const projectDir = freshProjectDir();
      writeEncryptedProject(projectDir, {
        orgId: org.id,
        projectId: 'projCprime',
        masterKey: m,
        secretValue: `secret-case-cprime-${label}`,
        deriveProjectKey: keyManager.deriveProjectKey,
      });
      const result = await capyRun(projectDir, currentHome, fakeService.url, ['--', 'node', '-e', 'console.log(process.env.SECRET_VAR)']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(`secret-case-cprime-${label}`);
    }
  });
});

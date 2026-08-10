/**
 * CAP-383 — the CAP-372 security assertions, tested at the CLI boundary:
 *
 *   1. No plaintext key material (M, K_local, PRF output) crosses the
 *      network, or appears in any log output these tests can observe,
 *      during a real enrollment.
 *   2. The enrollment path requires a verified-email session: the client
 *      handles the service's CODED rejection (never message text, never a
 *      crash) when the broker refuses to mint a connection.
 *   3. A completed ceremony alone (a PRF output, with no session) cannot
 *      touch the wrapper endpoints — the session gate is structurally
 *      independent of, and upstream from, ceremony completion.
 */
import { mock, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { startFakeWrapperService, kmsWrap, kmsStrip, type FakeWrapperService } from '../../helpers/fakeWrapperService';
import { writeFakeSession } from '../../helpers/fakeSession';
import { driveCeremony } from '../../helpers/fakeCeremonyPage';
import { CapyError } from '../../../src/types/index';
import type { CeremonyTransport, CeremonyFailureCode, EnrollmentRequest, UnlockRequest } from '../../../src/auth/deviceKey/ceremonyTransport';

let currentHome = '';
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => currentHome };
});

afterAll(() => {
  mock.restore();
});

let onboarding: typeof import('../../../src/auth/deviceKey/onboarding');
let gc: typeof import('../../../src/config/globalConfig');
let wiring: typeof import('../../../src/auth/deviceKey/wiring');
let serviceOpsMod: typeof import('../../../src/auth/deviceKey/serviceOps');
let AuthServiceMod: typeof import('../../../src/auth/authService');
let ServiceClientMod: typeof import('../../../src/service/serviceClient');
let brokerCeremonyMod: typeof import('../../../src/auth/deviceKey/brokerCeremonyTransport');

beforeAll(async () => {
  onboarding = await import('../../../src/auth/deviceKey/onboarding');
  gc = await import('../../../src/config/globalConfig');
  wiring = await import('../../../src/auth/deviceKey/wiring');
  serviceOpsMod = await import('../../../src/auth/deviceKey/serviceOps');
  AuthServiceMod = await import('../../../src/auth/authService');
  ServiceClientMod = await import('../../../src/service/serviceClient');
  brokerCeremonyMod = await import('../../../src/auth/deviceKey/brokerCeremonyTransport');
});

const USER_ID = 'user_sec_1';
const kmsOps = {
  coDecrypt: async (_orgId: string, ct: string) => kmsStrip(ct),
  wrapOuterLayer: async (_orgId: string, pt: string) => kmsWrap(pt),
};

/** Records every secret it mints, so a test can assert none of them leaked. */
class RecordingAuthenticator implements CeremonyTransport {
  credentialId = 'cred-sec-1';
  mintedPrfOutputs: Buffer[] = [];
  private prf = new Map<string, Buffer>();

  async requestEnrollment(req: EnrollmentRequest) {
    const output = randomBytes(32);
    this.mintedPrfOutputs.push(output);
    this.prf.set(`${this.credentialId}:${req.prfSalt}`, output);
    return { ok: true as const, credentialId: this.credentialId, prfOutput: output.toString('base64'), backupEligible: true, backupState: true };
  }
  async requestUnlock(req: UnlockRequest) {
    for (const c of req.candidates) {
      const output = this.prf.get(`${c.credentialId}:${c.prfSalt}`);
      if (output) return { ok: true as const, credentialId: c.credentialId, prfOutput: output.toString('base64') };
    }
    return { ok: false as const, code: 'no_credential' as CeremonyFailureCode };
  }
}

describe('CAP-383 security assertions (CAP-372)', () => {
  let tempHome: string;
  let fakeService: FakeWrapperService;
  const prevApiUrl = process.env.CAPY_API_URL;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'capy-security-'));
    currentHome = tempHome;
    fakeService = startFakeWrapperService();
    process.env.CAPY_API_URL = fakeService.url;
  });

  afterEach(() => {
    fakeService.close();
    if (prevApiUrl === undefined) delete process.env.CAPY_API_URL;
    else process.env.CAPY_API_URL = prevApiUrl;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('no plaintext key material appears in any network payload or observed log output during a real enrollment', async () => {
    const org = { id: 'orgSec', workos_org_id: 'wos_orgSec', name: 'Org Sec' };
    const masterKey = randomBytes(32);
    writeFakeSession({ userId: USER_ID, userEmail: 'sec@example.com', organizations: [org] });
    const authService = new AuthServiceMod.AuthService(fakeService.url, false);
    const serviceClient = new ServiceClientMod.ServiceClient(fakeService.url, false);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    await authService.authenticateSilent(org.id);
    const { ops, opsForOrg } = serviceOpsMod.createDeviceKeyServiceOps(serviceClient, authService);

    const auth = new RecordingAuthenticator();
    const capturedLogs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => capturedLogs.push(a.map(String).join(' '));
    console.error = (...a: unknown[]) => capturedLogs.push(a.map(String).join(' '));

    let result;
    try {
      result = await onboarding.runNewUserEnrollment(
        { userId: USER_ID, userEmail: 'sec@example.com', organizations: [org], activeOrgId: org.id, ceremony: auth, ops, opsForOrg },
        { orgId: org.id, masterKey },
      );
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    if (!result.ok) throw new Error('setup: enrollment unexpectedly declined');

    const kLocal = gc.readLocalRoot(org.id, USER_ID)!;
    expect(auth.mintedPrfOutputs.length).toBeGreaterThan(0);

    const secretsToNeverSee: Array<{ label: string; hex: string; b64: string }> = [
      { label: 'master key M', hex: masterKey.toString('hex'), b64: masterKey.toString('base64') },
      { label: 'K_local root', hex: kLocal.toString('hex'), b64: kLocal.toString('base64') },
      ...auth.mintedPrfOutputs.map((p, i) => ({ label: `PRF output #${i}`, hex: p.toString('hex'), b64: p.toString('base64') })),
    ];

    const networkPayloads = fakeService.requests.map((r) => JSON.stringify(r.body ?? {}));
    const allObservableText = [...networkPayloads, ...capturedLogs].join('\n');

    for (const secret of secretsToNeverSee) {
      expect(allObservableText.includes(secret.hex)).toBe(false);
      expect(allObservableText.includes(secret.b64)).toBe(false);
    }

    // Sanity: the wrapped forms (which legitimately DO cross the network) are
    // actually present — proves this assertion isn't vacuously true because
    // nothing was captured.
    const doorUpload = fakeService.requests.find((r) => r.method === 'POST' && r.path === '/wrappers' && (r.body as any)?.type === 'wrapped_k_local');
    expect(doorUpload).toBeDefined();
    expect(typeof (doorUpload!.body as any).wrapped_k_local).toBe('string');
  });

  it('the enrollment path requires a verified-email session: a coded 403 from the broker create is handled, not crashed on', async () => {
    fakeService.failNextConnectionCreate(403, { error: 'email address is not verified', code: 'EMAIL_NOT_VERIFIED' });

    const transport = new brokerCeremonyMod.BrokerCeremonyTransport({
      serviceUrl: fakeService.url,
      getToken: () => 'some-token',
      ttlSeconds: 900,
      deadlineMs: 3000,
    });

    // Never throws — the coded rejection is handled uniformly with every
    // other createConnection failure (Rule: branch on structure, never on
    // response prose — see brokerClient.ts's own catch, which never inspects
    // `err.message`).
    const outcome = await transport.requestEnrollment({ userId: USER_ID, prfSalt: randomBytes(32).toString('base64') });
    expect(outcome).toEqual({ ok: false, code: 'transport_error' });

    // And the onboarding engine surfaces this as a clean, typed refusal —
    // never an unhandled rejection, never a partial/inconsistent write.
    const org = { id: 'orgVerify', workos_org_id: 'wos_orgVerify', name: 'Org Verify' };
    const masterKey = randomBytes(32);
    writeFakeSession({ userId: USER_ID, userEmail: 'unverified@example.com', organizations: [org] });
    const authService = new AuthServiceMod.AuthService(fakeService.url, false);
    const serviceClient = new ServiceClientMod.ServiceClient(fakeService.url, false);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    await authService.authenticateSilent(org.id);
    const { ops, opsForOrg } = serviceOpsMod.createDeviceKeyServiceOps(serviceClient, authService);

    fakeService.failNextConnectionCreate(403, { error: 'email address is not verified', code: 'EMAIL_NOT_VERIFIED' });
    const rejectingTransport = new brokerCeremonyMod.BrokerCeremonyTransport({
      serviceUrl: fakeService.url,
      getToken: () => 'some-token',
      ttlSeconds: 900,
      deadlineMs: 3000,
    });
    const result = await onboarding.runNewUserEnrollment(
      { userId: USER_ID, userEmail: 'unverified@example.com', organizations: [org], activeOrgId: org.id, ceremony: rejectingTransport, ops, opsForOrg },
      { orgId: org.id, masterKey },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.ceremonyCode).toBe('transport_error');
    // Refusal costs nothing — no wrapper call was ever attempted.
    expect(fakeService.rows.length).toBe(0);
  });

  it('a completed ceremony alone (PRF output, no session) cannot reach the wrapper endpoints', async () => {
    const org = { id: 'orgNoSession', workos_org_id: 'wos_orgNoSession', name: 'Org No Session' };
    // Deliberately NO session written for this home — a real ceremony can
    // still run (it needs no session at all, by interface design), but
    // nothing downstream of it should be able to touch /wrappers.
    const authService = new AuthServiceMod.AuthService(fakeService.url, false);
    const serviceClient = new ServiceClientMod.ServiceClient(fakeService.url, false);
    serviceClient.setTokenProvider(() => authService.getValidToken());

    const { opsForOrg } = serviceOpsMod.createDeviceKeyServiceOps(serviceClient, authService);
    const orgOps = await opsForOrg(org.id);
    // Structural proof: no session → opsForOrg refuses before any request is
    // attempted, regardless of what a ceremony would have produced.
    expect(orgOps).toBeNull();
    expect(fakeService.requests.some((r) => r.path.startsWith('/wrappers'))).toBe(false);

    // And the user-scoped door-upload path is equally gated: a session-less
    // token provider yields no Authorization header, and even this HONEST
    // fake server (which does not require auth by default) is switched to
    // require it here so the assertion is about the CLIENT's request, not
    // this fixture's leniency.
    fakeService.requireAuth = true;
    const { ops } = serviceOpsMod.createDeviceKeyServiceOps(serviceClient, authService);
    let threw = false;
    try {
      await ops.uploadDoorWrapper({ wrapped_k_local: 'ct', iv: 'iv', prf_salt: 'salt', credential_id: 'cred-x', kdf_version: 1 });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(CapyError);
    }
    expect(threw).toBe(true);
  });
});

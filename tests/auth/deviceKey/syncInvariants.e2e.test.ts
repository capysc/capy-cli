/**
 * CAP-383 — the sync-invariant battery, driven over a REAL loopback HTTP
 * server (`tests/helpers/fakeWrapperService.ts`) through the real
 * `AuthService` + `ServiceClient` + `src/auth/deviceKey/serviceOps.ts`
 * stack, not CAP-380's own in-memory `FakeWrapperServer` — these tests
 * exist specifically to prove the network-facing half (conflict rotation,
 * retry-on-failure, concurrent requests hitting a server that enforces its
 * own invariants) that an in-memory fake can't exercise honestly.
 *
 * None of these tests drives a WebAuthn ceremony — `runPendingSync` and its
 * helpers never touch `deps.ceremony` — so the ceremony transport passed in
 * is a stub that throws if ever called, itself an assertion that these code
 * paths are ceremony-free.
 */
import { mock, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { startFakeWrapperService, kmsWrap, kmsStrip, type FakeWrapperService, type WrapperRow } from '../../helpers/fakeWrapperService';
import { writeFakeSession } from '../../helpers/fakeSession';
import { ERROR_CODES } from '../../../src/types/index';
import type { CeremonyTransport } from '../../../src/auth/deviceKey/ceremonyTransport';

let currentHome = '';
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => currentHome };
});

afterAll(() => {
  mock.restore();
});

let onboarding: typeof import('../../../src/auth/deviceKey/onboarding');
let keyResolver: typeof import('../../../src/crypto/keyResolver');
let gc: typeof import('../../../src/config/globalConfig');
let serviceOpsMod: typeof import('../../../src/auth/deviceKey/serviceOps');
let AuthServiceMod: typeof import('../../../src/auth/authService');
let ServiceClientMod: typeof import('../../../src/service/serviceClient');

beforeAll(async () => {
  onboarding = await import('../../../src/auth/deviceKey/onboarding');
  keyResolver = await import('../../../src/crypto/keyResolver');
  gc = await import('../../../src/config/globalConfig');
  serviceOpsMod = await import('../../../src/auth/deviceKey/serviceOps');
  AuthServiceMod = await import('../../../src/auth/authService');
  ServiceClientMod = await import('../../../src/service/serviceClient');
});

const USER_ID = 'user_sync_1';
const neverCalledCeremony: CeremonyTransport = {
  requestEnrollment: async () => {
    throw new Error('runPendingSync must never invoke the ceremony');
  },
  requestUnlock: async () => {
    throw new Error('runPendingSync must never invoke the ceremony');
  },
};

const kmsOps = {
  coDecrypt: async (_orgId: string, ct: string) => kmsStrip(ct),
  wrapOuterLayer: async (_orgId: string, pt: string) => kmsWrap(pt),
};

/** Real production wiring (AuthService + ServiceClient + serviceOps) against `server`, for a session pre-seeded with `orgs`. */
async function buildDeps(
  server: FakeWrapperService,
  orgs: Array<{ id: string; workos_org_id: string; name: string }>,
  activeOrgId: string,
) {
  writeFakeSession({ userId: USER_ID, userEmail: 'sync@example.com', organizations: orgs });
  const authService = new AuthServiceMod.AuthService(server.url, false);
  const serviceClient = new ServiceClientMod.ServiceClient(server.url, false);
  serviceClient.setTokenProvider(() => authService.getValidToken());
  for (const org of orgs) {
    const pinned = await authService.authenticateSilent(org.id);
    if (!pinned.success) throw new Error(`setup: could not pin org ${org.id}`);
  }
  await authService.authenticateSilent(activeOrgId);
  const { ops, opsForOrg } = serviceOpsMod.createDeviceKeyServiceOps(serviceClient, authService);
  return {
    userId: USER_ID,
    userEmail: 'sync@example.com',
    organizations: orgs,
    activeOrgId,
    ceremony: neverCalledCeremony,
    ops,
    opsForOrg,
  };
}

function liveDoor(): WrapperRow {
  return {
    id: 'door-seed',
    type: 'wrapped_k_local',
    credential_id: 'cred-seed',
    kdf_version: 1,
    is_seed: true,
    verified_at: new Date().toISOString(),
    organization_id: null,
    created_at: new Date().toISOString(),
    deleted_at: null,
    mirror_state: 'pending',
  };
}

describe('CAP-383 sync-invariant battery (real HTTP)', () => {
  let tempHome: string;
  let fakeService: FakeWrapperService;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'capy-sync-inv-'));
    currentHome = tempHome;
    fakeService = startFakeWrapperService();
  });

  afterEach(() => {
    fakeService.close();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('offline re-wrap retry: a transient 503 leaves the marker, and a later run retries it to success', async () => {
    const org = { id: 'org1', workos_org_id: 'wos_org1', name: 'Org One' };
    await keyResolver.wrapAndSaveMasterKey(randomBytes(32), org.id, USER_ID, kmsOps);
    fakeService.rows.push(liveDoor());
    const root = gc.readLocalRoot(org.id, USER_ID)!;
    gc.markKeyEncSyncPending(org.id, USER_ID, org.id, root);

    // The org's key.enc upload fails once ("offline") — see fakeWrapperService's
    // header note on why an HTTP 503 is the honest stand-in for a real drop.
    fakeService.failNext(
      (method, path) => method === 'POST' && path === '/wrappers',
      { status: 503, body: { error: 'offline', code: 'SERVICE_UNAVAILABLE' } },
      1,
    );

    const deps = await buildDeps(fakeService, [org], org.id);

    const firstAttempt = await onboarding.runPendingSync(deps);
    expect(firstAttempt).toEqual([{ orgId: org.id, status: 'failed', code: ERROR_CODES.SERVICE_ERROR }]);
    expect(gc.isKeyEncSyncPending(org.id, USER_ID)).toBe(true);
    expect(fakeService.rows.some((r) => r.type === 'key_enc')).toBe(false);

    const retry = await onboarding.runPendingSync(deps);
    expect(retry).toEqual([{ orgId: org.id, status: 'uploaded' }]);
    expect(gc.isKeyEncSyncPending(org.id, USER_ID)).toBe(false);
    const live = fakeService.rows.find((r) => r.type === 'key_enc' && !r.deleted_at);
    expect(live).toBeDefined();
    expect(live!.key_enc).toBe(gc.readMasterKey(org.id, USER_ID));
  });

  it('concurrent re-wrap race: two racing syncs for the same org converge on exactly one live key.enc row', async () => {
    const org = { id: 'org1', workos_org_id: 'wos_org1', name: 'Org One' };
    await keyResolver.wrapAndSaveMasterKey(randomBytes(32), org.id, USER_ID, kmsOps);
    fakeService.rows.push(liveDoor());
    const root = gc.readLocalRoot(org.id, USER_ID)!;
    gc.markKeyEncSyncPending(org.id, USER_ID, org.id, root);

    const deps = await buildDeps(fakeService, [org], org.id);

    // Two "processes" racing the same pending retry against the same live
    // server — exercises the client's WRAPPER_CONFLICT rotate-on-conflict
    // path for real, against a server that actually enforces "one live
    // key_enc row per org" the way CAP-379's does.
    const [a, b] = await Promise.all([onboarding.runPendingSync(deps), onboarding.runPendingSync(deps)]);

    const outcomes = [...a, ...b].filter((o) => o.orgId === org.id);
    // At least one racer must have completed the upload; a loser that found
    // the marker already cleared reports nothing for this org (empty array).
    expect(outcomes.some((o) => o.status === 'uploaded')).toBe(true);
    // No matter how the race resolved, the server invariant holds: exactly
    // one LIVE key_enc row for this org, never zero, never two.
    const liveKeyEncRows = fakeService.rows.filter((r) => r.type === 'key_enc' && !r.deleted_at && r.organization_id === org.id);
    expect(liveKeyEncRows.length).toBe(1);
    expect(gc.isKeyEncSyncPending(org.id, USER_ID)).toBe(false);
  });

  it('stale server copy vs disk copy: a sync makes the server catch up to the fresher local blob', async () => {
    const org = { id: 'org1', workos_org_id: 'wos_org1', name: 'Org One' };
    await keyResolver.wrapAndSaveMasterKey(randomBytes(32), org.id, USER_ID, kmsOps);
    fakeService.rows.push(liveDoor());

    // A STALE row already lives server-side — e.g. left by a machine that
    // enrolled first and never got this org's most current re-wrap.
    fakeService.rows.push({
      id: 'stale-row',
      type: 'key_enc',
      credential_id: null,
      kdf_version: 1,
      is_seed: false,
      verified_at: null,
      organization_id: org.id,
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
      deleted_at: null,
      mirror_state: 'diverged',
      key_enc: 'KMS1.STALE-BLOB-FROM-YESTERDAY',
    });

    const root = gc.readLocalRoot(org.id, USER_ID)!;
    gc.markKeyEncSyncPending(org.id, USER_ID, org.id, root);
    const deps = await buildDeps(fakeService, [org], org.id);

    const outcomes = await onboarding.runPendingSync(deps);
    expect(outcomes).toEqual([{ orgId: org.id, status: 'uploaded' }]);

    const stale = fakeService.rows.find((r) => r.id === 'stale-row')!;
    expect(stale.deleted_at).not.toBeNull(); // soft-deleted, not hard-deleted (CAP-379 contract)

    const live = fakeService.rows.find((r) => r.type === 'key_enc' && !r.deleted_at && r.organization_id === org.id)!;
    expect(live.key_enc).toBe(gc.readMasterKey(org.id, USER_ID)); // disk's copy won
    expect(live.key_enc).not.toBe('KMS1.STALE-BLOB-FROM-YESTERDAY');
  });

  it('canonical-identity marker (gate-2 fix): fails CLOSED when the recorded canonical root has since moved', async () => {
    const org1 = { id: 'org1', workos_org_id: 'wos_org1', name: 'Org One' };
    const org2 = { id: 'org2', workos_org_id: 'wos_org2', name: 'Org Two' };
    await keyResolver.wrapAndSaveMasterKey(randomBytes(32), org1.id, USER_ID, kmsOps);
    await keyResolver.wrapAndSaveMasterKey(randomBytes(32), org2.id, USER_ID, kmsOps);
    fakeService.rows.push(liveDoor());

    const originalOrg1Root = gc.readLocalRoot(org1.id, USER_ID)!;
    // org2's key.enc is recorded pending AGAINST org1's root as it was at mark-time.
    gc.markKeyEncSyncPending(org2.id, USER_ID, org1.id, originalOrg1Root);

    // org1's root then moves — e.g. a corrupt-root recovery re-minted it —
    // WITHOUT updating org2's already-recorded marker.
    gc.saveLocalRoot(org1.id, randomBytes(32), USER_ID);
    expect(gc.readLocalRoot(org1.id, USER_ID)!.equals(originalOrg1Root)).toBe(false);

    const deps = await buildDeps(fakeService, [org1, org2], org1.id);
    const outcomes = await onboarding.runPendingSync(deps);

    expect(outcomes).toEqual([{ orgId: org2.id, status: 'failed', code: ERROR_CODES.INVALID_FORMAT }]);
    // Fails closed: nothing uploaded, marker left in place for a human/ops to resolve, not silently mis-keyed.
    expect(fakeService.rows.some((r) => r.type === 'key_enc')).toBe(false);
    expect(gc.isKeyEncSyncPending(org2.id, USER_ID)).toBe(true);
  });
});

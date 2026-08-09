/**
 * CAP-382 wiring.ts — the command-facing helpers (attemptCaseAEnrollment,
 * attemptCaseCUnlock, runDeviceKeyEnrollment, runPendingSyncBestEffort) in
 * isolation from real network/crypto: `createDeviceKeyServiceOps` and
 * `BrokerCeremonyTransport` are replaced with in-memory fakes so this suite
 * tests wiring.ts's OWN dispatch/glue logic — the underlying engine
 * (onboarding.ts) is already exhaustively covered by
 * tests/auth/deviceKeyOnboarding.test.ts, and the real broker/envelope
 * protocol by tests/auth/deviceKey/brokerCeremonyTransport.test.ts.
 *
 * ISOLATED (mock.module + os.homedir swap): registered in run-tests.sh.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tempHome = mkdtempSync(join(tmpdir(), 'capy-devicekey-wiring-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

const USER = 'user_wiring1';
const ORG_A = 'org-a';
const ORG_B = 'org-b';

interface FakeCeremonyScript {
  enroll: { ok: true; credentialId: string; prfOutput: string; backupEligible: boolean; backupState: boolean } | { ok: false; code: string };
  unlock: { ok: true; credentialId: string; prfOutput: string } | { ok: false; code: string };
}

const ceremonyCalls: { enroll: number; unlock: number } = { enroll: 0, unlock: 0 };
let script: FakeCeremonyScript = {
  enroll: { ok: true, credentialId: 'cred-1', prfOutput: Buffer.alloc(32, 9).toString('base64'), backupEligible: true, backupState: true },
  unlock: { ok: true, credentialId: 'cred-1', prfOutput: Buffer.alloc(32, 9).toString('base64') },
};

class FakeCeremonyTransport {
  constructor(_opts: unknown) {}
  async requestEnrollment() {
    ceremonyCalls.enroll++;
    return script.enroll as any;
  }
  async requestUnlock() {
    ceremonyCalls.unlock++;
    return script.unlock as any;
  }
}
mock.module('../../../src/auth/deviceKey/brokerCeremonyTransport', () => ({
  BrokerCeremonyTransport: FakeCeremonyTransport,
}));

// In-memory wrapper "server" — mirrors deviceKeyOnboarding.test.ts's fake.
interface FakeWrapperRow {
  id: string;
  type: 'wrapped_k_local' | 'key_enc';
  credential_id?: string;
  organization_id?: string | null;
  deleted_at?: string | null;
  wrapped_k_local?: string;
  iv?: string;
  prf_salt?: string;
  key_enc?: string;
  kdf_version: number;
  is_seed: boolean;
  verified_at?: string | null;
  created_at: string;
  mirror_state: 'pending';
}

class FakeWrapperServer {
  rows: FakeWrapperRow[] = [];
  seq = 0;

  list() {
    return this.rows.filter((r) => !r.deleted_at);
  }
  fetch(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error('not found');
    return row;
  }
  uploadDoor(body: { wrapped_k_local: string; iv: string; prf_salt: string; credential_id: string; kdf_version: number }) {
    const row = {
      id: `door-${++this.seq}`,
      type: 'wrapped_k_local' as const,
      credential_id: body.credential_id,
      wrapped_k_local: body.wrapped_k_local,
      iv: body.iv,
      prf_salt: body.prf_salt,
      kdf_version: body.kdf_version,
      is_seed: this.rows.filter((r) => r.type === 'wrapped_k_local' && !r.deleted_at).length === 0,
      verified_at: null,
      created_at: new Date().toISOString(),
      mirror_state: 'pending' as const,
    };
    this.rows.push(row);
    return row;
  }
  verify(id: string) {
    const row = this.fetch(id);
    row.verified_at = new Date().toISOString();
    return row;
  }
  delete(id: string) {
    const row = this.fetch(id);
    row.deleted_at = new Date().toISOString();
    return row;
  }
  uploadKeyEnc(orgId: string, keyEnc: string) {
    const row = {
      id: `keyenc-${++this.seq}`,
      type: 'key_enc' as const,
      organization_id: orgId,
      key_enc: keyEnc,
      kdf_version: 1,
      is_seed: false,
      verified_at: null,
      created_at: new Date().toISOString(),
      mirror_state: 'pending' as const,
    };
    this.rows.push(row);
    return row;
  }
}

let server: FakeWrapperServer;
mock.module('../../../src/auth/deviceKey/serviceOps', () => ({
  createDeviceKeyServiceOps: mock(() => ({
    ops: {
      listWrappers: async () => server.list(),
      fetchWrapper: async (id: string) => server.fetch(id),
      uploadDoorWrapper: async (body: any) => server.uploadDoor(body),
      verifyWrapper: async (id: string) => server.verify(id),
      deleteWrapper: async (id: string) => server.delete(id),
    },
    opsForOrg: async (orgId: string) => ({
      coDecrypt: async (_oid: string, ct: string) => ct,
      wrapOuterLayer: async (_oid: string, pt: string) => `kms:${pt}`,
      uploadKeyEnc: async (keyEnc: string) => server.uploadKeyEnc(orgId, keyEnc),
      fetchKeyEnc: async (wrapperId: string) => {
        const row = server.fetch(wrapperId);
        return row.key_enc!;
      },
    }),
  })),
}));

// maybeNudgeDeviceKeyEnrollment (final-gate MAJOR-5) — declinable confirm.
let interactive = true;
mock.module('../../../src/ui/interactive', () => ({
  isInteractive: mock(() => interactive),
}));

let confirmAnswer = true;
let promptShouldThrow = false;
const promptCalls: unknown[] = [];
mock.module('inquirer', () => ({
  default: {
    prompt: mock(async (questions: any) => {
      promptCalls.push(questions);
      if (promptShouldThrow) throw new Error('terminal went away mid-prompt');
      const q = Array.isArray(questions) ? questions[0] : questions;
      if (q.name === 'confirmed') return { confirmed: confirmAnswer };
      throw new Error(`unexpected prompt: ${q.name}`);
    }),
  },
}));

afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

let wiring: typeof import('../../../src/auth/deviceKey/wiring');
let globalConfig: typeof import('../../../src/config/globalConfig');

beforeAll(async () => {
  wiring = await import('../../../src/auth/deviceKey/wiring');
  globalConfig = await import('../../../src/config/globalConfig');
});

beforeEach(() => {
  server = new FakeWrapperServer();
  ceremonyCalls.enroll = 0;
  ceremonyCalls.unlock = 0;
  script = {
    enroll: { ok: true, credentialId: 'cred-1', prfOutput: Buffer.alloc(32, 9).toString('base64'), backupEligible: true, backupState: true },
    unlock: { ok: true, credentialId: 'cred-1', prfOutput: Buffer.alloc(32, 9).toString('base64') },
  };
  rmSync(join(tempHome, '.capy'), { recursive: true, force: true });
  interactive = true;
  confirmAnswer = true;
  promptShouldThrow = false;
  promptCalls.length = 0;
});

function ctx(overrides: Partial<import('../../../src/auth/deviceKey/wiring').DeviceKeyWiringContext> = {}) {
  return {
    authService: { getValidToken: async () => ({ access_token: 'org-token' }) } as any,
    serviceClient: {} as any,
    devMode: true,
    userId: USER,
    userEmail: 'u@example.com',
    organizations: [{ id: ORG_A, workos_org_id: 'wo-a', name: 'Org A' }],
    activeOrgId: ORG_A,
    ...overrides,
  };
}

describe('attemptCaseAEnrollment', () => {
  test('no org-less token captured → the ceremony is never touched (flag-off / no-token byte-identity)', async () => {
    await wiring.attemptCaseAEnrollment({
      ctx: ctx(),
      orgId: ORG_A,
      orgName: 'Org A',
      masterKey: Buffer.alloc(32, 1),
      orglessToken: undefined,
    });
    expect(ceremonyCalls.enroll).toBe(0);
    expect(server.rows.length).toBe(0);
  });

  test('with an org-less token and a successful ceremony, enrolls a door and syncs key.enc for the org', async () => {
    await wiring.attemptCaseAEnrollment({
      ctx: ctx(),
      orgId: ORG_A,
      orgName: 'Org A',
      masterKey: Buffer.alloc(32, 1),
      orglessToken: 'org-less-token',
    });
    expect(ceremonyCalls.enroll).toBe(1);
    const door = server.rows.find((r) => r.type === 'wrapped_k_local');
    expect(door).toBeDefined();
    expect(door!.verified_at).not.toBeNull();
    const keyEnc = server.rows.find((r) => r.type === 'key_enc' && r.organization_id === ORG_A);
    expect(keyEnc).toBeDefined();
  });

  test('a declined ceremony never throws and never uploads a door', async () => {
    script.enroll = { ok: false, code: 'cancelled' };
    await expect(
      wiring.attemptCaseAEnrollment({
        ctx: ctx(),
        orgId: ORG_A,
        orgName: 'Org A',
        masterKey: Buffer.alloc(32, 1),
        orglessToken: 'org-less-token',
      }),
    ).resolves.toBeUndefined();
    expect(server.rows.find((r) => r.type === 'wrapped_k_local')).toBeUndefined();
  });
});

describe('attemptCaseCUnlock', () => {
  test('no live doors → detection is not "unlock", the ceremony is never touched', async () => {
    const result = await wiring.attemptCaseCUnlock(ctx());
    expect(result).toEqual({ ok: false, installedCurrentOrg: false });
    expect(ceremonyCalls.unlock).toBe(0);
  });

  test('a live door exists and the ceremony succeeds → installs the current org', async () => {
    server.uploadDoor({ wrapped_k_local: 'w', iv: 'i', prf_salt: Buffer.alloc(32, 1).toString('base64'), credential_id: 'cred-1', kdf_version: 1 });
    // Give the fake door a fetch-able payload shape the engine needs.
    const door = server.rows.find((r) => r.type === 'wrapped_k_local')!;
    const { deriveDeviceKeyKek, deviceKeyWrapAAD, wrapKLocal } = await import('../../../src/auth/deviceKey/crypto');
    const prfOutput = Buffer.from((script.unlock as any).prfOutput, 'base64');
    const kek = deriveDeviceKeyKek(prfOutput, Buffer.alloc(32, 1));
    const wrapped = wrapKLocal(Buffer.alloc(32, 7), kek, deviceKeyWrapAAD(USER, 'cred-1'));
    door.wrapped_k_local = wrapped.wrappedKLocal;
    door.iv = wrapped.iv;
    door.prf_salt = Buffer.alloc(32, 1).toString('base64');

    server.uploadKeyEnc(ORG_A, 'kms:inner');

    const result = await wiring.attemptCaseCUnlock(ctx());
    expect(ceremonyCalls.unlock).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.installedCurrentOrg).toBe(true);
  });
});

describe('runDeviceKeyEnrollment', () => {
  test('brand_new (no orgs, no local root, no live doors) → not_ready', async () => {
    const outcome = await wiring.runDeviceKeyEnrollment(ctx({ organizations: [], activeOrgId: null }));
    expect(outcome).toEqual({ kind: 'not_ready', verdictKind: 'brand_new' });
    expect(ceremonyCalls.enroll).toBe(0);
  });

  test('a live door already enrolled → already_enrolled, no new ceremony', async () => {
    server.uploadDoor({ wrapped_k_local: 'w', iv: 'i', prf_salt: 's', credential_id: 'cred-1', kdf_version: 1 });
    const outcome = await wiring.runDeviceKeyEnrollment(ctx());
    expect(outcome).toEqual({ kind: 'already_enrolled' });
    expect(ceremonyCalls.enroll).toBe(0);
  });

  test('local root present, no live doors, ceremony succeeds → enrolled', async () => {
    globalConfig.saveLocalRoot(ORG_A, Buffer.alloc(32, 3), USER);
    const outcome = await wiring.runDeviceKeyEnrollment(ctx());
    expect(outcome.kind).toBe('enrolled');
    expect(ceremonyCalls.enroll).toBe(1);
  });

  test('local root present, ceremony declines → declined, carries the ceremony code', async () => {
    globalConfig.saveLocalRoot(ORG_A, Buffer.alloc(32, 3), USER);
    script.enroll = { ok: false, code: 'prf_unsupported' };
    const outcome = await wiring.runDeviceKeyEnrollment(ctx());
    expect(outcome).toEqual({ kind: 'declined', ceremonyCode: 'prf_unsupported' });
  });
});

describe('runPendingSyncBestEffort', () => {
  test('no pending markers → no-op, never throws', async () => {
    await expect(wiring.runPendingSyncBestEffort(ctx())).resolves.toBeUndefined();
  });
});

describe('syncOrgOntoDeviceKeyIfEnrolled (the CAP-380 "org joined after enrollment" gap)', () => {
  test('nothing enrolled anywhere → not alreadyEnrolled, no ceremony, no marker set', async () => {
    const result = await wiring.syncOrgOntoDeviceKeyIfEnrolled(ctx(), ORG_A);
    expect(result).toEqual({ alreadyEnrolled: false, synced: false });
    expect(ceremonyCalls.unlock).toBe(0);
  });

  test('already enrolled elsewhere, but this machine holds no canonical root yet → alreadyEnrolled true, synced false', async () => {
    server.uploadDoor({ wrapped_k_local: 'w', iv: 'i', prf_salt: 's', credential_id: 'cred-1', kdf_version: 1 });
    const result = await wiring.syncOrgOntoDeviceKeyIfEnrolled(ctx(), ORG_A);
    expect(result).toEqual({ alreadyEnrolled: true, synced: false });
  });

  test('already enrolled + a canonical root already known on this machine (another org) → the newly-joined org is unified onto it', async () => {
    server.uploadDoor({ wrapped_k_local: 'w', iv: 'i', prf_salt: 's', credential_id: 'cred-1', kdf_version: 1 });
    const canonicalRoot = Buffer.alloc(32, 5);
    globalConfig.saveLocalRoot(ORG_B, canonicalRoot, USER);
    // ORG_A already happens to share the same root and already has a local
    // key.enc — the simple "upload unchanged" path, no re-key needed.
    globalConfig.saveLocalRoot(ORG_A, canonicalRoot, USER);
    globalConfig.saveMasterKey(ORG_A, 'kms:already-wrapped', USER);

    const orgs = [
      { id: ORG_A, workos_org_id: 'wo-a', name: 'Org A' },
      { id: ORG_B, workos_org_id: 'wo-b', name: 'Org B' },
    ];
    const result = await wiring.syncOrgOntoDeviceKeyIfEnrolled(ctx({ activeOrgId: ORG_A, organizations: orgs }), ORG_A);
    expect(result).toEqual({ alreadyEnrolled: true, synced: true });

    const keyEncRow = server.rows.find((r) => r.type === 'key_enc' && r.organization_id === ORG_A);
    expect(keyEncRow).toBeDefined();
    expect(keyEncRow!.key_enc).toBe('kms:already-wrapped');
  });
});

describe('maybeNudgeDeviceKeyEnrollment (final-gate MAJOR-5 — the ordinary-flow on-ramp)', () => {
  test('non-interactive (CI/agent/--web) — no prompt, no ceremony, nothing persisted', async () => {
    interactive = false;
    globalConfig.saveLocalRoot(ORG_A, Buffer.alloc(32, 3), USER);
    await wiring.maybeNudgeDeviceKeyEnrollment(ctx(), 'Org A');
    expect(promptCalls).toHaveLength(0);
    expect(ceremonyCalls.enroll).toBe(0);
    expect(globalConfig.hasDeclinedDeviceKeyNudge()).toBe(false);
  });

  test('already declined once — no prompt, never asks twice', async () => {
    globalConfig.saveLocalRoot(ORG_A, Buffer.alloc(32, 3), USER);
    globalConfig.setDeviceKeyNudgeDeclined();
    await wiring.maybeNudgeDeviceKeyEnrollment(ctx(), 'Org A');
    expect(promptCalls).toHaveLength(0);
    expect(ceremonyCalls.enroll).toBe(0);
  });

  test('not eligible — a live door already exists (Case C territory, not B) — no prompt', async () => {
    server.uploadDoor({ wrapped_k_local: 'w', iv: 'i', prf_salt: 's', credential_id: 'cred-1', kdf_version: 1 });
    await wiring.maybeNudgeDeviceKeyEnrollment(ctx(), 'Org A');
    expect(promptCalls).toHaveLength(0);
    expect(ceremonyCalls.enroll).toBe(0);
  });

  test('not eligible — no local root and orgs exist (recovery_or_transport) — no prompt', async () => {
    await wiring.maybeNudgeDeviceKeyEnrollment(ctx(), 'Org A');
    expect(promptCalls).toHaveLength(0);
  });

  test('not eligible — brand new (no orgs, no local root) — no prompt', async () => {
    await wiring.maybeNudgeDeviceKeyEnrollment(ctx({ organizations: [], activeOrgId: null }), 'Org A');
    expect(promptCalls).toHaveLength(0);
  });

  test('eligible (local root, zero live doors) + declines the offer — persists the marker, never enrolls', async () => {
    globalConfig.saveLocalRoot(ORG_A, Buffer.alloc(32, 3), USER);
    confirmAnswer = false;
    await wiring.maybeNudgeDeviceKeyEnrollment(ctx(), 'Org A');
    expect(promptCalls).toHaveLength(1);
    expect(ceremonyCalls.enroll).toBe(0);
    expect(globalConfig.hasDeclinedDeviceKeyNudge()).toBe(true);
  });

  test('eligible + accepts + ceremony succeeds — enrolls, marker is NOT set (nothing was declined)', async () => {
    globalConfig.saveLocalRoot(ORG_A, Buffer.alloc(32, 3), USER);
    confirmAnswer = true;
    await wiring.maybeNudgeDeviceKeyEnrollment(ctx(), 'Org A');
    expect(ceremonyCalls.enroll).toBe(1);
    expect(globalConfig.hasDeclinedDeviceKeyNudge()).toBe(false);
    const door = server.rows.find((r) => r.type === 'wrapped_k_local');
    expect(door).toBeDefined();
  });

  test('eligible + accepts + the ceremony itself is declined (e.g. cancelled) — persists the marker', async () => {
    globalConfig.saveLocalRoot(ORG_A, Buffer.alloc(32, 3), USER);
    confirmAnswer = true;
    script.enroll = { ok: false, code: 'cancelled' };
    await wiring.maybeNudgeDeviceKeyEnrollment(ctx(), 'Org A');
    expect(globalConfig.hasDeclinedDeviceKeyNudge()).toBe(true);
  });

  test('never throws — a prompt-layer blowup (e.g. terminal went away) degrades to a no-op', async () => {
    globalConfig.saveLocalRoot(ORG_A, Buffer.alloc(32, 3), USER);
    promptShouldThrow = true;
    await expect(wiring.maybeNudgeDeviceKeyEnrollment(ctx(), 'Org A')).resolves.toBeUndefined();
    expect(ceremonyCalls.enroll).toBe(0);
    expect(globalConfig.hasDeclinedDeviceKeyNudge()).toBe(false);
  });
});

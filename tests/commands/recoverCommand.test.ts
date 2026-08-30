import { mock, describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Per-suite isolated HOME ───────────────────────────────────────────────────
const tempHome = mkdtempSync(join(tmpdir(), 'capy-recover-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

// ── Inquirer answers — mutated per test ───────────────────────────────────────
let answers: Record<string, any> = {};
mock.module('inquirer', () => ({
  default: {
    prompt: mock(async (q: any) => {
      const arr = Array.isArray(q) ? q : [q];
      const out: Record<string, any> = {};
      for (const item of arr) {
        if (!(item.name in answers)) {
          throw new Error(`unexpected prompt: ${item.name}`);
        }
        out[item.name] = answers[item.name];
      }
      return out;
    }),
  },
}));

// ── Stub AuthService and ServiceClient so we don't authenticate over the
//    network. The user has memberships for THREE orgs — Demos, Vincent, Capy —
//    mirroring the real bug Vince hit where the wrong one was auto-picked. ──
const FAKE_USER_ID = 'user_01RECOVER';
const ORG_DEMOS = 'org-uuid-demos';
const ORG_VINCENT = 'org-uuid-vincent';
const ORG_CAPY = 'org-uuid-capy';
const FAKE_ORGS = [
  { id: ORG_DEMOS, workos_org_id: 'workos-demos', name: 'Demos' },
  { id: ORG_VINCENT, workos_org_id: 'workos-vincent', name: 'Vincent' },
  { id: ORG_CAPY, workos_org_id: 'workos-capy', name: 'Capy' },
];

const authCalls: Array<{ method: string; orgId?: string }> = [];
mock.module('../../src/auth/authService', () => ({
  AuthService: class FakeAuthService {
    constructor(_apiUrl?: string, _devMode?: boolean, _userId?: string) {}
    async authenticateSilent(orgId?: string) {
      authCalls.push({ method: 'authenticateSilent', orgId });
      return {
        success: true,
        user_id: FAKE_USER_ID,
        user_email: 'vince@capy.sc',
        organizations: FAKE_ORGS,
        organization_id: orgId,
      };
    }
    async authenticate(orgId?: string) {
      authCalls.push({ method: 'authenticate', orgId });
      return { success: true, user_id: FAKE_USER_ID, user_email: 'vince@capy.sc', organizations: FAKE_ORGS, organization_id: orgId };
    }
    getValidToken() { return Promise.resolve('fake-token'); }
    getToken() { return 'fake-token'; }
  },
}));

// CAP-382: staleDoors + deleteWrapper bookkeeping for the re-enroll-after-
// recovery cleanup. Empty by default — most tests never touch device keys.
let listWrappersResult: Array<{ id: string; type: string; deleted_at: string | null }> = [];
const deleteWrapperCalls: string[] = [];
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class FakeServiceClient {
    constructor(_apiUrl?: string) {}
    setTokenProvider(_fn: any) {}
    coDecrypt(_oid: string, _ct: string) { return Promise.resolve({ plaintext: 'unused' }); }
    wrapOuterLayer(_oid: string, pt: string) { return Promise.resolve({ ciphertext: 'kms-wrapped:' + pt }); }
    listWrappers(_includeDeleted?: boolean) { return Promise.resolve(listWrappersResult); }
    deleteWrapper(id: string) {
      deleteWrapperCalls.push(id);
      return Promise.resolve({ id });
    }
  },
}));

let interactive = true;
mock.module('../../src/ui/interactive', () => ({
  isInteractive: mock(() => interactive),
}));

// `capy recover --web` (final-gate failure-signal #5). A faithful-enough
// fake of the real reducer in ui/recoveryScreens.ts: it actually calls the
// `ops` the command wires up (scopeToOrg, writeKey) rather than short-
// circuiting past them, because recoverCommand's own hadLocalRootBeforeWrite
// capture lives INSIDE that writeKey closure — a mock that never called it
// would prove nothing about whether the capture still runs under --web.
let webOrgId = ORG_DEMOS;
let webPhraseFn: () => string = () => '';
let webCancelled = false;
mock.module('../../src/ui/recoveryScreens', () => ({
  recoverInBrowser: mock(async (p: any) => {
    if (webCancelled) {
      return { orgId: '', orgName: '', kdfVersion: null, keyPath: null, cancelled: true };
    }
    const orgId = webOrgId;
    await p.ops.scopeToOrg(orgId);
    const outcome = await p.ops.writeKey(orgId, webPhraseFn());
    return {
      orgId,
      orgName: p.orgs.find((o: any) => o.id === orgId)?.name ?? '',
      kdfVersion: null,
      keyPath: outcome.ok ? outcome.keyPath : null,
      cancelled: false,
    };
  }),
}));

let enrollmentOutcome: unknown = { kind: 'enrolled', result: { ok: true, credentialId: 'c1', wrapperId: 'w1', verified: true, backupEligible: true, backupState: true, orgs: [] } };
const runDeviceKeyEnrollmentCalls: unknown[] = [];
const reportedOutcomes: unknown[] = [];
mock.module('../../src/auth/deviceKey/wiring', () => ({
  runDeviceKeyEnrollment: mock(async (ctx: unknown) => {
    runDeviceKeyEnrollmentCalls.push(ctx);
    return enrollmentOutcome;
  }),
  reportEnrollmentOutcome: mock((result: unknown, orgName: string) => {
    reportedOutcomes.push({ result, orgName });
  }),
}));

// ProjectManager — return a state with a keep.lock pointing at ORG_VINCENT
// (a DIFFERENT org than the seed phrase's). The recover command must NOT
// pick this up — it must always prompt.
mock.module('../../src/core/projectManager', () => ({
  ProjectManager: class FakeProjectManager {
    async detectProjectState() {
      return {
        initialized: true,
        organizationId: ORG_VINCENT, // ← intentionally wrong org from keep.lock
        userId: FAKE_USER_ID,
        projectId: 'proj-vincent',
        projectName: 'vincent-app',
        activeBranch: 'main',
      };
    }
  },
}));

// ── Capture wrapAndSaveMasterKey calls ─────────────────────────────────────
const wrapCalls: Array<{ orgId: string; userId: string; m: Buffer }> = [];
mock.module('../../src/crypto/keyResolver', () => ({
  // This fake ServiceClient has no listProjects, so findOrgCiphertextOracle
  // finds no oracle and recover falls back to CURRENT_KDF_VERSION — the trial
  // resolver is never reached here (its behavior is covered by
  // kdfMigration.test.ts and recoverKdf.test.ts). The export must still exist
  // to satisfy the static import binding in recoverCommand.
  resolveProjectKeyByTrial: mock(() => null),
  hasOrgKey: mock((orgId: string, userId: string) => {
    return existsSync(join(tempHome, '.capy', 'orgs', orgId, 'users', userId, 'key.enc'));
  }),
  wrapAndSaveMasterKey: mock(async (m: Buffer, orgId: string, userId: string) => {
    wrapCalls.push({ orgId, userId, m: Buffer.from(m) });
    const path = join(tempHome, '.capy', 'orgs', orgId, 'users', userId);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'key.enc'), JSON.stringify({
      version: '1.0', org_id: orgId, encrypted_master_key: 'kms-wrapped:fake',
    }));
  }),
}));

// process.exit shim — record the code, throw to abort the command flow.
class ExitError extends Error { constructor(public code: number) { super(`exit:${code}`); } }
const originalExit = process.exit;
(process as any).exit = (code?: number) => { throw new ExitError(code ?? 0); };

afterAll(() => {
  mock.restore();
  (process as any).exit = originalExit;
  rmSync(tempHome, { recursive: true, force: true });
});

let RecoverCommand: any;
let generateSeedPhrase: any;
let seedPhraseToMasterKey: any;
let saveLocalRoot: any;

const ORIGINAL_DEVICE_KEYS_FLAG = process.env.CAPY_DEVICE_KEYS;

beforeAll(async () => {
  ({ RecoverCommand } = await import('../../src/commands/recoverCommand'));
  const km = await import('../../src/crypto/keyManager');
  generateSeedPhrase = km.generateSeedPhrase;
  seedPhraseToMasterKey = km.seedPhraseToMasterKey;
  const gc = await import('../../src/config/globalConfig');
  saveLocalRoot = gc.saveLocalRoot;
});

beforeEach(() => {
  wrapCalls.length = 0;
  authCalls.length = 0;
  answers = {};
  listWrappersResult = [];
  deleteWrapperCalls.length = 0;
  runDeviceKeyEnrollmentCalls.length = 0;
  reportedOutcomes.length = 0;
  interactive = true;
  enrollmentOutcome = { kind: 'enrolled', result: { ok: true, credentialId: 'c1', wrapperId: 'w1', verified: true, backupEligible: true, backupState: true, orgs: [] } };
  delete process.env.CAPY_DEVICE_KEYS;
  webOrgId = ORG_DEMOS;
  webPhraseFn = () => '';
  webCancelled = false;
  rmSync(join(tempHome, '.capy'), { recursive: true, force: true });
});

afterEach(() => {
  if (ORIGINAL_DEVICE_KEYS_FLAG === undefined) delete process.env.CAPY_DEVICE_KEYS;
  else process.env.CAPY_DEVICE_KEYS = ORIGINAL_DEVICE_KEYS_FLAG;
});

describe('RecoverCommand', () => {
  test('always prompts for org selection — does NOT inherit keep.lock org', async () => {
    // The mocked ProjectManager returns keep.lock pointing at ORG_VINCENT,
    // but the user picks ORG_DEMOS in the prompt. The wrap must land on Demos.
    const phrase = generateSeedPhrase();
    answers = { orgId: ORG_DEMOS, seedPhrase: phrase, confirmed: false };

    const cmd = new RecoverCommand();
    await cmd.execute();

    expect(wrapCalls).toHaveLength(1);
    expect(wrapCalls[0].orgId).toBe(ORG_DEMOS); // ← the picked org, NOT ORG_VINCENT
  });

  test('valid seed phrase → wrapAndSaveMasterKey called with M derived from the phrase', async () => {
    const phrase = generateSeedPhrase();
    const expectedM = seedPhraseToMasterKey(phrase);
    answers = { orgId: ORG_DEMOS, seedPhrase: phrase, confirmed: false };

    const cmd = new RecoverCommand();
    await cmd.execute();

    expect(wrapCalls).toHaveLength(1);
    expect(wrapCalls[0].userId).toBe(FAKE_USER_ID);
    expect(wrapCalls[0].m.equals(expectedM)).toBe(true);
  });

  test('re-scopes the auth session to the chosen org before wrapping', async () => {
    // The KMS wrap-outer endpoint is org-scoped: the access token must be
    // for the same org we're wrapping for, or the server 403s. Recover MUST
    // re-call authenticateSilent(orgId) after the picker.
    const phrase = generateSeedPhrase();
    answers = { orgId: ORG_CAPY, seedPhrase: phrase, confirmed: false };

    const cmd = new RecoverCommand();
    await cmd.execute();

    const scopedAuth = authCalls.find(c => c.method === 'authenticateSilent' && c.orgId === ORG_CAPY);
    expect(scopedAuth).toBeDefined();
  });

  test('invalid phrase (wrong word count) is rejected before any wrap call', async () => {
    answers = { orgId: ORG_DEMOS, seedPhrase: 'just three words' };

    const cmd = new RecoverCommand();
    await expect(cmd.execute()).rejects.toBeInstanceOf(ExitError);
    expect(wrapCalls).toHaveLength(0);
  });

  test('invalid phrase (non-BIP39 word) is rejected', async () => {
    const bad = ('abandon '.repeat(23) + 'notaword').trim();
    answers = { orgId: ORG_DEMOS, seedPhrase: bad };

    const cmd = new RecoverCommand();
    await expect(cmd.execute()).rejects.toBeInstanceOf(ExitError);
    expect(wrapCalls).toHaveLength(0);
  });

  test('invalid phrase (bad checksum) is rejected', async () => {
    const badChecksum = 'abandon '.repeat(23).trim() + ' abandon';
    answers = { orgId: ORG_DEMOS, seedPhrase: badChecksum };

    const cmd = new RecoverCommand();
    await expect(cmd.execute()).rejects.toBeInstanceOf(ExitError);
    expect(wrapCalls).toHaveLength(0);
  });

  test('empty input is rejected', async () => {
    answers = { orgId: ORG_DEMOS, seedPhrase: '' };
    const cmd = new RecoverCommand();
    await expect(cmd.execute()).rejects.toBeInstanceOf(ExitError);
    expect(wrapCalls).toHaveLength(0);
  });

  test('existing key.enc + user declines overwrite → no wrap', async () => {
    const dir = join(tempHome, '.capy', 'orgs', ORG_DEMOS, 'users', FAKE_USER_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'key.enc'), 'pre-existing');

    const phrase = generateSeedPhrase();
    answers = { orgId: ORG_DEMOS, proceed: false, seedPhrase: phrase };

    const cmd = new RecoverCommand();
    await cmd.execute();

    expect(wrapCalls).toHaveLength(0);
  });

  test('existing key.enc + user confirms overwrite → wrap proceeds', async () => {
    const dir = join(tempHome, '.capy', 'orgs', ORG_DEMOS, 'users', FAKE_USER_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'key.enc'), 'pre-existing');

    const phrase = generateSeedPhrase();
    answers = { orgId: ORG_DEMOS, proceed: true, seedPhrase: phrase, confirmed: false };

    const cmd = new RecoverCommand();
    await cmd.execute();

    expect(wrapCalls).toHaveLength(1);
    expect(wrapCalls[0].orgId).toBe(ORG_DEMOS);
    expect(wrapCalls[0].m.equals(seedPhraseToMasterKey(phrase))).toBe(true);
  });

  test('overwrite gate is ONLY triggered for the picked org, not the keep.lock org', async () => {
    // Pre-populate a key.enc for ORG_VINCENT (the keep.lock org). The user
    // picks ORG_DEMOS. The overwrite confirmation should NOT fire.
    const dir = join(tempHome, '.capy', 'orgs', ORG_VINCENT, 'users', FAKE_USER_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'key.enc'), 'vincent-pre-existing');

    const phrase = generateSeedPhrase();
    // No `proceed` answer — if the gate fires, prompt() throws "unexpected prompt".
    answers = { orgId: ORG_DEMOS, seedPhrase: phrase, confirmed: false };

    const cmd = new RecoverCommand();
    await cmd.execute();

    expect(wrapCalls).toHaveLength(1);
    expect(wrapCalls[0].orgId).toBe(ORG_DEMOS);
    // Vincent's key.enc untouched.
    expect(existsSync(join(dir, 'key.enc'))).toBe(true);
  });

  test('two distinct seed phrases derive distinct Ms (sanity)', () => {
    const a = generateSeedPhrase();
    let b = generateSeedPhrase();
    while (b === a) b = generateSeedPhrase();
    expect(seedPhraseToMasterKey(a).equals(seedPhraseToMasterKey(b))).toBe(false);
  });

  describe('CAP-382 re-enroll-after-recovery nudge', () => {
    test('rail always on — the nudge prompts even with the legacy env flag unset; declining leaves no residue', async () => {
      // Permanently ON as of onboarding v2 — the env var is no longer
      // consulted (src/auth/deviceKey/flag.ts).
      const phrase = generateSeedPhrase();
      answers = { orgId: ORG_DEMOS, seedPhrase: phrase, confirmed: false };

      const cmd = new RecoverCommand();
      await cmd.execute();

      expect(runDeviceKeyEnrollmentCalls).toHaveLength(0);
      expect(deleteWrapperCalls).toHaveLength(0);
    });

    test('flag on, non-interactive — no prompt (no hang in CI/agents)', async () => {
      process.env.CAPY_DEVICE_KEYS = '1';
      interactive = false;
      const phrase = generateSeedPhrase();
      answers = { orgId: ORG_DEMOS, seedPhrase: phrase };

      const cmd = new RecoverCommand();
      await cmd.execute();

      expect(runDeviceKeyEnrollmentCalls).toHaveLength(0);
    });

    test('flag on, interactive, declines — no enrollment attempted, no wrapper touched', async () => {
      process.env.CAPY_DEVICE_KEYS = '1';
      const phrase = generateSeedPhrase();
      answers = { orgId: ORG_DEMOS, seedPhrase: phrase, confirmed: false };

      const cmd = new RecoverCommand();
      await cmd.execute();

      expect(runDeviceKeyEnrollmentCalls).toHaveLength(0);
      expect(deleteWrapperCalls).toHaveLength(0);
    });

    test('no local.key existed before recovery (fresh mint) + a live stale door + accept + enrollment succeeds → the stale door is soft-deleted AFTER the new one enrolls', async () => {
      process.env.CAPY_DEVICE_KEYS = '1';
      listWrappersResult = [{ id: 'stale-door-1', type: 'wrapped_k_local', deleted_at: null }];
      enrollmentOutcome = { kind: 'enrolled', result: { ok: true, credentialId: 'new-cred', wrapperId: 'new-wrapper', verified: true, backupEligible: true, backupState: true, orgs: [] } };
      const phrase = generateSeedPhrase();
      answers = { orgId: ORG_DEMOS, seedPhrase: phrase, confirmed: true };

      const cmd = new RecoverCommand();
      await cmd.execute();

      expect(runDeviceKeyEnrollmentCalls).toHaveLength(1);
      expect(reportedOutcomes).toHaveLength(1);
      expect(deleteWrapperCalls).toEqual(['stale-door-1']);
    });

    test('a declined re-enrollment ceremony leaves stale doors untouched', async () => {
      process.env.CAPY_DEVICE_KEYS = '1';
      listWrappersResult = [{ id: 'stale-door-2', type: 'wrapped_k_local', deleted_at: null }];
      enrollmentOutcome = { kind: 'declined', ceremonyCode: 'cancelled' };
      const phrase = generateSeedPhrase();
      answers = { orgId: ORG_DEMOS, seedPhrase: phrase, confirmed: true };

      const cmd = new RecoverCommand();
      await cmd.execute();

      expect(runDeviceKeyEnrollmentCalls).toHaveLength(1);
      expect(deleteWrapperCalls).toHaveLength(0);
    });

    test('local.key ALREADY existed before recovery (overwrite branch) — existing doors are never touched, even on accept', async () => {
      process.env.CAPY_DEVICE_KEYS = '1';
      // Pre-seed a root for ORG_DEMOS so hadLocalRootBefore is true — the
      // root is UNCHANGED by this recovery, so any existing door remains
      // valid and must not be caught up in the stale-door cleanup.
      saveLocalRoot(ORG_DEMOS, Buffer.alloc(32, 4), FAKE_USER_ID);
      listWrappersResult = [{ id: 'still-valid-door', type: 'wrapped_k_local', deleted_at: null }];
      const phrase = generateSeedPhrase();
      // Overwrite gate fires because key.enc doesn't exist for the mocked
      // hasOrgKey (keyed on key.enc, not local.key) — no `proceed` needed
      // since no key.enc was pre-created here.
      answers = { orgId: ORG_DEMOS, seedPhrase: phrase, confirmed: true };

      const cmd = new RecoverCommand();
      await cmd.execute();

      expect(runDeviceKeyEnrollmentCalls).toHaveLength(1);
      // No stale doors were ever computed for a machine that already had a
      // root — the existing door survives untouched.
      expect(deleteWrapperCalls).toHaveLength(0);
    });
  });

  describe('final-gate failure-signal #5 — `capy recover --web` reaches the same post-recovery nudge', () => {
    test('rail always on: --web reaches the nudge even with the legacy env flag unset; declining changes nothing else', async () => {
      // Permanently ON as of onboarding v2 — the env var is no longer
      // consulted (src/auth/deviceKey/flag.ts).
      webOrgId = ORG_DEMOS;
      webPhraseFn = () => generateSeedPhrase();
      answers = { confirmed: false };

      const cmd = new RecoverCommand();
      await cmd.execute({ web: true });

      expect(wrapCalls).toHaveLength(1);
      expect(wrapCalls[0].orgId).toBe(ORG_DEMOS);
      expect(runDeviceKeyEnrollmentCalls).toHaveLength(0);
    });

    test('flag on, non-interactive: --web reaches the nudge code path, but isInteractive() still no-ops it (no hang)', async () => {
      process.env.CAPY_DEVICE_KEYS = '1';
      interactive = false;
      webOrgId = ORG_CAPY;
      webPhraseFn = () => generateSeedPhrase();

      const cmd = new RecoverCommand();
      await cmd.execute({ web: true });

      expect(wrapCalls).toHaveLength(1);
      expect(runDeviceKeyEnrollmentCalls).toHaveLength(0);
    });

    test('flag on, interactive, accepts: --web now runs the SAME re-enrollment ceremony the terminal path runs, for the org actually recovered', async () => {
      process.env.CAPY_DEVICE_KEYS = '1';
      interactive = true;
      answers = { confirmed: true }; // the nudge's own confirm prompt
      webOrgId = ORG_VINCENT;
      webPhraseFn = () => generateSeedPhrase();

      const cmd = new RecoverCommand();
      await cmd.execute({ web: true });

      expect(wrapCalls).toHaveLength(1);
      expect(wrapCalls[0].orgId).toBe(ORG_VINCENT);
      expect(runDeviceKeyEnrollmentCalls).toHaveLength(1);
      expect(reportedOutcomes).toHaveLength(1);
      // The ctx handed to the enrollment engine must be scoped to the org
      // that was ACTUALLY recovered in the browser, not some other org.
      expect((runDeviceKeyEnrollmentCalls[0] as any).activeOrgId).toBe(ORG_VINCENT);
    });

    test('flag on, interactive, declines the nudge: no ceremony, key is still written', async () => {
      process.env.CAPY_DEVICE_KEYS = '1';
      interactive = true;
      answers = { confirmed: false };
      webOrgId = ORG_DEMOS;
      webPhraseFn = () => generateSeedPhrase();

      const cmd = new RecoverCommand();
      await cmd.execute({ web: true });

      expect(wrapCalls).toHaveLength(1);
      expect(runDeviceKeyEnrollmentCalls).toHaveLength(0);
    });

    test('a cancelled --web flow (no key written) never reaches the nudge', async () => {
      process.env.CAPY_DEVICE_KEYS = '1';
      interactive = true;
      webCancelled = true;

      const cmd = new RecoverCommand();
      await cmd.execute({ web: true });

      expect(wrapCalls).toHaveLength(0);
      expect(runDeviceKeyEnrollmentCalls).toHaveLength(0);
    });

    test('local.key already existed before this --web recovery (overwrite branch) — hadLocalRootBeforeWrite is still captured correctly under --web', async () => {
      process.env.CAPY_DEVICE_KEYS = '1';
      interactive = true;
      answers = { confirmed: true };
      saveLocalRoot(ORG_DEMOS, Buffer.alloc(32, 4), FAKE_USER_ID);
      listWrappersResult = [{ id: 'still-valid-door-web', type: 'wrapped_k_local', deleted_at: null }];
      webOrgId = ORG_DEMOS;
      webPhraseFn = () => generateSeedPhrase();

      const cmd = new RecoverCommand();
      await cmd.execute({ web: true });

      expect(runDeviceKeyEnrollmentCalls).toHaveLength(1);
      // Root pre-existed (unchanged by this recovery) — no stale-door
      // cleanup, exactly like the terminal path's own "already existed" test.
      expect(deleteWrapperCalls).toHaveLength(0);
    });
  });
});

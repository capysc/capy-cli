/**
 * `capy redeem` — CAP-382's post-redeem device-key nudge (accept/decline),
 * exercised end to end through RedeemCommand.execute() on the "new key
 * written" success path. The redeem crypto pipeline itself (parseRedeemCode,
 * co-decrypt, inner-unwrap) is mocked to a deterministic happy path — this
 * file's job is the nudge, not re-testing redeem's pre-existing logic (which
 * has no dedicated test file to extend).
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const FAKE_USER = 'user_redeemnudge';
const ORG_ID = 'org-redeem-1';

mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    async authenticateSilent(orgId?: string) {
      return {
        success: true,
        organization_id: orgId,
        user_id: FAKE_USER,
        user_email: 'u@example.com',
        organizations: [{ id: ORG_ID, workos_org_id: 'wo-1', name: 'Org One' }],
      };
    }
    async authenticate(orgId?: string) {
      return this.authenticateSilent(orgId);
    }
  },
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    async coDecrypt() {
      return { plaintext: 'inner-blob' };
    }
  },
}));

mock.module('../../src/files/fileManager', () => ({
  FileManager: class {
    writeSyncState() {}
  },
}));

mock.module('../../src/errors/membershipRevoked', () => ({
  isMembershipRevokedError: mock(() => false),
}));
mock.module('../../src/cleanup/orgCleanup', () => ({
  cleanupOrgData: mock(() => {}),
}));

mock.module('../../src/crypto/inviteCrypto', () => ({
  parseRedeemCode: mock(() => ({
    token: Buffer.alloc(32, 1),
    orgId: ORG_ID,
    ciphertext: 'ct',
    notAfter: Date.now() + 60_000,
  })),
  innerUnwrap: mock(() => Buffer.alloc(32, 2)),
}));

const wrapCalls: unknown[] = [];
let hasOrgKeyResult = false;
mock.module('../../src/crypto/keyResolver', () => ({
  wrapAndSaveMasterKey: mock(async (...args: unknown[]) => {
    wrapCalls.push(args);
  }),
  hasOrgKey: mock(() => hasOrgKeyResult),
}));

let interactive = true;
mock.module('../../src/ui/interactive', () => ({
  isInteractive: mock(() => interactive),
}));

let confirmedAnswer = false;
const promptCalls: string[] = [];
mock.module('inquirer', () => ({
  default: {
    prompt: mock(async (q: any) => {
      const item = Array.isArray(q) ? q[0] : q;
      promptCalls.push(item.name);
      if (item.name === 'confirmed') return { confirmed: confirmedAnswer };
      throw new Error(`unexpected prompt: ${item.name}`);
    }),
  },
}));

let enrollmentOutcome: unknown = { kind: 'enrolled', result: { ok: true, credentialId: 'c1', wrapperId: 'w1', verified: true, backupEligible: true, backupState: true, orgs: [] } };
const runDeviceKeyEnrollmentCalls: unknown[] = [];
const reportedOutcomes: unknown[] = [];
let syncResult: { alreadyEnrolled: boolean; synced: boolean } = { alreadyEnrolled: false, synced: false };
const syncCalls: string[] = [];
mock.module('../../src/auth/deviceKey/wiring', () => ({
  runDeviceKeyEnrollment: mock(async (ctx: unknown) => {
    runDeviceKeyEnrollmentCalls.push(ctx);
    return enrollmentOutcome;
  }),
  reportEnrollmentOutcome: mock((result: unknown, orgName: string) => {
    reportedOutcomes.push({ result, orgName });
  }),
  syncOrgOntoDeviceKeyIfEnrolled: mock(async (_ctx: unknown, orgId: string) => {
    syncCalls.push(orgId);
    return syncResult;
  }),
}));

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}
const originalExit = process.exit;
(process as any).exit = (code?: number) => {
  throw new ExitError(code ?? 0);
};

afterAll(() => {
  mock.restore();
  (process as any).exit = originalExit;
});

let RedeemCommand: any;

beforeAll(async () => {
  ({ RedeemCommand } = await import('../../src/commands/redeemCommand'));
});

const ORIGINAL_FLAG = process.env.CAPY_DEVICE_KEYS;

beforeEach(() => {
  wrapCalls.length = 0;
  promptCalls.length = 0;
  runDeviceKeyEnrollmentCalls.length = 0;
  reportedOutcomes.length = 0;
  syncCalls.length = 0;
  syncResult = { alreadyEnrolled: false, synced: false };
  confirmedAnswer = false;
  interactive = true;
  hasOrgKeyResult = false;
  delete process.env.CAPY_DEVICE_KEYS;
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.CAPY_DEVICE_KEYS;
  else process.env.CAPY_DEVICE_KEYS = ORIGINAL_FLAG;
});

describe('post-redeem device-key nudge', () => {
  test('flag off — the nudge never prompts, redeem completes exactly as before', async () => {
    await new RedeemCommand().execute('CODE');
    expect(wrapCalls).toHaveLength(1);
    expect(promptCalls).not.toContain('confirmed');
    expect(runDeviceKeyEnrollmentCalls).toHaveLength(0);
    expect(syncCalls).toHaveLength(0);
  });

  test('flag on, account already has a device key enrolled elsewhere — syncs this newly-joined org silently, no nudge', async () => {
    process.env.CAPY_DEVICE_KEYS = '1';
    syncResult = { alreadyEnrolled: true, synced: true };
    await new RedeemCommand().execute('CODE');
    expect(syncCalls).toEqual([ORG_ID]);
    expect(promptCalls).not.toContain('confirmed');
    expect(runDeviceKeyEnrollmentCalls).toHaveLength(0);
  });

  test('flag on, already enrolled but this machine holds no canonical root yet — still no nudge (not the right remedy)', async () => {
    process.env.CAPY_DEVICE_KEYS = '1';
    syncResult = { alreadyEnrolled: true, synced: false };
    await new RedeemCommand().execute('CODE');
    expect(promptCalls).not.toContain('confirmed');
  });

  test('flag on, non-interactive — the nudge never prompts (no hang in CI/agents)', async () => {
    process.env.CAPY_DEVICE_KEYS = '1';
    interactive = false;
    await new RedeemCommand().execute('CODE');
    expect(promptCalls).not.toContain('confirmed');
    expect(runDeviceKeyEnrollmentCalls).toHaveLength(0);
  });

  test('flag on, interactive, declines — leaves no residue: no enrollment attempted', async () => {
    process.env.CAPY_DEVICE_KEYS = '1';
    confirmedAnswer = false;
    await new RedeemCommand().execute('CODE');
    expect(promptCalls).toContain('confirmed');
    expect(runDeviceKeyEnrollmentCalls).toHaveLength(0);
  });

  test('flag on, interactive, accepts, enrollment succeeds — reports the outcome', async () => {
    process.env.CAPY_DEVICE_KEYS = '1';
    confirmedAnswer = true;
    enrollmentOutcome = { kind: 'enrolled', result: { ok: true, credentialId: 'c1', wrapperId: 'w1', verified: true, backupEligible: true, backupState: true, orgs: [] } };
    await new RedeemCommand().execute('CODE');
    expect(runDeviceKeyEnrollmentCalls).toHaveLength(1);
    expect(reportedOutcomes).toHaveLength(1);
  });

  test('flag on, interactive, accepts, ceremony declined — no throw, redeem result stands', async () => {
    process.env.CAPY_DEVICE_KEYS = '1';
    confirmedAnswer = true;
    enrollmentOutcome = { kind: 'declined', ceremonyCode: 'cancelled' };
    await expect(new RedeemCommand().execute('CODE')).resolves.toBeUndefined();
  });

  test('the "already have the key" early-return branch never offers the nudge (nothing new was written)', async () => {
    process.env.CAPY_DEVICE_KEYS = '1';
    confirmedAnswer = true;
    hasOrgKeyResult = true;
    await new RedeemCommand().execute('CODE');
    expect(wrapCalls).toHaveLength(0);
    expect(promptCalls).not.toContain('confirmed');
  });
});

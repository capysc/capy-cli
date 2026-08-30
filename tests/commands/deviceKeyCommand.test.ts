/**
 * `capy device-key enroll|list|remove` command-level tests — flag-off
 * refusal, enroll's outcome-kind switch, list's human/JSON output, and
 * remove's coded-error handling (incl. the invariant-blocked case,
 * CAP-382's requirement to surface WRAPPER_INVARIANT_VIOLATION honestly).
 *
 * `runDeviceKeyEnrollment`/`reportEnrollmentOutcome` are mocked so this file
 * tests the COMMAND's handling of each outcome, not the engine underneath it
 * (covered by tests/auth/deviceKey/wiring.test.ts and
 * tests/auth/deviceKeyOnboarding.test.ts).
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const FAKE_USER = 'user_devicekeycmd';

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: class {
    async detectProjectState() {
      return { userId: FAKE_USER };
    }
  },
}));

mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    async authenticateSilent() {
      return { success: true, user_id: FAKE_USER, user_email: 'u@example.com', organizations: [{ id: 'org-1', workos_org_id: 'wo-1', name: 'Org One' }], organization_id: 'org-1' };
    }
    async authenticate() {
      return { success: true, user_id: FAKE_USER, user_email: 'u@example.com', organizations: [{ id: 'org-1', workos_org_id: 'wo-1', name: 'Org One' }], organization_id: 'org-1' };
    }
    getValidToken() {
      return Promise.resolve({ access_token: 'fake' });
    }
  },
}));

const serviceClientCalls: { listWrappers: unknown[]; deleteWrapper: unknown[] } = { listWrappers: [], deleteWrapper: [] };
let listWrappersResult: unknown[] = [];
let deleteWrapperImpl: (id: string) => Promise<unknown> = async () => ({ id: 'w1' });

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    async listWrappers(includeDeleted?: boolean) {
      serviceClientCalls.listWrappers.push(includeDeleted);
      return listWrappersResult;
    }
    async deleteWrapper(id: string) {
      serviceClientCalls.deleteWrapper.push(id);
      return deleteWrapperImpl(id);
    }
  },
}));

let enrollmentOutcome: unknown = { kind: 'enrolled', result: { ok: true, credentialId: 'c1', wrapperId: 'w1', verified: true, backupEligible: true, backupState: true, orgs: [] } };
const reportedOutcomes: unknown[] = [];

mock.module('../../src/auth/deviceKey/wiring', () => ({
  runDeviceKeyEnrollment: mock(async () => enrollmentOutcome),
  reportEnrollmentOutcome: mock((result: unknown, orgName: string) => {
    reportedOutcomes.push({ result, orgName });
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

let DeviceKeyEnrollCommand: any;
let DeviceKeyListCommand: any;
let DeviceKeyRemoveCommand: any;
let ERROR_CODES: any;
let CapyError: any;

beforeAll(async () => {
  ({ DeviceKeyEnrollCommand, DeviceKeyListCommand, DeviceKeyRemoveCommand } = await import('../../src/commands/deviceKeyCommand'));
  ({ ERROR_CODES, CapyError } = await import('../../src/types/index'));
});

const ORIGINAL_FLAG = process.env.CAPY_DEVICE_KEYS;

beforeEach(() => {
  serviceClientCalls.listWrappers.length = 0;
  serviceClientCalls.deleteWrapper.length = 0;
  reportedOutcomes.length = 0;
  listWrappersResult = [];
  deleteWrapperImpl = async () => ({ id: 'w1' });
  delete process.env.CAPY_DEVICE_KEYS;
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.CAPY_DEVICE_KEYS;
  else process.env.CAPY_DEVICE_KEYS = ORIGINAL_FLAG;
});

describe('rail always on — device-key commands run even with the legacy env flag unset', () => {
  // Permanently ON as of onboarding v2 — the env var is no longer
  // consulted (src/auth/deviceKey/flag.ts). beforeEach deletes it; these
  // assert the commands reach their normal paths anyway.
  test('enroll proceeds into the ceremony (cancelled by the mock resolves cleanly)', async () => {
    await new DeviceKeyEnrollCommand().execute();
  });
  test('list reaches the service', async () => {
    await new DeviceKeyListCommand().execute();
    expect(serviceClientCalls.listWrappers.length).toBe(1);
  });
  test('remove reaches the service', async () => {
    await new DeviceKeyRemoveCommand().execute('w1');
    expect(serviceClientCalls.deleteWrapper.length).toBe(1);
  });
});

describe('device-key enroll (flag on)', () => {
  beforeEach(() => {
    process.env.CAPY_DEVICE_KEYS = '1';
  });

  test('enrolled → reports the outcome', async () => {
    enrollmentOutcome = { kind: 'enrolled', result: { ok: true, credentialId: 'c1', wrapperId: 'w1', verified: true, backupEligible: true, backupState: true, orgs: [] } };
    await new DeviceKeyEnrollCommand().execute();
    expect(reportedOutcomes.length).toBe(1);
  });

  test('declined ceremony → non-zero exit code, no throw', async () => {
    enrollmentOutcome = { kind: 'declined', ceremonyCode: 'cancelled' };
    process.exitCode = 0;
    await new DeviceKeyEnrollCommand().execute();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test('already_enrolled → no error, points at `list`', async () => {
    enrollmentOutcome = { kind: 'already_enrolled' };
    await expect(new DeviceKeyEnrollCommand().execute()).resolves.toBeUndefined();
  });

  test('not_ready (brand_new) → non-zero exit code', async () => {
    enrollmentOutcome = { kind: 'not_ready', verdictKind: 'brand_new' };
    process.exitCode = 0;
    await new DeviceKeyEnrollCommand().execute();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test('not_ready (recovery_or_transport) → non-zero exit code', async () => {
    enrollmentOutcome = { kind: 'not_ready', verdictKind: 'recovery_or_transport' };
    process.exitCode = 0;
    await new DeviceKeyEnrollCommand().execute();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe('device-key list (flag on)', () => {
  beforeEach(() => {
    process.env.CAPY_DEVICE_KEYS = '1';
  });

  test('empty → a helpful message, no throw', async () => {
    listWrappersResult = [];
    await expect(new DeviceKeyListCommand().execute()).resolves.toBeUndefined();
  });

  test('--json emits the raw wrapper list', async () => {
    listWrappersResult = [{ id: 'w1', type: 'wrapped_k_local', is_seed: true, kdf_version: 1, mirror_state: 'pending', created_at: 'now' }];
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await new DeviceKeyListCommand().execute({ json: true });
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.wrappers).toHaveLength(1);
    expect(parsed.wrappers[0].id).toBe('w1');
  });

  test('--include-deleted rides through to the service call', async () => {
    await new DeviceKeyListCommand().execute({ includeDeleted: true });
    expect(serviceClientCalls.listWrappers).toEqual([true]);
  });
});

describe('device-key remove (flag on)', () => {
  beforeEach(() => {
    process.env.CAPY_DEVICE_KEYS = '1';
  });

  test('success → removes, no throw', async () => {
    await expect(new DeviceKeyRemoveCommand().execute('w1')).resolves.toBeUndefined();
    expect(serviceClientCalls.deleteWrapper).toEqual(['w1']);
  });

  test('the invariant-blocked case (WRAPPER_INVARIANT_VIOLATION) is surfaced with explanatory copy and exit 1', async () => {
    deleteWrapperImpl = async () => {
      throw new CapyError('blocked', ERROR_CODES.WRAPPER_INVARIANT_VIOLATION);
    };
    const errs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(' '));
    try {
      await expect(new DeviceKeyRemoveCommand().execute('w1')).rejects.toBeInstanceOf(ExitError);
    } finally {
      console.error = original;
    }
    expect(errs.join('\n')).toContain('only verified device key');
  });

  test('WRAPPER_NOT_FOUND → coded, exit 1', async () => {
    deleteWrapperImpl = async () => {
      throw new CapyError('nope', ERROR_CODES.WRAPPER_NOT_FOUND);
    };
    await expect(new DeviceKeyRemoveCommand().execute('missing')).rejects.toBeInstanceOf(ExitError);
  });

  test('an unexpected error still exits 1 rather than crashing uncaught', async () => {
    deleteWrapperImpl = async () => {
      throw new Error('network blip');
    };
    await expect(new DeviceKeyRemoveCommand().execute('w1')).rejects.toBeInstanceOf(ExitError);
  });
});

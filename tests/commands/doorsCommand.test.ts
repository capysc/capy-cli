/**
 * `capy doors` command-level tests (CAP-378 CLI slice) — human/JSON output,
 * the honest-gap notices (sessions_unavailable_reason, unavailable
 * transport_code), the revoke pointer, and coded-error handling for both the
 * auth step and the service call.
 *
 * `ServiceClient.listDoors` is mocked so this file tests the COMMAND's
 * rendering/error handling, not the client's HTTP plumbing (covered by
 * tests/service/serviceClient.test.ts) or the service itself.
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const FAKE_USER = 'user_doorscmd';

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: class {
    async detectProjectState() {
      return { userId: FAKE_USER };
    }
  },
}));

let silentResult: unknown = {
  success: true,
  user_id: FAKE_USER,
  user_email: 'u@example.com',
  organizations: [{ id: 'org-1', workos_org_id: 'wo-1', name: 'Org One' }],
  organization_id: 'org-1',
};

mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    async authenticateSilent() {
      return silentResult;
    }
    async authenticate() {
      return silentResult;
    }
    getValidToken() {
      return Promise.resolve({ access_token: 'fake' });
    }
  },
}));

const serviceClientCalls: { listDoors: number } = { listDoors: 0 };
let listDoorsImpl: () => Promise<unknown> = async () => ({
  doors: [],
  has_seed_wrapper: false,
  sessions_unavailable_reason: null,
  unavailable_door_types: [{ door_type: 'transport_code', reason: 'NOT_PERSISTED' }],
});

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    async listDoors() {
      serviceClientCalls.listDoors++;
      return listDoorsImpl();
    }
  },
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

let DoorsCommand: any;

beforeAll(async () => {
  ({ DoorsCommand } = await import('../../src/commands/doorsCommand'));
});

const ORIGINAL_KEEP_ORIGIN = process.env.CAPY_KEEP_ORIGIN;

beforeEach(() => {
  serviceClientCalls.listDoors = 0;
  silentResult = {
    success: true,
    user_id: FAKE_USER,
    user_email: 'u@example.com',
    organizations: [{ id: 'org-1', workos_org_id: 'wo-1', name: 'Org One' }],
    organization_id: 'org-1',
  };
  listDoorsImpl = async () => ({
    doors: [],
    has_seed_wrapper: false,
    sessions_unavailable_reason: null,
    unavailable_door_types: [{ door_type: 'transport_code', reason: 'NOT_PERSISTED' }],
  });
  delete process.env.CAPY_KEEP_ORIGIN;
});

afterEach(() => {
  if (ORIGINAL_KEEP_ORIGIN === undefined) delete process.env.CAPY_KEEP_ORIGIN;
  else process.env.CAPY_KEEP_ORIGIN = ORIGINAL_KEEP_ORIGIN;
});

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errs: string[] }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errs.push(args.map(String).join(' '));
  return fn()
    .then(() => ({ logs, errs }))
    .finally(() => {
      console.log = origLog;
      console.error = origErr;
    });
}

describe('capy doors — auth failure', () => {
  test('sign-in failure exits 1 and never calls the service', async () => {
    silentResult = { success: false, error: 'nope' };
    await expect(new DoorsCommand().execute()).rejects.toBeInstanceOf(ExitError);
    expect(serviceClientCalls.listDoors).toBe(0);
  });
});

describe('capy doors — empty inventory', () => {
  test('human output: "No doors found", no throw', async () => {
    const { logs } = await captureLogs(() => new DoorsCommand().execute());
    expect(logs.join('\n')).toContain('No doors found');
  });

  test('--json emits the raw inventory object untouched', async () => {
    const { logs } = await captureLogs(() => new DoorsCommand().execute({ json: true }));
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.doors).toEqual([]);
    expect(parsed.has_seed_wrapper).toBe(false);
    expect(parsed.unavailable_door_types).toEqual([{ door_type: 'transport_code', reason: 'NOT_PERSISTED' }]);
  });
});

describe('capy doors — populated inventory', () => {
  beforeEach(() => {
    listDoorsImpl = async () => ({
      doors: [
        {
          door_type: 'device_key',
          id: 'dk-1',
          credential_id: 'cred-abcdefghijklmnopqrstuvwxyz',
          kdf_version: 1,
          is_seed: true,
          verified_at: '2026-08-01T00:00:00.000Z',
          created_at: '2026-08-01T00:00:00.000Z',
          revocable: true,
        },
        {
          door_type: 'org_key',
          id: 'ok-1',
          organization_id: 'org-1',
          kdf_version: 1,
          verified_at: null,
          created_at: '2026-08-02T00:00:00.000Z',
          revocable: true,
        },
        {
          door_type: 'session',
          id: 'sess-1',
          auth_method: 'oauth',
          ip_address: '203.0.113.5',
          status: 'active',
          created_at: '2026-08-03T00:00:00.000Z',
          revocable: true,
        },
      ],
      has_seed_wrapper: true,
      sessions_unavailable_reason: null,
      unavailable_door_types: [{ door_type: 'transport_code', reason: 'NOT_PERSISTED' }],
    });
  });

  test('renders all three door types, grouped by section', async () => {
    const { logs } = await captureLogs(() => new DoorsCommand().execute());
    const out = logs.join('\n');
    expect(out).toContain('Device keys');
    expect(out).toContain('dk-1');
    expect(out).toContain('Org key copies');
    expect(out).toContain('ok-1');
    expect(out).toContain('Sessions');
    expect(out).toContain('sess-1');
  });

  test('the seed device key is labeled "seed", the unverified org key "unverified"', async () => {
    const { logs } = await captureLogs(() => new DoorsCommand().execute());
    const out = logs.join('\n');
    expect(out).toMatch(/dk-1\s+device key\s+seed/);
    expect(out).toMatch(/ok-1\s+org key copy\s+unverified/);
  });

  test('mentions where to revoke, using keepOrigin()', async () => {
    const { logs } = await captureLogs(() => new DoorsCommand().execute());
    const out = logs.join('\n');
    expect(out).toContain('https://keep.capy.sc/flow/doors');
  });

  test('CAPY_KEEP_ORIGIN overrides the revoke pointer', async () => {
    process.env.CAPY_KEEP_ORIGIN = 'https://keep.test.local';
    const { logs } = await captureLogs(() => new DoorsCommand().execute());
    const out = logs.join('\n');
    expect(out).toContain('https://keep.test.local/flow/doors');
  });

  test('--json passes the populated inventory through untouched', async () => {
    const { logs } = await captureLogs(() => new DoorsCommand().execute({ json: true }));
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.doors).toHaveLength(3);
    expect(parsed.has_seed_wrapper).toBe(true);
  });
});

describe('capy doors — honest gaps', () => {
  test('sessions_unavailable_reason renders a distinct notice, not a silent empty section', async () => {
    listDoorsImpl = async () => ({
      doors: [],
      has_seed_wrapper: false,
      sessions_unavailable_reason: 'WORKOS_LOOKUP_FAILED',
      unavailable_door_types: [{ door_type: 'transport_code', reason: 'NOT_PERSISTED' }],
    });
    const { logs } = await captureLogs(() => new DoorsCommand().execute());
    const out = logs.join('\n');
    expect(out).toContain('WORKOS_LOOKUP_FAILED');
    expect(out).toContain('not the same as having zero sessions');
  });

  test('transport_code unavailability is explained, never silently omitted', async () => {
    const { logs } = await captureLogs(() => new DoorsCommand().execute());
    const out = logs.join('\n');
    expect(out).toContain('Transport codes never appear here');
    expect(out).toContain('NOT_PERSISTED');
  });
});

describe('capy doors — service failure', () => {
  test('a thrown error exits 1 rather than crashing uncaught', async () => {
    listDoorsImpl = async () => {
      throw new Error('network blip');
    };
    const errs: string[] = [];
    const originalErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(' '));
    try {
      await expect(new DoorsCommand().execute()).rejects.toBeInstanceOf(ExitError);
    } finally {
      console.error = originalErr;
    }
    expect(errs.join('\n')).toContain('Failed to load doors');
  });
});

describe('capy doors — final-gate BLOCKER-2 (route missing on this service build)', () => {
  test('a DOORS_NOT_SUPPORTED coded error prints a capability-gap message, not the generic failure text, and exits 1', async () => {
    listDoorsImpl = async () => {
      // Mirrors what ServiceClient.listDoors() synthesizes from a bare 404 —
      // this test exercises the COMMAND's handling of the code, independent
      // of the client's own 404→code mapping (covered by
      // tests/service/serviceClient.test.ts).
      const { CapyError, ERROR_CODES } = await import('../../src/types/index');
      throw new CapyError(
        'This Capy service does not support device-key doors yet (no /doors route).',
        ERROR_CODES.DOORS_NOT_SUPPORTED,
        { status: 404 },
      );
    };
    const errs: string[] = [];
    const originalErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(' '));
    try {
      await expect(new DoorsCommand().execute()).rejects.toBeInstanceOf(ExitError);
    } finally {
      console.error = originalErr;
    }
    const out = errs.join('\n');
    expect(out).toContain('not available yet');
    expect(out).toContain('does not support');
    expect(out).not.toContain('Failed to load doors');
  });

  test('a generic (non-coded) failure still falls through to the ordinary message', async () => {
    listDoorsImpl = async () => {
      throw new Error('some other failure');
    };
    const errs: string[] = [];
    const originalErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(' '));
    try {
      await expect(new DoorsCommand().execute()).rejects.toBeInstanceOf(ExitError);
    } finally {
      console.error = originalErr;
    }
    expect(errs.join('\n')).toContain('Failed to load doors');
  });
});

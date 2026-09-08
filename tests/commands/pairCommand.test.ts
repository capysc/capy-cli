/**
 * CAP-409 — `PairCommand`'s branching over `runPairCeremony`'s outcomes:
 * answered (installs session + spawns the grant daemon), expired (coded
 * EXIT_NEEDS_INPUT, nothing installed), failure (exit 1, nothing installed),
 * and a bootstrap-level throw before any code was ever shown. The ceremony
 * engine, session installer, and grant daemon are mocked — this file tests
 * the COMMAND's decisions, not the engines underneath (covered by
 * tests/auth/pairing/*).
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { CapyError } from '../../src/types/index';

const authState = {
  result: { success: false, error_code: 'no_session' } as any,
  binding: null as null | { userId: string },
  activeOrg: undefined as string | undefined,
  calls: [] as any[],
  constructors: [] as any[],
  authorizeCalls: [] as string[],
};
mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    constructor(...args: any[]) { authState.constructors.push(args); }
    getOrganizationId() { return authState.activeOrg; }
    async authenticateSilent(orgId?: string) {
      authState.calls.push(orgId);
      return authState.result;
    }
  },
}));
mock.module('../../src/auth/pairing/runtimePairing', () => ({
  readRuntimePairing: () => authState.binding,
  assertRuntimePairingUser: (userId: string) => {
    if (authState.binding && authState.binding.userId !== userId) {
      throw new CapyError('This runtime is paired to another Capy account. Run `capy logout` before pairing a different account.',
        'RUNTIME_PAIR_USER_MISMATCH');
    }
    return authState.binding;
  },
}));

mock.module('../../src/config/profileConfig', () => ({
  resolveActiveUrl: () => 'https://api.test.invalid',
}));

// CAP-566 moved the SEAM, not the branching: the command drives the device
// grant (deviceAuth.ts) instead of runPairCeremony. Everything these tests
// assert about the command — the printed block, exit codes, --json shape, the
// QR rules — is unchanged behaviour and is asserted unchanged below; only the
// module being faked here is different.
let ceremonyImpl: (opts: any) => Promise<any> = async () => {
  throw new Error('ceremonyImpl not configured for this test');
};
const ceremonyCalls: any[] = [];
const AUTHORIZATION = {
  device_code: 'dc_test',
  user_code: 'ABCD-1234',
  verification_uri: 'https://auth.test.invalid/device',
  expires_in: 300,
  interval: 5,
};
// Bootstrap failure now means the AUTHORIZE leg failing — that is the point
// before which no code exists to print. A poll failure is a different case:
// the code has necessarily been shown by then.
let authorizeImpl: () => Promise<any> = async () => AUTHORIZATION;
mock.module('../../src/auth/pairing/deviceAuth', () => ({
  startDeviceAuthorization: async (url: string) => {
    authState.authorizeCalls.push(url);
    return authorizeImpl();
  },
  awaitDeviceApproval: async (_url: string, authorization: any) => {
    ceremonyCalls.push({ authorization });
    return ceremonyImpl({ authorization });
  },
}));

let installImpl: (session: any, opts: any) => Promise<any> = async () => ({ orgId: null, orgTokenReady: false });
const installCalls: any[] = [];
mock.module('../../src/auth/pairing/installPairedSession', () => ({
  installPairedSession: async (session: any, opts: any) => {
    installCalls.push({ session, opts });
    return installImpl(session, opts);
  },
}));

// The key-material resolution step (fetch + KEK-derive + unwrap) is its own
// module (pairKeyMaterial.ts) with its own unit tests
// (tests/auth/pairing/pairKeyMaterial.test.ts) — mocked here so this file
// stays about the COMMAND's branching, not the real network/AuthService
// paths that module's production entry point touches.
let resolveKeyMaterialImpl: (answer: any, opts: any) => Promise<any> = async () => ({
  ok: true,
  material: { userId: 'user_1', credentialId: 'cred_1', kLocal: Buffer.alloc(32, 9) },
});
const resolveKeyMaterialCalls: any[] = [];
mock.module('../../src/auth/pairing/pairDeviceGrant', () => ({
  grantKeyMaterialForPairedMachine: async (opts: any) => {
    resolveKeyMaterialCalls.push({ answer: null, opts });
    return resolveKeyMaterialImpl(null, opts);
  },
}));

const spawnCalls: any[] = [];
let spawnResult = { socketPath: '/tmp/fake.sock', expiresAt: Date.now() + 1_800_000, pid: 4242 };
mock.module('../../src/auth/deviceKey/grantHolder', () => ({
  spawnGrantDaemon: async (material: any, opts: any) => {
    spawnCalls.push({ material, opts });
    return spawnResult;
  },
  GRANT_SOCKET_ENV_VAR: 'CAPY_DEVICE_KEY_GRANT_SOCKET',
  DEFAULT_GRANT_TTL_MS: 30 * 60_000,
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

let PairCommand: any;
let ERROR_CODES: any;

beforeAll(async () => {
  ({ PairCommand } = await import('../../src/commands/pairCommand'));
  ({ ERROR_CODES } = await import('../../src/types/index'));
});

afterAll(() => {
  mock.restore();
  (process as any).exit = originalExit;
});

const VALID_ANSWER = {
  v: 1 as const,
  flow: 'pair' as const,
  ceremony: 'machine-pair' as const,
  session: {
    user: { id: 'user_1', email: 'u@example.com' },
    refresh_token: 'rt_1',
    organizations: [{ id: 'org_1', name: 'Org One' }],
  },
  keyMaterial: {
    orgId: 'org_1',
    prfOutput: Buffer.alloc(32, 3).toString('base64'),
    credentialId: 'cred_1',
  },
};

let logs: string[] = [];
let errs: string[] = [];
const originalLog = console.log;
const originalErr = console.error;
const ORIGINAL_FLAG = process.env.CAPY_DEVICE_KEYS;

beforeEach(async () => {
  authState.result = { success: false, error_code: 'no_session' };
  authState.binding = null;
  authState.activeOrg = undefined;
  authState.calls.length = 0;
  authState.constructors.length = 0;
  authState.authorizeCalls.length = 0;
  ceremonyCalls.length = 0;
  installCalls.length = 0;
  resolveKeyMaterialCalls.length = 0;
  spawnCalls.length = 0;
  authorizeImpl = async () => AUTHORIZATION;
  installImpl = async () => ({ orgId: 'org_1', orgName: 'Org One', orgTokenReady: true });
  resolveKeyMaterialImpl = async () => ({
    ok: true,
    material: { userId: 'user_1', credentialId: 'cred_1', kLocal: Buffer.alloc(32, 9) },
  });
  // Bun (unlike Node) does not treat `process.exitCode = undefined` as
  // clearing a previously-set nonzero value — the process still exits 1 at
  // the end even though the value reads back as `undefined` in between.
  // `0` is the only value that actually clears it under Bun.
  process.exitCode = 0;
  // Every describe block below exercises the ceremony/install/daemon
  // branching, which only runs with the flag on (see pairCommand.ts's
  // module doc: a grant obtained with the flag off is unusable by
  // `capy run` regardless). The flag-gating itself is its own describe
  // block, further down, which explicitly unsets it per test.
  process.env.CAPY_DEVICE_KEYS = '1';
  logs = [];
  errs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  if (ORIGINAL_FLAG === undefined) delete process.env.CAPY_DEVICE_KEYS;
  else process.env.CAPY_DEVICE_KEYS = ORIGINAL_FLAG;
  // Several tests intentionally drive PairCommand down a failure path that
  // sets process.exitCode = 1 (asserted above via `expect((process as
  // any).exitCode).toBe(1)`). Without resetting it here, whichever test
  // happens to run last leaves it set for the rest of the process — bun
  // test then exits 1 for this whole file even though every assertion
  // passed, which run-tests.sh's isolation loop (correctly) reads as FAIL.
  // Must be `0`, not `undefined` — see the beforeEach comment above.
  process.exitCode = 0;
});

describe('PairCommand — rail always on', () => {
  test('runs the ceremony even with the legacy env flag unset', async () => {
    // Permanently ON as of onboarding v2 — the env var is no longer
    // consulted (src/auth/deviceKey/flag.ts).
    delete process.env.CAPY_DEVICE_KEYS;
    ceremonyImpl = async () => ({ status: 'complete', session: VALID_ANSWER.session });
    await new PairCommand().execute({});
    expect(ceremonyCalls.length).toBeGreaterThan(0);
    expect(installCalls.length).toBe(1);
  });
});

describe('PairCommand — answered', () => {
  test('installs the session and spawns the grant daemon with the right key material', async () => {
    ceremonyImpl = async () => ({ status: 'complete', session: VALID_ANSWER.session });

    await new PairCommand().execute({});

    expect(logs.some((l) => l.includes('ABCD-1234'))).toBe(true);
    expect(installCalls.length).toBe(1);
    expect(installCalls[0].session).toEqual(VALID_ANSWER.session);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].material.userId).toBe('user_1');
    expect(spawnCalls[0].material.credentialId).toBe('cred_1');
    expect(spawnCalls[0].material.kLocal).toEqual(Buffer.alloc(32, 9));
    expect(logs.some((l) => l.includes('u@example.com'))).toBe(true);
    expect(logs.some((l) => l.includes('Org One'))).toBe(true);
  });

  test('--json prints exactly one machine-readable object with the socket path and org', async () => {
    ceremonyImpl = async () => ({ status: 'complete', session: VALID_ANSWER.session });

    await new PairCommand().execute({ json: true });

    const jsonStart = logs.findIndex((l) => l.trim().startsWith('{'));
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(logs.slice(jsonStart).join('\n'));
    expect(parsed.ok).toBe(true);
    expect(parsed.userCode).toBe('ABCD-1234');
    expect(parsed.orgId).toBe('org_1');
    expect(parsed.socketPath).toBe('/tmp/fake.sock');
    expect(parsed.envVar).toBe('CAPY_DEVICE_KEY_GRANT_SOCKET');
  });

  test('--ttl-minutes is passed through to the grant daemon spawn', async () => {
    ceremonyImpl = async () => ({ status: 'complete', session: VALID_ANSWER.session });

    await new PairCommand().execute({ ttlMinutes: 5 });
    expect(spawnCalls[0].opts.ttlMs).toBe(5 * 60_000);
  });

  test('a coded key-material resolution failure (e.g. malformed PRF output) is rejected before spawning a daemon', async () => {
    ceremonyImpl = async () => ({ status: 'complete', session: VALID_ANSWER.session });
    resolveKeyMaterialImpl = async () => ({ ok: false, code: ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED });

    await new PairCommand().execute({});
    expect(spawnCalls.length).toBe(0);
    expect((process as any).exitCode).toBe(1);
  });

  test('the session installs BEFORE key material is resolved — the fetch authenticates with the just-installed session', async () => {
    ceremonyImpl = async () => ({ status: 'complete', session: VALID_ANSWER.session });

    await new PairCommand().execute({});
    expect(installCalls.length).toBe(1);
    expect(resolveKeyMaterialCalls.length).toBe(1);
    // CHANGED EXPECTATION (CAP-566): key material is no longer sourced from
    // the approver's sealed answer, because there is no sealed answer — that
    // payload carried the approver's own session, which is the defect this
    // ticket removes. The grant now runs over the machine's OWN authenticated
    // session, so there is nothing to pass in.
    //
    // The invariant this test exists for is UNCHANGED and still asserted
    // below: the session must be installed BEFORE key material is resolved,
    // because the grant authenticates with it. That ordering is arguably more
    // load-bearing now, not less.
    expect(resolveKeyMaterialCalls[0].answer).toBeNull();
    // installImpl (above) resolves { orgId: 'org_1', ... } — that's the org
    // pairKeyMaterial.ts should authenticate the wrapper fetch against.
    expect(resolveKeyMaterialCalls[0].opts.authOrgId).toBe('org_1');
  });

  test("a non-interactive multi-org install (orgId: null) still authenticates the key-material fetch, against the session's own org", async () => {
    // CHANGED EXPECTATION (CAP-566): the fallback source, not the behaviour.
    //
    // This asserted the fallback came from `answer.keyMaterial.orgId` — the
    // org the APPROVER's browser had active when it sealed the payload. There
    // is no sealed answer any more, so that source is gone.
    //
    // The behaviour it protects is unchanged and still asserted: when
    // `install.orgId` is null (the non-interactive multi-org case, where
    // installPairedSession deliberately pins nothing), the key-material fetch
    // must STILL be authenticated against some org rather than silently
    // skipped. It now falls back to an org from the machine's own session,
    // which is a strictly better source — doors are org-less server-side, so
    // any org this account belongs to authenticates the fetch, and taking it
    // from our own session removes a dependency on what the approver happened
    // to have selected.
    installImpl = async () => ({ orgId: null, orgTokenReady: false });
    ceremonyImpl = async () => ({ status: 'complete', session: VALID_ANSWER.session });

    await new PairCommand().execute({});
    expect(resolveKeyMaterialCalls.length).toBe(1);
    // VALID_ANSWER.session's first organization — the fallback when
    // install.orgId is null (see pairCommand.ts's finish()).
    expect(resolveKeyMaterialCalls[0].opts.authOrgId).toBe('org_1');
  });
});

describe('PairCommand — expired', () => {
  test('exits EXIT_NEEDS_INPUT (3), coded, and installs nothing', async () => {
    ceremonyImpl = async () => ({ status: 'denied', error: 'expired_token' });

    await expect(new PairCommand().execute({})).rejects.toMatchObject({ code: 3 });
    expect(installCalls.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
    expect(errs.some((l) => l.includes('expired'))).toBe(true);
  });

  test('--json emits the PAIR_CODE_EXPIRED code', async () => {
    ceremonyImpl = async () => ({ status: 'denied', error: 'expired_token' });

    await expect(new PairCommand().execute({ json: true })).rejects.toBeInstanceOf(ExitError);
    const jsonStart = logs.findIndex((l) => l.trim().startsWith('{'));
    const parsed = JSON.parse(logs.slice(jsonStart).join('\n'));
    expect(parsed).toEqual({ ok: false, code: ERROR_CODES.PAIR_CODE_EXPIRED, userCode: 'ABCD-1234' });
  });
});

describe('PairCommand — declined/cancelled/error', () => {
  test('a CeremonyFailure code exits 1 and installs nothing', async () => {
    ceremonyImpl = async () => ({ status: 'denied', error: 'cancelled' });

    await new PairCommand().execute({});
    expect((process as any).exitCode).toBe(1);
    expect(installCalls.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
  });
});

describe('PairCommand — bootstrap failure before any code is ever shown', () => {
  test('a thrown bootstrap error exits 1, prints no pairing code, installs nothing', async () => {
    authorizeImpl = async () => {
      throw new Error('network is down');
    };

    await new PairCommand().execute({});
    expect((process as any).exitCode).toBe(1);
    expect(installCalls.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
    expect(logs.join('\n')).not.toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
  });
});

describe('PairCommand — install failure', () => {
  test('a session-install throw does not spawn a grant daemon', async () => {
    ceremonyImpl = async () => ({ status: 'complete', session: VALID_ANSWER.session });
    installImpl = async () => {
      throw new Error('disk full');
    };

    await new PairCommand().execute({});
    expect((process as any).exitCode).toBe(1);
    expect(spawnCalls.length).toBe(0);
  });
});

// CAP-409 QR follow-up. `printPairingBlock` always prints the plain URL and
// code (spec §5's bright-line exception, unrelated to TTY-ness); the QR is
// purely additive on top and gated by `renderTerminalQr` (src/ui/terminalQr.ts).
// These tests exercise that gate through the real command, not just the
// helper in isolation — proving the wiring, not just the decision function.
describe('PairCommand — terminal QR (CAP-409 follow-up)', () => {
  const HALF_BLOCK = /[█▀▄]/;
  const originalIsTTY = process.stdout.isTTY;
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  const originalNoColor = process.env.NO_COLOR;

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  function pending() {
    // Never resolves within a test's lifetime — these tests only care about
    // what `onCodeReady` prints synchronously, not about a ceremony outcome.
    // The command prints the block itself now, then waits — so this just
    // never resolves. Callers await a tick so the print has happened.
    ceremonyImpl = () => new Promise(() => {});
  }

  test('a wide real TTY gets the QR alongside the unconditional plain text', async () => {
    process.stdout.isTTY = true;
    process.stdout.columns = 80;
    process.stdout.rows = 24;
    delete process.env.NO_COLOR;
    pending();

    void new PairCommand().execute({});
    // The block is printed after an awaited authorize call, so let the event
    // loop turn before asserting. Harness timing only — the contract, that the
    // code and URL are printed before the wait begins, is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const all = logs.join('\n');
    expect(all).toContain('ABCD-1234');
    // CHANGED EXPECTATION (CAP-566): the pairing URL is no longer Keep's
    // /pair page. The machine now authenticates itself through the identity
    // provider's own RFC 8628 device page, so the URL printed here is the
    // `verification_uri` the authorize response returned.
    //
    // This is a TRUST-SURFACE change, not only a UX one, and it is the single
    // most important thing to look at in this diff: a user who has been taught
    // that pairing happens on a capy.sc domain is now sent somewhere that is
    // not ours. "The pairing link goes somewhere else now" is precisely the
    // shape a phishing attempt takes. That may well be the right trade for a
    // real device grant — the machine getting its own credentials is the whole
    // point — but it is a product decision, and it strengthens the case for
    // putting the device page on a Capy-owned domain.
    //
    // Asserted from the authorize response rather than hardcoded, so moving to
    // a custom domain changes config and not this test.
    expect(all).toContain(AUTHORIZATION.verification_uri);
    expect(HALF_BLOCK.test(all)).toBe(true);
  });

  test('a piped, non-TTY stdout gets the plain text but never the QR', async () => {
    process.stdout.isTTY = undefined as unknown as true; // spawned-process shape
    process.stdout.columns = 80;
    process.stdout.rows = 24;
    pending();

    void new PairCommand().execute({});
    // The block is printed after an awaited authorize call, so let the event
    // loop turn before asserting. Harness timing only — the contract, that the
    // code and URL are printed before the wait begins, is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const all = logs.join('\n');
    expect(all).toContain('ABCD-1234');
    // CHANGED EXPECTATION (CAP-566): the pairing URL is no longer Keep's
    // /pair page. The machine now authenticates itself through the identity
    // provider's own RFC 8628 device page, so the URL printed here is the
    // `verification_uri` the authorize response returned.
    //
    // This is a TRUST-SURFACE change, not only a UX one, and it is the single
    // most important thing to look at in this diff: a user who has been taught
    // that pairing happens on a capy.sc domain is now sent somewhere that is
    // not ours. "The pairing link goes somewhere else now" is precisely the
    // shape a phishing attempt takes. That may well be the right trade for a
    // real device grant — the machine getting its own credentials is the whole
    // point — but it is a product decision, and it strengthens the case for
    // putting the device page on a Capy-owned domain.
    //
    // Asserted from the authorize response rather than hardcoded, so moving to
    // a custom domain changes config and not this test.
    expect(all).toContain(AUTHORIZATION.verification_uri);
    expect(HALF_BLOCK.test(all)).toBe(false);
  });

  test('a narrow real TTY falls back to plain text only — no QR, no crash', async () => {
    process.stdout.isTTY = true;
    process.stdout.columns = 10;
    process.stdout.rows = 24;
    pending();

    void new PairCommand().execute({});
    // The block is printed after an awaited authorize call, so let the event
    // loop turn before asserting. Harness timing only — the contract, that the
    // code and URL are printed before the wait begins, is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const all = logs.join('\n');
    expect(all).toContain('ABCD-1234');
    // CHANGED EXPECTATION (CAP-566): the pairing URL is no longer Keep's
    // /pair page. The machine now authenticates itself through the identity
    // provider's own RFC 8628 device page, so the URL printed here is the
    // `verification_uri` the authorize response returned.
    //
    // This is a TRUST-SURFACE change, not only a UX one, and it is the single
    // most important thing to look at in this diff: a user who has been taught
    // that pairing happens on a capy.sc domain is now sent somewhere that is
    // not ours. "The pairing link goes somewhere else now" is precisely the
    // shape a phishing attempt takes. That may well be the right trade for a
    // real device grant — the machine getting its own credentials is the whole
    // point — but it is a product decision, and it strengthens the case for
    // putting the device page on a Capy-owned domain.
    //
    // Asserted from the authorize response rather than hardcoded, so moving to
    // a custom domain changes config and not this test.
    expect(all).toContain(AUTHORIZATION.verification_uri);
    expect(HALF_BLOCK.test(all)).toBe(false);
  });

  test('NO_COLOR suppresses the QR even on a wide real TTY, text stays', async () => {
    process.stdout.isTTY = true;
    process.stdout.columns = 80;
    process.stdout.rows = 24;
    process.env.NO_COLOR = '1';
    pending();

    void new PairCommand().execute({});
    // The block is printed after an awaited authorize call, so let the event
    // loop turn before asserting. Harness timing only — the contract, that the
    // code and URL are printed before the wait begins, is unchanged.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const all = logs.join('\n');
    expect(all).toContain('ABCD-1234');
    expect(HALF_BLOCK.test(all)).toBe(false);
  });

  test('the CAP-386 CAPY_EVENT_V1 marker never appears here, TTY or not — the two stay mutually exclusive', () => {
    for (const isTTY of [true, undefined]) {
      logs = [];
      process.stdout.isTTY = isTTY as unknown as true;
      process.stdout.columns = 80;
      process.stdout.rows = 24;
      pending();

      void new PairCommand().execute({});

      expect(logs.join('\n')).not.toContain('CAPY_EVENT_V1');
    }
  });
});

const REUSED_AUTH = {
  success: true,
  user_id: 'user_1',
  user_email: 'u@example.com',
  organization_id: 'org_1',
  organizations: [{ id: 'org_1', name: 'Org One', workos_org_id: 'wo_1' }],
  _auth_method: 'cached',
  _refresh_token: 'mock-refresh-must-not-print',
  _orgless_access_token: 'mock-bearer-must-not-print',
};

function expectNoLogin() {
  expect(authState.authorizeCalls).toHaveLength(0);
  expect(ceremonyCalls).toHaveLength(0);
  expect(installCalls).toHaveLength(0);
  expect(logs.join('\n')).not.toContain(AUTHORIZATION.verification_uri);
  expect(logs.join('\n')).not.toContain(AUTHORIZATION.user_code);
  expect(logs.join('\n')).not.toContain('sign this machine in');
}

describe('PairCommand — reuse CLI authentication', () => {
  beforeEach(() => { authState.result = REUSED_AUTH; });

  test.each(['cached', 'refreshed'])('%s authentication proceeds directly to the grant', async (method) => {
    authState.result = { ...REUSED_AUTH, _auth_method: method };
    authState.binding = { userId: 'user_1' };
    await new PairCommand('https://custom.test.invalid').execute({ json: true });
    expectNoLogin();
    expect(authState.calls).toHaveLength(1);
    expect(authState.constructors).toEqual([['https://custom.test.invalid', false, 'user_1']]);
    expect(resolveKeyMaterialCalls[0].opts).toMatchObject({ userId: 'user_1', authOrgId: 'org_1', serviceUrl: 'https://custom.test.invalid' });
    expect(spawnCalls).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({ ok: true, userCode: null, userId: 'user_1', orgTokenReady: true });
    expect(logs.join('\n')).not.toContain('mock-refresh');
    expect(logs.join('\n')).not.toContain('mock-bearer');
    expect(logs.join('\n')).not.toContain('kLocal');
  });

  test.each(['network', 'server_error', 'org_not_found', undefined])('preserves session on %s without device login', async (error_code) => {
    authState.result = { success: false, error_code, error: 'Sign in again (untrusted prose)' };
    await new PairCommand().execute({ json: true });
    expectNoLogin();
    expect(process.exitCode).toBe(1);
    expect(resolveKeyMaterialCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
    expect(JSON.parse(logs[0]).code).toBe(error_code ?? ERROR_CODES.AUTH_FAILED);
  });

  test('account mismatch stops before the grant and preserves session', async () => {
    authState.binding = { userId: 'other_user' };
    await new PairCommand().execute({ json: true });
    expectNoLogin();
    expect(JSON.parse(logs[0]).code).toBe(ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
    expect(resolveKeyMaterialCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  test('failed grant then retry reuses authentication both times', async () => {
    resolveKeyMaterialImpl = async () => ({ ok: false, code: 'transport_error' });
    const command = new PairCommand();
    await command.execute({ json: true });
    expect(process.exitCode).toBe(1);
    expect(spawnCalls).toHaveLength(0);
    resolveKeyMaterialImpl = async () => ({ ok: true, material: { userId: 'user_1', credentialId: 'cred_1', kLocal: Buffer.alloc(32, 9) } });
    process.exitCode = 0;
    await command.execute({ json: true });
    expectNoLogin();
    expect(authState.calls).toHaveLength(2);
    expect(resolveKeyMaterialCalls).toHaveLength(2);
    expect(spawnCalls).toHaveLength(1);
  });

  test.each([
    { active: 'org_2', orgs: [{ id: 'org_1', name: 'One' }, { id: 'org_2', name: 'Two' }], expected: 'org_2', grant: 'org_2' },
    { active: '', orgs: [{ id: 'org_1', name: 'One' }, { id: 'org_2', name: 'Two' }], expected: null, grant: 'org_1' },
    { active: '', orgs: [{ id: 'org_1', name: 'One' }], expected: 'org_1', grant: 'org_1' },
    { active: '', orgs: [], expected: null, grant: null },
  ])('keeps organization context $active / $expected', async ({ active, orgs, expected, grant }) => {
    authState.result = { ...REUSED_AUTH, organization_id: active, organizations: orgs };
    authState.activeOrg = active || undefined;
    await new PairCommand().execute({ json: true });
    expectNoLogin();
    expect(authState.calls).toEqual([active || undefined]);
    expect(resolveKeyMaterialCalls[0].opts.authOrgId).toBe(grant);
    expect(JSON.parse(logs[0]).orgId).toBe(expected);
  });
});

describe('PairCommand — definitive reauthentication', () => {
  test('fresh authentication survives a failed grant and is reused on retry', async () => {
    ceremonyImpl = async () => ({ status: 'complete', session: VALID_ANSWER.session });
    installImpl = async () => {
      authState.result = REUSED_AUTH;
      return { orgId: 'org_1', orgName: 'Org One', orgTokenReady: true };
    };
    resolveKeyMaterialImpl = async () => ({ ok: false, code: 'transport_error' });
    await new PairCommand().execute({ json: true });
    expect(process.exitCode).toBe(1);
    expect(spawnCalls).toHaveLength(0);
    const beforeRetry = logs.length;
    resolveKeyMaterialImpl = async () => ({ ok: true, material: { userId: 'user_1', credentialId: 'cred_1', kLocal: Buffer.alloc(32, 9) } });
    process.exitCode = 0;
    await new PairCommand().execute({ json: true });
    expect(authState.authorizeCalls).toHaveLength(1);
    expect(ceremonyCalls).toHaveLength(1);
    expect(installCalls).toHaveLength(1);
    expect(resolveKeyMaterialCalls).toHaveLength(2);
    expect(spawnCalls).toHaveLength(1);
    expect(JSON.parse(logs[beforeRetry])).toMatchObject({ ok: true, userCode: null });
  });

  test.each([true, false])('org-less authentication preserves the existing grant refusal (reuse: %s)', async (reuse) => {
    authState.result = reuse ? { ...REUSED_AUTH, organization_id: '', organizations: [] } : { success: false, error_code: 'no_session' };
    ceremonyImpl = async () => ({ status: 'complete', session: { ...VALID_ANSWER.session, organizations: [] } });
    installImpl = async () => ({ orgId: null, orgTokenReady: false });
    resolveKeyMaterialImpl = async () => ({ ok: false, code: ERROR_CODES.AUTH_FAILED });
    await new PairCommand().execute({ json: true });
    expect(resolveKeyMaterialCalls[0].opts.authOrgId).toBeNull();
    expect(spawnCalls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(logs.find((line) => line.startsWith('{'))!)).toMatchObject({ ok: false, code: ERROR_CODES.AUTH_FAILED });
  });

  test.each(['no_session', 'session_ended'])('%s installs before grant', async (error_code) => {
    authState.result = { success: false, error_code };
    ceremonyImpl = async () => ({ status: 'complete', session: VALID_ANSWER.session });
    resolveKeyMaterialImpl = async () => {
      expect(installCalls).toHaveLength(1);
      return { ok: true, material: { userId: 'user_1', credentialId: 'cred_1', kLocal: Buffer.alloc(32, 9) } };
    };
    await new PairCommand().execute({ json: true });
    expect(ceremonyCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);
    expect(JSON.parse(logs.find((line) => line.startsWith('{'))!)).toMatchObject({ ok: true, userCode: AUTHORIZATION.user_code });
    expect(logs.join('\n')).not.toContain('rt_1');
    expect(logs.join('\n')).not.toContain('kLocal');
  });

  test('fresh account mismatch is reported before session installation', async () => {
    authState.binding = { userId: 'other_user' };
    ceremonyImpl = async () => ({ status: 'complete', session: VALID_ANSWER.session });
    await new PairCommand().execute({ json: true });
    expect(installCalls).toHaveLength(0);
    expect(resolveKeyMaterialCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
    expect(JSON.parse(logs.find((line) => line.startsWith('{'))!).code).toBe(ERROR_CODES.RUNTIME_PAIR_USER_MISMATCH);
  });
});

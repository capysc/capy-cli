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

mock.module('../../src/config/profileConfig', () => ({
  resolveActiveUrl: () => 'https://api.test.invalid',
}));

let ceremonyImpl: (opts: any) => Promise<any> = async () => {
  throw new Error('ceremonyImpl not configured for this test');
};
const ceremonyCalls: any[] = [];
mock.module('../../src/auth/pairing/pairCeremony', () => ({
  runPairCeremony: async (opts: any) => {
    ceremonyCalls.push(opts);
    return ceremonyImpl(opts);
  },
  PAIR_TTL_SECONDS: 900,
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
mock.module('../../src/auth/pairing/pairKeyMaterial', () => ({
  resolvePairedKeyMaterial: async (answer: any, opts: any) => {
    resolveKeyMaterialCalls.push({ answer, opts });
    return resolveKeyMaterialImpl(answer, opts);
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
  ceremonyCalls.length = 0;
  installCalls.length = 0;
  resolveKeyMaterialCalls.length = 0;
  spawnCalls.length = 0;
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

describe('PairCommand — flag off', () => {
  test('refuses before ever contacting the ceremony engine', async () => {
    delete process.env.CAPY_DEVICE_KEYS;
    await expect(new PairCommand().execute({})).rejects.toBeInstanceOf(ExitError);
    expect(ceremonyCalls.length).toBe(0);
    expect(installCalls.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
  });
});

describe('PairCommand — answered', () => {
  test('installs the session and spawns the grant daemon with the right key material', async () => {
    ceremonyImpl = async (opts: any) => {
      opts.onCodeReady('ABCD-1234');
      return { kind: 'answered', answer: VALID_ANSWER, userCode: 'ABCD-1234' };
    };

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
    ceremonyImpl = async (opts: any) => {
      opts.onCodeReady('ABCD-1234');
      return { kind: 'answered', answer: VALID_ANSWER, userCode: 'ABCD-1234' };
    };

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
    ceremonyImpl = async (opts: any) => {
      opts.onCodeReady('ABCD-1234');
      return { kind: 'answered', answer: VALID_ANSWER, userCode: 'ABCD-1234' };
    };

    await new PairCommand().execute({ ttlMinutes: 5 });
    expect(spawnCalls[0].opts.ttlMs).toBe(5 * 60_000);
  });

  test('a coded key-material resolution failure (e.g. malformed PRF output) is rejected before spawning a daemon', async () => {
    ceremonyImpl = async (opts: any) => {
      opts.onCodeReady('ABCD-1234');
      return { kind: 'answered', answer: VALID_ANSWER, userCode: 'ABCD-1234' };
    };
    resolveKeyMaterialImpl = async () => ({ ok: false, code: ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED });

    await new PairCommand().execute({});
    expect(spawnCalls.length).toBe(0);
    expect((process as any).exitCode).toBe(1);
  });

  test('the session installs BEFORE key material is resolved — the fetch authenticates with the just-installed session', async () => {
    ceremonyImpl = async (opts: any) => {
      opts.onCodeReady('ABCD-1234');
      return { kind: 'answered', answer: VALID_ANSWER, userCode: 'ABCD-1234' };
    };

    await new PairCommand().execute({});
    expect(installCalls.length).toBe(1);
    expect(resolveKeyMaterialCalls.length).toBe(1);
    expect(resolveKeyMaterialCalls[0].answer).toEqual(VALID_ANSWER);
    // installImpl (above) resolves { orgId: 'org_1', ... } — that's the org
    // pairKeyMaterial.ts should authenticate the wrapper fetch against.
    expect(resolveKeyMaterialCalls[0].opts.authOrgId).toBe('org_1');
  });

  test('a non-interactive multi-org install (orgId: null) still authenticates the key-material fetch, against answer.keyMaterial.orgId', async () => {
    installImpl = async () => ({ orgId: null, orgTokenReady: false });
    ceremonyImpl = async (opts: any) => {
      opts.onCodeReady('ABCD-1234');
      return { kind: 'answered', answer: VALID_ANSWER, userCode: 'ABCD-1234' };
    };

    await new PairCommand().execute({});
    expect(resolveKeyMaterialCalls.length).toBe(1);
    // VALID_ANSWER's keyMaterial.orgId is 'org_1' — the fallback when
    // install.orgId is null (see pairCommand.ts's finish()).
    expect(resolveKeyMaterialCalls[0].opts.authOrgId).toBe('org_1');
  });
});

describe('PairCommand — expired', () => {
  test('exits EXIT_NEEDS_INPUT (3), coded, and installs nothing', async () => {
    ceremonyImpl = async (opts: any) => {
      opts.onCodeReady('ZZZZ-9999');
      return { kind: 'expired', userCode: 'ZZZZ-9999' };
    };

    await expect(new PairCommand().execute({})).rejects.toMatchObject({ code: 3 });
    expect(installCalls.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
    expect(errs.some((l) => l.includes('expired'))).toBe(true);
  });

  test('--json emits the PAIR_CODE_EXPIRED code', async () => {
    ceremonyImpl = async (opts: any) => {
      opts.onCodeReady('ZZZZ-9999');
      return { kind: 'expired', userCode: 'ZZZZ-9999' };
    };

    await expect(new PairCommand().execute({ json: true })).rejects.toBeInstanceOf(ExitError);
    const jsonStart = logs.findIndex((l) => l.trim().startsWith('{'));
    const parsed = JSON.parse(logs.slice(jsonStart).join('\n'));
    expect(parsed).toEqual({ ok: false, code: ERROR_CODES.PAIR_CODE_EXPIRED, userCode: 'ZZZZ-9999' });
  });
});

describe('PairCommand — declined/cancelled/error', () => {
  test('a CeremonyFailure code exits 1 and installs nothing', async () => {
    ceremonyImpl = async (opts: any) => {
      opts.onCodeReady('CCCC-1111');
      return { kind: 'failure', code: 'cancelled', userCode: 'CCCC-1111' };
    };

    await new PairCommand().execute({});
    expect((process as any).exitCode).toBe(1);
    expect(installCalls.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
  });
});

describe('PairCommand — bootstrap failure before any code is ever shown', () => {
  test('a thrown bootstrap error exits 1, prints no pairing code, installs nothing', async () => {
    ceremonyImpl = async () => {
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
    ceremonyImpl = async (opts: any) => {
      opts.onCodeReady('ABCD-1234');
      return { kind: 'answered', answer: VALID_ANSWER, userCode: 'ABCD-1234' };
    };
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
    ceremonyImpl = (opts: any) =>
      new Promise(() => {
        opts.onCodeReady('QR12-3456');
      });
  }

  test('a wide real TTY gets the QR alongside the unconditional plain text', () => {
    process.stdout.isTTY = true;
    process.stdout.columns = 80;
    process.stdout.rows = 24;
    delete process.env.NO_COLOR;
    pending();

    void new PairCommand().execute({});

    const all = logs.join('\n');
    expect(all).toContain('QR12-3456');
    expect(all).toContain('keep.capy.sc/pair');
    expect(HALF_BLOCK.test(all)).toBe(true);
  });

  test('a piped, non-TTY stdout gets the plain text but never the QR', () => {
    process.stdout.isTTY = undefined as unknown as true; // spawned-process shape
    process.stdout.columns = 80;
    process.stdout.rows = 24;
    pending();

    void new PairCommand().execute({});

    const all = logs.join('\n');
    expect(all).toContain('QR12-3456');
    expect(all).toContain('keep.capy.sc/pair');
    expect(HALF_BLOCK.test(all)).toBe(false);
  });

  test('a narrow real TTY falls back to plain text only — no QR, no crash', () => {
    process.stdout.isTTY = true;
    process.stdout.columns = 10;
    process.stdout.rows = 24;
    pending();

    void new PairCommand().execute({});

    const all = logs.join('\n');
    expect(all).toContain('QR12-3456');
    expect(all).toContain('keep.capy.sc/pair');
    expect(HALF_BLOCK.test(all)).toBe(false);
  });

  test('NO_COLOR suppresses the QR even on a wide real TTY, text stays', () => {
    process.stdout.isTTY = true;
    process.stdout.columns = 80;
    process.stdout.rows = 24;
    process.env.NO_COLOR = '1';
    pending();

    void new PairCommand().execute({});

    const all = logs.join('\n');
    expect(all).toContain('QR12-3456');
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

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
    kLocal: Buffer.alloc(32, 9).toString('base64'),
    kdfVersion: '1',
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
  spawnCalls.length = 0;
  installImpl = async () => ({ orgId: 'org_1', orgName: 'Org One', orgTokenReady: true });
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

  test('malformed key material (wrong length) is rejected before spawning a daemon', async () => {
    const badAnswer = { ...VALID_ANSWER, keyMaterial: { ...VALID_ANSWER.keyMaterial, kLocal: Buffer.alloc(4).toString('base64') } };
    ceremonyImpl = async (opts: any) => {
      opts.onCodeReady('ABCD-1234');
      return { kind: 'answered', answer: badAnswer, userCode: 'ABCD-1234' };
    };

    await new PairCommand().execute({});
    expect(spawnCalls.length).toBe(0);
    expect((process as any).exitCode).toBe(1);
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

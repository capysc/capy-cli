/**
 * `capy pair` in agent mode (short runs, `link` elicitation) at the command level.
 *
 * Real: the pending-grant file (under a temp home), the pair key pair (exported to the file and restored by the wait
 * run), `deviceGrant` (talking to a stubbed `fetch`), the envelope opening and the key-file writes. Mocked: `AuthService`
 * and `ServiceClient` (no service), and `os.homedir` so the files land in a temp dir. The clock and sleep are injected, so
 * nothing really waits.
 */
import { mock, jest, describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { webcrypto } from 'crypto';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import { PAIR_AAD, type PairEnvelope } from '../../src/crypto/pairCrypto';
import type { PairingPayload } from '../../src/crypto/pairingPayload';

const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-pair-agent-'));
mock.module('os', () => {
  const actual = require('os');
  const patched = { ...actual, homedir: () => tempHome };
  return { ...patched, default: patched };
});

const mockInstallDeviceGrantSession = jest.fn();
const mockAuthenticateSilent = jest.fn();
const mockGetValidToken = jest.fn();
const realAuthService = await import('../../src/auth/authService');
mock.module('../../src/auth/authService', () => ({
  ...realAuthService,
  AuthService: jest.fn().mockImplementation(() => ({
    installDeviceGrantSession: mockInstallDeviceGrantSession,
    authenticateSilent: mockAuthenticateSilent,
    getValidToken: mockGetValidToken,
  })),
}));

const mockPickupDevicePairing = jest.fn();
const realServiceClient = await import('../../src/service/serviceClient');
mock.module('../../src/service/serviceClient', () => ({
  ...realServiceClient,
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: jest.fn(),
    pickupDevicePairing: mockPickupDevicePairing,
  })),
}));

const { pairAgentCommand, accountMatches, normalizeEmail, PAIR_WAIT_CEILING_MS } = await import('../../src/commands/pairAgentCommand');
const { getPairPendingPath, getGlobalCapyDir, getAuthSessionPath, getLocalRootPath, getOrgKeyPath, readLocalRoot } = await import('../../src/config/globalConfig');
const { PAIR_DEFAULT_PURPOSE } = await import('../../src/commands/pairCommand');
const { exportPairKeyPair, generatePairKeyPair, importPairKeyPair } = await import('../../src/crypto/pairCrypto');

/** Thrown by the `process.exit` spy, so a refusal's exit code is a field, never message text. */
class ExitSignal extends Error {
  constructor(readonly exitCode: number) {
    super('exit');
  }
}

const originalFetch = globalThis.fetch;
const BIN = process.env.CAPY_BIN_NAME ?? 'capy';
const USER = { id: 'user-456', email: 'mike@example.com', first_name: null, last_name: null };
const AUTHORIZE_BODY = { device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://x/verify', expires_in: 600, interval: 5 };
const APPROVED = { status: 200, body: { token: { access_token: 'jwt-secret', refresh_token: 'rt-secret', expires_in: 600 }, user: USER, organizations: [{ id: 'org-123', workos_org_id: 'wo_1', name: 'Acme' }] } };
const PENDING = { status: 200, body: { status: 'pending', code: 'authorization_pending' } };
const SLOW_DOWN = { status: 200, body: { status: 'pending', code: 'slow_down' } };
const EXPIRED = { status: 400, body: { status: 'denied', code: 'expired_token' } };
const DENIED = { status: 400, body: { status: 'denied', code: 'access_denied' } };

type Wire = { readonly status: number; readonly body: unknown };

/** Stubs `fetch`: `/auth/device/authorize` answers `authorize`; each `/auth/device/token` takes the next of `tokens` (the last one repeats). */
function stubFetch(tokens: readonly Wire[], authorize: Record<string, unknown> = AUTHORIZE_BODY) {
  const iterator = tokens[Symbol.iterator]();
  const last = tokens[tokens.length - 1];
  const respond = ({ status, body }: Wire) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
  const fn = jest.fn(async (url: string) => {
    if (url.endsWith('/auth/device/authorize')) return respond({ status: 200, body: authorize });
    const { value, done } = iterator.next();
    return respond(done ? last : value);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function callsTo(fetchMock: ReturnType<typeof stubFetch>, suffix: string): readonly unknown[][] {
  return (fetchMock.mock.calls as unknown[][]).filter(([url]) => String(url).endsWith(suffix));
}

/** The public key the start run sent to `/auth/device/authorize`, from the stub's own call log. */
function sentPublicKey(fetchMock: ReturnType<typeof stubFetch>): Buffer {
  const [, init] = callsTo(fetchMock, '/auth/device/authorize')[0] as [string, { body: string }];
  return Buffer.from(JSON.parse(init.body).public_key, 'base64url');
}

/** A fake clock: `now` is the start plus every ms slept so far, read from the sleep mock's own call log. */
function fakeClock(start = Date.now()) {
  const sleep = jest.fn(async (_ms: number) => {});
  const now = () => start + (sleep.mock.calls as number[][]).reduce((total, [ms]) => total + ms, 0);
  return { sleep, now };
}

type Ran = { readonly exit: number; readonly stdout: string; readonly json: any };

async function run(options: Parameters<typeof pairAgentCommand>[0], deps: Parameters<typeof pairAgentCommand>[1] = fakeClock()): Promise<Ran> {
  const log = spyOn(console, 'log').mockImplementation((() => {}) as any);
  const err = spyOn(console, 'error').mockImplementation((() => {}) as any);
  try {
    const exit = await pairAgentCommand(options, deps).then(
      () => 0,
      (error: unknown) => {
        if (error instanceof ExitSignal) return error.exitCode;
        throw error;
      },
    );
    const stdout = (log.mock.calls as unknown[][]).map((args) => args.join(' ')).join('\n');
    return { exit, stdout, json: JSON.parse(stdout) };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

async function sealAsBrowser(payload: PairingPayload, recipientPublicKeyRaw: Buffer): Promise<string> {
  const recipientKey = await webcrypto.subtle.importKey('raw', recipientPublicKeyRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ephemeral = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epkRaw = Buffer.from(await webcrypto.subtle.exportKey('raw', ephemeral.publicKey));
  const sharedBits = await webcrypto.subtle.deriveBits({ name: 'ECDH', public: recipientKey }, ephemeral.privateKey, 256);
  const material = await webcrypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const aesKey = await webcrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('capy:pair:v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: PAIR_AAD, tagLength: 128 }, aesKey, new TextEncoder().encode(JSON.stringify(payload))));
  const envelope: PairEnvelope = { v: 1, epk: epkRaw.toString('base64url'), iv: Buffer.from(iv).toString('base64url'), ct: ct.toString('base64url') };
  return JSON.stringify(envelope);
}

const PAYLOAD: PairingPayload = {
  v: 1,
  entries: [{
    org_id: 'org-123',
    user_id: USER.id,
    k_local: Buffer.alloc(32, 5).toString('base64url'),
    key_enc: JSON.stringify({ version: '2.0', org_id: 'org-123', encrypted_master_key: 'blob', wrapping_method: 'local_root', created_at: '2026-09-29T00:00:00.000Z' }),
  }],
};

const pendingExists = (): boolean => existsSync(getPairPendingPath());
const pendingRaw = (): string => readFileSync(getPairPendingPath(), 'utf8');
const keysWritten = (): boolean => existsSync(getLocalRootPath('org-123', USER.id)) || existsSync(getOrgKeyPath('org-123', USER.id));

describe('capy pair, agent mode', () => {
  spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as any);

  beforeEach(() => {
    jest.clearAllMocks();
    // Never clear anything that is not the temp home (a real ~/.capy holds recovery-equivalent keys).
    if (!getGlobalCapyDir().startsWith(tempHome)) throw new Error('the home directory mock is not in effect');
    rmSync(getGlobalCapyDir(), { recursive: true, force: true });
    mockInstallDeviceGrantSession.mockResolvedValue({ success: true, organization_id: 'org-123', user_id: USER.id });
    mockAuthenticateSilent.mockResolvedValue({ success: true, organization_id: 'org-123', user_id: USER.id });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe('no expected account', () => {
    test('exits 3 with a form for the email, and contacts nothing', async () => {
      const fetchMock = stubFetch([PENDING]);
      const ran = await run({ json: true });
      expect(ran.exit).toBe(3);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(pendingExists()).toBe(false);
      expect(ran.json.ok).toBe(false);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_EMAIL_REQUIRED);
      expect(ran.json.elicitation.kind).toBe('form');
      expect(ran.json.elicitation.fields.map((f: { name: string }) => f.name)).toEqual(['email']);
      expect(ran.json.elicitation.answer).toEqual({ rerun: `${BIN} pair --email <email>` });
    });

    test('an empty or blank --email is the same as none', async () => {
      const fetchMock = stubFetch([PENDING]);
      const ran = await run({ email: '   ' });
      expect(ran.exit).toBe(3);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_EMAIL_REQUIRED);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('start run', () => {
    test('exits 3 at once with a link elicitation, polls nothing, and saves a 0600 pending file with no token in it', async () => {
      const fetchMock = stubFetch([APPROVED]);
      const ran = await run({ email: 'mike@example.com' });
      expect(ran.exit).toBe(3);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(0);
      expect(ran.json.ok).toBe(false);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_APPROVAL_PENDING);
      const { elicitation } = ran.json;
      expect(Object.keys(elicitation).toSorted()).toEqual(['answer', 'code', 'expires_at', 'kind', 'purpose', 'url']);
      expect(elicitation.kind).toBe('link');
      expect(elicitation.code).toBe('ABCD-EFGH');
      expect(elicitation.url).toContain('/device?code=ABCD-EFGH');
      expect(Number.isNaN(Date.parse(elicitation.expires_at))).toBe(false);
      expect(typeof elicitation.purpose).toBe('string');
      expect(elicitation.answer).toEqual({ wait: `${BIN} pair --wait` });
      // Nothing secret reaches stdout.
      expect(ran.stdout).not.toContain('device-1');

      expect(pendingExists()).toBe(true);
      expect(statSync(getPairPendingPath()).mode & 0o777).toBe(0o600);
      expect(getPairPendingPath()).toBe(join(getGlobalCapyDir(), 'pair', 'pending.json'));
      const file = pendingRaw();
      expect(file).not.toContain('access_token');
      expect(file).not.toContain('refresh_token');
      expect(file).not.toContain('jwt-secret');
      expect(JSON.parse(file).expected_email).toBe('mike@example.com');
    });

    test('the displayed purpose is the default pairing purpose', async () => {
      stubFetch([PENDING]);
      const ran = await run({ email: 'a@b.co' });
      expect(ran.json.elicitation.purpose).toBe(PAIR_DEFAULT_PURPOSE);
    });

    test('a start run while a pending file exists replaces it', async () => {
      stubFetch([PENDING], { ...AUTHORIZE_BODY, device_code: 'device-first' });
      await run({ email: 'a@b.co' });
      expect(JSON.parse(pendingRaw()).device_code).toBe('device-first');
      stubFetch([PENDING], { ...AUTHORIZE_BODY, device_code: 'device-second' });
      await run({ email: 'a@b.co' });
      expect(JSON.parse(pendingRaw()).device_code).toBe('device-second');
      expect(statSync(getPairPendingPath()).mode & 0o777).toBe(0o600);
    });

    test('a refused authorize is a coded error and leaves no pending file', async () => {
      globalThis.fetch = (async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad', code: 'INVALID_FORMAT' }) }) as Response) as typeof fetch;
      const ran = await run({ email: 'a@b.co' });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.INVALID_FORMAT);
      expect(pendingExists()).toBe(false);
    });
  });

  describe('wait run', () => {
    /** Runs the start run, then swaps in the token responses for the wait run. */
    async function startThenStub(email: string, tokens: readonly Wire[], extra: Parameters<typeof pairAgentCommand>[0] = {}) {
      const startFetch = stubFetch([PENDING]);
      await run({ email, ...extra });
      const publicKey = sentPublicKey(startFetch);
      mockPickupDevicePairing.mockImplementation(async () => ({ sealed: await sealAsBrowser(PAYLOAD, publicKey) }));
      return stubFetch(tokens);
    }

    test('approved by the expected account: installs the session, writes the keys, removes the pending file, prints the success JSON', async () => {
      const fetchMock = await startThenStub('mike@example.com', [PENDING, APPROVED]);
      const clock = fakeClock();
      const ran = await run({ wait: true }, clock);
      expect(ran.exit).toBe(0);
      expect(ran.json).toEqual({ ok: true, user_id: USER.id, paired: [{ org_id: 'org-123', user_id: USER.id }] });
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(2);
      expect(clock.sleep).toHaveBeenCalledTimes(1);
      expect(clock.sleep).toHaveBeenCalledWith(5000);
      expect(mockInstallDeviceGrantSession).toHaveBeenCalledTimes(1);
      expect(mockInstallDeviceGrantSession.mock.calls[0][0]).toEqual({ access_token: 'jwt-secret', refresh_token: 'rt-secret', expires_in: 600 });
      expect(mockPickupDevicePairing).toHaveBeenCalledWith('device-1');
      expect(readLocalRoot('org-123', USER.id)?.equals(Buffer.alloc(32, 5))).toBe(true);
      expect(existsSync(getOrgKeyPath('org-123', USER.id))).toBe(true);
      expect(pendingExists()).toBe(false);
    });

    test('returns at the first poll when the grant is already approved, without sleeping', async () => {
      await startThenStub('mike@example.com', [APPROVED]);
      const clock = fakeClock();
      const ran = await run({ wait: true }, clock);
      expect(ran.exit).toBe(0);
      expect(clock.sleep).not.toHaveBeenCalled();
    });

    test('the email is compared case- and whitespace-insensitively', async () => {
      await startThenStub('  MIKE@Example.COM  ', [APPROVED]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(0);
      expect(ran.json.ok).toBe(true);
      expect(mockInstallDeviceGrantSession).toHaveBeenCalledTimes(1);
    });

    test('approved by a different email: PAIR_ACCOUNT_MISMATCH, nothing installed, pending file gone', async () => {
      await startThenStub('someone.else@example.com', [APPROVED]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(1);
      expect(ran.json).toEqual({ ok: false, code: ERROR_CODES.PAIR_ACCOUNT_MISMATCH, error: expect.any(String) });
      expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
      expect(mockPickupDevicePairing).not.toHaveBeenCalled();
      expect(existsSync(getAuthSessionPath(USER.id))).toBe(false);
      expect(existsSync(getAuthSessionPath())).toBe(false);
      expect(keysWritten()).toBe(false);
      expect(pendingExists()).toBe(false);
      expect(ran.stdout).not.toContain('mike@example.com');
    });

    test('an email that merely contains the expected one is a mismatch', async () => {
      await startThenStub('ike@example.com', [APPROVED]);
      const ran = await run({ wait: true });
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_ACCOUNT_MISMATCH);
      expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
    });

    test('a different local key is refused without --force carried from the start run, and the pending file is gone', async () => {
      await startThenStub('mike@example.com', [APPROVED]);
      const { saveLocalRoot } = await import('../../src/config/globalConfig');
      saveLocalRoot('org-123', Buffer.alloc(32, 9), USER.id);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_LOCAL_KEY_CONFLICT);
      expect(pendingExists()).toBe(false);
    });

    test('--force given to the start run is applied by the wait run', async () => {
      await startThenStub('mike@example.com', [APPROVED], { force: true });
      const { saveLocalRoot } = await import('../../src/config/globalConfig');
      saveLocalRoot('org-123', Buffer.alloc(32, 9), USER.id);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(0);
      expect(readLocalRoot('org-123', USER.id)?.equals(Buffer.alloc(32, 5))).toBe(true);
    });

    test('still pending at the ceiling: exits 3 with the same link, the still-waiting code and the same wait command; the file is kept', async () => {
      stubFetch([PENDING]);
      const started = await run({ email: 'mike@example.com' });
      const fetchMock = stubFetch([PENDING]);
      const clock = fakeClock();
      const ran = await run({ wait: true }, { ...clock, ceilingMs: PAIR_WAIT_CEILING_MS });
      expect(PAIR_WAIT_CEILING_MS).toBe(30_000);
      expect(ran.exit).toBe(3);
      expect(ran.json.ok).toBe(false);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect(ran.json.elicitation).toEqual(started.json.elicitation);
      expect(ran.json.elicitation.answer).toEqual({ wait: `${BIN} pair --wait` });
      expect(pendingExists()).toBe(true);
      // Polls at 0,5,...,25 seconds, then one more interval so the next run never polls early: 30 seconds in all.
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(6);
      expect(clock.sleep).toHaveBeenCalledTimes(6);
      expect((clock.sleep.mock.calls as number[][]).reduce((total, [ms]) => total + ms, 0)).toBe(30_000);
    });

    test('a slow_down adds 5 seconds to the interval, and the longer interval is kept for the next run', async () => {
      await startThenStub('mike@example.com', [SLOW_DOWN, PENDING]);
      const clock = fakeClock();
      const ran = await run({ wait: true }, clock);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect((clock.sleep.mock.calls as number[][])[0][0]).toBe(10_000);
      expect(JSON.parse(pendingRaw()).interval_seconds).toBe(10);
    });

    test('an interval longer than the ceiling polls once and says still waiting', async () => {
      stubFetch([PENDING], { ...AUTHORIZE_BODY, interval: 60 });
      await run({ email: 'mike@example.com' });
      const fetchMock = stubFetch([PENDING]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(3);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(1);
    });

    test('an expired grant (service says so): PAIR_EXPIRED, pending file gone, nothing installed', async () => {
      await startThenStub('mike@example.com', [EXPIRED]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_EXPIRED);
      expect(pendingExists()).toBe(false);
      expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
    });

    test('an expired grant (its own expiry has passed): PAIR_EXPIRED without polling', async () => {
      await startThenStub('mike@example.com', [APPROVED]);
      const fetchMock = stubFetch([APPROVED]);
      const clock = fakeClock(Date.now() + 10_000_000);
      const ran = await run({ wait: true }, clock);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_EXPIRED);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(0);
      expect(pendingExists()).toBe(false);
    });

    test('a denied grant: PAIR_DENIED, pending file gone, nothing installed', async () => {
      await startThenStub('mike@example.com', [DENIED]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_DENIED);
      expect(pendingExists()).toBe(false);
      expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
    });

    test('no pending file: PAIR_NOT_PENDING, and nothing is contacted', async () => {
      const fetchMock = stubFetch([APPROVED]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_NOT_PENDING);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('a pending file that cannot be read is PAIR_NOT_PENDING and is removed', async () => {
      stubFetch([PENDING]);
      await run({ email: 'mike@example.com' });
      const { savePairPendingRaw } = await import('../../src/config/globalConfig');
      savePairPendingRaw('{"v":1,"device_code":"x"}');
      const ran = await run({ wait: true });
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_NOT_PENDING);
      expect(pendingExists()).toBe(false);
    });

    test('a service error while polling is coded, and the pending file stays so the agent can wait again', async () => {
      await startThenStub('mike@example.com', [{ status: 500, body: { error: 'boom', code: 'AUTH_FAILED' } }]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.AUTH_FAILED);
      expect(pendingExists()).toBe(true);
    });
  });

  describe('cancel', () => {
    test('removes the pending file', async () => {
      stubFetch([PENDING]);
      await run({ email: 'mike@example.com' });
      expect(pendingExists()).toBe(true);
      const ran = await run({ cancel: true });
      expect(ran.exit).toBe(0);
      expect(ran.json).toEqual({ ok: true, code: ERROR_CODES.PAIR_CANCELLED });
      expect(pendingExists()).toBe(false);
    });

    test('succeeds when there was none', async () => {
      const fetchMock = stubFetch([PENDING]);
      const ran = await run({ cancel: true });
      expect(ran.exit).toBe(0);
      expect(ran.json).toEqual({ ok: true, code: ERROR_CODES.PAIR_CANCELLED });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('who must approve', () => {
  test('normalizeEmail trims and lower-cases', () => {
    expect(normalizeEmail('  Mike@Example.COM\n')).toBe('mike@example.com');
  });

  test('an email matches only on exact equality after normalizing', () => {
    const grant = { expectedEmail: 'mike@example.com' };
    expect(accountMatches(grant, { email: ' MIKE@example.com ' })).toBe(true);
    expect(accountMatches(grant, { email: 'mike@example.com.evil.io' })).toBe(false);
    expect(accountMatches(grant, { email: 'xmike@example.com' })).toBe(false);
    expect(accountMatches(grant, { email: '' })).toBe(false);
  });

});

describe('the pair key pair in the pending file', () => {
  test('survives export and import: the restored key opens what the original public key received', async () => {
    const original = generatePairKeyPair();
    const restored = importPairKeyPair(exportPairKeyPair(original));
    expect(restored.publicKey).toBe(original.publicKey);
    const { openPairEnvelope } = await import('../../src/crypto/pairCrypto');
    const sealed = await sealAsBrowser(PAYLOAD, Buffer.from(original.publicKey, 'base64url'));
    expect(openPairEnvelope(JSON.parse(sealed), restored)).toEqual(PAYLOAD);
  });

  test('a private key that does not belong to the stored public key is refused with a code', () => {
    const a = exportPairKeyPair(generatePairKeyPair());
    const b = exportPairKeyPair(generatePairKeyPair());
    expect(() => importPairKeyPair({ privateKey: a.privateKey, publicKey: b.publicKey })).toThrow(CapyError);
    try {
      importPairKeyPair({ privateKey: a.privateKey, publicKey: b.publicKey });
    } catch (error) {
      expect((error as CapyError).code).toBe(ERROR_CODES.INVALID_FORMAT);
    }
  });
});

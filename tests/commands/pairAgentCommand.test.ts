/**
 * `capy pair` in agent mode (short runs, `link` elicitation) at the command level.
 *
 * Real: the pending-grant file (under a temp home), the pair key pair (exported to the file and restored by the wait
 * run), `deviceGrant` (talking to a stubbed `fetch`), the envelope opening and the key-file writes. Mocked: `AuthService`
 * and `ServiceClient` (no service), and `os.homedir` so the files land in a temp dir. The clock and sleep are injected, so
 * nothing really waits.
 */
import { mock, jest, describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
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
const { getPairPendingPath, getGlobalCapyDir, getAuthSessionPath, getLocalRootPath, getOrgKeyPath, readLocalRoot, saveAuthSession, savePairPendingRaw } = await import('../../src/config/globalConfig');
const { PAIR_DEFAULT_PURPOSE } = await import('../../src/commands/pairCommand');
const { exportPairKeyPair, generatePairKeyPair, importPairKeyPair } = await import('../../src/crypto/pairCrypto');
const { buildTerminalQr } = await import('../../src/ui/terminalQr');
const { removePendingPairGrant } = await import('../../src/auth/pairing/pendingGrant');

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

const readPairFileOf = (path: string): string => readFileSync(path, 'utf8');
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
    // The real session-writing step: a session file appears on disk exactly when this runs.
    mockInstallDeviceGrantSession.mockImplementation(async (_token: unknown, user: { id: string }) => {
      saveAuthSession({ version: 2, user_id: user.id }, user.id);
      return { success: true, organization_id: 'org-123', user_id: user.id };
    });
    mockAuthenticateSilent.mockResolvedValue({ success: true, organization_id: 'org-123', user_id: USER.id });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // Whatever grant a test left pending keeps a PNG in the system temp dir: take it out with the grant.
    removePendingPairGrant();
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
      expect(Object.keys(elicitation).toSorted()).toEqual(['answer', 'code', 'expires_at', 'kind', 'purpose', 'qr', 'url']);
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
      expect(existsSync(getAuthSessionPath(USER.id))).toBe(true);
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
      // The same link, but its QR is cut down to the PNG's file path.
      expect(ran.json.elicitation).toEqual({
        ...started.json.elicitation,
        qr: { image: { mime_type: 'image/png', file: started.json.elicitation.qr.image.file } },
      });
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

    test('an interval at least as long as the ceiling polls once and returns at once; the next run waits it out without polling', async () => {
      stubFetch([PENDING], { ...AUTHORIZE_BODY, interval: 60 });
      await run({ email: 'mike@example.com' });
      const fetchMock = stubFetch([PENDING]);
      const first = fakeClock();
      const ran = await run({ wait: true }, first);
      expect(ran.exit).toBe(3);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(1);
      expect(first.sleep).not.toHaveBeenCalled();
      expect(JSON.parse(pendingRaw()).interval_seconds).toBe(60);
      const second = fakeClock();
      const again = await run({ wait: true }, second);
      expect(again.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(1);
      expect(second.sleep).not.toHaveBeenCalled();
    });

    test('the interval is respected across runs: the next run sleeps until the saved earliest-next-poll time before it polls', async () => {
      await startThenStub('mike@example.com', [PENDING]);
      const first = await run({ wait: true });
      expect(first.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      const saved = JSON.parse(pendingRaw()).next_poll_at as number;
      expect(saved).toBeGreaterThan(Date.now());
      const fetchMock = stubFetch([APPROVED]);
      // The real first run takes its 30 seconds; the fake one did not, so the second run starts a moment later.
      const clock = fakeClock(Date.now() + 1000);
      const ran = await run({ wait: true }, clock);
      expect(ran.exit).toBe(0);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(1);
      const [[slept]] = clock.sleep.mock.calls as number[][];
      expect(slept).toBeGreaterThan(20_000);
      expect(slept).toBeLessThanOrEqual(30_000);
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

  describe('bounds and hygiene', () => {
    const EMPTY_EMAIL_USER = { ...USER, email: '' };

    async function startThenStubAny(email: string | undefined, tokens: readonly Wire[]) {
      const startFetch = stubFetch([PENDING]);
      await run({ ...(email === undefined ? {} : { email }) });
      mockPickupDevicePairing.mockImplementation(async () => ({ sealed: await sealAsBrowser(PAYLOAD, sentPublicKey(startFetch)) }));
      return stubFetch(tokens);
    }

    test('a start run that replaces a pending file whose mode was loosened to 0644 leaves it at 0600', async () => {
      stubFetch([PENDING]);
      await run({ email: 'mike@example.com' });
      chmodSync(getPairPendingPath(), 0o644);
      expect(statSync(getPairPendingPath()).mode & 0o777).toBe(0o644);
      await run({ email: 'mike@example.com' });
      expect(statSync(getPairPendingPath()).mode & 0o777).toBe(0o600);
    });

    test('a still-waiting rewrite of the pending file holds no token', async () => {
      await startThenStubAny('mike@example.com', [PENDING]);
      const before = pendingRaw();
      await run({ wait: true });
      const after = pendingRaw();
      expect(after).not.toBe(before);
      expect(after).not.toMatch(/token/i);
      expect(after).not.toContain('jwt-secret');
    });

    test('the pending file is private to its global dir name: two names, two paths, and a file under one is invisible to the other', () => {
      const script = (action: string) => `
        import { getPairPendingPath, savePairPendingRaw, readPairPendingRaw } from ${JSON.stringify(join(import.meta.dir, '../../src/config/globalConfig.ts'))};
        ${action}
        console.log(JSON.stringify({ path: getPairPendingPath(), content: readPairPendingRaw() }));`;
      const inDir = (name: string, action: string) => {
        const result = Bun.spawnSync(['bun', '-e', script(action)], { env: { ...process.env, HOME: tempHome, CAPY_GLOBAL_DIR_NAME: name } });
        return JSON.parse(result.stdout.toString().trim().split('\n').at(-1) as string) as { path: string; content: string | null };
      };
      const a = inDir('.capy-iso-a', "savePairPendingRaw('only-in-a');");
      const b = inDir('.capy-iso-b', '');
      const aAgain = inDir('.capy-iso-a', '');
      expect(a.path).not.toBe(b.path);
      expect(a.path).toBe(join(tempHome, '.capy-iso-a', 'pair', 'pending.json'));
      expect(b.path).toBe(join(tempHome, '.capy-iso-b', 'pair', 'pending.json'));
      expect(a.content).toBe('only-in-a');
      expect(b.content).toBeNull();
      expect(aAgain.content).toBe('only-in-a');
      expect(readPairFileOf(a.path)).toBe('only-in-a');
    });

    test('no agent path prints the private key, the device code or a token', async () => {
      const secretsOf = (): readonly string[] => {
        const file = JSON.parse(pendingRaw());
        return [file.pair_private_key, file.device_code];
      };
      const quiet = (ran: Ran, secrets: readonly string[]) => {
        secrets.forEach((secret) => expect(ran.stdout).not.toContain(secret));
        ['jwt-secret', 'rt-secret', 'device-1'].forEach((secret) => expect(ran.stdout).not.toContain(secret));
      };
      stubFetch([PENDING]);
      const form = await run({});
      quiet(form, []);
      const started = await run({ email: 'mike@example.com' });
      const secrets = secretsOf();
      quiet(started, secrets);
      stubFetch([PENDING]);
      quiet(await run({ wait: true }), secrets);
      quiet(await run({ cancel: true }), secrets);
      quiet(await run({ wait: true }), secrets);
      // Mismatch, success, expired and denied.
      await startThenStubAny('other@example.com', [APPROVED]);
      const mismatchSecrets = secretsOf();
      quiet(await run({ wait: true }), mismatchSecrets);
      await startThenStubAny('mike@example.com', [APPROVED]);
      const successSecrets = secretsOf();
      quiet(await run({ wait: true }), successSecrets);
      await startThenStubAny('mike@example.com', [EXPIRED]);
      const expiredSecrets = secretsOf();
      quiet(await run({ wait: true }), expiredSecrets);
      await startThenStubAny('mike@example.com', [DENIED]);
      const deniedSecrets = secretsOf();
      quiet(await run({ wait: true }), deniedSecrets);
    });

    test('a poll that times out is a coded NETWORK_ERROR, the pending file is kept, and the request carried an abort signal', async () => {
      await startThenStubAny('mike@example.com', [PENDING]);
      const fetchMock = jest.fn((_url: string, init: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const before = pendingRaw();
      const ran = await run({ wait: true }, { ...fakeClock(), pollTimeoutMs: 20 });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.NETWORK_ERROR);
      expect(pendingExists()).toBe(true);
      expect(pendingRaw()).toBe(before);
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    test('the authorize request carries no abort signal (the shared request path is unchanged for everyone else)', async () => {
      const fetchMock = stubFetch([PENDING]);
      await run({ email: 'mike@example.com' });
      const [, init] = callsTo(fetchMock, '/auth/device/authorize')[0] as [string, { signal?: AbortSignal }];
      expect(init.signal).toBeUndefined();
    });

    test('an expired pending file is swept by a start run that fails, and by the form path, and by cancel', async () => {
      const expire = () => {
        const file = JSON.parse(pendingRaw());
        savePairPendingRaw(JSON.stringify({ ...file, expires_at: new Date(Date.now() - 1000).toISOString() }));
      };
      stubFetch([PENDING]);
      await run({ email: 'mike@example.com' });
      expire();
      expect(pendingExists()).toBe(true);
      const form = await run({});
      expect(form.json.code).toBe(ERROR_CODES.PAIR_EMAIL_REQUIRED);
      expect(pendingExists()).toBe(false);

      await run({ email: 'mike@example.com' });
      expire();
      globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({ error: 'down', code: 'AUTH_FAILED' }) }) as Response) as typeof fetch;
      const failed = await run({ email: 'mike@example.com' });
      expect(failed.exit).toBe(1);
      expect(pendingExists()).toBe(false);

      stubFetch([PENDING]);
      await run({ email: 'mike@example.com' });
      expire();
      await run({ cancel: true });
      expect(pendingExists()).toBe(false);
    });

    test('a pending file that has not expired is not swept by the form path', async () => {
      stubFetch([PENDING]);
      await run({ email: 'mike@example.com' });
      await run({});
      expect(pendingExists()).toBe(true);
    });

    test('an approving user with no email, or an empty one, cannot satisfy an email expectation: PAIR_ACCOUNT_MISMATCH, nothing installed', async () => {
      const { email: _omitted, ...noEmail } = USER;
      const bodies = [{ ...APPROVED.body, user: noEmail }, { ...APPROVED.body, user: EMPTY_EMAIL_USER }, { ...APPROVED.body, user: { ...USER, email: null } }];
      for (const body of bodies) {
        await startThenStubAny('mike@example.com', [{ status: 200, body }]);
        const ran = await run({ wait: true });
        expect(ran.exit).toBe(1);
        expect(ran.json.code).toBe(ERROR_CODES.PAIR_ACCOUNT_MISMATCH);
        expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
        expect(existsSync(getAuthSessionPath(USER.id))).toBe(false);
        expect(keysWritten()).toBe(false);
        expect(pendingExists()).toBe(false);
      }
    });

    test.each(['not-an-email', 'a b@c.co', 'a@@b.co', '@b.co', 'a@'])('--email %p fails the form field\'s own pattern: the form again, no network call', async (email) => {
      const fetchMock = stubFetch([PENDING]);
      const ran = await run({ email });
      expect(ran.exit).toBe(3);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_EMAIL_REQUIRED);
      expect(ran.json.elicitation.kind).toBe('form');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(pendingExists()).toBe(false);
    });

    test('every email the form accepts is one the form\'s pattern matches', async () => {
      stubFetch([PENDING]);
      const form = await run({});
      const pattern = new RegExp(form.json.elicitation.fields[0].pattern);
      expect(pattern.test('mike@example.com')).toBe(true);
      expect(pattern.test('not-an-email')).toBe(false);
    });

    test.each([
      ['a zero interval', { interval: 0 }],
      ['a negative interval', { interval: -5 }],
      ['a non-numeric interval', { interval: 'soon' }],
      ['no interval', { interval: undefined }],
      ['no expiry at all', { expires_in: undefined }],
      ['a zero expires_in', { expires_in: 0 }],
      ['an unparseable expires_at', { expires_at: 'tomorrow-ish' }],
      ['no user code', { user_code: '' }],
    ])('%s from the service: INVALID_FORMAT and nothing is saved', async (_name, patch) => {
      stubFetch([PENDING], { ...AUTHORIZE_BODY, ...patch });
      const ran = await run({ email: 'mike@example.com' });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.INVALID_FORMAT);
      expect(pendingExists()).toBe(false);
    });

    test('a valid expires_at from the service is kept as the grant\'s expiry', async () => {
      const at = new Date(Date.now() + 120_000).toISOString();
      stubFetch([PENDING], { ...AUTHORIZE_BODY, expires_at: at });
      const ran = await run({ email: 'mike@example.com' });
      expect(ran.json.elicitation.expires_at).toBe(at);
    });
  });

  describe('QR on the link step', () => {
    const URL_OF_GRANT = (): string => JSON.parse(pendingRaw()).device_link as string;
    const pngFileInPending = (): string => JSON.parse(pendingRaw()).qr_file as string;
    const gone = (file: string): boolean => !existsSync(file) && !existsSync(join(file, '..'));

    /** The start run's QR image file, with the start's own response. */
    async function started(email = 'mike@example.com', authorize: Record<string, unknown> = AUTHORIZE_BODY) {
      const fetchMock = stubFetch([PENDING], authorize);
      const ran = await run({ email });
      return { ran, file: ran.json.elicitation.qr.image.file as string, publicKey: sentPublicKey(fetchMock) };
    }

    test('the start run carries qr.text and a qr.image whose file is 0600 and whose data URI is the same PNG bytes', async () => {
      const { ran, file } = await started();
      const { qr, url } = ran.json.elicitation;
      expect(Object.keys(qr).toSorted()).toEqual(['image', 'text']);
      expect(qr.text.length).toBeGreaterThan(0);
      expect(qr.text).toBe(buildTerminalQr(url).text);
      expect(Object.keys(qr.image).toSorted()).toEqual(['data_uri', 'file', 'mime_type']);
      expect(qr.image.mime_type).toBe('image/png');
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const bytes = readFileSync(file);
      expect(qr.image.data_uri).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
      expect(Buffer.from(qr.image.data_uri.slice('data:image/png;base64,'.length), 'base64').equals(bytes)).toBe(true);
      const png = PNG.sync.read(bytes);
      expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(url);
      expect(pngFileInPending()).toBe(file);
    });

    test('the text QR renders off a TTY with NO_COLOR set', () => {
      const script = `
        import { buildTerminalQr } from ${JSON.stringify(join(import.meta.dir, '../../src/ui/terminalQr.ts'))};
        console.log(JSON.stringify(buildTerminalQr('https://keep.capy.sc/device?code=ABCD-EFGH').text.length));`;
      const result = Bun.spawnSync(['bun', '-e', script], { env: { ...process.env, NO_COLOR: '1' }, stdin: 'ignore' });
      expect(Number(result.stdout.toString().trim())).toBeGreaterThan(0);
    });

    test('a start run response holds no device code, private key or token', async () => {
      const { ran } = await started();
      const file = JSON.parse(pendingRaw());
      [file.device_code, file.pair_private_key, 'jwt-secret', 'rt-secret'].forEach((secret) => expect(ran.stdout).not.toContain(secret));
    });

    test('still-waiting carries only the PNG file path: no data URI, no text, no device code or key', async () => {
      const { ran: start, file } = await started();
      stubFetch([PENDING]);
      const ran = await run({ wait: true });
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect(ran.json.elicitation.qr).toEqual({ image: { mime_type: 'image/png', file } });
      expect(ran.stdout).not.toContain('data_uri');
      expect(ran.stdout).not.toContain('data:image');
      expect(ran.stdout).not.toContain(start.json.elicitation.qr.text);
      const pending = JSON.parse(pendingRaw());
      [pending.device_code, pending.pair_private_key].forEach((secret) => expect(ran.stdout).not.toContain(secret));
      expect(existsSync(file)).toBe(true);
    });

    test('still-waiting leaves qr out when the file is gone', async () => {
      const { file } = await started();
      rmSync(file, { force: true });
      stubFetch([PENDING]);
      const ran = await run({ wait: true });
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect(ran.json.elicitation).not.toHaveProperty('qr');
    });

    test('a pending file written without qr_file still works: waiting has no qr, approval completes', async () => {
      const { ran: start, publicKey } = await started();
      const { qr_file: qrFile, ...older } = JSON.parse(pendingRaw());
      savePairPendingRaw(JSON.stringify(older));
      rmSync(qrFile, { force: true });
      stubFetch([PENDING]);
      const waiting = await run({ wait: true });
      expect(waiting.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect(waiting.json.elicitation).not.toHaveProperty('qr');
      expect(waiting.json.elicitation.url).toBe(start.json.elicitation.url);
      mockPickupDevicePairing.mockImplementation(async () => ({ sealed: await sealAsBrowser(PAYLOAD, publicKey) }));
      stubFetch([APPROVED]);
      // The first wait run took its 30 seconds in real life; the fake one did not.
      const approved = await run({ wait: true }, fakeClock(Date.now() + 40_000));
      expect(approved.exit).toBe(0);
      expect(approved.json.ok).toBe(true);
    });

    test('the PNG is gone after approval by the expected account', async () => {
      const { file, publicKey } = await started();
      mockPickupDevicePairing.mockImplementation(async () => ({ sealed: await sealAsBrowser(PAYLOAD, publicKey) }));
      stubFetch([APPROVED]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(0);
      expect(gone(file)).toBe(true);
    });

    test('the PNG is gone after approval by another account', async () => {
      const { file } = await started('someone.else@example.com');
      stubFetch([APPROVED]);
      const ran = await run({ wait: true });
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_ACCOUNT_MISMATCH);
      expect(gone(file)).toBe(true);
    });

    test.each([
      ['an expiry the service reports', EXPIRED, ERROR_CODES.PAIR_EXPIRED],
      ['a denial', DENIED, ERROR_CODES.PAIR_DENIED],
    ])('the PNG is gone after %s', async (_name, wire, code) => {
      const { file } = await started();
      stubFetch([wire]);
      const ran = await run({ wait: true });
      expect(ran.json.code).toBe(code);
      expect(gone(file)).toBe(true);
    });

    test('the PNG is gone after the grant\'s own expiry passes', async () => {
      const { file } = await started();
      stubFetch([APPROVED]);
      const ran = await run({ wait: true }, fakeClock(Date.now() + 10_000_000));
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_EXPIRED);
      expect(gone(file)).toBe(true);
    });

    test('the PNG is gone after --cancel', async () => {
      const { file } = await started();
      const ran = await run({ cancel: true });
      expect(ran.json).toEqual({ ok: true, status: 'cancelled' });
      expect(gone(file)).toBe(true);
    });

    test('the PNG is gone when a later run sweeps the expired grant', async () => {
      const { file } = await started();
      savePairPendingRaw(JSON.stringify({ ...JSON.parse(pendingRaw()), expires_at: new Date(Date.now() - 1000).toISOString() }));
      await run({});
      expect(pendingExists()).toBe(false);
      expect(gone(file)).toBe(true);
    });

    test('the PNG is gone when the pending file cannot be read, as far as it names one', async () => {
      const { file } = await started();
      savePairPendingRaw(JSON.stringify({ v: 1, qr_file: file }));
      const ran = await run({ wait: true });
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_NOT_PENDING);
      expect(gone(file)).toBe(true);
    });

    test('a new start run replaces the grant and the old PNG goes, the new one stays', async () => {
      const first = await started('mike@example.com', { ...AUTHORIZE_BODY, device_code: 'device-first' });
      const second = await started('mike@example.com', { ...AUTHORIZE_BODY, device_code: 'device-second' });
      expect(second.file).not.toBe(first.file);
      expect(gone(first.file)).toBe(true);
      expect(existsSync(second.file)).toBe(true);
      expect(pngFileInPending()).toBe(second.file);
    });

    test('a start run that fails keeps the pending grant and its PNG', async () => {
      const { file } = await started();
      globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({ error: 'down', code: 'AUTH_FAILED' }) }) as Response) as typeof fetch;
      const ran = await run({ email: 'mike@example.com' });
      expect(ran.exit).toBe(1);
      expect(existsSync(file)).toBe(true);
      expect(pngFileInPending()).toBe(file);
    });

    test('the QR encodes the same URL the elicitation shows, and that URL holds the short code only', async () => {
      const { ran } = await started();
      expect(URL_OF_GRANT()).toBe(ran.json.elicitation.url);
      expect(ran.json.elicitation.url).toContain('code=ABCD-EFGH');
      expect(ran.json.elicitation.url).not.toContain('device-1');
    });
  });

  describe('cancel', () => {
    test('removes the pending file', async () => {
      stubFetch([PENDING]);
      await run({ email: 'mike@example.com' });
      expect(pendingExists()).toBe(true);
      const ran = await run({ cancel: true });
      expect(ran.exit).toBe(0);
      expect(ran.json).toEqual({ ok: true, status: 'cancelled' });
      expect(pendingExists()).toBe(false);
    });

    test('succeeds when there was none', async () => {
      const fetchMock = stubFetch([PENDING]);
      const ran = await run({ cancel: true });
      expect(ran.exit).toBe(0);
      expect(ran.json).toEqual({ ok: true, status: 'cancelled' });
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

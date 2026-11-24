/**
 * `capy pair` in agent mode (short runs, `link` elicitation) at the command level.
 *
 * Real: the pending-grant file (under a temp home), the pair key pair (exported to the file and restored by the wait
 * run), `deviceGrant` (talking to a stubbed `fetch`), the envelope opening and the key-file writes. Mocked: `AuthService`
 * and `ServiceClient` (no service), and `os.homedir` so the files land in a temp dir. The clock and sleep are injected, so
 * nothing really waits.
 */
import { mock, jest, describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { webcrypto } from 'crypto';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import { PAIR_LINK_INSTRUCTIONS } from '../../src/ui/pairingPresentation';
import { PAIR_AAD, type PairEnvelope } from '../../src/crypto/pairCrypto';
import type { PairingPayload } from '../../src/crypto/pairingPayload';

const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-pair-agent-'));
mock.module('os', () => {
  const actual = require('os');
  const patched = { ...actual, homedir: () => tempHome };
  return { ...patched, default: patched };
});

/** Every `writeFileSync` goes through this hook, so a test can make writes fail the way a full disk would. Unset, it writes for real. */
const writeFault = { current: null as null | ((path: unknown) => boolean) };
mock.module('fs', () => {
  const actual = require('fs');
  const writeFileSync = (path: unknown, ...rest: unknown[]) => {
    if (writeFault.current?.(path)) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    return actual.writeFileSync(path, ...rest);
  };
  const patched = { ...actual, writeFileSync };
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

// The terminal flow asks a person at the terminal for the code Keep shows (CAP-877).
const mockAskConfirmationCode = jest.fn();
mock.module('../../src/commands/pairConfirmationCode', () => ({ askConfirmationCode: mockAskConfirmationCode }));

const mockPickupDevicePairing = jest.fn();
const realServiceClient = await import('../../src/service/serviceClient');
mock.module('../../src/service/serviceClient', () => ({
  ...realServiceClient,
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: jest.fn(),
    pickupDevicePairing: mockPickupDevicePairing,
  })),
}));

const { pairAgentCommand, PAIR_WAIT_CEILING_MS } = await import('../../src/commands/pairAgentCommand');
const { getPairPendingPath, getGlobalCapyDir, getAuthSessionPath, getLocalRootPath, getOrgKeyPath, readLocalRoot, saveAuthSession, saveLocalRoot, savePairPendingRaw, writeOrgKeyFileRaw } = await import('../../src/config/globalConfig');
const { PAIR_DEFAULT_PURPOSE, pairCommand, pairPurpose } = await import('../../src/commands/pairCommand');
const { exportPairKeyPair, generatePairKeyPair, importPairKeyPair } = await import('../../src/crypto/pairCrypto');
const { buildTerminalQr } = await import('../../src/ui/terminalQr');
const { removePendingPairGrant } = await import('../../src/auth/pairing/pendingGrant');
const { removePairingQrImage } = await import('../../src/ui/pairingPresentation');

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
// CAP-877: approved in Keep, the one-time code Keep showed the approver is needed.
const CONFIRM_REQUIRED = { status: 200, body: { status: 'confirm', code: 'confirmation_required', attempts_left: 5 } };
const CONFIRM_MISMATCH = { status: 200, body: { status: 'confirm', code: 'confirmation_mismatch', attempts_left: 4 } };
const CONFIRM_FAILED = { status: 400, body: { status: 'denied', code: 'confirmation_failed' } };

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
    // These tests predate the sign-in-only mode: they run a key handover unless they say otherwise.
    const exit = await pairAgentCommand({ transport: true, ...options }, deps).then(
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

const REAL_TMP = realpathSync(tmpdir());

/** The directories in the OS temp folder that hold a QR PNG a pairing run made (a `capy-pair-` directory with a `pair.png` in it). */
const qrDirs = (): readonly string[] => readdirSync(REAL_TMP).filter((name) => name.startsWith('capy-pair-') && existsSync(join(REAL_TMP, name, 'pair.png')));
const newQrDirsSince = (before: readonly string[]): readonly string[] => qrDirs().filter((name) => !before.includes(name));
/** What was already in the temp folder when this file started: leftovers of earlier runs are not this file's to judge. */
const QR_DIRS_AT_START = qrDirs();

/** A file's bytes and modification time, to prove it was not read-and-rewritten. */
const fingerprint = (path: string): { readonly bytes: string; readonly mtimeMs: number; readonly ino: number } => ({
  bytes: readFileSync(path).toString('base64'),
  mtimeMs: statSync(path).mtimeMs,
  ino: statSync(path).ino,
});

const EXISTING_K_LOCAL = Buffer.alloc(32, 7);
const EXISTING_KEY_ENC = JSON.stringify({ version: '2.0', org_id: 'org-123', encrypted_master_key: 'already-here', wrapping_method: 'local_root', created_at: '2026-01-01T00:00:00.000Z' });

/** The keys of `userId` for org-123, as a machine that was paired earlier holds them. */
function placeKeysFor(userId: string): void {
  saveLocalRoot('org-123', EXISTING_K_LOCAL, userId);
  writeOrgKeyFileRaw('org-123', EXISTING_KEY_ENC, userId);
}

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
    expect(newQrDirsSince(QR_DIRS_AT_START)).toEqual([]);
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe('asks nothing up front', () => {
    test('no email is asked: the start run goes straight to the link, and the pending file names no email', async () => {
      stubFetch([PENDING]);
      const ran = await run({ json: true });
      expect(ran.exit).toBe(3);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_APPROVAL_PENDING);
      expect(ran.json.elicitation.kind).toBe('link');
      expect(ran.stdout).not.toMatch(/email/i);
      expect(pendingRaw()).not.toMatch(/email/i);
    });

    test('--force is kept in the pending grant', async () => {
      stubFetch([PENDING]);
      const started = await run({ json: true, force: true });
      expect(started.exit).toBe(3);
      expect(JSON.parse(pendingRaw()).force).toBe(true);
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
      expect(Object.keys(elicitation).toSorted()).toEqual(['answer', 'code', 'expires_at', 'fingerprint', 'instructions', 'kind', 'purpose', 'qr', 'url']);
      expect(elicitation.fingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
      expect(elicitation.kind).toBe('link');
      expect(elicitation.code).toBe('ABCD-EFGH');
      expect(elicitation.url).toContain('/transport/pair?code=ABCD-EFGH');
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
      expect(JSON.parse(file).expected_email).toBeUndefined();
    });

    test('the displayed purpose says what each kind of pairing does', async () => {
      stubFetch([PENDING]);
      const ran = await run({ email: 'a@b.co' });
      expect(ran.json.elicitation.purpose).toBe(pairPurpose({ mode: 'transport', signup: false }));
      expect(pairPurpose({ mode: 'transport', signup: true })).toBe(PAIR_DEFAULT_PURPOSE);
      expect(pairPurpose({ mode: 'session', signup: false })).toContain('none are sent');
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

    /** What each `/auth/device/token` call sent. */
    const tokenBodies = (fetchMock: ReturnType<typeof stubFetch>): readonly Record<string, unknown>[] =>
      callsTo(fetchMock, '/auth/device/token').map(([, init]) => JSON.parse((init as { body: string }).body));

    describe('the one-time code Keep shows the approver (CAP-877)', () => {
      test('approved in Keep: PAIR_CODE_REQUIRED with a form for the code, nothing installed, the grant kept', async () => {
        await startThenStub('mike@example.com', [CONFIRM_REQUIRED]);
        const ran = await run({ wait: true }, fakeClock(Date.now() + 5000));
        expect(ran.exit).toBe(3);
        expect(ran.json.code).toBe(ERROR_CODES.PAIR_CODE_REQUIRED);
        const form = ran.json.elicitation;
        expect(form.kind).toBe('form');
        expect(form.fields).toEqual([expect.objectContaining({ name: 'code', type: 'string' })]);
        expect(form.details).toEqual({ attempts_left: 5 });
        expect(form.answer.rerun).toBe('capy pair --wait --code <code>');
        expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
        expect(pendingExists()).toBe(true);
      });

      test('--code sends the code at once and finishes the pairing', async () => {
        await startThenStub('mike@example.com', [CONFIRM_REQUIRED]);
        await run({ wait: true }, fakeClock(Date.now() + 5000));
        const fetchMock = stubFetch([APPROVED]);
        const clock = fakeClock(Date.now());
        const ran = await run({ wait: true, code: ' abcd-efgh ' }, clock);
        expect(ran.exit).toBe(0);
        expect(ran.json.ok).toBe(true);
        expect(tokenBodies(fetchMock)).toEqual([{ device_code: 'device-1', confirmation_code: 'abcd-efgh' }]);
        expect(clock.sleep).not.toHaveBeenCalled();
        expect(mockInstallDeviceGrantSession).toHaveBeenCalledTimes(1);
        expect(pendingExists()).toBe(false);
      });

      test('CAP-890: the 4-character code fits the form and finishes the pairing; the form asks for it to be entered', async () => {
        await startThenStub('mike@example.com', [CONFIRM_REQUIRED]);
        const asked = await run({ wait: true }, fakeClock(Date.now() + 5000));
        const field = asked.json.elicitation.fields[0];
        expect(new RegExp(field.pattern).test('K7QM')).toBe(true);
        expect(JSON.stringify(asked.json.elicitation.display)).toContain('to enter');
        expect(JSON.stringify(asked.json.elicitation.display)).not.toContain('to choose');
        const fetchMock = stubFetch([APPROVED]);
        const ran = await run({ wait: true, code: ' k7qm ' }, fakeClock(Date.now()));
        expect(ran.exit).toBe(0);
        expect(tokenBodies(fetchMock)).toEqual([{ device_code: 'device-1', confirmation_code: 'k7qm' }]);
        expect(mockInstallDeviceGrantSession).toHaveBeenCalledTimes(1);
      });

      test('a wrong code: PAIR_CODE_MISMATCH with the form again and the tries left, nothing installed', async () => {
        await startThenStub('mike@example.com', [CONFIRM_MISMATCH]);
        const ran = await run({ wait: true, code: 'WRONG-CODE' }, fakeClock(Date.now() + 5000));
        expect(ran.exit).toBe(3);
        expect(ran.json.code).toBe(ERROR_CODES.PAIR_CODE_MISMATCH);
        expect(ran.json.elicitation.details).toEqual({ attempts_left: 4 });
        expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
        expect(pendingExists()).toBe(true);
      });

      test('too many wrong codes: PAIR_CODE_FAILED, the grant removed, nothing installed', async () => {
        await startThenStub('mike@example.com', [CONFIRM_FAILED]);
        const ran = await run({ wait: true, code: 'WRONG-CODE' }, fakeClock(Date.now() + 5000));
        expect(ran.exit).toBe(1);
        expect(ran.json).toEqual({ ok: false, code: ERROR_CODES.PAIR_CODE_FAILED, error: expect.any(String) });
        expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
        expect(pendingExists()).toBe(false);
      });

      test('without --code, no confirmation_code is sent', async () => {
        const fetchMock = await startThenStub('mike@example.com', [PENDING, APPROVED]);
        await run({ wait: true }, fakeClock(Date.now() + 5000));
        expect(tokenBodies(fetchMock).every((body) => !('confirmation_code' in body))).toBe(true);
      });
    });

    test('approved by the expected account: installs the session, writes the keys, removes the pending file, prints the success JSON', async () => {
      const fetchMock = await startThenStub('mike@example.com', [PENDING, APPROVED]);
      // The start run saved authorize time + interval as the earliest first poll; this run starts after it, so it polls at once.
      const clock = fakeClock(Date.now() + 5000);
      const ran = await run({ wait: true }, clock);
      expect(ran.exit).toBe(0);
      expect(ran.json).toEqual({ ok: true, user_id: USER.id, paired: [{ org_id: 'org-123', user_id: USER.id }], keys: 'picked_up' });
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
      // The start run saved authorize time + interval as the earliest first poll; this run starts after it, so it polls at once.
      const clock = fakeClock(Date.now() + 5000);
      const ran = await run({ wait: true }, clock);
      expect(ran.exit).toBe(0);
      expect(clock.sleep).not.toHaveBeenCalled();
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
      // The start run saved authorize time + interval as the earliest first poll; this run starts after it, so it polls at once.
      const clock = fakeClock(Date.now() + 5000);
      const ran = await run({ wait: true }, { ...clock, ceilingMs: PAIR_WAIT_CEILING_MS });
      expect(PAIR_WAIT_CEILING_MS).toBe(540_000);
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
      // The link lives 10 minutes, past the 9-minute cap (CAP-899). Polls at 0,5,...,535 seconds, then one more interval
      // so the next run never polls early: 9 minutes in all.
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(108);
      expect(clock.sleep).toHaveBeenCalledTimes(108);
      expect((clock.sleep.mock.calls as number[][]).reduce((total, [ms]) => total + ms, 0)).toBe(540_000);
    });

    test('a slow_down adds 5 seconds to the interval, and the longer interval is kept for the next run', async () => {
      await startThenStub('mike@example.com', [SLOW_DOWN, PENDING]);
      // The start run saved authorize time + interval as the earliest first poll; this run starts after it, so it polls at once.
      const clock = fakeClock(Date.now() + 5000);
      const ran = await run({ wait: true }, clock);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect((clock.sleep.mock.calls as number[][])[0][0]).toBe(10_000);
      expect(JSON.parse(pendingRaw()).interval_seconds).toBe(10);
    });

    test('an interval at least as long as the ceiling polls once and returns at once; the next run waits it out without polling', async () => {
      stubFetch([PENDING], { ...AUTHORIZE_BODY, interval: 60 });
      await run({ email: 'mike@example.com' });
      const fetchMock = stubFetch([PENDING]);
      // The start run saved authorize time + 60 seconds; this run starts after it, so it polls once.
      const first = fakeClock(Date.now() + 60_000);
      const ran = await run({ wait: true }, { ...first, ceilingMs: 30_000 });
      expect(ran.exit).toBe(3);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(1);
      expect(first.sleep).not.toHaveBeenCalled();
      expect(JSON.parse(pendingRaw()).interval_seconds).toBe(60);
      const second = fakeClock();
      const again = await run({ wait: true }, { ...second, ceilingMs: 30_000 });
      expect(again.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(1);
      expect(second.sleep).not.toHaveBeenCalled();
    });

    test('the first poll waits one interval after the authorize time: not before, and at that time', async () => {
      const authorizedAt = 1_700_000_000_000;
      const startFetch = stubFetch([PENDING]);
      await run({ email: 'mike@example.com' }, fakeClock(authorizedAt));
      const publicKey = sentPublicKey(startFetch);
      mockPickupDevicePairing.mockImplementation(async () => ({ sealed: await sealAsBrowser(PAYLOAD, publicKey) }));
      expect(JSON.parse(pendingRaw()).next_poll_at).toBe(authorizedAt + 5000);
      const fetchMock = stubFetch([APPROVED]);
      // A run whose ceiling ends before authorize time + interval sends no poll at all.
      const early = fakeClock(authorizedAt);
      const waiting = await run({ wait: true }, { ...early, ceilingMs: 4000 });
      expect(waiting.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(0);
      expect(JSON.parse(pendingRaw()).next_poll_at).toBe(authorizedAt + 5000);
      // A run that reaches that time sleeps up to it and polls then, never earlier.
      const atTime = fakeClock(authorizedAt);
      const sleepSeen = jest.fn(async (ms: number) => {
        expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(0);
        await atTime.sleep(ms);
      });
      const ran = await run({ wait: true }, { sleep: sleepSeen, now: atTime.now });
      expect(ran.exit).toBe(0);
      expect(sleepSeen).toHaveBeenCalledWith(5000);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(1);
    });

    test('a pending file written by the previous build (no next_poll_at) still works: its first wait run polls at once', async () => {
      await startThenStub('mike@example.com', [APPROVED]);
      const { next_poll_at: _dropped, ...legacy } = JSON.parse(pendingRaw());
      savePairPendingRaw(JSON.stringify(legacy));
      const clock = fakeClock();
      const ran = await run({ wait: true }, clock);
      expect(ran.exit).toBe(0);
      expect(clock.sleep).not.toHaveBeenCalled();
    });

    test('the interval is respected across runs: the next run sleeps until the saved earliest-next-poll time before it polls', async () => {
      await startThenStub('mike@example.com', [PENDING]);
      const first = await run({ wait: true }, { ...fakeClock(), ceilingMs: 30_000 });
      expect(first.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      const saved = JSON.parse(pendingRaw()).next_poll_at as number;
      expect(saved).toBeGreaterThan(Date.now());
      const fetchMock = stubFetch([APPROVED]);
      // The first run's first poll waited one interval, so its last one is 30 seconds after the start run. The real run
      // takes that long; the fake one did not, so the second run starts a few seconds later, before the saved time.
      const clock = fakeClock(Date.now() + 6000);
      const ran = await run({ wait: true }, clock);
      expect(ran.exit).toBe(0);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(1);
      const [[slept]] = clock.sleep.mock.calls as number[][];
      expect(slept).toBeGreaterThan(20_000);
      expect(slept).toBeLessThanOrEqual(30_000);
    });

    // CAP-885: a slow human never sees pairing die. An expired grant is replaced by a fresh one, and the wait hands the
    // agent the new link to show.
    const RENEWED_BODY = { ...AUTHORIZE_BODY, device_code: 'device-2', user_code: 'WXYZ-2345' };

    test('an expired grant (service says so): PAIR_LINK_RENEWED with a fresh link and full QR, nothing installed', async () => {
      await startThenStub('mike@example.com', [EXPIRED]);
      const old = JSON.parse(pendingRaw());
      const fetchMock = stubFetch([EXPIRED], RENEWED_BODY);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(3);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_LINK_RENEWED);
      const link = ran.json.elicitation;
      expect(link.kind).toBe('link');
      expect(link.code).toBe('WXYZ-2345');
      expect(link.url).toContain('WXYZ-2345');
      expect(link.answer).toEqual({ wait: `${BIN} pair --wait` });
      // A link the human has not seen: the whole QR, as a start run gives it.
      expect(typeof link.qr.text).toBe('string');
      expect(link.qr.image.data_uri).toMatch(/^data:image\/png;base64,/);
      // The fresh grant replaced the old one, with a new key pair, and asked for the same thing.
      const fresh = JSON.parse(pendingRaw());
      expect(fresh.device_code).toBe('device-2');
      expect(fresh.pair_public_key).not.toBe(old.pair_public_key);
      expect(fresh.renew).toEqual(old.renew);
      expect(fresh.mode).toBe(old.mode);
      expect(callsTo(fetchMock, '/auth/device/authorize')).toHaveLength(1);
      expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
    });

    // CAP-897: an agent with no AGENTS block learns the wait and renew rule from the link itself.
    test('every link (pending, still waiting, renewed) carries the same next-step instructions', async () => {
      stubFetch([PENDING]);
      const started = await run({ email: 'mike@example.com' });
      expect(started.json.code).toBe(ERROR_CODES.PAIR_APPROVAL_PENDING);
      expect(started.json.elicitation.instructions).toBe(PAIR_LINK_INSTRUCTIONS);
      stubFetch([PENDING]);
      const still = await run({ wait: true }, { ...fakeClock(Date.now() + 5000), ceilingMs: PAIR_WAIT_CEILING_MS });
      expect(still.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect(still.json.elicitation.instructions).toBe(PAIR_LINK_INSTRUCTIONS);
      stubFetch([PENDING], RENEWED_BODY);
      const renewed = await run({ wait: true }, fakeClock(Date.now() + 10_000_000));
      expect(renewed.json.code).toBe(ERROR_CODES.PAIR_LINK_RENEWED);
      expect(renewed.json.elicitation.instructions).toBe(PAIR_LINK_INSTRUCTIONS);
      for (const phrase of ['at once in the foreground', 'PAIR_STILL_WAITING', 'PAIR_LINK_RENEWED', 'Never start a new `capy pair`', 'never fill in the one-time code']) {
        expect(PAIR_LINK_INSTRUCTIONS).toContain(phrase);
      }
    });

    // CAP-899: one wait run returns only when something changes, so an agent never gets a "still waiting" turn to stop on.
    test('a pending link is waited out to its expiry in one run, then renewed (no PAIR_STILL_WAITING on the way)', async () => {
      const authorizedAt = 1_700_000_000_000;
      stubFetch([PENDING], { ...AUTHORIZE_BODY, expires_in: 300 });
      await run({ email: 'mike@example.com' }, fakeClock(authorizedAt));
      const expiresAt = Date.parse(JSON.parse(pendingRaw()).expires_at);
      expect(expiresAt).toBe(authorizedAt + 300_000);
      const fetchMock = stubFetch([PENDING], RENEWED_BODY);
      const clock = fakeClock(authorizedAt + 5000);
      const ran = await run({ wait: true }, clock);
      expect(ran.exit).toBe(3);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_LINK_RENEWED);
      expect(ran.json.elicitation.code).toBe('WXYZ-2345');
      // It polled the old link until it ran out (5,10,...,295 seconds), slept to its expiry, and never polled past it.
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(59);
      expect(clock.now()).toBe(expiresAt);
      expect(callsTo(fetchMock, '/auth/device/authorize')).toHaveLength(1);
    });

    test('an approval mid-wait returns at once with the code form, without waiting for the link to run out', async () => {
      const authorizedAt = 1_700_000_000_000;
      stubFetch([PENDING], { ...AUTHORIZE_BODY, expires_in: 300 });
      await run({ email: 'mike@example.com' }, fakeClock(authorizedAt));
      const fetchMock = stubFetch([PENDING, PENDING, CONFIRM_REQUIRED]);
      const clock = fakeClock(authorizedAt + 5000);
      const ran = await run({ wait: true }, clock);
      expect(ran.exit).toBe(3);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_CODE_REQUIRED);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(3);
      expect(clock.now()).toBe(authorizedAt + 15_000);
      expect(pendingExists()).toBe(true);
    });

    test('a denial mid-wait returns at once', async () => {
      const authorizedAt = 1_700_000_000_000;
      stubFetch([PENDING], { ...AUTHORIZE_BODY, expires_in: 300 });
      await run({ email: 'mike@example.com' }, fakeClock(authorizedAt));
      stubFetch([PENDING, DENIED]);
      const clock = fakeClock(authorizedAt + 5000);
      const ran = await run({ wait: true }, clock);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_DENIED);
      expect(clock.now()).toBe(authorizedAt + 10_000);
    });

    test('a wait killed by the agent\'s tool loses nothing: the file keeps the next poll time, and a rerun after expiry renews', async () => {
      const authorizedAt = 1_700_000_000_000;
      stubFetch([PENDING], { ...AUTHORIZE_BODY, expires_in: 300 });
      await run({ email: 'mike@example.com' }, fakeClock(authorizedAt));
      const fetchMock = stubFetch([PENDING], RENEWED_BODY);
      // The tool kills the run while it sleeps after its third poll.
      const clock = fakeClock(authorizedAt + 5000);
      const killed = jest.fn(async (ms: number) => {
        if (callsTo(fetchMock, '/auth/device/token').length === 3) throw new Error('killed by the tool');
        await clock.sleep(ms);
      });
      // A thrown sleep stands in for the kill: the run stops mid-wait, between polls.
      const stopped = await run({ wait: true }, { sleep: killed, now: clock.now });
      expect(stopped.exit).not.toBe(0);
      const kept = JSON.parse(pendingRaw());
      expect(kept.device_code).toBe('device-1');
      // The next run would not poll before the killed run's next poll.
      expect(kept.next_poll_at).toBe(authorizedAt + 20_000);
      // A rerun after the link ran out renews it.
      const ran = await run({ wait: true }, fakeClock(authorizedAt + 400_000));
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_LINK_RENEWED);
      expect(ran.json.elicitation.code).toBe('WXYZ-2345');
    });

    test('a slow_down that pushes the next poll past expiry: sleeps to the expiry and renews, never polls the dead link', async () => {
      const authorizedAt = 1_700_000_000_000;
      stubFetch([PENDING], { ...AUTHORIZE_BODY, expires_in: 300 });
      await run({ email: 'mike@example.com' }, fakeClock(authorizedAt));
      const fetchMock = stubFetch([SLOW_DOWN], RENEWED_BODY);
      const clock = fakeClock(authorizedAt + 292_000);
      const ran = await run({ wait: true }, clock);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_LINK_RENEWED);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(1);
      expect(clock.now()).toBe(authorizedAt + 300_000);
    });

    test('--code on a link that already expired: the code is not sent, and the link is renewed', async () => {
      const authorizedAt = 1_700_000_000_000;
      stubFetch([PENDING], { ...AUTHORIZE_BODY, expires_in: 300 });
      await run({ email: 'mike@example.com' }, fakeClock(authorizedAt));
      const fetchMock = stubFetch([CONFIRM_REQUIRED], RENEWED_BODY);
      const ran = await run({ wait: true, code: 'AB12' }, fakeClock(authorizedAt + 301_000));
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_LINK_RENEWED);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(0);
    });

    test('an expired grant (its own expiry has passed): renewed without polling the old one', async () => {
      await startThenStub('mike@example.com', [APPROVED]);
      const fetchMock = stubFetch([APPROVED], RENEWED_BODY);
      const clock = fakeClock(Date.now() + 10_000_000);
      const ran = await run({ wait: true }, clock);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_LINK_RENEWED);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(0);
      expect(JSON.parse(pendingRaw()).device_code).toBe('device-2');
    });

    test('an expired grant is renewed even when this run would not poll, and the old PNG goes', async () => {
      stubFetch([PENDING], { ...AUTHORIZE_BODY, expires_in: 10, interval: 60 });
      const started = await run({ email: 'mike@example.com' });
      const image = started.json.elicitation.qr.image.file as string;
      // The start run saved the earliest first poll a minute away (the interval is longer than the ceiling).
      const fetchMock = stubFetch([PENDING], RENEWED_BODY);
      // This run starts after the grant's own expiry (10 seconds) but before that poll time: it does not poll.
      const later = await run({ wait: true }, fakeClock(Date.now() + 20_000));
      expect(later.exit).toBe(3);
      expect(later.json.code).toBe(ERROR_CODES.PAIR_LINK_RENEWED);
      expect(callsTo(fetchMock, '/auth/device/token')).toHaveLength(0);
      expect(existsSync(image)).toBe(false);
      expect(existsSync(later.json.elicitation.qr.image.file)).toBe(true);
    });

    test('the renewed grant is waited on like any other: approve it and the pairing finishes', async () => {
      await startThenStub('mike@example.com', [EXPIRED]);
      stubFetch([EXPIRED], RENEWED_BODY);
      const renewed = await run({ wait: true });
      expect(renewed.json.code).toBe(ERROR_CODES.PAIR_LINK_RENEWED);
      const fetchMock = stubFetch([PENDING]);
      const still = await run({ wait: true });
      expect(still.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
      expect(still.json.elicitation.code).toBe('WXYZ-2345');
      const [, init] = callsTo(fetchMock, '/auth/device/token')[0] as [string, { body: string }];
      expect(JSON.parse(init.body).device_code).toBe('device-2');
    });

    test('a grant saved by an earlier build (no renew) still answers PAIR_EXPIRED, pending file gone', async () => {
      await startThenStub('mike@example.com', [EXPIRED]);
      const { renew: _renew, ...older } = JSON.parse(pendingRaw());
      savePairPendingRaw(JSON.stringify(older));
      const fetchMock = stubFetch([EXPIRED]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_EXPIRED);
      expect(pendingExists()).toBe(false);
      expect(callsTo(fetchMock, '/auth/device/authorize')).toHaveLength(0);
    });

    test('a renewal the service refuses ends the wait with that error, coded', async () => {
      await startThenStub('mike@example.com', [EXPIRED]);
      globalThis.fetch = (async (url: string) => url.endsWith('/auth/device/authorize')
        ? ({ ok: false, status: 500, json: async () => ({ error: 'down', code: 'AUTH_FAILED' }) }) as Response
        : ({ ok: false, status: 400, json: async () => EXPIRED.body }) as Response) as typeof fetch;
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.AUTH_FAILED);
    });

    test('a denied grant: PAIR_DENIED, pending file gone, nothing installed', async () => {
      await startThenStub('mike@example.com', [DENIED]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_DENIED);
      expect(pendingExists()).toBe(false);
      expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
    });

    test('the service refused the approving account (not the Keep approver, or not a member): PAIR_ACCESS_DENIED, pending file gone, nothing installed', async () => {
      await startThenStub('mike@example.com', [{ status: 400, body: { status: 'denied', code: 'pairing_access_denied' } }]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_ACCESS_DENIED);
      expect(pendingExists()).toBe(false);
      expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
    });

    test('a machine with no keys asks nothing: one key-handover link, and Keep decides after sign-in', async () => {
      const fetchMock = stubFetch([PENDING]);
      const ran = await run({ transport: false, title: 'Ship it' });
      expect(ran.exit).toBe(3);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_APPROVAL_PENDING);
      expect(ran.json.elicitation.kind).toBe('link');
      expect(ran.json.elicitation.url).toContain('/transport/pair?code=ABCD-EFGH');
      expect(ran.stdout).not.toMatch(/email|signup|--transport/i);
      const authorizeBody = JSON.parse(String((callsTo(fetchMock, '/auth/device/authorize')[0] as [unknown, RequestInit])[1].body));
      // Not a signup request: Keep sends a new user through signup, and an existing one approves their org's keys.
      expect(authorizeBody).toMatchObject({ mode: 'transport' });
      expect(authorizeBody.is_signup).not.toBe(true);
      expect(JSON.parse(pendingRaw()).mode).toBe('transport');
    });

    test('sign-in only: the link is Keep /pair, the rerun carries no --transport, and keys of an org other than the bound one are not enough', async () => {
      // Keys of some org are here, so sign-in only goes ahead (the bound org is only known after approval).
      placeKeysFor('someone-else');
      stubFetch([PENDING]);
      const started = await run({ json: true, transport: false });
      expect(started.json.elicitation.url).toContain('/pair?code=ABCD-EFGH');
      expect(started.json.elicitation.url).not.toContain('/transport/');
      // APPROVED reports no paired_org_id: nothing to check keys against, so nothing is installed.
      stubFetch([APPROVED]);
      const ran = await run({ wait: true }, fakeClock(Date.now() + 5000));
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_TRANSPORT_REQUIRED);
      expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
      expect(mockPickupDevicePairing).not.toHaveBeenCalled();
    });

    test('--title/--description are sent as the pairing intent and shown as the purpose', async () => {
      const fetchMock = stubFetch([PENDING]);
      const started = await run({ json: true, title: "  Deploy Bob's API ", description: 'Ship it' });
      expect(started.json.elicitation.purpose).toBe('Ship it');
      const authorizeBody = JSON.parse(String((callsTo(fetchMock, '/auth/device/authorize')[0] as unknown[])[1] && ((callsTo(fetchMock, '/auth/device/authorize')[0] as [unknown, RequestInit])[1].body)));
      expect(authorizeBody).toMatchObject({ intent_title: "Deploy Bob's API", intent_description: 'Ship it', mode: 'transport' });
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
      const started = await run({ email: 'mike@example.com' });
      // Overwriting the pending file by hand orphans its PNG: take that out afterwards.
      const orphan = started.json.elicitation.qr.image.file as string;
      try {
        const { savePairPendingRaw } = await import('../../src/config/globalConfig');
        savePairPendingRaw('{"v":1,"device_code":"x"}');
        const ran = await run({ wait: true });
        expect(ran.json.code).toBe(ERROR_CODES.PAIR_NOT_PENDING);
        expect(pendingExists()).toBe(false);
      } finally {
        removePairingQrImage(orphan);
      }
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

    test('an expired pending file is swept by a start run that fails, and by cancel', async () => {
      const expire = () => {
        const file = JSON.parse(pendingRaw());
        savePairPendingRaw(JSON.stringify({ ...file, expires_at: new Date(Date.now() - 1000).toISOString() }));
      };
      stubFetch([PENDING]);
      await run({ email: 'mike@example.com' });
      expire();
      expect(pendingExists()).toBe(true);

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

    test.each([
      ['a zero interval', { interval: 0 }],
      ['a negative interval', { interval: -5 }],
      ['a non-numeric interval', { interval: 'soon' }],
      ['no interval', { interval: undefined }],
      ['no expiry at all', { expires_in: undefined }],
      ['a zero expires_in', { expires_in: 0 }],
      ['an expires_in too large to be a date', { expires_in: 1e300 }],
      ['an unparseable expires_at', { expires_at: 'tomorrow-ish' }],
      ['no user code', { user_code: '' }],
    ])('%s from the service: INVALID_FORMAT and nothing is saved', async (_name, patch) => {
      const before = qrDirs();
      stubFetch([PENDING], { ...AUTHORIZE_BODY, ...patch });
      const ran = await run({ email: 'mike@example.com' });
      expect(ran.exit).toBe(1);
      expect(ran.json.code).toBe(ERROR_CODES.INVALID_FORMAT);
      expect(pendingExists()).toBe(false);
      // No QR image is left behind in the temp folder.
      expect(newQrDirsSince(before)).toEqual([]);
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
      try {
        rmSync(file, { force: true });
        stubFetch([PENDING]);
        const ran = await run({ wait: true });
        expect(ran.json.code).toBe(ERROR_CODES.PAIR_STILL_WAITING);
        expect(ran.json.elicitation).not.toHaveProperty('qr');
      } finally {
        // Only the file was removed by hand: its directory goes too.
        rmSync(dirname(file), { recursive: true, force: true });
      }
    });

    test('a pending file written without qr_file still works: waiting has no qr, approval completes', async () => {
      const { ran: start, publicKey } = await started();
      const { qr_file: qrFile, ...older } = JSON.parse(pendingRaw());
      savePairPendingRaw(JSON.stringify(older));
      rmSync(qrFile, { force: true });
      // The pending file no longer names the directory, so it is removed here.
      rmSync(dirname(qrFile), { recursive: true, force: true });
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

    test.each([
      ['an expiry the service reports (the link is renewed)', EXPIRED, ERROR_CODES.PAIR_LINK_RENEWED],
      ['a denial', DENIED, ERROR_CODES.PAIR_DENIED],
    ])('the PNG is gone after %s', async (_name, wire, code) => {
      const { file } = await started();
      stubFetch([wire]);
      const ran = await run({ wait: true });
      expect(ran.json.code).toBe(code);
      expect(gone(file)).toBe(true);
    });

    test('the PNG is gone after the grant\'s own expiry passes (the link is renewed)', async () => {
      const { file } = await started();
      stubFetch([APPROVED], { ...AUTHORIZE_BODY, device_code: 'device-2', user_code: 'WXYZ-2345' });
      const ran = await run({ wait: true }, fakeClock(Date.now() + 10_000_000));
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_LINK_RENEWED);
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
      // A start run that fails after the sweep: the expired grant and its PNG are gone, and no new one is made.
      globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({ error: 'down', code: 'AUTH_FAILED' }) }) as Response) as typeof fetch;
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

  describe('a QR path that cannot be removed never keeps the pending grant', () => {
    /** Starts a pairing, then points its pending file at a directory named like the PNG: the shape that used to make removal throw. */
    async function startWithDirectoryForPng(): Promise<string> {
      stubFetch([PENDING]);
      const started = await run({ email: 'mike@example.com' });
      removePairingQrImage(started.json.elicitation.qr.image.file as string);
      const blocker = join(mkdtempSync(join(REAL_TMP, 'capy-pair-')), 'pair.png');
      mkdirSync(blocker);
      savePairPendingRaw(JSON.stringify({ ...JSON.parse(pendingRaw()), qr_file: blocker }));
      return blocker;
    }
    const cleanUp = (blocker: string): void => rmSync(dirname(blocker), { recursive: true, force: true });

    test('--cancel succeeds and the pending file is gone', async () => {
      const blocker = await startWithDirectoryForPng();
      try {
        const ran = await run({ cancel: true });
        expect(ran.exit).toBe(0);
        expect(ran.json).toEqual({ ok: true, status: 'cancelled' });
        expect(pendingExists()).toBe(false);
        expect(lstatSync(blocker).isDirectory()).toBe(true);
      } finally {
        cleanUp(blocker);
      }
    });

    test('--wait on an expired grant renews it, and the old grant is replaced', async () => {
      const blocker = await startWithDirectoryForPng();
      try {
        stubFetch([APPROVED], { ...AUTHORIZE_BODY, device_code: 'device-2', user_code: 'WXYZ-2345' });
        const ran = await run({ wait: true }, fakeClock(Date.now() + 10_000_000));
        expect(ran.exit).toBe(3);
        expect(ran.json.code).toBe(ERROR_CODES.PAIR_LINK_RENEWED);
        expect(JSON.parse(pendingRaw()).device_code).toBe('device-2');
      } finally {
        cleanUp(blocker);
      }
    });

    test('a new start run still starts, and its grant replaces the old one', async () => {
      const blocker = await startWithDirectoryForPng();
      try {
        stubFetch([PENDING], { ...AUTHORIZE_BODY, device_code: 'device-new' });
        const ran = await run({ email: 'mike@example.com' });
        expect(ran.exit).toBe(3);
        expect(ran.json.code).toBe(ERROR_CODES.PAIR_APPROVAL_PENDING);
        expect(JSON.parse(pendingRaw()).device_code).toBe('device-new');
        expect(lstatSync(blocker).isDirectory()).toBe(true);
      } finally {
        cleanUp(blocker);
      }
    });

    test('a later run that sweeps the expired grant deletes it', async () => {
      const blocker = await startWithDirectoryForPng();
      try {
        savePairPendingRaw(JSON.stringify({ ...JSON.parse(pendingRaw()), expires_at: new Date(Date.now() - 1000).toISOString() }));
        globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({ error: 'down', code: 'AUTH_FAILED' }) }) as Response) as typeof fetch;
        await run({});
        expect(pendingExists()).toBe(false);
      } finally {
        cleanUp(blocker);
      }
    });
  });

  describe('sign-in-only pairing, agent mode', () => {
    /** Runs the start run, then swaps in the token responses for the wait run. */
    async function startThenStub(email: string, tokens: readonly Wire[], extra: Parameters<typeof pairAgentCommand>[0] = {}) {
      const startFetch = stubFetch([PENDING]);
      await run({ email, ...extra });
      const publicKey = sentPublicKey(startFetch);
      mockPickupDevicePairing.mockImplementation(async () => ({ sealed: await sealAsBrowser(PAYLOAD, publicKey) }));
      return stubFetch(tokens);
    }
    const ROOT = (userId: string): string => getLocalRootPath('org-123', userId);
    const ENC = (userId: string): string => getOrgKeyPath('org-123', userId);

    test('keys already here: no pickup, key files untouched, session installed, keys is already_present', async () => {
      await startThenStub('mike@example.com', [APPROVED]);
      placeKeysFor(USER.id);
      const before = [fingerprint(ROOT(USER.id)), fingerprint(ENC(USER.id))];
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(0);
      expect(ran.json).toEqual({ ok: true, user_id: USER.id, paired: [], keys: 'already_present' });
      expect(mockPickupDevicePairing).not.toHaveBeenCalled();
      expect([fingerprint(ROOT(USER.id)), fingerprint(ENC(USER.id))]).toEqual(before);
      expect(readLocalRoot('org-123', USER.id)?.equals(EXISTING_K_LOCAL)).toBe(true);
      expect(mockInstallDeviceGrantSession).toHaveBeenCalledTimes(1);
      expect(existsSync(getAuthSessionPath(USER.id))).toBe(true);
      expect(pendingExists()).toBe(false);
    });

    test('local.key missing: the keys are not "already here", so the pickup repairs the machine', async () => {
      await startThenStub('mike@example.com', [APPROVED]);
      placeKeysFor(USER.id);
      rmSync(ROOT(USER.id));
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(0);
      expect(ran.json.keys).toBe('picked_up');
      expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
      expect(readLocalRoot('org-123', USER.id)?.equals(Buffer.alloc(32, 5))).toBe(true);
    });

    test('local.key corrupt: the pickup repairs the machine', async () => {
      await startThenStub('mike@example.com', [APPROVED]);
      placeKeysFor(USER.id);
      writeFileSync(ROOT(USER.id), 'AAAA');
      const ran = await run({ wait: true });
      expect(ran.json.keys).toBe('picked_up');
      expect(readLocalRoot('org-123', USER.id)?.equals(Buffer.alloc(32, 5))).toBe(true);
    });

    test.each([
      ['not JSON', 'not json at all'],
      ['JSON with no wrapped master key', JSON.stringify({ version: '2.0', org_id: 'org-123' })],
      ['a wrapped master key that is empty', JSON.stringify({ version: '2.0', encrypted_master_key: '' })],
    ])('key.enc corrupt (%s): the pickup repairs the machine', async (_name, content) => {
      await startThenStub('mike@example.com', [APPROVED]);
      // The same local key the sealed payload carries, so only the damaged key.enc is in the way.
      saveLocalRoot('org-123', Buffer.alloc(32, 5), USER.id);
      writeFileSync(ENC(USER.id), content);
      const ran = await run({ wait: true });
      expect(ran.json.keys).toBe('picked_up');
      expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
      expect(readFileSync(ENC(USER.id), 'utf8')).toBe(PAYLOAD.entries[0].key_enc);
    });

    test.each([
      ['an empty user id', ''],
      ['no user id', undefined],
    ])('%s from the service: another account\'s un-scoped keys never answer already_present, so the pickup runs and fails closed', async (_name, id) => {
      const approvedWithoutId = { status: 200, body: { ...APPROVED.body, user: { ...USER, id } } };
      await startThenStub('mike@example.com', [approvedWithoutId]);
      // The legacy files that every key path falls back to without a user id.
      saveLocalRoot('org-123', EXISTING_K_LOCAL);
      writeOrgKeyFileRaw('org-123', EXISTING_KEY_ENC);
      const ran = await run({ wait: true });
      // The normal pickup runs, and it finds no entry for an account with no id: it fails closed, never answers already_present.
      expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_NO_KEYS);
      expect(ran.json.keys).toBeUndefined();
    });

    describe('an account in two organizations', () => {
      const SECOND_ORG = { id: 'org-456', workos_org_id: 'wo_2', name: 'Beta' };
      const TWO_ORGS = { status: 200, body: { ...APPROVED.body, organizations: [...APPROVED.body.organizations, SECOND_ORG] } };
      const SECOND_ENTRY = { ...PAYLOAD.entries[0], org_id: 'org-456', k_local: Buffer.alloc(32, 6).toString('base64url') };
      const TWO_ORG_PAYLOAD: PairingPayload = { v: 1, entries: [...PAYLOAD.entries, SECOND_ENTRY] };

      async function startTwoOrgs(): Promise<void> {
        const startFetch = stubFetch([PENDING]);
        await run({ email: 'mike@example.com' });
        const publicKey = sentPublicKey(startFetch);
        mockPickupDevicePairing.mockImplementation(async () => ({ sealed: await sealAsBrowser(TWO_ORG_PAYLOAD, publicKey) }));
        stubFetch([TWO_ORGS]);
      }

      test('keys here for one organization only: the pickup runs and writes the other one too', async () => {
        await startTwoOrgs();
        saveLocalRoot('org-123', Buffer.alloc(32, 5), USER.id);
        writeOrgKeyFileRaw('org-123', PAYLOAD.entries[0].key_enc, USER.id);
        const ran = await run({ wait: true });
        expect(ran.exit).toBe(0);
        expect(ran.json.keys).toBe('picked_up');
        expect(ran.json.paired).toEqual([{ org_id: 'org-123', user_id: USER.id }, { org_id: 'org-456', user_id: USER.id }]);
        expect(readLocalRoot('org-456', USER.id)?.equals(Buffer.alloc(32, 6))).toBe(true);
        expect(existsSync(getOrgKeyPath('org-456', USER.id))).toBe(true);
      });

      test('keys here for both organizations: sign in only, nothing picked up', async () => {
        await startTwoOrgs();
        saveLocalRoot('org-123', Buffer.alloc(32, 5), USER.id);
        writeOrgKeyFileRaw('org-123', PAYLOAD.entries[0].key_enc, USER.id);
        saveLocalRoot('org-456', Buffer.alloc(32, 6), USER.id);
        writeOrgKeyFileRaw('org-456', PAYLOAD.entries[0].key_enc, USER.id);
        const ran = await run({ wait: true });
        expect(ran.json).toEqual({ ok: true, user_id: USER.id, paired: [], keys: 'already_present' });
        expect(mockPickupDevicePairing).not.toHaveBeenCalled();
      });
    });

    test('keys absent: the pickup runs and keys is picked_up', async () => {
      await startThenStub('mike@example.com', [APPROVED]);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(0);
      expect(ran.json.keys).toBe('picked_up');
      expect(ran.json.paired).toEqual([{ org_id: 'org-123', user_id: USER.id }]);
      expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
      expect(readLocalRoot('org-123', USER.id)?.equals(Buffer.alloc(32, 5))).toBe(true);
    });

    test('--force with the keys already here picks them up and overwrites', async () => {
      await startThenStub('mike@example.com', [APPROVED], { force: true });
      placeKeysFor(USER.id);
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(0);
      expect(ran.json.keys).toBe('picked_up');
      expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
      expect(readLocalRoot('org-123', USER.id)?.equals(Buffer.alloc(32, 5))).toBe(true);
    });

    test('keys of another account only: it is the pickup path, and the other account\'s files are untouched', async () => {
      await startThenStub('mike@example.com', [APPROVED]);
      placeKeysFor('someone-else');
      const before = [fingerprint(ROOT('someone-else')), fingerprint(ENC('someone-else'))];
      const ran = await run({ wait: true });
      expect(ran.exit).toBe(0);
      expect(ran.json.keys).toBe('picked_up');
      expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
      expect(readLocalRoot('org-123', USER.id)?.equals(Buffer.alloc(32, 5))).toBe(true);
      expect([fingerprint(ROOT('someone-else')), fingerprint(ENC('someone-else'))]).toEqual(before);
    });

    test('no organization resolved for the session: the keys cannot be matched to one, so the pickup is tried', async () => {
      await startThenStub('mike@example.com', [APPROVED]);
      placeKeysFor(USER.id);
      mockInstallDeviceGrantSession.mockImplementation(async (_token: unknown, user: { id: string }) => ({ success: true, organization_id: '', user_id: user.id }));
      mockAuthenticateSilent.mockResolvedValue({ success: false });
      const ran = await run({ wait: true });
      expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
      // The sealed local key differs from the one already here, so without --force the write is refused: the pickup really ran.
      expect(ran.json.code).toBe(ERROR_CODES.PAIR_LOCAL_KEY_CONFLICT);
    });
  });

  describe('sign-in-only pairing, terminal flow', () => {
    type Terminal = { readonly exit: number; readonly stdout: string };

    async function runTerminal(options: Parameters<typeof pairCommand>[0]): Promise<Terminal> {
      const log = spyOn(console, 'log').mockImplementation((() => {}) as any);
      const err = spyOn(console, 'error').mockImplementation((() => {}) as any);
      try {
        const exit = await pairCommand({ transport: true, ...options }).then(
          () => 0,
          (error: unknown) => {
            if (error instanceof ExitSignal) return error.exitCode;
            throw error;
          },
        );
        return { exit, stdout: (log.mock.calls as unknown[][]).map((args) => args.join(' ')).join('\n') };
      } finally {
        log.mockRestore();
        err.mockRestore();
      }
    }

    /** The service side of one terminal pairing: authorize, an immediate approval, and a pickup sealed to the key the command sent. */
    function approvedTerminalPairing(): void {
      const fetchMock = stubFetch([APPROVED], { ...AUTHORIZE_BODY, interval: 0.001 });
      mockPickupDevicePairing.mockImplementation(async () => ({ sealed: await sealAsBrowser(PAYLOAD, sentPublicKey(fetchMock)) }));
    }
    const ROOT = (userId: string): string => getLocalRootPath('org-123', userId);
    const ENC = (userId: string): string => getOrgKeyPath('org-123', userId);

    test('keys already here: no pickup, key files untouched, signed-in line instead of the paired one', async () => {
      approvedTerminalPairing();
      placeKeysFor(USER.id);
      const before = [fingerprint(ROOT(USER.id)), fingerprint(ENC(USER.id))];
      const ran = await runTerminal({});
      expect(ran.exit).toBe(0);
      expect(mockPickupDevicePairing).not.toHaveBeenCalled();
      expect([fingerprint(ROOT(USER.id)), fingerprint(ENC(USER.id))]).toEqual(before);
      expect(mockInstallDeviceGrantSession).toHaveBeenCalledTimes(1);
      expect(existsSync(getAuthSessionPath(USER.id))).toBe(true);
      expect(ran.stdout).toContain('signed in');
      expect(ran.stdout).not.toContain('Paired');
    });

    test('local.key missing: the pickup runs and repairs the machine', async () => {
      approvedTerminalPairing();
      placeKeysFor(USER.id);
      rmSync(ROOT(USER.id));
      const ran = await runTerminal({});
      expect(ran.exit).toBe(0);
      expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
      expect(readLocalRoot('org-123', USER.id)?.equals(Buffer.alloc(32, 5))).toBe(true);
      expect(ran.stdout).toContain('Paired 1 organization to this machine.');
    });

    test('keys absent: the pickup runs and the paired line is printed exactly as before', async () => {
      approvedTerminalPairing();
      const ran = await runTerminal({});
      expect(ran.exit).toBe(0);
      expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
      expect(readLocalRoot('org-123', USER.id)?.equals(Buffer.alloc(32, 5))).toBe(true);
      expect(ran.stdout).toContain('Paired 1 organization to this machine.');
    });

    test('--force with the keys already here picks them up', async () => {
      approvedTerminalPairing();
      placeKeysFor(USER.id);
      const ran = await runTerminal({ force: true });
      expect(ran.exit).toBe(0);
      expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
      expect(readLocalRoot('org-123', USER.id)?.equals(Buffer.alloc(32, 5))).toBe(true);
      expect(ran.stdout).toContain('Paired 1 organization to this machine.');
    });

    test('keys of another account only: it is the pickup path', async () => {
      approvedTerminalPairing();
      placeKeysFor('someone-else');
      const ran = await runTerminal({});
      expect(ran.exit).toBe(0);
      expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
      expect(readLocalRoot('org-123', USER.id)?.equals(Buffer.alloc(32, 5))).toBe(true);
    });

    test('no code from the terminal installs nothing, even with the keys already here', async () => {
      mockAskConfirmationCode.mockRejectedValue(new CapyError('no terminal', ERROR_CODES.PAIR_CODE_REQUIRED));
      const fetchMock = stubFetch([CONFIRM_REQUIRED, APPROVED], { ...AUTHORIZE_BODY, interval: 0.001 });
      mockPickupDevicePairing.mockImplementation(async () => ({ sealed: await sealAsBrowser(PAYLOAD, sentPublicKey(fetchMock)) }));
      placeKeysFor(USER.id);
      const before = [fingerprint(ROOT(USER.id)), fingerprint(ENC(USER.id))];
      const ran = await runTerminal({});
      expect(ran.exit).toBe(1);
      expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
      expect(mockPickupDevicePairing).not.toHaveBeenCalled();
      expect(existsSync(getAuthSessionPath(USER.id))).toBe(false);
      expect([fingerprint(ROOT(USER.id)), fingerprint(ENC(USER.id))]).toEqual(before);
    });
  });

  describe('a failed write of the pending file never strands a QR image', () => {
    /** Makes every write to the pending file (or a file a replacement is staged in) fail with ENOSPC, until the returned function is called. */
    function failPendingWrites() {
      writeFault.current = (path) => String(path).includes('pending.json');
      return { mockRestore: () => { writeFault.current = null; } };
    }
    /** Every PNG directory this file made that no pending grant names: the leak. */
    const orphanedQrDirs = (): readonly string[] => {
      const named = pendingExists() ? [basename(dirname(JSON.parse(pendingRaw()).qr_file as string))] : [];
      return newQrDirsSince(QR_DIRS_AT_START).filter((name) => !named.includes(name));
    };

    test('a start run that replaces a grant and cannot save the new one leaves no orphaned PNG', async () => {
      stubFetch([PENDING]);
      const first = await run({ email: 'mike@example.com' });
      expect(first.exit).toBe(3);
      const failing = failPendingWrites();
      try {
        stubFetch([PENDING], { ...AUTHORIZE_BODY, device_code: 'device-new', user_code: 'WXYZ-1234' });
        const second = await run({ email: 'mike@example.com' });
        expect(second.exit).toBe(1);
        expect(second.json.code).toBe(ERROR_CODES.SERVICE_ERROR);
      } finally {
        failing.mockRestore();
      }
      expect(orphanedQrDirs()).toEqual([]);
    });

    test('a wait run that is still waiting and cannot save the grant leaves no orphaned PNG', async () => {
      stubFetch([PENDING]);
      await run({ email: 'mike@example.com' });
      const failing = failPendingWrites();
      try {
        stubFetch([PENDING]);
        const waited = await run({ wait: true });
        expect(waited.exit).toBe(1);
        expect(waited.json.code).toBe(ERROR_CODES.SERVICE_ERROR);
      } finally {
        failing.mockRestore();
      }
      expect(orphanedQrDirs()).toEqual([]);
    });

    test('the earlier grant is still there, whole, after a failed replacement', async () => {
      stubFetch([PENDING]);
      await run({ email: 'mike@example.com' });
      const before = pendingRaw();
      const failing = failPendingWrites();
      try {
        stubFetch([PENDING], { ...AUTHORIZE_BODY, device_code: 'device-new' });
        await run({ email: 'mike@example.com' });
      } finally {
        failing.mockRestore();
      }
      expect(pendingRaw()).toBe(before);
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

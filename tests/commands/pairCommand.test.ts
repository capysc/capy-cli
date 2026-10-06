/**
 * `capy pair` (CAP-684) at the command level.
 *
 * `AuthService`/`ServiceClient`/`deviceGrant` are mocked (same shape
 * `inviteCommand.test.ts` uses for the first two); `crypto/pairCrypto.ts`
 * is left REAL, so the ECDH key pair `pairCommand` generates internally is
 * exercised for real — the mocked `pickupDevicePairing` seals a payload to
 * whatever public key the command actually sent to `authorizeDevice`, read
 * back from `mockAuthorizeDevice.mock.calls` (the mock's own call log,
 * never a variable this file assigns to itself), using a WebCrypto seal
 * that stands in for Keep's browser JS — the same construction
 * `tests/crypto/pairCrypto.test.ts` uses. That is what proves the wiring
 * end-to-end rather than just each piece in isolation.
 */
import { mock, jest, describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { webcrypto } from 'crypto';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import { PAIR_AAD, type PairEnvelope } from '../../src/crypto/pairCrypto';
import type { PairingPayload } from '../../src/crypto/pairingPayload';

const mockConfirmPairAccount = jest.fn();
mock.module('../../src/commands/pairAccountConfirmation', () => ({
  confirmPairAccount: mockConfirmPairAccount,
}));

const mockResolveKeepOrigin = jest.fn();
mock.module('../../src/config/keepOrigin', () => ({
  resolveKeepOrigin: mockResolveKeepOrigin,
}));

const mockAuthorizeDevice = jest.fn();
const mockPollDeviceToken = jest.fn();
mock.module('../../src/auth/deviceGrant', () => ({
  authorizeDevice: mockAuthorizeDevice,
  pollDeviceToken: mockPollDeviceToken,
}));

const mockInstallDeviceGrantSession = jest.fn();
const mockAuthenticateSilent = jest.fn();
const mockGetValidToken = jest.fn();
mock.module('../../src/auth/authService', () => ({
  AuthService: jest.fn().mockImplementation(() => ({
    installDeviceGrantSession: mockInstallDeviceGrantSession,
    authenticateSilent: mockAuthenticateSilent,
    getValidToken: mockGetValidToken,
  })),
}));

const mockSetTokenProvider = jest.fn();
const mockPickupDevicePairing = jest.fn();
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: mockSetTokenProvider,
    pickupDevicePairing: mockPickupDevicePairing,
  })),
}));

const realGlobalConfig = await import('../../src/config/globalConfig');
const mockReadLocalRoot = jest.fn();
const mockSaveLocalRoot = jest.fn();
const mockWriteOrgKeyFileRaw = jest.fn();
mock.module('../../src/config/globalConfig', () => ({
  ...realGlobalConfig,
  readLocalRoot: mockReadLocalRoot,
  saveLocalRoot: mockSaveLocalRoot,
  writeOrgKeyFileRaw: mockWriteOrgKeyFileRaw,
}));

// Masked-link work (CAP-684 follow-up): `renderTerminalQr` is mocked so
// tests can assert on exactly what url it was called with (the QR must
// always encode the FULL url — with the real `?code=...` — never the
// masked text, Vince's explicit addendum) without depending on a real TTY.
const mockRenderTerminalQr = jest.fn();
mock.module('../../src/ui/terminalQr', () => ({ renderTerminalQr: mockRenderTerminalQr }));

const mockIsFullScreenQrEligible = jest.fn();
const mockStartFullScreenQrView = jest.fn();
mock.module('../../src/ui/fullScreenQr', () => ({
  isFullScreenQrEligible: mockIsFullScreenQrEligible,
  startFullScreenQrView: mockStartFullScreenQrView,
  printMaskedLinkFooter: jest.fn(),
}));

import { pairCommand } from '../../src/commands/pairCommand';
import { AuthService } from '../../src/auth/authService';

/**
 * Seals `payload` to `recipientPublicKeyRaw` the way Keep's browser JS does
 * — mirrors tests/crypto/pairCrypto.test.ts's helper — and returns it
 * JSON-stringified, matching the real wire contract: `POST
 * /device-pairings/pickup`'s `sealed` field is a JSON STRING (the
 * `JSON.stringify` of the `{v:1,epk,iv,ct}` envelope), never an
 * already-parsed object. Every test that calls this therefore exercises
 * `pairCommand`'s `JSON.parse` + validate step for real, not a mock of it.
 */
async function sealAsBrowser(payload: PairingPayload, recipientPublicKeyRaw: Buffer): Promise<string> {
  const recipientKey = await webcrypto.subtle.importKey('raw', recipientPublicKeyRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ephemeral = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epkRaw = Buffer.from(await webcrypto.subtle.exportKey('raw', ephemeral.publicKey));
  const sharedBits = await webcrypto.subtle.deriveBits({ name: 'ECDH', public: recipientKey }, ephemeral.privateKey, 256);
  const hkdfKeyMaterial = await webcrypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const aesKey = await webcrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('capy:pair:v1') },
    hkdfKeyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(payload));
  const ctBuf = Buffer.from(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: PAIR_AAD, tagLength: 128 },
    aesKey,
    plaintextBytes,
  ));
  const envelope: PairEnvelope = { v: 1, epk: epkRaw.toString('base64url'), iv: Buffer.from(iv).toString('base64url'), ct: ctBuf.toString('base64url') };
  return JSON.stringify(envelope);
}

/** The public key `pairCommand` sent to `authorizeDevice` on its (only) call this test — read from the mock's own call log, never a variable this file reassigns. */
function capturedPairPublicKey(): Buffer {
  const [, publicKey] = mockAuthorizeDevice.mock.calls[0] as [string, string];
  return Buffer.from(publicKey, 'base64url');
}

/**
 * Reads back what `console.log`/`console.error` were called with straight
 * from the spy's own call log — no accumulator of our own to mutate on
 * every call. `mockRestore()` clears `.mock.calls`, so callers must read
 * `stdout()`/`stderr()` BEFORE calling `restore()`.
 */
function captureStdio(): { stdout: () => string; stderr: () => string; restore: () => void } {
  const log = spyOn(console, 'log').mockImplementation((() => {}) as any);
  const err = spyOn(console, 'error').mockImplementation((() => {}) as any);
  const joined = (calls: unknown[][]): string => calls.map((args) => args.join(' ') + '\n').join('');
  return {
    stdout: () => joined(log.mock.calls as unknown[][]),
    stderr: () => joined(err.mock.calls as unknown[][]),
    restore: () => {
      log.mockRestore();
      err.mockRestore();
    },
  };
}

/** Runs `run`, capturing stdout/stderr around it — read before the spies are restored, every time. */
async function withCapturedIo<T>(run: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const io = captureStdio();
  try {
    const result = await run();
    return { result, stdout: io.stdout(), stderr: io.stderr() };
  } finally {
    io.restore();
  }
}

const EXCHANGE_USER = { id: 'user-456', email: 'mike@example.com', first_name: null, last_name: null };

function buildPayload(overrides?: Partial<PairingPayload>): PairingPayload {
  return {
    v: 1,
    entries: [{
      org_id: 'org-123',
      user_id: 'user-456',
      k_local: Buffer.alloc(32, 5).toString('base64url'),
      key_enc: JSON.stringify({ version: '2.0', org_id: 'org-123', encrypted_master_key: 'blob', wrapping_method: 'local_root', created_at: '2026-09-29T00:00:00.000Z' }),
    }],
    ...overrides,
  };
}

describe('pairCommand', () => {
  const mockExit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as any);

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfirmPairAccount.mockResolvedValue(true);

    mockAuthorizeDevice.mockResolvedValue({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://x/verify', expires_in: 600, interval: 5 });
    mockPollDeviceToken.mockResolvedValue({
      token: { access_token: 'jwt', refresh_token: 'rt', expires_in: 600 },
      user: EXCHANGE_USER,
      organizations: [{ id: 'org-123', workos_org_id: 'wo_1', name: 'Acme' }],
    });
    mockInstallDeviceGrantSession.mockResolvedValue({ success: true, organization_id: 'org-123', user_id: EXCHANGE_USER.id });
    mockAuthenticateSilent.mockResolvedValue({ success: true, organization_id: 'org-123', user_id: EXCHANGE_USER.id });
    mockPickupDevicePairing.mockImplementation(async () => ({ sealed: await sealAsBrowser(buildPayload(), capturedPairPublicKey()) }));
    mockReadLocalRoot.mockReturnValue(null);
    mockRenderTerminalQr.mockReturnValue(null);
    mockResolveKeepOrigin.mockReturnValue('https://keep.capy.sc');
    mockIsFullScreenQrEligible.mockReturnValue(false);
  });

  test('writes local.key + key.enc for every entry matching the logged-in user, and reports it under --json', async () => {
    const { stdout } = await withCapturedIo(() => pairCommand({ json: true }));
    expect(stdout.trim().startsWith('{')).toBe(true);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.paired).toEqual([{ org_id: 'org-123', user_id: 'user-456' }]);

    expect(mockSaveLocalRoot).toHaveBeenCalledTimes(1);
    const [orgArg, kLocalArg, userArg] = mockSaveLocalRoot.mock.calls[0];
    expect(orgArg).toBe('org-123');
    expect(userArg).toBe('user-456');
    expect(Buffer.isBuffer(kLocalArg)).toBe(true);
    expect(kLocalArg.equals(Buffer.alloc(32, 5))).toBe(true);

    expect(mockWriteOrgKeyFileRaw).toHaveBeenCalledTimes(1);
    expect(mockWriteOrgKeyFileRaw.mock.calls[0][0]).toBe('org-123');
    expect(mockWriteOrgKeyFileRaw.mock.calls[0][2]).toBe('user-456');
  });

  test('under --json, the QR/link/progress lines go to stderr and stdout stays pure JSON', async () => {
    const { stdout, stderr } = await withCapturedIo(() => pairCommand({ json: true }));
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain('ABCD-EFGH');
  });

  // CAP-684 follow-up: `bun test`'s stdin is never a real TTY, so this
  // exercises the non-interactive human path (masked link + a `--json`
  // hint) — the TTY/interactive OSC 8 + key-prompt path (and the
  // concurrent-with-polling property) is exercised at the mechanism level
  // in tests/ui/maskedLinkPrompt.test.ts, since driving a REAL raw-mode
  // stdin through a faked `isTTY` throws (not a real TTY-backed stream) —
  // the same constraint documented in
  // tests/commands/deployDokploySystemStoreToken.test.ts.
  test('human mode (non-TTY) prints the code and the MASKED link, plus a --json hint — never the query string', async () => {
    const { stdout } = await withCapturedIo(() => pairCommand({}));
    expect(stdout).toContain('ABCD-EFGH');
    expect(stdout).toContain('https://keep.capy.sc/device?…');
    expect(stdout).toContain('Run with --json to print the full link.');
    // The device code as a query param (the sensitive redeemable value)
    // must never appear in plain text.
    expect(stdout).not.toContain('code=ABCD-EFGH');
  });

  test('the QR always encodes the FULL device link (?code=... and all), never the masked text', async () => {
    await withCapturedIo(() => pairCommand({}));
    expect(mockRenderTerminalQr).toHaveBeenCalledTimes(1);
    const [qrArg] = mockRenderTerminalQr.mock.calls[0] as [string];
    expect(qrArg).toBe('https://keep.capy.sc/device?code=ABCD-EFGH');
    expect(qrArg).not.toBe('https://keep.capy.sc/device?…');
  });

  test('keeps the selected API and Keep origins together for staging pairing', async () => {
    mockResolveKeepOrigin.mockReturnValue('https://keep.staging.test');
    await withCapturedIo(() => pairCommand({ json: true, apiUrl: 'https://api.staging.test', devMode: true }));

    expect(mockAuthorizeDevice).toHaveBeenCalledWith('https://api.staging.test', expect.any(String));
    expect(mockRenderTerminalQr).toHaveBeenCalledWith('https://keep.staging.test/device?code=ABCD-EFGH');
  });

  test('centers only explicit pair while inline pairing keeps the caller flow in place', async () => {
    const fullScreenView = { done: Promise.resolve(), stop: jest.fn() };
    mockRenderTerminalQr.mockReturnValue({ text: 'QR', hint: null });
    mockIsFullScreenQrEligible.mockReturnValue(true);
    mockStartFullScreenQrView.mockReturnValue(fullScreenView);

    await withCapturedIo(() => pairCommand({}));
    expect(mockStartFullScreenQrView).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    mockConfirmPairAccount.mockResolvedValue(true);
    mockAuthorizeDevice.mockResolvedValue({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://x/verify', expires_in: 600, interval: 5 });
    mockPollDeviceToken.mockResolvedValue({
      token: { access_token: 'jwt', refresh_token: 'rt', expires_in: 600 },
      user: EXCHANGE_USER,
      organizations: [{ id: 'org-123', workos_org_id: 'wo_1', name: 'Acme' }],
    });
    mockInstallDeviceGrantSession.mockResolvedValue({ success: true, organization_id: 'org-123', user_id: EXCHANGE_USER.id });
    mockAuthenticateSilent.mockResolvedValue({ success: true, organization_id: 'org-123', user_id: EXCHANGE_USER.id });
    mockPickupDevicePairing.mockImplementation(async () => ({ sealed: await sealAsBrowser(buildPayload(), capturedPairPublicKey()) }));
    mockReadLocalRoot.mockReturnValue(null);
    mockRenderTerminalQr.mockReturnValue({ text: 'QR', hint: null });
    mockResolveKeepOrigin.mockReturnValue('https://keep.capy.sc');
    mockIsFullScreenQrEligible.mockReturnValue(true);

    await withCapturedIo(() => pairCommand({ presentation: 'inline' }));
    expect(mockStartFullScreenQrView).not.toHaveBeenCalled();
  });

  test('--json is untouched: the progress line on stderr still carries the FULL link, exactly as before', async () => {
    const { stderr } = await withCapturedIo(() => pairCommand({ json: true }));
    expect(stderr).toContain('/device?code=ABCD-EFGH');
  });

  test('only writes entries whose user_id matches the logged-in user', async () => {
    mockPickupDevicePairing.mockImplementation(async () => ({
      sealed: await sealAsBrowser(
        buildPayload({
          entries: [
            { org_id: 'org-mine', user_id: 'user-456', k_local: Buffer.alloc(32, 1).toString('base64url'), key_enc: '{}' },
            { org_id: 'org-other-user', user_id: 'someone-else', k_local: Buffer.alloc(32, 2).toString('base64url'), key_enc: '{}' },
          ],
        }),
        capturedPairPublicKey(),
      ),
    }));
    const { stdout } = await withCapturedIo(() => pairCommand({ json: true }));
    const parsed = JSON.parse(stdout);
    expect(parsed.paired).toEqual([{ org_id: 'org-mine', user_id: 'user-456' }]);
    expect(mockSaveLocalRoot).toHaveBeenCalledTimes(1);
    expect(mockSaveLocalRoot.mock.calls[0][0]).toBe('org-mine');
  });

  test('refuses with coded PAIR_NO_KEYS when no entry matches the logged-in user', async () => {
    mockPickupDevicePairing.mockImplementation(async () => ({
      sealed: await sealAsBrowser(buildPayload({ entries: [] }), capturedPairPublicKey()),
    }));
    const { stdout, stderr } = await withCapturedIo(async () => {
      await expect(pairCommand({ json: true })).rejects.toThrow();
    });
    // Under --json, progress (QR/link/code) goes to stderr — only the final
    // refusal is on stdout, and it must be pure JSON.
    expect(stderr).toContain('ABCD-EFGH');
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('PAIR_NO_KEYS');
    expect(mockSaveLocalRoot).not.toHaveBeenCalled();
  });

  test('refuses with coded PAIR_LOCAL_KEY_CONFLICT when local.key already exists with a different value, and does not write', async () => {
    mockReadLocalRoot.mockReturnValue(Buffer.alloc(32, 9)); // different from the sealed entry's k_local (all 5s)
    const { stdout } = await withCapturedIo(async () => {
      await expect(pairCommand({ json: true })).rejects.toThrow();
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('PAIR_LOCAL_KEY_CONFLICT');
    expect(mockSaveLocalRoot).not.toHaveBeenCalled();
  });

  test('--force overwrites a conflicting local.key', async () => {
    mockReadLocalRoot.mockReturnValue(Buffer.alloc(32, 9));
    const { stdout } = await withCapturedIo(() => pairCommand({ json: true, force: true }));
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(mockSaveLocalRoot).toHaveBeenCalledTimes(1);
  });

  test('an identical existing local.key is not a conflict, --force or not', async () => {
    mockReadLocalRoot.mockReturnValue(Buffer.alloc(32, 5)); // matches the sealed entry's k_local
    const { stdout } = await withCapturedIo(() => pairCommand({ json: true }));
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(mockSaveLocalRoot).toHaveBeenCalledTimes(1);
  });

  test('device pairing denial refuses with a coded CapyError, never a bare exit', async () => {
    mockPollDeviceToken.mockRejectedValue(new CapyError('Device pairing was denied', ERROR_CODES.AUTH_FAILED, { reason: 'access_denied' }));
    const { stdout } = await withCapturedIo(async () => {
      await expect(pairCommand({ json: true })).rejects.toThrow();
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('AUTH_FAILED');
    expect(mockPickupDevicePairing).not.toHaveBeenCalled();
  });

  test('stops after account-confirmation cancellation without installing state or retrying', async () => {
    mockConfirmPairAccount.mockResolvedValue(false);
    const { stdout } = await withCapturedIo(async () => {
      await expect(pairCommand({ json: true, expectedUserId: EXCHANGE_USER.id })).rejects.toThrow();
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('AUTH_FAILED');
    expect(mockConfirmPairAccount).toHaveBeenCalledTimes(1);
    expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
    expect(mockPickupDevicePairing).not.toHaveBeenCalled();
    expect(mockSaveLocalRoot).not.toHaveBeenCalled();
  });

  test('refuses a paired account that differs from the account that started the root command', async () => {
    mockPollDeviceToken.mockResolvedValue({
      token: { access_token: 'jwt', refresh_token: 'rt', expires_in: 600 },
      user: { ...EXCHANGE_USER, id: 'other-user' },
      organizations: [{ id: 'org-123', workos_org_id: 'wo_1', name: 'Acme' }],
    });
    const { stdout } = await withCapturedIo(async () => {
      await expect(pairCommand({ json: true, expectedUserId: EXCHANGE_USER.id })).rejects.toThrow();
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('AUTH_FAILED');
    expect(mockConfirmPairAccount).not.toHaveBeenCalled();
    expect(mockInstallDeviceGrantSession).not.toHaveBeenCalled();
    expect(mockSaveLocalRoot).not.toHaveBeenCalled();
  });

  test('falls back to authenticateSilent() when the device-grant token has no scoped org yet', async () => {
    mockInstallDeviceGrantSession.mockResolvedValue({ success: true, organization_id: '', user_id: EXCHANGE_USER.id });
    const { result, stdout } = await withCapturedIo(() => pairCommand({ json: true }));
    expect(mockAuthenticateSilent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, organization_id: 'org-123', user_id: EXCHANGE_USER.id });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
  });

  test('rejects before Transport when an orgless device grant cannot establish a session', async () => {
    mockInstallDeviceGrantSession.mockResolvedValue({ success: true, organization_id: '', user_id: EXCHANGE_USER.id });
    mockAuthenticateSilent.mockResolvedValue({ success: false, error: 'No valid session available' });
    const { stdout } = await withCapturedIo(async () => {
      await expect(pairCommand({ json: true })).rejects.toThrow();
    });

    expect(JSON.parse(stdout).code).toBe('AUTH_FAILED');
    expect(mockPickupDevicePairing).not.toHaveBeenCalled();
  });

  test('rejects before Transport when the requested organization cannot be scoped after pairing', async () => {
    mockAuthenticateSilent.mockResolvedValue({ success: false, error: 'No access to the requested organization' });
    const { stdout } = await withCapturedIo(async () => {
      await expect(pairCommand({ json: true, organizationId: 'org-not-authorized' })).rejects.toThrow();
    });

    expect(mockAuthenticateSilent).toHaveBeenCalledWith('org-not-authorized');
    expect(JSON.parse(stdout).code).toBe('AUTH_FAILED');
    expect(mockPickupDevicePairing).not.toHaveBeenCalled();
  });

  test('reuses an injected AuthService for interactive login without starting another auth flow', async () => {
    const injectedInstall = jest.fn().mockResolvedValue({ success: true, organization_id: 'org-123', user_id: EXCHANGE_USER.id });
    const injectedSilent = jest.fn();
    const injectedToken = jest.fn();
    const injectedAuthService = {
      installDeviceGrantSession: injectedInstall,
      authenticateSilent: injectedSilent,
      getValidToken: injectedToken,
    };

    const { stdout } = await withCapturedIo(() => pairCommand({ json: true, authService: injectedAuthService as any }));

    expect(JSON.parse(stdout).ok).toBe(true);
    expect(injectedInstall).toHaveBeenCalledTimes(1);
    const [tokenProvider] = mockSetTokenProvider.mock.calls[0] as [() => unknown];
    tokenProvider();
    expect(injectedToken).toHaveBeenCalledTimes(1);
    expect(AuthService).not.toHaveBeenCalled();
  });

  test('a pickup refusal (e.g. PAIRING_NOT_READY) surfaces its own code, not a generic one', async () => {
    mockPickupDevicePairing.mockRejectedValue(new CapyError('Not sealed yet', ERROR_CODES.PAIRING_NOT_READY));
    const { stdout } = await withCapturedIo(async () => {
      await expect(pairCommand({ json: true })).rejects.toThrow();
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('PAIRING_NOT_READY');
  });

  test('pickup\'s `sealed` field is a JSON string end to end — parsed and opened, never handled as a pre-parsed object', async () => {
    // The default `beforeEach` mock already builds `sealed` via
    // `sealAsBrowser`, matching the real wire contract (a JSON string, not
    // an object). Run the whole command, confirm it succeeds (proving
    // `pairCommand` actually parsed and opened that string), then inspect
    // what the mock handed back to prove it really was a string and not an
    // object a future regression quietly reverted to.
    const { stdout } = await withCapturedIo(() => pairCommand({ json: true }));
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);

    expect(mockPickupDevicePairing).toHaveBeenCalledTimes(1);
    const result = await mockPickupDevicePairing.mock.results[0].value;
    expect(typeof result.sealed).toBe('string');
    const parsedEnvelope = JSON.parse(result.sealed);
    expect(parsedEnvelope).toMatchObject({ v: 1 });
    expect(typeof parsedEnvelope.epk).toBe('string');
    expect(typeof parsedEnvelope.iv).toBe('string');
    expect(typeof parsedEnvelope.ct).toBe('string');
  });

  test('a malformed `sealed` string refuses with a coded INVALID_FORMAT, not a crash', async () => {
    mockPickupDevicePairing.mockResolvedValue({ sealed: 'not json at all' });
    const { stdout } = await withCapturedIo(async () => {
      await expect(pairCommand({ json: true })).rejects.toThrow();
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('INVALID_FORMAT');
    expect(mockSaveLocalRoot).not.toHaveBeenCalled();
  });

  test('a `sealed` string that parses but has the wrong shape also refuses with INVALID_FORMAT', async () => {
    mockPickupDevicePairing.mockResolvedValue({ sealed: JSON.stringify({ v: 1, epk: 'x' }) }); // missing iv/ct
    const { stdout } = await withCapturedIo(async () => {
      await expect(pairCommand({ json: true })).rejects.toThrow();
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('INVALID_FORMAT');
  });
});

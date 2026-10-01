/**
 * `capy transport` (CAP-684; CAP-692 for the v3-only wire format) at the
 * command level.
 *
 * `--json` must print pure JSON on stdout (`{url, expires_at}`, no QR) and
 * every refusal must be coded — never a bare `process.exit` with prose only.
 * `AuthService`/`ServiceClient`/`ProjectManager` are mocked the same way
 * `inviteCommand.test.ts` mocks them; `globalConfig` is mocked for its
 * local-key reads only, everything else stays real (`mock.module` is
 * process-wide — spreading the real module keeps every other export intact,
 * which is also why this file is in run-tests.sh's isolated list).
 *
 * v3 is the only link format (no v2 fallback) — every happy-path test's
 * mock `key.enc`/org id/user id/transport id is shaped so `packTransportV3`
 * actually succeeds (a real UUID org id, a `user_`+ULID user id, canonical
 * base64, ms-precision `created_at`, and the exact pretty-JSON shape
 * `saveMasterKey` writes), so these tests exercise the real v3 fragment,
 * not a synthetic shortcut. The "can't pack" path has its own dedicated
 * test below using a key.enc shaped like the OLD (now-removed) v2 fixture.
 */
import { mock, jest, describe, test, expect, beforeEach, spyOn } from 'bun:test';

const mockDetectProjectState = jest.fn();
const mockAuthenticateSilent = jest.fn();
const mockAuthenticate = jest.fn();
const mockGetToken = jest.fn();
const mockSetTokenProvider = jest.fn();
const mockCreateTransport = jest.fn();

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: jest.fn().mockImplementation(() => ({
    detectProjectState: mockDetectProjectState,
  })),
}));

mock.module('../../src/auth/authService', () => ({
  AuthService: jest.fn().mockImplementation(() => ({
    authenticate: mockAuthenticate,
    authenticateSilent: mockAuthenticateSilent,
    getValidToken: mockGetToken,
  })),
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: mockSetTokenProvider,
    createTransport: mockCreateTransport,
  })),
}));

const realGlobalConfig = await import('../../src/config/globalConfig');
const mockReadLocalRoot = jest.fn();
const mockReadOrgKeyFileRaw = jest.fn();
mock.module('../../src/config/globalConfig', () => ({
  ...realGlobalConfig,
  readLocalRoot: mockReadLocalRoot,
  readOrgKeyFileRaw: mockReadOrgKeyFileRaw,
}));

// Masked-link work (CAP-684 follow-up): `renderTerminalQr` is mocked so
// tests can assert on exactly what url it was called with (the QR must
// always encode the FULL url, never the masked text — Vince's explicit
// addendum) without depending on a real TTY to make it render anything.
const mockRenderTerminalQr = jest.fn();
mock.module('../../src/ui/terminalQr', () => ({ renderTerminalQr: mockRenderTerminalQr }));

import { TransportCommand } from '../../src/commands/transportCommand';
import { openTransportBlob, parseTransportFragmentV4, unpackTransportV3 } from '../../src/crypto/transportPackV3';

const ORG_ID = '9f1c2b3a-0000-4000-8000-000000000001';
const USER_ID = 'user_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TRANSPORT_ID = '11111111-1111-4111-8111-111111111111';
const K_LOCAL = Buffer.alloc(32, 5);
// A canonical (round-trips through base64 unchanged) 60-byte blob — the
// same shape a real local_root `encrypted_master_key` has (iv[12] ||
// ciphertext || tag[16]). Its content doesn't matter to packTransportV3;
// only its canonical-base64-ness and the surrounding JSON shape do.
const MASTER_KEY_B64 = 'F1GCcyi5YK/rsiuuDSH5OBg0BBV9Jc1bEt4AvuUjVTDrFglY4dinuE6hOAW+u797pFxHxc7/NmBg4aa3';
const CREATED_AT = '2026-09-29T00:00:00.000Z';
// Exact shape `saveMasterKey` (globalConfig.ts) writes — pretty-printed,
// this field order, `version: '2.0'`, `wrapping_method: 'local_root'`.
const KEY_ENC = JSON.stringify(
  { version: '2.0', org_id: ORG_ID, encrypted_master_key: MASTER_KEY_B64, wrapping_method: 'local_root', created_at: CREATED_AT },
  null,
  2,
);
// The OLD v2 fixture shape (single-line JSON, non-UUID org id) — v2 is
// gone, so this now exercises the "can't pack losslessly, refuse" path
// instead of a fallback.
const UNPACKABLE_KEY_ENC = JSON.stringify({ version: '2.0', org_id: 'org-123', encrypted_master_key: 'blob', wrapping_method: 'local_root', created_at: '2026-09-29T00:00:00.000Z' });

/**
 * Reads back what `console.log`/`console.error` were called with straight
 * from the spy's own call log (`spyOn(...).mock.calls`) — no accumulator of
 * our own to mutate on every call. `mockRestore()` clears `.mock.calls`, so
 * callers must read `stdout()`/`stderr()` BEFORE calling `restore()`.
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
async function withCapturedIo(run: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const io = captureStdio();
  try {
    await run();
    return { stdout: io.stdout(), stderr: io.stderr() };
  } finally {
    io.restore();
  }
}

describe('TransportCommand', () => {
  const mockExit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as any);

  beforeEach(() => {
    jest.clearAllMocks();
    mockDetectProjectState.mockResolvedValue({ organizationId: ORG_ID, userId: USER_ID });
    mockAuthenticateSilent.mockResolvedValue({
      success: true,
      user_id: USER_ID,
      user_email: 'mike@example.com',
      organization_id: ORG_ID,
      organizations: [{ id: ORG_ID, name: 'Acme' }],
    });
    mockReadLocalRoot.mockReturnValue(K_LOCAL);
    mockReadOrgKeyFileRaw.mockReturnValue(KEY_ENC);
    mockCreateTransport.mockResolvedValue({ id: TRANSPORT_ID, expires_at: '2026-09-29T00:15:00.000Z' });
    mockRenderTerminalQr.mockReturnValue(null);
  });

  test('--json prints pure JSON with {url, expires_at} and no QR', async () => {
    const { stdout, stderr } = await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout);
    // v4 fragment: `#4.<id as 16 bytes, base64url (22 chars)>.<S as 32 bytes, base64url (43 chars)>`.
    expect(parsed.url).toMatch(/^https:\/\/keep\.capy\.sc\/transport#4\.[\w-]{22}\.[\w-]{43}$/);
    expect(parsed.expires_at).toBe('2026-09-29T00:15:00.000Z');
    // No QR block leaked into stdout alongside the JSON.
    expect(stdout.trim().startsWith('{')).toBe(true);
  });

  test('sends the SEALED blob as the transport ciphertext (never S, never plaintext k_local/key.enc)', async () => {
    const { stdout } = await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    const ciphertextArg = mockCreateTransport.mock.calls[0][0];
    expect(typeof ciphertextArg).toBe('string');
    // iv (12) + tag (16) + a packed entry: well over a bare 32-byte key.
    expect(Buffer.from(ciphertextArg, 'base64url').length).toBeGreaterThan(12 + 16 + 74);
    expect(ciphertextArg).not.toContain(K_LOCAL.toString('base64url'));
    expect(ciphertextArg).not.toContain(MASTER_KEY_B64);

    // S lives only in the printed link; the service never receives it.
    const fragment = JSON.parse(stdout).url.split('#')[1];
    const { key } = parseTransportFragmentV4(fragment);
    expect(ciphertextArg).not.toContain(key.toString('base64url'));
  });

  test('the server ciphertext opens with the S from the link, and the link carries the returned id', async () => {
    const { stdout } = await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    const fragment = JSON.parse(stdout).url.split('#')[1];
    const { id, key } = parseTransportFragmentV4(fragment);
    expect(id).toBe(TRANSPORT_ID);
    const entry = unpackTransportV3(openTransportBlob(mockCreateTransport.mock.calls[0][0], key));
    expect(entry).toEqual({ org_id: ORG_ID, user_id: USER_ID, k_local: K_LOCAL.toString('base64url'), key_enc: KEY_ENC });
  });

  // CAP-684 follow-up: `bun test`'s stdin is never a real TTY, so this
  // exercises the non-interactive human path (masked link + a `--json`
  // hint) — the TTY/interactive OSC 8 + key-prompt path is exercised at
  // the mechanism level in tests/ui/maskedLinkPrompt.test.ts, since driving
  // a REAL raw-mode stdin through a faked `isTTY` throws (not a real
  // TTY-backed stream) — the same constraint documented in
  // tests/commands/deployDokploySystemStoreToken.test.ts.
  test('human mode (non-TTY) prints the MASKED link, a --json hint, and expiry — never the full fragment', async () => {
    const { stdout } = await withCapturedIo(() => new TransportCommand().execute({}));
    expect(stdout).toContain('https://keep.capy.sc/transport#…');
    expect(stdout).toContain('Run with --json to print the full link.');
    expect(stdout).toContain('2026-09-29T00:15:00.000Z');
    // The fragment (encrypted key material) must never appear in plain text.
    expect(stdout).not.toContain(`3.${Buffer.from(TRANSPORT_ID.replace(/-/g, ''), 'hex').toString('base64url')}.`);
    expect(stdout).not.toMatch(/#[^…\s]/);
  });

  test('the QR always encodes the FULL url (fragment and all), never the masked text', async () => {
    await withCapturedIo(() => new TransportCommand().execute({}));
    expect(mockRenderTerminalQr).toHaveBeenCalledTimes(1);
    const [qrArg] = mockRenderTerminalQr.mock.calls[0] as [string];
    expect(qrArg).toMatch(/^https:\/\/keep\.capy\.sc\/transport#4\.[\w-]{22}\.[\w-]{43}$/);
    expect(qrArg).not.toBe('https://keep.capy.sc/transport#…');
  });

  test('--json is untouched: renderTerminalQr is never called, and no QR/masked-link text leaks into stdout', async () => {
    const { stdout } = await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    expect(mockRenderTerminalQr).not.toHaveBeenCalled();
    expect(stdout.trim().startsWith('{')).toBe(true);
    expect(stdout).not.toContain('Run with --json');
  });

  test('refuses with a coded TRANSPORT_NO_LOCAL_KEY when there is no local key on this machine', async () => {
    mockReadLocalRoot.mockReturnValue(null);
    const { stdout, stderr } = await withCapturedIo(async () => {
      await expect(new TransportCommand().execute({ json: true })).rejects.toThrow();
    });
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('TRANSPORT_NO_LOCAL_KEY');
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  test('refuses with a coded TRANSPORT_NO_LOCAL_KEY when key.enc is missing (even if local.key exists)', async () => {
    mockReadOrgKeyFileRaw.mockReturnValue(null);
    const { stdout } = await withCapturedIo(async () => {
      await expect(new TransportCommand().execute({ json: true })).rejects.toThrow();
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('TRANSPORT_NO_LOCAL_KEY');
  });

  test('a service failure refuses with SERVICE_ERROR under --json, prose on stderr under human mode', async () => {
    mockCreateTransport.mockRejectedValue(new Error('network down'));
    const { stdout } = await withCapturedIo(async () => {
      await expect(new TransportCommand().execute({ json: true })).rejects.toThrow();
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.code).toBe('SERVICE_ERROR');
  });

  // CAP-692: v3 is the only link format now — there is no v2 to fall back
  // to, so an unpackable key.enc refuses outright, coded, and (the point of
  // checking BEFORE calling the service) never burns a one-time transport
  // row for a link that could never be produced.
  test('refuses with a coded TRANSPORT_KEY_FORMAT_UNSUPPORTED when key.enc cannot be packed losslessly (no v2 fallback) — under --json', async () => {
    mockReadOrgKeyFileRaw.mockReturnValue(UNPACKABLE_KEY_ENC);
    const { stdout, stderr } = await withCapturedIo(async () => {
      await expect(new TransportCommand().execute({ json: true })).rejects.toThrow();
    });
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('TRANSPORT_KEY_FORMAT_UNSUPPORTED');
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  test('refuses with a coded TRANSPORT_KEY_FORMAT_UNSUPPORTED under human mode too — prose on stderr, nothing on stdout', async () => {
    mockReadOrgKeyFileRaw.mockReturnValue(UNPACKABLE_KEY_ENC);
    const { stdout, stderr } = await withCapturedIo(async () => {
      await expect(new TransportCommand().execute({})).rejects.toThrow();
    });
    expect(stdout).toBe('');
    expect(stderr.length).toBeGreaterThan(0);
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  // CAP-684 follow-up (2026-09-30): the Vince-approved intro copy explaining
  // what `capy transport` is for, printed ahead of the QR/link.
  describe('intro copy', () => {
    test('prints all four paragraphs, in order, before the link label', async () => {
      const { stdout } = await withCapturedIo(() => new TransportCommand().execute({}));
      const paragraph1 = 'Transport works with';
      const paragraph2 = 'Open or scan this link to activate your transport key';
      const paragraph3 = 'If you lose the device or browser that activated the key';
      const paragraph4 = 'Why we do this: https://capy.sc/zero-trust';
      const label = 'Open on your other device:';

      expect(stdout).toContain(paragraph1);
      expect(stdout).toContain('to let you use Capy anywhere: your other devices, sandboxes, and cloud AI sessions.');
      expect(stdout).toContain(paragraph2);
      expect(stdout).toContain("We recommend your phone's browser.");
      expect(stdout).toContain("Sign in with the same account as this capy session, or activation won't work.");
      expect(stdout).toContain(paragraph3);
      expect(stdout).toContain('That creates a new transport key to activate in a new browser.');
      expect(stdout).toContain(paragraph4);

      const idx1 = stdout.indexOf(paragraph1);
      const idx2 = stdout.indexOf(paragraph2);
      const idx3 = stdout.indexOf(paragraph3);
      const idx4 = stdout.indexOf(paragraph4);
      const idxLabel = stdout.indexOf(label);
      expect(idx1).toBeGreaterThanOrEqual(0);
      expect(idx2).toBeGreaterThan(idx1);
      expect(idx3).toBeGreaterThan(idx2);
      expect(idx4).toBeGreaterThan(idx3);
      expect(idxLabel).toBeGreaterThan(idx4);
    });

    test('--json stdout stays pure JSON with only url and expires_at — no intro copy leaks in', async () => {
      const { stdout } = await withCapturedIo(() => new TransportCommand().execute({ json: true }));
      const parsed = JSON.parse(stdout);
      expect(Object.keys(parsed).sort()).toEqual(['expires_at', 'url']);
      expect(stdout).not.toContain('Transport works with');
      expect(stdout).not.toContain('Why we do this');
    });

    test('with NO_COLOR set, "capy pair" and "capy transport" appear as plain text (no ANSI escapes)', async () => {
      const prevNoColor = process.env.NO_COLOR;
      process.env.NO_COLOR = '1';
      try {
        const { stdout } = await withCapturedIo(() => new TransportCommand().execute({}));
        expect(stdout).toContain('Transport works with capy pair to let you use Capy anywhere');
        expect(stdout).toContain('run capy transport on any device where Capy is set up');
        expect(stdout).not.toContain('\x1b[1m');
      } finally {
        if (prevNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = prevNoColor;
      }
    });

    test('without NO_COLOR, "capy pair" and "capy transport" are wrapped in bold ANSI', async () => {
      const prevNoColor = process.env.NO_COLOR;
      delete process.env.NO_COLOR;
      try {
        const { stdout } = await withCapturedIo(() => new TransportCommand().execute({}));
        expect(stdout).toContain('\x1b[1mcapy pair\x1b[0m');
        expect(stdout).toContain('\x1b[1mcapy transport\x1b[0m');
      } finally {
        if (prevNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = prevNoColor;
      }
    });
  });
});

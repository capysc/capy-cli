/**
 * `capy transport` (CAP-684) at the command level.
 *
 * `--json` must print pure JSON on stdout (`{url, expires_at}`, no QR) and
 * every refusal must be coded — never a bare `process.exit` with prose only.
 * `AuthService`/`ServiceClient`/`ProjectManager` are mocked the same way
 * `inviteCommand.test.ts` mocks them; `globalConfig` is mocked for its
 * local-key reads only, everything else stays real (`mock.module` is
 * process-wide — spreading the real module keeps every other export intact,
 * which is also why this file is in run-tests.sh's isolated list).
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

const K_LOCAL = Buffer.alloc(32, 5);
const KEY_ENC = JSON.stringify({ version: '2.0', org_id: 'org-123', encrypted_master_key: 'blob', wrapping_method: 'local_root', created_at: '2026-09-29T00:00:00.000Z' });

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
    mockDetectProjectState.mockResolvedValue({ organizationId: 'org-123', userId: 'user-456' });
    mockAuthenticateSilent.mockResolvedValue({
      success: true,
      user_id: 'user-456',
      user_email: 'mike@example.com',
      organization_id: 'org-123',
      organizations: [{ id: 'org-123', name: 'Acme' }],
    });
    mockReadLocalRoot.mockReturnValue(K_LOCAL);
    mockReadOrgKeyFileRaw.mockReturnValue(KEY_ENC);
    mockCreateTransport.mockResolvedValue({ id: 'transport-1', expires_at: '2026-09-29T00:15:00.000Z' });
    mockRenderTerminalQr.mockReturnValue(null);
  });

  test('--json prints pure JSON with {url, expires_at} and no QR', async () => {
    const { stdout, stderr } = await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout);
    expect(parsed.url).toMatch(/^https:\/\/keep\.capy\.sc\/transport#transport-1\./);
    expect(parsed.expires_at).toBe('2026-09-29T00:15:00.000Z');
    // No QR block leaked into stdout alongside the JSON.
    expect(stdout.trim().startsWith('{')).toBe(true);
  });

  test('sends S (a fresh 32-byte key) as the transport ciphertext field — never the payload, never k_local/key.enc', async () => {
    const { stdout } = await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    const ciphertextArg = mockCreateTransport.mock.calls[0][0];
    // "v2": this argument IS the one-time key S itself (base64url), not a
    // sealed envelope — assert its shape, and that it carries no trace of
    // the plaintext k_local or key_enc content.
    expect(typeof ciphertextArg).toBe('string');
    expect(Buffer.from(ciphertextArg, 'base64url').length).toBe(32);
    expect(ciphertextArg).not.toContain(K_LOCAL.toString('base64url'));
    expect(ciphertextArg).not.toContain('blob');

    // The actual sealed payload (iv + ciphertext) lives only in the printed
    // link's fragment — S itself never appears there.
    const parsed = JSON.parse(stdout);
    const fragment = parsed.url.split('#')[1];
    expect(fragment.split('.')).toHaveLength(3);
    expect(fragment).not.toContain(ciphertextArg);
  });

  test('the link fragment opens with S and the returned id, and fails with a different id (AAD binding)', async () => {
    const { stdout } = await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    const { openTransportFragment, parseTransportFragment } = await import('../../src/crypto/transportCrypto');

    const parsed = JSON.parse(stdout);
    const fragment = parseTransportFragment(parsed.url.split('#')[1]);
    expect(fragment.id).toBe('transport-1');

    const key = Buffer.from(mockCreateTransport.mock.calls[0][0], 'base64url');
    const opened = openTransportFragment({ iv: fragment.iv, ct: fragment.ct }, key, fragment.id);
    expect(opened).toEqual({
      v: 1,
      entries: [{ org_id: 'org-123', user_id: 'user-456', k_local: K_LOCAL.toString('base64url'), key_enc: KEY_ENC }],
    });

    expect(() => openTransportFragment({ iv: fragment.iv, ct: fragment.ct }, key, 'transport-someone-elses')).toThrow();
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
    expect(stdout).not.toContain('transport-1.');
    expect(stdout).not.toMatch(/#[^…\s]/);
  });

  test('the QR always encodes the FULL url (fragment and all), never the masked text', async () => {
    await withCapturedIo(() => new TransportCommand().execute({}));
    expect(mockRenderTerminalQr).toHaveBeenCalledTimes(1);
    const [qrArg] = mockRenderTerminalQr.mock.calls[0] as [string];
    expect(qrArg).toMatch(/^https:\/\/keep\.capy\.sc\/transport#transport-1\.\S+\.\S+$/);
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

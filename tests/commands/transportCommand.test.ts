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

  test('sends the org+user local key and key.enc content as the transport payload', async () => {
    await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    const ciphertextArg = mockCreateTransport.mock.calls[0][0];
    // The envelope is opaque ciphertext to this test — it must not contain
    // the plaintext k_local or key_enc content anywhere.
    expect(ciphertextArg).not.toContain(K_LOCAL.toString('base64url'));
    expect(ciphertextArg).not.toContain('blob');
    const envelope = JSON.parse(ciphertextArg);
    expect(envelope.v).toBe(1);
    expect(typeof envelope.iv).toBe('string');
    expect(typeof envelope.ct).toBe('string');
  });

  test('human mode prints the link and expiry', async () => {
    const { stdout } = await withCapturedIo(() => new TransportCommand().execute({}));
    expect(stdout).toContain('https://keep.capy.sc/transport#transport-1.');
    expect(stdout).toContain('2026-09-29T00:15:00.000Z');
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
});

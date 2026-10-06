import { mock, jest, describe, test, expect, beforeEach, spyOn } from 'bun:test';

const mockResolveOrgContext = jest.fn();
const mockUnwrapMasterKey = jest.fn();
const mockCreateTransport = jest.fn();
const mockWrapOuterLayer = jest.fn();
const mockUploadTransport = jest.fn();
const mockRenderTerminalQr = jest.fn();

mock.module('../../src/core/orgContext', () => ({ resolveOrgContext: mockResolveOrgContext }));
mock.module('../../src/crypto/keyResolver', () => ({ unwrapMasterKey: mockUnwrapMasterKey }));
mock.module('../../src/ui/terminalQr', () => ({ renderTerminalQr: mockRenderTerminalQr }));

import { TransportCommand } from '../../src/commands/transportCommand';
import { openTransportBlob, parseTransportFragmentV4 } from '../../src/crypto/transportPackV3';

const ORG_ID = '9f1c2b3a-0000-4000-8000-000000000001';
const USER_ID = 'user_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TRANSPORT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_MASTER_KEY = Buffer.alloc(32, 5);

function captureStdio(): { readonly stdout: () => string; readonly stderr: () => string; readonly restore: () => void } {
  const log = spyOn(console, 'log').mockImplementation((() => {}) as any);
  const err = spyOn(console, 'error').mockImplementation((() => {}) as any);
  const joined = (calls: readonly unknown[][]): string => calls.map((args) => args.join(' ') + '\n').join('');
  return {
    stdout: () => joined(log.mock.calls as unknown[][]),
    stderr: () => joined(err.mock.calls as unknown[][]),
    restore: () => {
      log.mockRestore();
      err.mockRestore();
    },
  };
}

async function withCapturedIo(run: () => Promise<void>): Promise<{ readonly stdout: string; readonly stderr: string }> {
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
    const serviceClient = {
      coDecrypt: jest.fn().mockResolvedValue({ plaintext: 'source-inner' }),
      wrapOuterLayer: mockWrapOuterLayer,
      createTransport: mockCreateTransport,
      uploadTransport: mockUploadTransport,
      getTransportStatus: jest.fn(),
    };
    mockResolveOrgContext.mockResolvedValue({ orgId: ORG_ID, userId: USER_ID, serviceClient });
    mockUnwrapMasterKey.mockResolvedValue(SOURCE_MASTER_KEY);
    mockCreateTransport.mockResolvedValue({ id: TRANSPORT_ID, expires_at: '2026-10-06T00:15:00.000Z' });
    mockWrapOuterLayer.mockResolvedValue({ ciphertext: 'context-bound-key-enc' });
    mockUploadTransport.mockResolvedValue(undefined);
    mockRenderTerminalQr.mockReturnValue(null);
  });

  test('reserves a transport, wraps under a fresh local root bound to its id, then uploads the sealed package', async () => {
    const { stdout, stderr } = await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    expect(stderr).toBe('');
    expect(mockCreateTransport).toHaveBeenCalledWith(ORG_ID, expect.any(String));
    expect(mockWrapOuterLayer).toHaveBeenCalledWith(ORG_ID, expect.any(String), undefined, TRANSPORT_ID);
    expect(mockUploadTransport).toHaveBeenCalledWith(TRANSPORT_ID, expect.any(String));

    const url = JSON.parse(stdout).url as string;
    const { id, key } = parseTransportFragmentV4(url.split('#')[1]);
    const payload = JSON.parse(openTransportBlob(mockUploadTransport.mock.calls[0][1], key).toString('utf8'));
    const keyFile = JSON.parse(payload.key_enc);

    expect(id).toBe(TRANSPORT_ID);
    expect(payload).toMatchObject({ v: 1, transport_id: TRANSPORT_ID, org_id: ORG_ID, user_id: USER_ID });
    expect(Buffer.from(payload.k_local, 'base64url')).toHaveLength(32);
    expect(keyFile).toMatchObject({ encrypted_master_key: 'context-bound-key-enc', transport_id: TRANSPORT_ID });
    expect(payload.k_local).not.toBe(SOURCE_MASTER_KEY.toString('base64url'));
  });

  test('never writes or migrates the source credential while creating a transport', async () => {
    await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    expect(mockUnwrapMasterKey).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      expect.any(Object),
      { migrateLegacy: false },
    );
    expect(mockWrapOuterLayer.mock.invocationCallOrder[0]).toBeGreaterThan(mockCreateTransport.mock.invocationCallOrder[0]);
  });

  test('keeps S out of the service upload while the link opens the package', async () => {
    const { stdout } = await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    const { key } = parseTransportFragmentV4((JSON.parse(stdout).url as string).split('#')[1]);
    const ciphertext = mockUploadTransport.mock.calls[0][1] as string;
    expect(ciphertext).not.toContain(key.toString('base64url'));
    expect(openTransportBlob(ciphertext, key).length).toBeGreaterThan(0);
  });

  test('does not upload when context-bound wrapping fails', async () => {
    mockWrapOuterLayer.mockRejectedValue(new Error('wrap failed'));
    const { stdout } = await withCapturedIo(async () => {
      await expect(new TransportCommand().execute({ json: true })).rejects.toThrow();
    });
    expect(JSON.parse(stdout).code).toBe('SERVICE_ERROR');
    expect(mockUploadTransport).not.toHaveBeenCalled();
  });

  test('--json remains pure and the QR uses the full link in human mode', async () => {
    const json = await withCapturedIo(() => new TransportCommand().execute({ json: true }));
    expect(json.stdout.trim().startsWith('{')).toBe(true);
    expect(mockRenderTerminalQr).not.toHaveBeenCalled();

    await withCapturedIo(() => new TransportCommand().execute({}));
    expect(mockRenderTerminalQr).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/keep\.capy\.sc\/transport#4\./));
  });

  test('returns a coded refusal when reservation fails', async () => {
    mockCreateTransport.mockRejectedValue(new Error('network down'));
    const { stdout } = await withCapturedIo(async () => {
      await expect(new TransportCommand().execute({ json: true })).rejects.toThrow();
    });
    expect(JSON.parse(stdout).code).toBe('SERVICE_ERROR');
  });
});

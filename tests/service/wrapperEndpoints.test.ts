import { jest, describe, it, expect, beforeEach } from 'bun:test';
import { ServiceClient } from '../../src/service/serviceClient';
import { CapyError, ERROR_CODES } from '../../src/types/index';

// Mock global fetch (same pattern as serviceClient.test.ts — isolated file).
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function response(data: any, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

const META = {
  id: 'w-1',
  type: 'wrapped_k_local',
  credential_id: 'cred-1',
  kdf_version: 1,
  is_seed: true,
  verified_at: null,
  organization_id: null,
  created_at: '2026-08-08T00:00:00Z',
  deleted_at: null,
  mirror_state: 'pending',
};

describe('ServiceClient wrapper endpoints (CAP-379 contract)', () => {
  let client: ServiceClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new ServiceClient('http://localhost:3002');
  });

  it('uploadDoorWrapper POSTs the exact door body and unwraps {wrapper}', async () => {
    mockFetch.mockResolvedValue(response({ wrapper: META }, true, 201));
    const body = {
      wrapped_k_local: 'CT',
      iv: 'IV',
      prf_salt: 'SALT',
      credential_id: 'cred-1',
      kdf_version: 1,
    };
    const wrapper = await client.uploadDoorWrapper(body);
    expect(wrapper.id).toBe('w-1');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3002/wrappers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ type: 'wrapped_k_local', ...body });
  });

  it('uploadKeyEncWrapper POSTs {type: key_enc, key_enc} with the org left to the JWT', async () => {
    mockFetch.mockResolvedValue(response({ wrapper: { ...META, type: 'key_enc' } }, true, 201));
    await client.uploadKeyEncWrapper('BLOB');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3002/wrappers');
    expect(JSON.parse(init.body)).toEqual({ type: 'key_enc', key_enc: 'BLOB' });
  });

  it('listWrappers GETs the inventory (and can include deleted rows)', async () => {
    mockFetch.mockResolvedValue(response({ wrappers: [META] }));
    const rows = await client.listWrappers();
    expect(rows).toEqual([META] as any);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3002/wrappers');

    mockFetch.mockResolvedValue(response({ wrappers: [] }));
    await client.listWrappers(true);
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:3002/wrappers?include_deleted=true');
  });

  it('fetchWrapper / verifyWrapper / deleteWrapper hit the id routes', async () => {
    mockFetch.mockResolvedValue(response({ wrapper: META }));
    await client.fetchWrapper('w-1');
    await client.verifyWrapper('w-1');
    await client.deleteWrapper('w-1');
    expect(mockFetch.mock.calls.map(c => [c[0], c[1].method])).toEqual([
      ['http://localhost:3002/wrappers/w-1', 'GET'],
      ['http://localhost:3002/wrappers/w-1/verify', 'POST'],
      ['http://localhost:3002/wrappers/w-1', 'DELETE'],
    ]);
  });

  it('mints WRAPPER_NOT_FOUND and WRAPPER_CONFLICT as top-level codes (SERVER_CODES allowlist)', async () => {
    mockFetch.mockResolvedValue(response({ error: 'no such wrapper', code: 'WRAPPER_NOT_FOUND' }, false, 404));
    try {
      await client.fetchWrapper('w-x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CapyError);
      expect((err as CapyError).code).toBe(ERROR_CODES.WRAPPER_NOT_FOUND);
    }

    mockFetch.mockResolvedValue(response({ error: 'slot taken', code: 'WRAPPER_CONFLICT' }, false, 409));
    try {
      await client.uploadKeyEncWrapper('BLOB');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CapyError).code).toBe(ERROR_CODES.WRAPPER_CONFLICT);
    }
  });

  it('preserves the full structured FreshAuthRequiredError body on 403 (code + remediation + max age)', async () => {
    mockFetch.mockResolvedValue(
      response(
        {
          error: 'token too old',
          code: 'FRESH_AUTH_REQUIRED',
          remediation: 'refresh_and_retry',
          max_token_age_seconds: 300,
        },
        false,
        403,
      ),
    );
    try {
      await client.fetchWrapper('w-1');
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as CapyError;
      expect(e.code).toBe(ERROR_CODES.PERMISSION_DENIED);
      expect(e.details.code).toBe(ERROR_CODES.FRESH_AUTH_REQUIRED);
      expect(e.details.data.remediation).toBe('refresh_and_retry');
      expect(e.details.data.max_token_age_seconds).toBe(300);
    }
  });

  it('an unknown server code still falls through to SERVICE_ERROR (allowlist, not passthrough)', async () => {
    mockFetch.mockResolvedValue(response({ error: 'weird', code: 'TOTALLY_NEW_CODE' }, false, 500));
    try {
      await client.listWrappers();
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CapyError).code).toBe(ERROR_CODES.SERVICE_ERROR);
    }
  });
});

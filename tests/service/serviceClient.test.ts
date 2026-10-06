import { jest, describe, test, expect, beforeEach } from 'bun:test';
import { ServiceClient, classifyResponse, rateInfoOf } from '../../src/service/serviceClient';
import { ServiceToken, CapyError, ERROR_CODES } from '../../src/types/index';

describe('classifyResponse', () => {
  // CAP-664: `code` is the primary signal; the message-text bridge is a
  // fallback for a 404 from a server old enough not to send one.
  test('a recognised `code` wins even over a message the legacy bridge would classify differently', () => {
    const result = classifyResponse(404, { code: 'NO_SECRETS' }, 'Branch not found');
    expect(result).toBe(ERROR_CODES.NO_SECRETS);
  });

  test('falls back to the legacy text bridge on a 404 with no code', () => {
    const result = classifyResponse(404, {}, 'No secrets have been pushed to this project yet.');
    expect(result).toBe(ERROR_CODES.NO_SECRETS);
  });

  test('an unrecognised code is ignored, not trusted', () => {
    const result = classifyResponse(404, { code: 'SOMETHING_THE_CLIENT_HAS_NEVER_HEARD_OF' }, 'No secrets have been pushed to this project yet.');
    expect(result).toBe(ERROR_CODES.NO_SECRETS);
  });
});

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function mockFetchResponse(data: any, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

describe('ServiceClient', () => {
  let serviceClient: ServiceClient;
  const defaultServiceUrl = 'http://localhost:3002';

  beforeEach(() => {
    jest.clearAllMocks();
    serviceClient = new ServiceClient(defaultServiceUrl);
  });

  describe('setTokenProvider', () => {
    test('should configure authorization header via provider callback', () => {
      const token: ServiceToken = {
        access_token: 'test_token',
        expires_at: Date.now() + 3600000,
        organization_id: 'org_123',
        user_id: 'user_456'
      };

      serviceClient.setTokenProvider(async () => token);

      // Verify that subsequent requests include auth header
      // This is tested implicitly in other test methods
    });
  });

  describe('getDecryptData', () => {
    test('should retrieve decrypt data successfully', async () => {
      const projectId = 'proj_123';
      const mockData = {
        env_file: 'API_KEY=test123\nDB_URL=postgres://localhost',
        permissions: ['*']
      };

      mockFetch.mockResolvedValue(mockFetchResponse(mockData));

      const result = await serviceClient.getDecryptData(projectId);

      expect(mockFetch).toHaveBeenCalledWith(
        `${defaultServiceUrl}/secrets/${projectId}`,
        expect.objectContaining({ method: 'GET' })
      );
      expect(result.env_content).toBe(mockData.env_file);
    });

    test('should include authorization header when token is set', async () => {
      const token: ServiceToken = {
        access_token: 'test_token',
        expires_at: Date.now() + 3600000,
        organization_id: 'org_123',
        user_id: 'user_456'
      };
      serviceClient.setTokenProvider(async () => token);

      mockFetch.mockResolvedValue(mockFetchResponse({ env_file: '', permissions: [] }));

      await serviceClient.getDecryptData('proj_123');

      expect(mockFetch).toHaveBeenCalledWith(
        `${defaultServiceUrl}/secrets/proj_123`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test_token',
          }),
        })
      );
    });

    test('should return empty data on 404 (new project with no secrets)', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(
        { error: 'No secrets stored for this project' }, false, 404
      ));

      const result = await serviceClient.getDecryptData('new_proj');
      expect(result.env_content).toBe('');
    });

    // CAP-664: the service now mints `code: 'NO_SECRETS'` on this 404 (see
    // service/src/routes/secrets.ts + errorCodes.ts) — classifyResponse must
    // take that code as the primary signal, with the legacy `message.includes`
    // bridge kept only as a fallback for older servers. Both shapes must
    // resolve to the same empty-state result.
    test('should return empty data on 404 with code NO_SECRETS (current server)', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(
        { error: 'No secrets have been pushed to this project yet.', code: 'NO_SECRETS' }, false, 404
      ));

      const result = await serviceClient.getDecryptData('new_proj');
      expect(result.env_content).toBe('');
    });

    test('should return empty data on 404 with the real message and no code (legacy server)', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(
        { error: 'No secrets have been pushed to this project yet.' }, false, 404
      ));

      const result = await serviceClient.getDecryptData('new_proj');
      expect(result.env_content).toBe('');
    });

    test('should throw on non-404 service errors', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(
        { error: 'Internal server error' }, false, 500
      ));

      await expect(serviceClient.getDecryptData('invalid_proj')).rejects.toThrow(CapyError);
    });

    test('should handle network errors', async () => {
      const networkError = new Error('Network Error');
      (networkError as any).code = 'ECONNREFUSED';
      mockFetch.mockRejectedValue(networkError);

      await expect(serviceClient.getDecryptData('proj_123')).rejects.toThrow(CapyError);
      await expect(serviceClient.getDecryptData('proj_123')).rejects.toThrow(/Failed to connect to .*Capy.*service/);
    });
  });

  describe('initializeProject', () => {
    test('should create new project successfully', async () => {
      const projectName = 'test-project';
      const organizationId = 'org_123';
      const mockData = {
        id: 'proj_456',
        name: projectName,
        organization_id: organizationId,
        s3_prefix: `${organizationId}/proj_456`
      };

      mockFetch.mockResolvedValue(mockFetchResponse(mockData));

      const result = await serviceClient.initializeProject(projectName, organizationId);

      expect(mockFetch).toHaveBeenCalledWith(
        `${defaultServiceUrl}/projects`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: projectName, organization_id: organizationId }),
        })
      );
      expect(result.project_id).toBe('proj_456');
      expect(result.project_name).toBe(projectName);
      expect(result.org_id).toBe(organizationId);
      expect(result.created).toBe(true);
    });

    test('should include auth headers when authenticated', async () => {
      const token: ServiceToken = {
        access_token: 'test_token',
        expires_at: Date.now() + 3600000,
        organization_id: 'org_123',
        user_id: 'user_456'
      };
      serviceClient.setTokenProvider(async () => token);

      mockFetch.mockResolvedValue(mockFetchResponse({
        id: 'proj_456', name: 'test', organization_id: 'org_123', s3_prefix: 'org_123/proj_456'
      }));

      await serviceClient.initializeProject('test', 'org_123');

      expect(mockFetch).toHaveBeenCalledWith(
        `${defaultServiceUrl}/projects`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test_token',
          }),
        })
      );
    });

    test('should handle project creation errors', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(
        { error: 'Project name already exists' }, false, 400
      ));

      await expect(serviceClient.initializeProject('existing', 'org_123')).rejects.toThrow(CapyError);
    });
  });

  describe('pushVariables', () => {
    test('should push variables successfully', async () => {
      const projectId = 'proj_123';
      const variables = { API_KEY: 'test123', DB_URL: 'postgres://localhost' };

      mockFetch.mockResolvedValue(mockFetchResponse({ success: true }));

      const result = await serviceClient.pushVariables(projectId, variables, null, undefined, 'test-encryption-key');

      expect(mockFetch).toHaveBeenCalledWith(
        `${defaultServiceUrl}/secrets/${projectId}`,
        expect.objectContaining({
          method: 'POST',
        })
      );

      // Verify the body contains encrypted values (capy: prefix)
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse((callArgs[1] as any).body);
      expect(body.env_file).toContain('API_KEY=capy:');
      expect(body.env_file).toContain('DB_URL=capy:');
      expect(body.keep_file).toBeDefined();

      expect(result.success).toBe(true);
      // Non-mock push returns resource IDs
      expect(result.variables).toHaveProperty('API_KEY');
      expect(result.variables).toHaveProperty('DB_URL');
      expect(result.variables.API_KEY.resource_id).toBeDefined();
    });

    test('should handle push errors', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(
        { error: 'Insufficient permissions' }, false, 403
      ));

      await expect(serviceClient.pushVariables('proj_123', {}, null, undefined, 'test-encryption-key')).rejects.toThrow(CapyError);
      await expect(serviceClient.pushVariables('proj_123', {}, null, undefined, 'test-encryption-key')).rejects.toThrow('Insufficient permissions');
    });
  });

  describe('custom service URL', () => {
    test('should use custom service URL', async () => {
      const customUrl = 'https://api.example.com';
      const customClient = new ServiceClient(customUrl);

      mockFetch.mockResolvedValue(mockFetchResponse({ env_file: '', permissions: [] }));

      await customClient.getDecryptData('proj_123');

      expect(mockFetch).toHaveBeenCalledWith(
        `${customUrl}/secrets/proj_123`,
        expect.anything()
      );
    });
  });

  describe('persistent transports', () => {
    test('reserves, context-wraps, uploads, and context-co-decrypts a transport', async () => {
      mockFetch
        .mockResolvedValueOnce(mockFetchResponse({ id: 'transport_123', expires_at: '2026-10-06T00:15:00.000Z' }))
        .mockResolvedValueOnce(mockFetchResponse({ ciphertext: 'wrapped' }))
        .mockResolvedValueOnce(mockFetchResponse({}))
        .mockResolvedValueOnce(mockFetchResponse({ plaintext: 'inner' }));

      await serviceClient.createTransport('org_123', 'example-host');
      await serviceClient.wrapOuterLayer('org_123', 'inner', undefined, 'transport_123');
      await serviceClient.uploadTransport('transport_123', 'sealed-package');
      await serviceClient.coDecrypt('org_123', 'wrapped', undefined, 'transport_123');

      expect(mockFetch.mock.calls.map(([url, init]) => ({
        url,
        method: (init as RequestInit).method,
        body: JSON.parse((init as RequestInit).body as string),
      }))).toEqual([
        { url: `${defaultServiceUrl}/transports`, method: 'POST', body: { org_id: 'org_123', name: 'example-host' } },
        { url: `${defaultServiceUrl}/orgs/org_123/wrap`, method: 'POST', body: { plaintext: 'inner', transport_id: 'transport_123' } },
        { url: `${defaultServiceUrl}/transports/transport_123`, method: 'PUT', body: { ciphertext: 'sealed-package' } },
        { url: `${defaultServiceUrl}/orgs/org_123/co-decrypt`, method: 'POST', body: { ciphertext: 'wrapped', transport_id: 'transport_123' } },
      ]);
    });
  });

  describe('403 response code threading', () => {
    // The CLI's destructive cleanup paths (cleanupOrgData, etc.) gate on
    // err.details.code === 'MEMBERSHIP_REVOKED' to avoid wiping local key
    // material on ambiguous 403s. The serviceClient is responsible for
    // surfacing the server's `code` field — these tests pin that behavior.

    test('threads MEMBERSHIP_REVOKED code into err.details when present', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(
        { error: 'You are no longer a member of this organization', code: 'MEMBERSHIP_REVOKED' },
        false,
        403,
      ));

      try {
        await serviceClient.getDecryptData('proj_kicked');
        throw new Error('expected request to throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(CapyError);
        expect(err.code).toBe(ERROR_CODES.PERMISSION_DENIED);
        expect(err.details?.status).toBe(403);
        expect(err.details?.code).toBe('MEMBERSHIP_REVOKED');
      }
    });

    test('leaves err.details.code undefined when the server omits code', async () => {
      // Bare 403 (e.g., route-handler token-scope mismatch). Cleanup must
      // NOT fire — verified by the absence of any `code` on the error.
      mockFetch.mockResolvedValue(mockFetchResponse(
        { error: 'Not authorized for this organization' },
        false,
        403,
      ));

      try {
        await serviceClient.getDecryptData('proj_wrongorg');
        throw new Error('expected request to throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(CapyError);
        expect(err.code).toBe(ERROR_CODES.PERMISSION_DENIED);
        expect(err.details?.status).toBe(403);
        expect(err.details?.code).toBeUndefined();
      }
    });

    test('ignores non-string code fields on 403 to avoid spoofed wipes', async () => {
      // Defense in depth: if the server (or a man-in-the-middle on a
      // localhost-vs-prod misconfig) returns code: true / 1 / object, we
      // must not coerce it into the kick gate.
      mockFetch.mockResolvedValue(mockFetchResponse(
        { error: 'forbidden', code: 12345 },
        false,
        403,
      ));

      try {
        await serviceClient.getDecryptData('proj_x');
        throw new Error('expected request to throw');
      } catch (err: any) {
        expect(err.details?.code).toBeUndefined();
      }
    });
  });

  // CAP-692 follow-up: `capy transport`'s redemption poll. Decided only on
  // status + the response body's `code` field (never message text) —
  // every case here asserts the resulting typed `TransportStatusResult`,
  // never a raw status/code pair leaking through.
  describe('getTransportStatus', () => {
    test('200 pending durable transport -> pending', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ transport: { activated_at: null, expires_at: '2099-10-01T00:15:00.000Z', revoked_at: null } }));
      const result = await serviceClient.getTransportStatus('transport-1');
      expect(result).toEqual({ kind: 'pending', expiresAt: '2099-10-01T00:15:00.000Z' });
    });

    test('200 activated durable transport -> redeemed', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ transport: { activated_at: '2026-10-06T00:01:00.000Z', expires_at: '2099-10-01T00:15:00.000Z', revoked_at: null } }));
      const result = await serviceClient.getTransportStatus('transport-1');
      expect(result).toEqual({ kind: 'redeemed' });
    });

    test('404 with TRANSPORT_NOT_FOUND -> unknown, never implicit activation', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ error: 'not found', code: 'TRANSPORT_NOT_FOUND' }, false, 404));
      const result = await serviceClient.getTransportStatus('transport-1');
      expect(result).toEqual({ kind: 'unknown' });
    });

    test('200 pending durable transport after expiry -> expired', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ transport: { activated_at: null, expires_at: '2020-10-01T00:15:00.000Z', revoked_at: null } }));
      const result = await serviceClient.getTransportStatus('transport-1');
      expect(result).toEqual({ kind: 'expired' });
    });

    test('410 with code TRANSPORT_EXPIRED -> expired', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ error: 'expired', code: 'TRANSPORT_EXPIRED' }, false, 410));
      const result = await serviceClient.getTransportStatus('transport-1');
      expect(result).toEqual({ kind: 'expired' });
    });

    test('400 INVALID_FORMAT (bad id) -> unknown', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ error: 'bad id', code: 'INVALID_FORMAT' }, false, 400));
      const result = await serviceClient.getTransportStatus('not-an-id');
      expect(result).toEqual({ kind: 'unknown' });
    });

    test('429 (mutation limiter) -> unknown, same as any other non-decisive answer', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ error: 'rate limited' }, false, 429));
      const result = await serviceClient.getTransportStatus('transport-1');
      expect(result).toEqual({ kind: 'unknown' });
    });

    test('401 -> unknown (never treated as redeemed/expired)', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ error: 'unauthorized' }, false, 401));
      const result = await serviceClient.getTransportStatus('transport-1');
      expect(result).toEqual({ kind: 'unknown' });
    });

    test('5xx -> unknown', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ error: 'boom' }, false, 500));
      const result = await serviceClient.getTransportStatus('transport-1');
      expect(result).toEqual({ kind: 'unknown' });
    });

    test('a network error -> unknown', async () => {
      const networkError = new Error('Network Error');
      (networkError as any).code = 'ECONNREFUSED';
      mockFetch.mockRejectedValue(networkError);
      const result = await serviceClient.getTransportStatus('transport-1');
      expect(result).toEqual({ kind: 'unknown' });
    });

    test('requests GET /transports/:id with the id URL-encoded', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ state: 'pending', expires_at: 'x' }));
      await serviceClient.getTransportStatus('abc/def');
      expect(mockFetch).toHaveBeenCalledWith(
        `${defaultServiceUrl}/transports/${encodeURIComponent('abc/def')}`,
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

});

describe('ServiceClient.getOrgRepos (REPO_LINKS_UNSUPPORTED)', () => {
  const client = () => new ServiceClient('http://localhost:3002');

  test('a 404 (the service predates the route) is REPO_LINKS_UNSUPPORTED, decided by the status and whatever the body says', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse({ error: 'Project not found' }, false, 404));
    const err = await client().getOrgRepos('org1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapyError);
    expect((err as CapyError).code).toBe(ERROR_CODES.REPO_LINKS_UNSUPPORTED);
    expect((err as CapyError).details?.status).toBe(404);
  });

  test('a 404 the server attributes to the org stays ORG_NOT_FOUND', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse({ error: 'x', code: 'ORG_NOT_FOUND' }, false, 404));
    const err = await client().getOrgRepos('org1').catch((e: unknown) => e);
    expect((err as CapyError).code).toBe(ERROR_CODES.ORG_NOT_FOUND);
  });

  test('a 403 stays PERMISSION_DENIED and a 500 stays SERVICE_ERROR', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse({ error: 'no', code: 'PERMISSION_DENIED' }, false, 403));
    expect(((await client().getOrgRepos('org1').catch((e: unknown) => e)) as CapyError).code).toBe(ERROR_CODES.PERMISSION_DENIED);
    mockFetch.mockResolvedValueOnce(mockFetchResponse({ error: 'boom' }, false, 500));
    expect(((await client().getOrgRepos('org1').catch((e: unknown) => e)) as CapyError).code).toBe(ERROR_CODES.SERVICE_ERROR);
  });

  test('a 200 returns the links untouched', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse({ org_id: 'org1', repos: [] }));
    expect(await client().getOrgRepos('org1')).toEqual({ org_id: 'org1', repos: [] });
  });
});

// ── Rate-limit headers (CAP-698) ────────────────────────────────────────────

describe('rate-limit headers as structured fields', () => {
  const withHeaders = (data: unknown, headers: Record<string, string>, ok = true, status = 200): Response =>
    ({ ...(mockFetchResponse(data, ok, status) as object), headers: new Headers(headers) }) as unknown as Response;
  const client = () => new ServiceClient('http://localhost:3002');

  test('rateInfoOf reads RateLimit-Remaining and RateLimit-Reset (seconds) into remaining and an absolute resetAt', () => {
    expect(rateInfoOf(withHeaders({}, { 'RateLimit-Remaining': '7', 'RateLimit-Reset': '12' }), 1000)).toEqual({ remaining: 7, resetAt: 13_000 });
  });

  test('either header missing or not a number: no reading', () => {
    expect(rateInfoOf(withHeaders({}, { 'RateLimit-Remaining': '7' }), 1000)).toBeUndefined();
    expect(rateInfoOf(withHeaders({}, { 'RateLimit-Remaining': 'lots', 'RateLimit-Reset': '12' }), 1000)).toBeUndefined();
    expect(rateInfoOf(mockFetchResponse({}), 1000)).toBeUndefined(); // a response with no headers object at all
  });

  test('getDecryptData and pushSecrets hand the reading to the optional callback; callers that pass none are unaffected', async () => {
    const seen = jest.fn();
    mockFetch.mockResolvedValueOnce(withHeaders({ env_file: '', permissions: [] }, { 'RateLimit-Remaining': '41', 'RateLimit-Reset': '30' }));
    await client().getDecryptData('p1', 'main', undefined, true, seen);
    mockFetch.mockResolvedValueOnce(withHeaders({ keep_hash: 'h' }, { 'RateLimit-Remaining': '40', 'RateLimit-Reset': '29' }));
    await client().pushSecrets('p1', '{}', 'blob', 'main', seen);
    expect(seen.mock.calls.map((c) => (c[0] as { remaining: number }).remaining)).toEqual([41, 40]);
    mockFetch.mockResolvedValueOnce(withHeaders({ keep_hash: 'h' }, { 'RateLimit-Remaining': '1', 'RateLimit-Reset': '1' }));
    expect(await client().pushSecrets('p1', '{}', 'blob', 'main')).toEqual({ keep_hash: 'h' });
  });

  test('a 429 is RATE_LIMITED with the wait it asked for in structured details (Retry-After first, else RateLimit-Reset)', async () => {
    mockFetch.mockResolvedValueOnce(withHeaders({ error: 'x' }, { 'Retry-After': '3', 'RateLimit-Reset': '9' }, false, 429));
    const a = (await client().pushSecrets('p1', '{}', 'b', 'main').catch((e: unknown) => e)) as CapyError;
    expect(a.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(a.details).toMatchObject({ status: 429, retry_after_ms: 3000 });
    mockFetch.mockResolvedValueOnce(withHeaders({ error: 'x' }, { 'RateLimit-Remaining': '0', 'RateLimit-Reset': '9' }, false, 429));
    const b = (await client().pushSecrets('p1', '{}', 'b', 'main').catch((e: unknown) => e)) as CapyError;
    expect(b.details).toMatchObject({ retry_after_ms: 9000 });
  });
});

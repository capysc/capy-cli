import { jest, describe, test, expect, beforeEach } from 'bun:test';
import { ServiceClient } from '../../src/service/serviceClient';
import { ServiceToken, CapyError, ERROR_CODES } from '../../src/types/index';

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

  describe('listDoors (final-gate BLOCKER-2 — /doors capability gap)', () => {
    test('a 404 (route missing on this service build) is reclassified to DOORS_NOT_SUPPORTED', async () => {
      // No `code` field — a bare route-not-found 404, not a data-shaped one.
      mockFetch.mockResolvedValue(mockFetchResponse({}, false, 404));

      try {
        await serviceClient.listDoors();
        throw new Error('expected request to throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(CapyError);
        expect(err.code).toBe(ERROR_CODES.DOORS_NOT_SUPPORTED);
        expect(err.details?.status).toBe(404);
      }
    });

    test('a non-404 failure (e.g. 500) is left as the ordinary classified error, not DOORS_NOT_SUPPORTED', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ error: 'boom' }, false, 500));

      try {
        await serviceClient.listDoors();
        throw new Error('expected request to throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(CapyError);
        expect(err.code).not.toBe(ERROR_CODES.DOORS_NOT_SUPPORTED);
      }
    });

    test('success (empty inventory) is returned untouched — a 200 with zero doors is not a capability gap', async () => {
      const inventory = { doors: [], has_seed_wrapper: false, sessions_unavailable_reason: null, unavailable_door_types: [] };
      mockFetch.mockResolvedValue(mockFetchResponse(inventory, true, 200));

      const result = await serviceClient.listDoors();
      expect(result).toEqual(inventory);
    });
  });

  describe('cancelFlow (capy flow cancel — the org-owner escape hatch)', () => {
    test('POSTs to /flows/:id/cancel and returns the server payload on success', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ flow_id: 'flow-abc', state: 'cancelled' }, true, 200));

      const result = await serviceClient.cancelFlow('flow-abc');

      expect(mockFetch).toHaveBeenCalledWith(
        `${defaultServiceUrl}/flows/flow-abc/cancel`,
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result).toEqual({ flow_id: 'flow-abc', state: 'cancelled' });
    });

    test('includes the authorization header from the token provider', async () => {
      const token: ServiceToken = {
        access_token: 'owner_token',
        expires_at: Date.now() + 3600000,
        organization_id: 'org_123',
        user_id: 'user_456',
      };
      serviceClient.setTokenProvider(async () => token);
      mockFetch.mockResolvedValue(mockFetchResponse({ flow_id: 'flow-abc', state: 'cancelled' }, true, 200));

      await serviceClient.cancelFlow('flow-abc');

      expect(mockFetch).toHaveBeenCalledWith(
        `${defaultServiceUrl}/flows/flow-abc/cancel`,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer owner_token' }),
        }),
      );
    });

    // The server answers 404 for "no such flow" and "not yours to cancel"
    // identically (by design — see the flows route's own doc comment: telling
    // them apart would let an unauthorized caller probe for a flow's
    // existence). It reuses the PROJECT_NOT_FOUND server code verbatim for
    // this 404; cancelFlow reclassifies that ONE honest answer to
    // FLOW_NOT_FOUND rather than inventing a distinction the wire never gave.
    test('a 404 (not found OR not authorized) is reclassified to FLOW_NOT_FOUND', async () => {
      mockFetch.mockResolvedValue(
        mockFetchResponse({ error: 'Flow not found', code: 'PROJECT_NOT_FOUND' }, false, 404),
      );

      try {
        await serviceClient.cancelFlow('flow-missing');
        throw new Error('expected request to throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(CapyError);
        expect(err.code).toBe(ERROR_CODES.FLOW_NOT_FOUND);
        expect(err.details?.status).toBe(404);
      }
    });

    test('a non-404 failure (e.g. 500) is left as the ordinary classified error, not FLOW_NOT_FOUND', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ error: 'boom' }, false, 500));

      try {
        await serviceClient.cancelFlow('flow-abc');
        throw new Error('expected request to throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(CapyError);
        expect(err.code).not.toBe(ERROR_CODES.FLOW_NOT_FOUND);
        expect(err.code).toBe(ERROR_CODES.SERVICE_ERROR);
      }
    });
  });

  describe('v3 invite blob + pickup wire methods (CAP-529)', () => {
    test('uploadInviteBlob POSTs to /orgs/:orgId/invites with the body verbatim', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ invite_id: 'abc123' }));
      const result = await serviceClient.uploadInviteBlob('org-1', {
        invite_id: 'abc123',
        email: 'bob@example.com',
        blob: 'outer-blob',
        not_after: 1700000000000,
      });
      expect(result).toEqual({ invite_id: 'abc123' });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${defaultServiceUrl}/orgs/org-1/invites`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        invite_id: 'abc123',
        email: 'bob@example.com',
        blob: 'outer-blob',
        not_after: 1700000000000,
      });
    });

    test('fetchInviteBlob GETs /orgs/:orgId/invites/:inviteId/blob', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ blob: 'outer-blob', email: 'bob@example.com' }));
      const result = await serviceClient.fetchInviteBlob('org-1', 'abc123');
      expect(result).toEqual({ blob: 'outer-blob', email: 'bob@example.com' });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${defaultServiceUrl}/orgs/org-1/invites/abc123/blob`);
      expect(init.method).toBe('GET');
    });

    test('getPendingInvitePickup GETs /invites/pending and passes the row through', async () => {
      const pickup = {
        id: 'pk-1',
        invite_id: 'abc123',
        organization_id: 'org-1',
        user_id: 'u-1',
        wrapped_t: 'ct',
        iv: 'iv',
        prf_salt: 'salt',
        credential_id: 'cred-1',
        kdf_version: 1,
        created_at: '2026-01-01T00:00:00Z',
        expires_at: '2026-01-02T00:00:00Z',
      };
      mockFetch.mockResolvedValue(mockFetchResponse({ pickup }));
      const result = await serviceClient.getPendingInvitePickup();
      expect(result).toEqual(pickup);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${defaultServiceUrl}/invites/pending`);
      expect(init.method).toBe('GET');
    });

    test('getPendingInvitePickup returns null when there is nothing pending', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({ pickup: null }));
      const result = await serviceClient.getPendingInvitePickup();
      expect(result).toBeNull();
    });

    test('deleteInvitePickup DELETEs /invites/:inviteId/pickup', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse({}, true, 204));
      await serviceClient.deleteInvitePickup('abc123');
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${defaultServiceUrl}/invites/abc123/pickup`);
      expect(init.method).toBe('DELETE');
    });

    test('a 409 WRAPPER_CONFLICT from the door-upload wire shape classifies as the existing typed code', async () => {
      // Exercises the SAME classifyResponse path uploadDoorWrapper already
      // relies on (SERVER_CODES allowlist) — nothing new to the wire
      // contract, just confirming the invite-pickup call sites inherit it.
      mockFetch.mockResolvedValue(mockFetchResponse({ code: 'WRAPPER_CONFLICT', error: 'conflict' }, false, 409));
      try {
        await serviceClient.uploadDoorWrapper({
          wrapped_k_local: 'x',
          iv: 'y',
          prf_salt: 'z',
          credential_id: 'cred-1',
          kdf_version: 1,
        });
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(CapyError);
        expect(err.code).toBe(ERROR_CODES.WRAPPER_CONFLICT);
      }
    });
  });

});

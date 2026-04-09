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

  describe('setToken', () => {
    test('should configure authorization header', () => {
      const token: ServiceToken = {
        access_token: 'test_token',
        expires_at: Date.now() + 3600000,
        organization_id: 'org_123',
        user_id: 'user_456'
      };

      serviceClient.setToken(token);

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
      serviceClient.setToken(token);

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
      serviceClient.setToken(token);

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

});

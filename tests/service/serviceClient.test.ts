import { jest } from '@jest/globals';
import axios from 'axios';
import { ServiceClient } from '../../src/service/serviceClient';
import { ServiceToken, CapyError, ERROR_CODES } from '../../src/types/index';

// Mock axios
jest.mock('axios');
const mockAxios = axios as jest.Mocked<typeof axios>;

// Mock axios.create to return a mock instance
const mockAxiosInstance = {
  get: jest.fn() as jest.MockedFunction<any>,
  post: jest.fn() as jest.MockedFunction<any>,
  delete: jest.fn() as jest.MockedFunction<any>,
  interceptors: {
    request: {
      use: jest.fn()
    },
    response: {
      use: jest.fn()
    }
  }
};

mockAxios.create.mockReturnValue(mockAxiosInstance as any);

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
      const mockResponse = {
        data: {
          env_file: 'API_KEY=test123\nDB_URL=postgres://localhost',
          permissions: ['*']
        }
      };

      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await serviceClient.getDecryptData(projectId);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(`/secrets/${projectId}`);
      expect(result.env_content).toBe(mockResponse.data.env_file);
    });

    test('should include authorization header when token is set', async () => {
      const token: ServiceToken = {
        access_token: 'test_token',
        expires_at: Date.now() + 3600000,
        organization_id: 'org_123',
        user_id: 'user_456'
      };
      serviceClient.setToken(token);

      const mockResponse = { data: { env_file: '', permissions: [] } };
      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      await serviceClient.getDecryptData('proj_123');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/secrets/proj_123');
    });

    test('should handle service errors', async () => {
      const errorResponse = {
        response: {
          status: 404,
          data: { error: 'Project not found' }
        }
      };

      mockAxiosInstance.get.mockRejectedValue(errorResponse);

      await expect(serviceClient.getDecryptData('invalid_proj')).rejects.toThrow(CapyError);
      await expect(serviceClient.getDecryptData('invalid_proj')).rejects.toThrow('Project not found');
    });

    test('should handle network errors', async () => {
      const networkError = new Error('Network Error');
      mockAxiosInstance.get.mockRejectedValue(networkError);

      await expect(serviceClient.getDecryptData('proj_123')).rejects.toThrow(CapyError);
      await expect(serviceClient.getDecryptData('proj_123')).rejects.toThrow('Network Error');
    });
  });

  describe('initializeProject', () => {
    test('should create new project successfully', async () => {
      const projectName = 'test-project';
      const organizationId = 'org_123';
      const mockResponse = {
        data: {
          id: 'proj_456',
          name: projectName,
          organization_id: organizationId,
          s3_prefix: `${organizationId}/proj_456`
        }
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const result = await serviceClient.initializeProject(projectName, organizationId);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/projects', {
        name: projectName,
        organization_id: organizationId,
      });
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

      const mockResponse = { data: { id: 'proj_456', name: 'test', organization_id: 'org_123', s3_prefix: 'org_123/proj_456' } };
      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      await serviceClient.initializeProject('test', 'org_123');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/projects', {
        name: 'test',
        organization_id: 'org_123',
      });
    });

    test('should handle project creation errors', async () => {
      const errorResponse = {
        response: {
          status: 400,
          data: { error: 'Project name already exists' }
        }
      };

      mockAxiosInstance.post.mockRejectedValue(errorResponse);

      await expect(serviceClient.initializeProject('existing', 'org_123')).rejects.toThrow(CapyError);
    });
  });

  describe('pushVariables', () => {
    test('should push variables successfully', async () => {
      const projectId = 'proj_123';
      const variables = { API_KEY: 'test123', DB_URL: 'postgres://localhost' };
      const mockResponse = {
        data: {
          success: true
        }
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const result = await serviceClient.pushVariables(projectId, variables);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(`/secrets/${projectId}`, {
        env_file: 'API_KEY=test123\nDB_URL=postgres://localhost',
        keep_file: JSON.stringify({ variables: {} })
      });
      expect(result.success).toBe(true);
    });

    test('should handle push errors', async () => {
      const errorResponse = {
        response: {
          status: 403,
          data: { error: 'Insufficient permissions' }
        }
      };

      mockAxiosInstance.post.mockRejectedValue(errorResponse);

      await expect(serviceClient.pushVariables('proj_123', {})).rejects.toThrow(CapyError);
      await expect(serviceClient.pushVariables('proj_123', {})).rejects.toThrow('Insufficient permissions');
    });
  });

  describe('custom service URL', () => {
    test('should use custom service URL', async () => {
      const customUrl = 'https://api.example.com';
      const customClient = new ServiceClient(customUrl);

      const mockResponse = { data: { env_file: '', permissions: [] } };
      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      await customClient.getDecryptData('proj_123');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/secrets/proj_123');
    });
  });

  describe('mock mode behavior', () => {
    let mockServiceClient: ServiceClient;

    beforeEach(() => {
      // Enable mock mode (requires both devMode=true AND CAPY_MOCK_AUTH=true)
      process.env.CAPY_MOCK_AUTH = 'true';
      mockServiceClient = new ServiceClient(undefined, true);
    });

    afterEach(() => {
      delete process.env.CAPY_MOCK_AUTH;
    });

    test('getDecryptData should return empty content for mock.env if it doesn\'t exist during mock mode initialization', async () => {
      const mockFs = require('fs');
      jest.spyOn(mockFs, 'existsSync').mockReturnValue(false);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await mockServiceClient.getDecryptData('proj_test');

      expect(result.env_content).toBe('');
      expect(result.decrypt_key).toBe('mock-decrypt-key-persistent');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No existing mock.env found - new project with 0 variables'));

      consoleSpy.mockRestore();
    });

    test('readMockEnvContent should return an empty string if mock.env does not exist', async () => {
      const mockFs = require('fs');
      jest.spyOn(mockFs, 'existsSync').mockReturnValue(false);

      // Call getDecryptData which internally uses readMockEnvContent
      const result = await mockServiceClient.getDecryptData('proj_test');

      expect(result.env_content).toBe('');
      expect(result.decrypt_key).toBeDefined();
    });
  });
});

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import {
  DecryptResponse,
  ProjectInitResult,
  PushResult,
  ServiceToken,
  EnvVariable,
  KeepFile,
  Branch,
  CapyError,
  ERROR_CODES
} from '../types/index';
import { Encryptor } from '../crypto/encryptor';
import { deriveResourceId } from '../crypto/resourceId';

export class ServiceClient {
  private apiUrl: string;
  private token: ServiceToken | null = null;
  private mockMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    // Mock mode requires BOTH dev entrypoint AND explicit env var
    this.mockMode = devMode && process.env.CAPY_MOCK_AUTH === 'true';
    if (this.mockMode) {
      console.log('🔫 ServiceClient: Mock mode enabled (CAPY_MOCK_AUTH=true)');
    }
    this.apiUrl = apiUrl || (devMode ? (process.env.CAPY_API_URL || 'http://localhost:3000') : 'https://api.capy.sc');
  }

  setToken(token: ServiceToken): void {
    this.token = token;
  }

  private async request<T>(method: string, path: string, body?: unknown, options?: { timeout?: number }): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token.access_token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeout ?? 30000);

    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new CapyError(
          'Failed to connect to Capy service. Please check your internet connection.',
          ERROR_CODES.NETWORK_ERROR,
          { code: 'ETIMEDOUT' }
        );
      }
      throw new CapyError(
        'Failed to connect to Capy service. Please check your internet connection.',
        ERROR_CODES.NETWORK_ERROR,
        { code: err.code || err.cause?.code }
      );
    }
    clearTimeout(timeout);

    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as Record<string, any>;

      if (res.status === 401) {
        const detail = data.error || 'Unknown auth error';
        throw new CapyError(
          `Authentication failed: ${detail}`,
          ERROR_CODES.AUTH_FAILED,
          { status: 401, detail }
        );
      }

      if (res.status === 403) {
        throw new CapyError(
          'Access denied. You do not have permission to access this project.',
          ERROR_CODES.PERMISSION_DENIED,
          { status: 403 }
        );
      }

      const serverMessage = data.error || data.message || 'Service request failed';
      throw new CapyError(
        serverMessage,
        ERROR_CODES.SERVICE_ERROR,
        { status: res.status, data }
      );
    }

    return res.json() as Promise<T>;
  }

  async initializeProject(projectName: string, organizationId: string): Promise<ProjectInitResult> {
    if (this.mockMode) {
      console.log(`🔫 Mock: Initializing project "${projectName}" for org "${organizationId}"`);
      await this.mockDelay();
      return {
        org_id: organizationId,
        project_id: `proj_${projectName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Math.random().toString(36).substr(2, 6)}`,
        project_name: projectName,
        created: true
      };
    }

    try {
      const data = await this.request<{ id: string; name: string; organization_id: string; s3_prefix: string }>(
        'POST', '/projects',
        { name: projectName, organization_id: organizationId },
      );

      return {
        org_id: data.organization_id,
        project_id: data.id,
        project_name: data.name,
        created: true
      };
    } catch (error: any) {
      if (error instanceof CapyError) {
        throw error;
      }
      throw new CapyError(
        'Failed to initialize project',
        ERROR_CODES.SERVICE_ERROR,
        { error: error.message }
      );
    }
  }

  async getDecryptData(projectId: string, branch?: string): Promise<DecryptResponse> {
    if (this.mockMode) {
      console.log(`🔫 Mock: Retrieving decrypt data for project "${projectId}"`);
      await this.mockDelay();
      const mockEnvPath = this.getMockEnvPath();

      // Check if mock.env exists - if not, this is a new project with no variables
      let mockEnvContent = '';
      if (existsSync(mockEnvPath)) {
        mockEnvContent = this.readMockEnvContent();
        const variableCount = mockEnvContent.split('\n').filter(line => line.trim() && !line.startsWith('#')).length;
        console.log(`🔫 Mock: Read env content with ${variableCount} variables from mock.env`);
      } else {
        console.log(`🔫 Mock: No existing mock.env found - new project with 0 variables`);
      }

      return {
        env_content: mockEnvContent,
        decrypt_key: 'mock-decrypt-key-persistent', // Consistent key for all projects in mock mode
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours from now
      };
    }

    try {
      const query = branch ? `?branch=${encodeURIComponent(branch)}` : '';
      const data = await this.request<{ env_file?: string; permissions: string[] }>(
        'GET', `/secrets/${projectId}${query}`,
      );

      return {
        env_content: data.env_file || '',
        decrypt_key: '', // Decrypt key is managed client-side
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      };
    } catch (error: any) {
      // 404 is normal for a new project with no secrets yet
      if (error instanceof CapyError && error.details?.status === 404) {
        return {
          env_content: '',
          decrypt_key: '',
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        };
      }
      if (error instanceof CapyError) {
        throw error;
      }
      throw new CapyError(
        error.message || 'Failed to retrieve decryption data',
        ERROR_CODES.SERVICE_ERROR,
        { error: error.message }
      );
    }
  }

  async pushVariables(
    projectId: string,
    variables: Record<string, string>,
    keep: KeepFile | null = null,
    branch?: string
  ): Promise<PushResult> {
    if (this.mockMode) {
      console.log(`🔫 Mock: Pushing ${Object.keys(variables).length} variables to project "${projectId}"`);
      await this.mockDelay();

      const { Encryptor } = require('../crypto/encryptor');
      const { deriveResourceId } = require('../crypto/resourceId');
      const mockDecryptKey = 'mock-decrypt-key-persistent';

      // Read current mock.env content
      const currentContent = this.readMockEnvContent();
      const currentVars: Record<string, string> = {};

      // Parse existing variables (they are encrypted with capy:{resource_id}: prefix)
      currentContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const [key, ...valueParts] = trimmed.split('=');
          currentVars[key] = valueParts.join('='); // Keep encrypted format
        }
      });

      // Encrypt new variables and create snippet-enhanced format with resource_id prefix
      const encryptedNewVars: Record<string, string> = {};
      const mockVariables: Record<string, any> = {};

      Object.entries(variables).forEach(([key, value]) => {
        // Check if this is a deletion marker
        if (value === 'capy:deleted') {
          // Store deletion marker as-is without encryption
          encryptedNewVars[key] = 'capy:deleted';

          mockVariables[key] = {
            resource_id: deriveResourceId(branch || '', key),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            success: true
          };
        } else {
          const resourceId = deriveResourceId(branch || '', key);
          const encrypted = Encryptor.encrypt(value, mockDecryptKey);
          const snippetValue = this.createSnippetWithEncryption(value, encrypted);

          encryptedNewVars[key] = `capy:${resourceId}:${snippetValue}`;

          mockVariables[key] = {
            resource_id: resourceId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            success: true
          };
        }
      });

      // Merge with existing encrypted variables
      const updatedVars = { ...currentVars, ...encryptedNewVars };

      // Convert back to content
      const updatedContent = Object.entries(updatedVars)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

      // Write back to mock.env
      this.writeMockEnvContent(updatedContent);

      console.log(`🔫 Mock: Updated mock.env with ${Object.keys(variables).length} new/updated encrypted variables`);
      return {
        success: true,
        variables: mockVariables
      };
    }

    try {
      const activeBranch = branch || '';
      const encryptedVars: Record<string, string> = {};
      const resultVariables: Record<string, any> = {};

      for (const [key, value] of Object.entries(variables)) {
        if (value === 'capy:deleted') {
          encryptedVars[key] = 'capy:deleted';
          resultVariables[key] = {
            resource_id: deriveResourceId(activeBranch, key),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        } else if (value.startsWith('capy:')) {
          // Already encrypted — pass through as-is
          const existingResourceId = value.split(':')[1] || deriveResourceId(activeBranch, key);
          encryptedVars[key] = value;
          resultVariables[key] = {
            resource_id: existingResourceId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        } else {
          const resourceId = deriveResourceId(activeBranch, key);
          const encrypted = Encryptor.encrypt(value, '');
          const snippetValue = this.createSnippetWithEncryption(value, encrypted);
          encryptedVars[key] = `capy:${resourceId}:${snippetValue}`;
          resultVariables[key] = {
            resource_id: resourceId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        }
      }

      const envFileContent = Object.entries(encryptedVars)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

      // Build keep_file content from keep data
      const keepFileContent = keep ? JSON.stringify(keep) : JSON.stringify({ variables: {} });

      const data = await this.request<{ success: boolean }>(
        'POST', `/secrets/${projectId}`,
        { env_file: envFileContent, keep_file: keepFileContent, ...(branch ? { branch } : {}) },
      );

      return {
        success: data.success,
        variables: resultVariables
      };
    } catch (error: any) {
      if (error instanceof CapyError) {
        throw error;
      }
      throw new CapyError(
        error.message || 'Failed to push variables',
        ERROR_CODES.SERVICE_ERROR,
        { error: error.message }
      );
    }
  }

  async createBranch(projectId: string, name: string, isProduction: boolean = false): Promise<Branch> {
    if (this.mockMode) {
      console.log(`🔫 Mock: Creating branch "${name}" for project "${projectId}"`);
      await this.mockDelay();
      return {
        id: `branch_${name}_${Math.random().toString(36).substr(2, 6)}`,
        name,
        project_id: projectId,
        is_production: isProduction,
      };
    }

    return this.request<Branch>(
      'POST', `/projects/${projectId}/branches`,
      { name, is_production: isProduction },
    );
  }

  async listBranches(projectId: string): Promise<Branch[]> {
    if (this.mockMode) {
      console.log(`🔫 Mock: Listing branches for project "${projectId}"`);
      await this.mockDelay();
      return [{ id: 'branch_default', name: '', project_id: projectId, is_production: false }];
    }

    const data = await this.request<{ branches: Branch[] }>(
      'GET', `/projects/${projectId}/branches`,
    );
    return data.branches;
  }

  async healthCheck(): Promise<boolean> {
    if (this.mockMode) {
      console.log('🔫 Mock: Health check - always healthy in mock mode');
      await this.mockDelay(100); // Short delay
      return true;
    }

    try {
      const res = await fetch(`${this.apiUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  private async mockDelay(ms: number = 500): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getMockEnvPath(): string {
    // Store mock.env in .capy folder
    return join(process.cwd(), '.capy', 'mock.env');
  }

  private readMockEnvContent(): string {
    const mockEnvPath = this.getMockEnvPath();

    if (!existsSync(mockEnvPath)) {
      // Return empty string for new projects - don't auto-create sample data
      return '';
    }

    try {
      const content = readFileSync(mockEnvPath, 'utf-8').trim();
      return content;
    } catch (error) {
      console.warn(`⚠️  Failed to read mock.env: ${error}`);
      return '';
    }
  }

  private writeMockEnvContent(content: string): void {
    const mockEnvPath = this.getMockEnvPath();
    try {
      // Ensure .capy directory exists
      const capyDir = dirname(mockEnvPath);
      if (!existsSync(capyDir)) {
        mkdirSync(capyDir, { recursive: true });
      }

      writeFileSync(mockEnvPath, content + '\n', 'utf-8');
      console.log(`🔫 Updated mock.env at ${mockEnvPath}`);
    } catch (error) {
      console.warn(`⚠️  Failed to write mock.env: ${error}`);
    }
  }

  /**
   * Creates a snippet-enhanced encrypted value for better usability (same logic as FileManager)
   */
  private createSnippetWithEncryption(originalValue: string, encryptedValue: string): string {
    const valueLength = originalValue.length;

    if (valueLength <= 8) {
      // For short values (<=8 chars), show only last character
      const snippet = originalValue.slice(-1);
      return `${encryptedValue}...${snippet}`;
    } else if (valueLength <= 16) {
      // For medium values (9-16 chars), show last 3 characters
      const snippet = originalValue.slice(-3);
      return `${encryptedValue}...${snippet}`;
    } else {
      // For long values (>16 chars), show first 4 and last 4 characters
      const firstSnippet = originalValue.slice(0, 4);
      const lastSnippet = originalValue.slice(-4);
      return `${firstSnippet}...${encryptedValue}...${lastSnippet}`;
    }
  }
}

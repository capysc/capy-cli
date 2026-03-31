import { join } from 'path';
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
  private onTokenExpired?: () => Promise<ServiceToken | null>;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl || (devMode ? (process.env.CAPY_API_URL || 'http://localhost:3000') : 'https://api.capy.sc');
  }

  setToken(token: ServiceToken): void {
    this.token = token;
  }

  setTokenRefresher(refresher: () => Promise<ServiceToken | null>): void {
    this.onTokenExpired = refresher;
  }

  private async request<T>(method: string, path: string, body?: unknown, options?: { timeout?: number; _retried?: boolean }): Promise<T> {
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
        // Try refreshing token once
        if (!options?._retried && this.onTokenExpired) {
          const newToken = await this.onTokenExpired();
          if (newToken) {
            this.token = newToken;
            return this.request<T>(method, path, body, { ...options, _retried: true });
          }
        }
        const detail = data.error || 'Unknown auth error';
        throw new CapyError(
          `Authentication failed: ${detail}`,
          ERROR_CODES.AUTH_FAILED,
          { status: 401, detail }
        );
      }

      if (res.status === 403) {
        const detail = data.error || 'You do not have permission to perform this action.';
        throw new CapyError(
          detail,
          ERROR_CODES.PERMISSION_DENIED,
          { status: 403, detail }
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
    try {
      const query = branch ? `?branch=${encodeURIComponent(branch)}` : '';
      const data = await this.request<{ env_file?: string; permissions: string[] }>(
        'GET', `/secrets/${projectId}${query}`,
      );

      return {
        env_content: data.env_file || '',
        decrypt_key: '', // Key is managed client-side via keyResolver
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      };
    } catch (error: any) {
      // 404 with "No secrets" is normal for a new project — return empty
      // 404 with "Project not found" or "Branch not found" should propagate
      if (error instanceof CapyError && error.details?.status === 404) {
        const msg = error.message || '';
        if (msg.includes('not found') && !msg.includes('No secrets')) {
          throw error; // Project or branch not found — let caller handle
        }
        return {
          env_content: '',
          decrypt_key: '', // Key is managed client-side via keyResolver
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
    branch?: string,
    encryptionKey?: string
  ): Promise<PushResult> {
    try {
      const activeBranch = branch || '';
      const encryptedVars: Record<string, string> = {};
      const resultVariables: Record<string, any> = {};

      if (!encryptionKey) {
        throw new CapyError(
          'Encryption key is required for pushing variables',
          ERROR_CODES.PERMISSION_DENIED
        );
      }

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
          const encrypted = Encryptor.encrypt(value, encryptionKey);
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
    return this.request<Branch>(
      'POST', `/projects/${projectId}/branches`,
      { name, is_production: isProduction },
    );
  }

  async deleteBranch(projectId: string, branchId: string): Promise<void> {
    await this.request<{ success: boolean }>(
      'DELETE', `/projects/${projectId}/branches/${branchId}`,
    );
  }

  async listBranches(projectId: string): Promise<Branch[]> {
    const data = await this.request<{ branches: Branch[] }>(
      'GET', `/projects/${projectId}/branches`,
    );
    return data.branches;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Creates a snippet-enhanced encrypted value for better usability (same logic as FileManager)
   */
  private createSnippetWithEncryption(originalValue: string, encryptedValue: string): string {
    const valueLength = originalValue.length;

    if (valueLength <= 8) {
      const snippet = originalValue.slice(-1);
      return `${encryptedValue}...${snippet}`;
    } else if (valueLength <= 16) {
      const snippet = originalValue.slice(-3);
      return `${encryptedValue}...${snippet}`;
    } else {
      const firstSnippet = originalValue.slice(0, 4);
      const lastSnippet = originalValue.slice(-4);
      return `${firstSnippet}...${encryptedValue}...${lastSnippet}`;
    }
  }

  async createInvite(orgId: string, email: string, role?: string): Promise<{ invite_id: string; org_id: string; email: string; role: string; user_id: string }> {
    return this.request('POST', `/orgs/${orgId}/invite`, { email, role });
  }

  async wrapOuterLayer(orgId: string, plaintext: string): Promise<{ ciphertext: string }> {
    return this.request('POST', `/orgs/${orgId}/wrap`, { plaintext });
  }

  async coDecrypt(orgId: string, ciphertext: string): Promise<{ plaintext: string }> {
    return this.request('POST', `/orgs/${orgId}/co-decrypt`, { ciphertext });
  }

  async listMembers(orgId: string): Promise<{ members: any[] }> {
    return this.request('GET', `/orgs/${orgId}/members`);
  }

  async kickMember(orgId: string, membershipId: string): Promise<void> {
    await this.request('DELETE', `/orgs/${orgId}/members/${encodeURIComponent(membershipId)}`);
  }
}

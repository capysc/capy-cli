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
  ERROR_CODES,
} from '../types/index';
import { createHash } from 'crypto';
import { Encryptor } from '../crypto/encryptor';
import { deriveResourceId } from '../crypto/resourceId';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export interface MemberProjectBranch {
  id: string;
  name: string;
  isProtected: boolean;
  hasAccess: boolean;
}

export interface MemberProject {
  id: string;
  name: string;
  role?: 'project-admin' | 'member';
  branches: MemberProjectBranch[];
}

export interface MemberDetail {
  membershipId: string;
  userId: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
  projects: MemberProject[];
}

export class ServiceClient {
  private apiUrl: string;
  private token: ServiceToken | null = null;
  private onTokenExpired?: () => Promise<ServiceToken | null>;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl || (devMode ? (process.env.CAPY_API_URL || 'http://localhost:3000') : 'https://api.capy.sc');
    if (devMode) {
      console.error(`[dev] ServiceClient → ${this.apiUrl}`);
    }
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
          `Failed to connect to ${B('Capy')} service. Please check your internet connection.`,
          ERROR_CODES.NETWORK_ERROR,
          { code: 'ETIMEDOUT' }
        );
      }
      throw new CapyError(
        `Failed to connect to ${B('Capy')} service. Please check your internet connection.`,
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

      if (res.status === 402 && data.code === 'QUOTA_EXCEEDED') {
        throw new CapyError(
          data.error || 'Account quota exceeded',
          ERROR_CODES.QUOTA_EXCEEDED,
          { status: 402, kind: data.kind, limit: data.limit, upgrade_url: data.upgrade_url }
        );
      }

      const serverMessage = data.error || data.message || 'Service request failed';
      throw new CapyError(
        serverMessage,
        ERROR_CODES.SERVICE_ERROR,
        { status: res.status, data }
      );
    }

    if (res.status === 204) {
      return undefined as T;
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

  async getDecryptData(
    projectId: string,
    branch?: string,
    keepHash?: string,
    includeLatestHash?: boolean,
  ): Promise<DecryptResponse> {
    try {
      const params: string[] = [];
      if (branch) params.push(`branch=${encodeURIComponent(branch)}`);
      if (keepHash) params.push(`keep_hash=${encodeURIComponent(keepHash)}`);
      if (includeLatestHash) params.push('include_latest_hash=true');
      const query = params.length ? `?${params.join('&')}` : '';
      const data = await this.request<{
        env_file?: string;
        permissions: string[];
        keep_hash?: string;
        latest_keep_hash?: string;
        keep_file?: string;
      }>(
        'GET', `/secrets/${projectId}${query}`,
      );

      return {
        env_content: data.env_file || '',
        decrypt_key: '', // Key is managed client-side via keyResolver
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        keep_hash: data.keep_hash,
        latest_keep_hash: data.latest_keep_hash,
        keep_file: data.keep_file,
      };
    } catch (error: any) {
      // 404 with "No secrets" or "Snapshot not found" — return empty for secrets, propagate snapshot miss
      // 404 with "Project not found" or "Branch not found" should propagate
      if (error instanceof CapyError && error.details?.status === 404) {
        const msg = error.message || '';
        if (msg.includes('Snapshot not found')) {
          throw error; // Pinned version missing — caller must handle
        }
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
            value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
          };
        } else if (value.startsWith('capy:')) {
          // Already encrypted — pass through as-is, no hash (keep existing)
          const existingResourceId = value.split(':')[1] || deriveResourceId(activeBranch, key);
          encryptedVars[key] = value;
          resultVariables[key] = {
            resource_id: existingResourceId,
          };
        } else {
          const resourceId = deriveResourceId(activeBranch, key);
          const encrypted = Encryptor.encrypt(value, encryptionKey);
          const snippetValue = this.createSnippetWithEncryption(value, encrypted);
          encryptedVars[key] = `capy:${resourceId}:${snippetValue}`;
          resultVariables[key] = {
            resource_id: resourceId,
            value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16),
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

  /**
   * v3: Fetch an encrypted env blob by keep_hash (no environment param).
   */
  async getSecrets(
    projectId: string,
    keepHash: string,
  ): Promise<{ env_file: string } | null> {
    try {
      const data = await this.request<{ env_file: string }>(
        'GET',
        `/secrets/${projectId}?keep_hash=${encodeURIComponent(keepHash)}`,
      );
      return data;
    } catch (error: any) {
      if (error instanceof CapyError && error.details?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * v3: Push a single env blob to content-addressed storage.
   */
  async pushSecrets(
    projectId: string,
    keepFile: string,
    envBlob: string,
    branch: string,
  ): Promise<{ keep_hash: string }> {
    return this.request('POST', `/secrets/${projectId}`, {
      keep_file: keepFile,
      env_blob: envBlob,
      branch,
    });
  }

  /**
   * List all projects in the caller's organization. Used by the client to
   * bootstrap when running in a directory with no local keep.lock.
   */
  async listProjects(): Promise<Array<{ id: string; name: string; organization_id: string }>> {
    const data = await this.request<{
      projects: Array<{ id: string; name: string; organization_id: string }>;
    }>('GET', '/projects');
    return data.projects;
  }

  async createBranch(projectId: string, name: string, isProtected: boolean = false): Promise<Branch> {
    return this.request<Branch>(
      'POST', `/projects/${projectId}/branches`,
      { name, is_protected: isProtected },
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

  async createInvite(orgId: string, email: string, role?: string, projectId?: string): Promise<{ invite_id: string; org_id: string; email: string; role: string; user_id: string; project_id: string | null }> {
    return this.request('POST', `/orgs/${orgId}/invite`, { email, role, project_id: projectId });
  }

  async inviteToProject(orgId: string, projectId: string, email: string, role: 'project-admin' | 'member'): Promise<{ user_id: string; email: string; project_id: string; role: string }> {
    return this.request('POST', `/orgs/${orgId}/projects/${projectId}/members`, { email, role });
  }

  async kickFromProject(orgId: string, projectId: string, userId: string): Promise<void> {
    await this.request('DELETE', `/orgs/${orgId}/projects/${projectId}/members/${encodeURIComponent(userId)}`);
  }

  async grantProtectedBranch(orgId: string, projectId: string, branchId: string, userId: string): Promise<void> {
    await this.request('POST', `/orgs/${orgId}/projects/${projectId}/branches/${branchId}/grants`, { user_id: userId });
  }

  async revokeProtectedBranch(orgId: string, projectId: string, branchId: string, userId: string): Promise<void> {
    await this.request('DELETE', `/orgs/${orgId}/projects/${projectId}/branches/${branchId}/grants/${encodeURIComponent(userId)}`);
  }

  async changeRole(orgId: string, userId: string, role: string, projectId?: string): Promise<{ user_id: string; role: string; project_id: string | null }> {
    return this.request('PATCH', `/orgs/${orgId}/members/${encodeURIComponent(userId)}/role`, { role, project_id: projectId });
  }

  async getOrgMe(orgId: string): Promise<{ user_id: string; role: string; admin_projects: Array<{ id: string; name: string }> }> {
    return this.request('GET', `/orgs/${orgId}/me`);
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

  async listMemberDetails(orgId: string): Promise<{ members: MemberDetail[] }> {
    return this.request('GET', `/orgs/${orgId}/members/details`);
  }

  async kickMember(orgId: string, membershipId: string): Promise<void> {
    await this.request('DELETE', `/orgs/${orgId}/members/${encodeURIComponent(membershipId)}`);
  }

  async createDeployToken(orgId: string, deployId: string, projectId: string, innerBlob: string): Promise<{ outer_blob: string }> {
    return this.request('POST', `/orgs/${orgId}/deploy`, { deploy_id: deployId, project_id: projectId, inner_blob: innerBlob });
  }

  /**
   * Decrypt a deploy token (unauthenticated, for CI runtime).
   * Makes a raw fetch without the auth header.
   */
  async deployDecrypt(deployId: string, ciphertext: string): Promise<{ plaintext: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/deploy/${encodeURIComponent(deployId)}/decrypt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext }),
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      throw new CapyError(
        `Cannot reach ${B('Capy')} service. Check your internet connection.`,
        ERROR_CODES.NETWORK_ERROR,
        { code: err.code || err.cause?.code },
      );
    }
    clearTimeout(timeout);

    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as Record<string, any>;
      const msg = data.error || 'Deploy decrypt failed';
      if (res.status === 403) {
        throw new CapyError(msg, ERROR_CODES.PERMISSION_DENIED, { status: 403 });
      }
      if (res.status === 404) {
        throw new CapyError(msg, ERROR_CODES.SERVICE_ERROR, { status: 404 });
      }
      throw new CapyError(msg, ERROR_CODES.SERVICE_ERROR, { status: res.status, data });
    }

    return res.json() as Promise<{ plaintext: string }>;
  }

  /**
   * Fetch platform-specific deploy instructions (unauthenticated).
   */
  async fetchDeployInstructions(platform: string): Promise<{ platform: string; markdown: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/deploy/instructions/${encodeURIComponent(platform)}`, {
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      return { platform, markdown: `Set SECRETS_BLOB and PROJECT_KEY as environment variables in your deployment platform.` };
    }
    clearTimeout(timeout);

    if (!res.ok) {
      return { platform, markdown: `Set SECRETS_BLOB and PROJECT_KEY as environment variables in your deployment platform.` };
    }

    return res.json() as Promise<{ platform: string; markdown: string }>;
  }

  async revokeDeployToken(deployId: string): Promise<void> {
    await this.request('DELETE', `/deploy/${encodeURIComponent(deployId)}`);
  }

  async listDeployTokens(orgId: string, projectId: string): Promise<{ tokens: Array<{ deploy_id: string; label: string | null; created_by: string; created_at: string; revoked_at: string | null }> }> {
    return this.request('GET', `/orgs/${orgId}/projects/${encodeURIComponent(projectId)}/deploy-tokens`);
  }
}

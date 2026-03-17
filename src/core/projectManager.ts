import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { ProjectState, VaultFile, DecryptKey, SyncState, CapyError, ERROR_CODES } from '../types/index';

export class ProjectManager {
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
  }

  async detectProjectState(): Promise<ProjectState> {
    const vaultPath = this.getVaultPath();
    const decryptPath = this.getDecryptPath();
    const envPath = this.getEnvPath();

    const hasVaultFile = existsSync(vaultPath);
    const hasDecryptKey = existsSync(decryptPath);
    const hasEnvFile = existsSync(envPath);

    let projectName: string | undefined;
    let organizationId: string | undefined;
    let projectId: string | undefined;

    if (hasVaultFile) {
      try {
        const vaultContent = readFileSync(vaultPath, 'utf-8');
        const vault: VaultFile = JSON.parse(vaultContent);
        this.validateVaultFile(vault);
        projectName = vault.project_name;
        organizationId = vault.capy_id;
        projectId = vault.project_id;
      } catch (error) {
        throw new CapyError(
          'Invalid .vault file format',
          ERROR_CODES.INVALID_FORMAT,
          { error, path: vaultPath }
        );
      }
    }

    return {
      initialized: hasVaultFile,
      hasVaultFile,
      hasDecryptKey,
      hasEnvFile,
      projectName,
      organizationId,
      projectId
    };
  }

  getVaultPath(): string {
    return join(this.projectRoot, '.vault');
  }

  getCapyDir(): string {
    return join(this.projectRoot, '.capy');
  }

  getDecryptPath(): string {
    return join(this.getCapyDir(), 'decrypt');
  }

  getSyncStatePath(): string {
    return join(this.getCapyDir(), 'sync-state');
  }

  getEnvPath(customPath?: string): string {
    return customPath || join(this.projectRoot, '.env');
  }

  getGitignorePath(): string {
    return join(this.projectRoot, '.gitignore');
  }

  getDefaultProjectName(): string {
    const raw = basename(this.projectRoot) || '';
    const normalized = raw
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!normalized) return 'my-project';
    return normalized;
  }

  readVaultFile(): VaultFile | null {
    const vaultPath = this.getVaultPath();
    if (!existsSync(vaultPath)) {
      return null;
    }

    try {
      const content = readFileSync(vaultPath, 'utf-8');
      const vault = JSON.parse(content) as VaultFile;
      this.validateVaultFile(vault);
      if (vault.variables && typeof vault.variables !== 'object') {
        throw new CapyError('Invalid variables structure', ERROR_CODES.INVALID_FORMAT);
      }
      return vault;
    } catch (error) {
      if (error instanceof CapyError) {
        throw error;
      }
      throw new CapyError(
        'Failed to read .vault file',
        ERROR_CODES.INVALID_FORMAT,
        { error, path: vaultPath }
      );
    }
  }

  private validateVaultFile(vault: any): void {
    const required = ['version', 'capy_id', 'project_id', 'project_name'];
    for (const field of required) {
      if (!vault || vault[field] === undefined || vault[field] === null) {
        throw new CapyError(`Missing required field: ${field}`, ERROR_CODES.INVALID_FORMAT);
      }
    }
    if (vault.variables !== undefined && typeof vault.variables !== 'object') {
      throw new CapyError('Invalid variables structure', ERROR_CODES.INVALID_FORMAT);
    }
  }

  readDecryptKey(): DecryptKey | null {
    const decryptPath = this.getDecryptPath();
    if (!existsSync(decryptPath)) {
      return null;
    }

    try {
      const content = readFileSync(decryptPath, 'utf-8');
      return JSON.parse(content) as DecryptKey;
    } catch (error) {
      throw new CapyError(
        'Failed to read .decrypt file',
        ERROR_CODES.INVALID_FORMAT,
        { error, path: decryptPath }
      );
    }
  }

  readSyncState(): SyncState | null {
    const syncStatePath = this.getSyncStatePath();
    if (!existsSync(syncStatePath)) {
      return null;
    }

    try {
      const content = readFileSync(syncStatePath, 'utf-8');
      return JSON.parse(content) as SyncState;
    } catch (error) {
      // If sync state is corrupted, return null (will be recreated)
      return null;
    }
  }

  isGitRepository(): boolean {
    const gitPath = join(this.projectRoot, '.git');
    return existsSync(gitPath);
  }

  validateProjectConfiguration(state: ProjectState): void {
    if (!state.hasVaultFile) {
      return;
    }

    if (!state.organizationId) {
      throw new CapyError(
        'Invalid .vault file: missing organization ID',
        ERROR_CODES.INVALID_FORMAT
      );
    }

    if (!state.projectId) {
      throw new CapyError(
        'Invalid .vault file: missing project ID',
        ERROR_CODES.INVALID_FORMAT
      );
    }
  }
}
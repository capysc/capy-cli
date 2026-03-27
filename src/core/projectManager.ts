import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { ProjectState, KeepFile, KeepVariableEntry, DecryptKey, SyncState, CapyError, ERROR_CODES } from '../types/index';

export class ProjectManager {
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
  }

  async detectProjectState(): Promise<ProjectState> {
    const keepPath = this.getKeepPath();
    const decryptPath = this.getDecryptPath();
    const envPath = this.getEnvPath();

    const hasKeepFile = existsSync(keepPath);
    const hasDecryptKey = existsSync(decryptPath);
    const hasEnvFile = existsSync(envPath);

    let projectName: string | undefined;
    let organizationId: string | undefined;
    let projectId: string | undefined;

    let activeBranch: string | undefined;

    if (hasKeepFile) {
      try {
        const keepContent = readFileSync(keepPath, 'utf-8');
        const keep = this.migrateKeepIfNeeded(JSON.parse(keepContent));
        this.validateKeepFile(keep);
        projectName = keep.project_name;
        organizationId = keep.org_id;
        projectId = keep.project_id;
        activeBranch = keep.active_branch;
      } catch (error) {
        if (error instanceof CapyError) throw error;
        throw new CapyError(
          'Invalid .keep file format',
          ERROR_CODES.INVALID_FORMAT,
          { error, path: keepPath }
        );
      }
    }

    return {
      initialized: hasKeepFile,
      hasKeepFile,
      hasDecryptKey,
      hasEnvFile,
      projectName,
      organizationId,
      projectId,
      activeBranch,
    };
  }

  getKeepPath(): string {
    return join(this.projectRoot, '.keep');
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

  readKeepFile(): KeepFile | null {
    const keepPath = this.getKeepPath();
    if (!existsSync(keepPath)) {
      return null;
    }

    try {
      const content = readFileSync(keepPath, 'utf-8');
      const raw = JSON.parse(content);
      const keep = this.migrateKeepIfNeeded(raw);
      this.validateKeepFile(keep);
      return keep;
    } catch (error) {
      if (error instanceof CapyError) {
        throw error;
      }
      throw new CapyError(
        'Failed to read .keep file',
        ERROR_CODES.INVALID_FORMAT,
        { error, path: keepPath }
      );
    }
  }

  /**
   * Migrate v1 .keep format (variables as objects) to v2 (variables as arrays).
   */
  private migrateKeepIfNeeded(raw: any): KeepFile {
    if (raw.version === '2.0') return raw as KeepFile;

    // v1 → v2: convert each variable from object to single-entry array
    const migratedVariables: Record<string, KeepVariableEntry[]> = {};
    if (raw.variables && typeof raw.variables === 'object') {
      for (const [varName, entry] of Object.entries(raw.variables)) {
        const v1 = entry as { resource_id: string; created_at: string; updated_at: string };
        if (v1.resource_id) {
          migratedVariables[varName] = [{
            resource_id: v1.resource_id,
            created_at: v1.created_at,
            updated_at: v1.updated_at,
          }];
        }
      }
    }

    return {
      ...raw,
      version: '2.0',
      variables: migratedVariables,
    };
  }

  private validateKeepFile(keep: any): void {
    const required = ['version', 'org_id', 'project_id', 'project_name'];
    for (const field of required) {
      if (!keep || keep[field] === undefined || keep[field] === null) {
        throw new CapyError(`Missing required field: ${field}`, ERROR_CODES.INVALID_FORMAT);
      }
    }
    if (keep.variables !== undefined && typeof keep.variables !== 'object') {
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
    if (!state.hasKeepFile) {
      return;
    }

    if (!state.organizationId) {
      throw new CapyError(
        'Invalid .keep file: missing organization ID',
        ERROR_CODES.INVALID_FORMAT
      );
    }

    if (!state.projectId) {
      throw new CapyError(
        'Invalid .keep file: missing project ID',
        ERROR_CODES.INVALID_FORMAT
      );
    }
  }
}
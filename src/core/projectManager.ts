import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { ProjectState, KeepFile, DecryptKey, SyncState, CapyError, ERROR_CODES } from '../types/index';

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

    if (hasKeepFile) {
      try {
        const keepContent = readFileSync(keepPath, 'utf-8');
        const keep = this.migrateKeepIfNeeded(JSON.parse(keepContent));
        this.validateKeepFile(keep);
        projectName = keep.project_name;
        organizationId = keep.org_id;
        projectId = keep.project_id;
      } catch (error) {
        if (error instanceof CapyError) throw error;
        throw new CapyError(
          'Invalid .keep file format',
          ERROR_CODES.INVALID_FORMAT,
          { error, path: keepPath }
        );
      }
    }

    const syncState = this.readSyncState();

    return {
      initialized: hasKeepFile,
      hasKeepFile,
      hasDecryptKey,
      hasEnvFile,
      projectName,
      organizationId,
      projectId,
      activeBranch: this.readActiveBranch(),
      userId: syncState?.user_id,
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

  getActiveBranchPath(): string {
    return join(this.getCapyDir(), 'branch');
  }

  readActiveBranch(): string | undefined {
    const branchPath = this.getActiveBranchPath();
    if (!existsSync(branchPath)) return undefined;
    try {
      const content = readFileSync(branchPath, 'utf-8').trim();
      return content || undefined;
    } catch {
      return undefined;
    }
  }

  writeActiveBranch(branch: string | undefined): void {
    const capyDir = this.getCapyDir();
    if (!existsSync(capyDir)) mkdirSync(capyDir, { recursive: true });
    const branchPath = this.getActiveBranchPath();
    writeFileSync(branchPath, branch || '', { encoding: 'utf-8', mode: 0o600 });
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
   * Migrate older .keep formats to current v3 (deterministic, no timestamps).
   */
  private migrateKeepIfNeeded(raw: any): KeepFile {
    if (raw.version === '2.0') {
      delete raw.created_at;
      delete raw.last_updated;
      if (raw.variables) {
        for (const entries of Object.values(raw.variables) as any[]) {
          for (const entry of entries) {
            delete entry.created_at;
          }
        }
      }
      raw.version = '3.0';
    }
    return raw as KeepFile;
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

  writeSyncStateUserId(userId: string): void {
    const syncStatePath = this.getSyncStatePath();
    const capyDir = this.getCapyDir();
    if (!existsSync(capyDir)) mkdirSync(capyDir, { recursive: true });
    const existing = this.readSyncState() || { last_sync: '', synced_variables: [] };
    existing.user_id = userId;
    writeFileSync(syncStatePath, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
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
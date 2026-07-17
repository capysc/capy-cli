import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { ProjectState, KeepFile, SyncState, CapyError, ERROR_CODES } from '../types/index';
import { branchesFromKeep, syncedBranchNames } from './branchResolver';

export class ProjectManager {
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
  }

  async detectProjectState(): Promise<ProjectState> {
    const keepPath = this.getKeepPath();
    const envPath = this.getEnvPath();

    const hasKeepFile = existsSync(keepPath);
    const hasEnvFile = existsSync(envPath);

    let projectName: string | undefined;
    let organizationId: string | undefined;
    let projectId: string | undefined;

    if (hasKeepFile) {
      try {
        const keepContent = readFileSync(keepPath, 'utf-8');
        const keep = this.parseKeepFile(JSON.parse(keepContent));
        this.validateKeepFile(keep);
        projectName = keep.project_name;
        organizationId = keep.org_id;
        projectId = keep.project_id;
      } catch (error) {
        if (error instanceof CapyError) throw error;
        throw new CapyError(
          'Invalid keep.lock file format',
          ERROR_CODES.INVALID_FORMAT,
          { error, path: keepPath }
        );
      }
    }

    const syncState = this.readSyncState();

    return {
      initialized: hasKeepFile,
      hasKeepFile,
      hasEnvFile,
      projectName,
      organizationId,
      projectId,
      activeBranch: this.deriveActiveBranch(),
      userId: syncState?.user_id,
    };
  }

  getKeepPath(): string {
    return join(this.projectRoot, 'keep.lock');
  }

  getCapyDir(): string {
    return join(this.projectRoot, '.capy');
  }

  getActiveBranchPath(): string {
    return join(this.getCapyDir(), 'branch');
  }

  /**
   * Raw contents of `.capy/branch`, or null when absent/unreadable/empty.
   * `.capy/` is gitignored, so a missing file is a normal state (fresh clone,
   * new Conductor workspace) — never fabricate a branch name for it.
   */
  readActiveBranch(): string | null {
    const branchPath = this.getActiveBranchPath();
    if (!existsSync(branchPath)) return null;
    try {
      const content = readFileSync(branchPath, 'utf-8').trim();
      return content || null;
    } catch {
      return null;
    }
  }

  /**
   * Best-effort branch derivation for commands that need a branch without an
   * interactive resolution flow: `.env` header (what the secrets on disk were
   * actually encrypted for) → `.capy/branch` → sole branch in sync-state →
   * sole branch in keep.lock. Returns null when nothing is known — callers
   * must treat that as "no active branch", never substitute a default name.
   */
  deriveActiveBranch(): string | null {
    const envBranch = this.readEnvHeaderBranch();
    if (envBranch) return envBranch;

    const fileBranch = this.readActiveBranch();
    if (fileBranch) return fileBranch;

    const synced = syncedBranchNames(this.readSyncState());
    if (synced.length === 1) return synced[0];

    try {
      const keepBranches = branchesFromKeep(this.readKeepFile());
      if (keepBranches.length === 1) return keepBranches[0];
    } catch {
      // Corrupt keep.lock is reported by the paths that actually need it.
    }
    return null;
  }

  /**
   * Branch recorded in the .env metadata header (`# capy:branch=…`).
   * Mirrors FileManager.readEnvMeta's header parse for the one key this
   * class needs; kept local to avoid pulling crypto-heavy FileManager in.
   */
  private readEnvHeaderBranch(): string | null {
    const envPath = this.getEnvPath();
    if (!existsSync(envPath)) return null;
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.startsWith('# capy:')) break;
        const match = line.match(/^# capy:branch=(.+)$/);
        if (match) return match[1].trim() || null;
      }
    } catch {
      // Unreadable .env — treated the same as absent.
    }
    return null;
  }

  writeActiveBranch(branch: string): void {
    const name = (branch || '').trim();
    const branchPath = this.getActiveBranchPath();
    if (!name) {
      // Never fabricate a branch name — an empty write clears the cache.
      if (existsSync(branchPath)) unlinkSync(branchPath);
      return;
    }
    const capyDir = this.getCapyDir();
    if (!existsSync(capyDir)) mkdirSync(capyDir, { recursive: true });
    writeFileSync(branchPath, name, { encoding: 'utf-8', mode: 0o600 });
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
      const keep = this.parseKeepFile(raw);
      this.validateKeepFile(keep);
      return keep;
    } catch (error) {
      if (error instanceof CapyError) {
        throw error;
      }
      throw new CapyError(
        'Failed to read keep.lock file',
        ERROR_CODES.INVALID_FORMAT,
        { error, path: keepPath }
      );
    }
  }

  private parseKeepFile(raw: any): KeepFile {
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

  writeSyncStateOrgId(orgId: string): void {
    const syncStatePath = this.getSyncStatePath();
    const capyDir = this.getCapyDir();
    if (!existsSync(capyDir)) mkdirSync(capyDir, { recursive: true });
    const existing = this.readSyncState() || { last_sync: '', synced_variables: [] };
    existing.org_id = orgId;
    writeFileSync(syncStatePath, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  /**
   * Drop just the user_id field from sync-state. Used by `capy logout` so the
   * next `capy` run doesn't pin the previous user's session via
   * setSessionUserId(projectState.userId). org_id, keep_hash, last_sync, and
   * synced_variables are preserved — they're not user-scoped.
   */
  clearSyncStateUserId(): boolean {
    const existing = this.readSyncState();
    if (!existing || existing.user_id === undefined) return false;
    delete existing.user_id;
    const syncStatePath = this.getSyncStatePath();
    writeFileSync(syncStatePath, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
    return true;
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
        'Invalid keep.lock file: missing organization ID',
        ERROR_CODES.INVALID_FORMAT
      );
    }

    if (!state.projectId) {
      throw new CapyError(
        'Invalid keep.lock file: missing project ID',
        ERROR_CODES.INVALID_FORMAT
      );
    }
  }
}

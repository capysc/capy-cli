export interface EnvVariable {
  name: string;
  value: string;
  source: 'local' | 'remote' | 'both';
  encrypted: boolean;
}

export interface KeepFile {
  version: string;
  org_id: string;
  project_id: string;
  project_name: string;
  active_branch?: string;
  created_at: string;
  last_sync: string;
  variables: Record<string, KeepVariableEntry[]>;
}

export interface KeepVariableEntry {
  resource_id: string;
  branch?: string;
  created_at: string;
  updated_at: string;
}

/** @deprecated v1 format — auto-migrated to KeepVariableEntry[] on read */
export interface KeepVariable {
  resource_id: string;
  created_at: string;
  updated_at: string;
}

export interface DecryptKey {
  version: string;
  org_id: string;
  project_id: string;
  user_id: string;
  decryption_key: string;
  expires_at: string;
  permissions: string[];
}

export interface ProjectState {
  initialized: boolean;
  hasKeepFile: boolean;
  hasDecryptKey: boolean;
  hasEnvFile: boolean;
  projectName?: string;
  organizationId?: string;
  projectId?: string;
  activeBranch?: string;
}

export interface Branch {
  id: string;
  name: string;
  project_id: string;
  is_production: boolean;
  created_at?: string;
}

export interface SyncResult {
  success: boolean;
  pushed: string[];
  pulled: string[];
  conflicts: string[];
  errors: string[];
  totalVariables: number;
}

export interface ChangeSet {
  newLocal: EnvVariable[];
  newRemote: EnvVariable[];
  conflicts: ConflictVariable[];
  unchanged: EnvVariable[];
  deleted: EnvVariable[]; // Variables marked as capy:deleted on remote
  deletedLocal: EnvVariable[]; // Variables deleted locally (in sync state but not in local .env)
}

export interface SyncState {
  last_sync: string;
  synced_variables: string[];
}

export interface ConflictVariable {
  name: string;
  localValue: string;
  remoteValue: string;
  isNew?: boolean; // True if local value has a different resource_id than remote
}

export interface UserDecisions {
  pushVariables: string[];
  pullVariables: string[];
  keepLocal: string[];
  keepRemote: string[];
  deleteLocal: string[]; // Variables to delete from local .env
  deleteRemote: string[]; // Variables to delete from remote (push deletion)
}

export interface Organization {
  id: string;
  workos_org_id: string;
  name: string;
}

export interface AuthResult {
  success: boolean;
  organization_id?: string;
  organization_name?: string;
  user_id?: string;
  user_email?: string;
  user_first_name?: string | null;
  user_last_name?: string | null;
  organizations?: Organization[];
  error?: string;
  /** WorkOS refresh token for use with createOrganization when org selection is pending */
  _refresh_token?: string;
  /** How the token was obtained: 'cached', 'refreshed', or 'oauth' */
  _auth_method?: 'cached' | 'refreshed' | 'oauth';
}

export interface DecryptResponse {
  env_content: string;
  decrypt_key: string;
  expires_at: string;
}

export interface ServiceToken {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  organization_id: string;
  user_id: string;
  user_email?: string;
  user_first_name?: string | null;
  user_last_name?: string | null;
  organizations?: Organization[];
}

export interface CliOptions {
  envPath?: string;
  verbose?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

export interface ProjectInitResult {
  org_id: string;
  project_id: string;
  project_name: string;
  created: boolean;
}

export interface PushResult {
  success: boolean;
  variables: Record<string, {
    resource_id: string;
    success: boolean;
    error?: string;
  }>;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface CliConfig {
  apiUrl: string;
  authTimeout: number;
  logLevel: LogLevel;
}

export class CapyError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'CapyError';
  }
}

export const ERROR_CODES = {
  AUTH_FAILED: 'AUTH_FAILED',
  NO_ENV_FILE: 'NO_ENV_FILE',
  NO_KEEP_FILE: 'NO_KEEP_FILE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  ENCRYPTION_ERROR: 'ENCRYPTION_ERROR',
  INVALID_FORMAT: 'INVALID_FORMAT',
  CONFLICT_RESOLUTION: 'CONFLICT_RESOLUTION',
  SERVICE_ERROR: 'SERVICE_ERROR'
} as const;
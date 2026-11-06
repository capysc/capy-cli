/**
 * The refusal codes of the steps every connector's `--discover` shares
 * (`discoverySteps.ts`, `dokployDiscovery.ts#findCandidateReposResult`,
 * `git/discoveryCommit.ts`).
 *
 * Each step is the same for every provider, but a provider decides how its
 * codes are spelled: Dokploy keeps the `DOKPLOY_*` spellings it has always
 * reported (its output does not change), and every other provider reports the
 * provider-neutral `CONNECTOR_*` ones. The table is passed in; a code is only
 * ever compared, never parsed.
 */
import { ERROR_CODES } from '../../types/index';

export interface DiscoveryCodes {
  /**
   * Whether a typed error from the service (for example `PERMISSION_DENIED`) that stops a folder's upload keeps its own code,
   * instead of becoming `pushFailed`. Dokploy has always reported `pushFailed` for it, so it stays `false` there.
   */
  readonly keepsServiceCode: boolean;
  readonly pushFailed: string;
  readonly folderNotInitialized: string;
  readonly projectLookupFailed: string;
  readonly projectNameExists: string;
  readonly projectNotFound: string;
  readonly initFailed: string;
  readonly projectNameTooLong: string;
  readonly keyResolutionFailed: string;
  readonly folderDirty: string;
  readonly branchProtected: string;
  readonly keepMissing: string;
  readonly checkoutFailed: string;
  readonly remoteUnreadable: string;
  readonly commitWouldMix: string;
  readonly commitBranchInvalid: string;
  readonly commitBranchExists: string;
  readonly gitIdentityMissing: string;
  readonly commitFailed: string;
}

/** Dokploy's spellings: exactly the strings its discovery has always reported. */
export const DOKPLOY_DISCOVERY_CODES: DiscoveryCodes = {
  keepsServiceCode: false,
  pushFailed: 'DOKPLOY_PUSH_FAILED',
  folderNotInitialized: 'DOKPLOY_FOLDER_NOT_INITIALIZED',
  projectLookupFailed: 'DOKPLOY_PROJECT_LOOKUP_FAILED',
  projectNameExists: 'DOKPLOY_PROJECT_NAME_EXISTS',
  projectNotFound: 'DOKPLOY_PROJECT_NOT_FOUND',
  initFailed: 'DOKPLOY_INIT_FAILED',
  projectNameTooLong: 'DOKPLOY_PROJECT_NAME_TOO_LONG',
  keyResolutionFailed: 'DOKPLOY_KEY_RESOLUTION_FAILED',
  folderDirty: 'DOKPLOY_FOLDER_DIRTY',
  branchProtected: 'DOKPLOY_BRANCH_PROTECTED',
  keepMissing: 'DOKPLOY_KEEP_MISSING',
  checkoutFailed: 'DOKPLOY_CHECKOUT_FAILED',
  remoteUnreadable: 'DOKPLOY_REMOTE_UNREADABLE',
  commitWouldMix: 'DOKPLOY_COMMIT_WOULD_MIX',
  commitBranchInvalid: 'DOKPLOY_COMMIT_BRANCH_INVALID',
  commitBranchExists: 'DOKPLOY_COMMIT_BRANCH_EXISTS',
  gitIdentityMissing: 'DOKPLOY_GIT_IDENTITY_MISSING',
  commitFailed: 'DOKPLOY_COMMIT_FAILED',
};

/** The provider-neutral spellings, for every provider other than Dokploy. */
export const CONNECTOR_DISCOVERY_CODES: DiscoveryCodes = {
  keepsServiceCode: true,
  pushFailed: ERROR_CODES.CONNECTOR_PUSH_FAILED,
  folderNotInitialized: ERROR_CODES.CONNECTOR_FOLDER_NOT_INITIALIZED,
  projectLookupFailed: ERROR_CODES.CONNECTOR_PROJECT_LOOKUP_FAILED,
  projectNameExists: ERROR_CODES.CONNECTOR_PROJECT_NAME_EXISTS,
  projectNotFound: ERROR_CODES.CONNECTOR_PROJECT_NOT_FOUND,
  initFailed: ERROR_CODES.CONNECTOR_INIT_FAILED,
  projectNameTooLong: ERROR_CODES.CONNECTOR_PROJECT_NAME_TOO_LONG,
  keyResolutionFailed: ERROR_CODES.CONNECTOR_KEY_RESOLUTION_FAILED,
  folderDirty: ERROR_CODES.CONNECTOR_FOLDER_DIRTY,
  branchProtected: ERROR_CODES.CONNECTOR_BRANCH_PROTECTED,
  keepMissing: ERROR_CODES.CONNECTOR_KEEP_MISSING,
  checkoutFailed: ERROR_CODES.CONNECTOR_CHECKOUT_FAILED,
  remoteUnreadable: ERROR_CODES.CONNECTOR_REMOTE_UNREADABLE,
  commitWouldMix: ERROR_CODES.CONNECTOR_COMMIT_WOULD_MIX,
  commitBranchInvalid: ERROR_CODES.CONNECTOR_COMMIT_BRANCH_INVALID,
  commitBranchExists: ERROR_CODES.CONNECTOR_COMMIT_BRANCH_EXISTS,
  gitIdentityMissing: ERROR_CODES.CONNECTOR_GIT_IDENTITY_MISSING,
  commitFailed: ERROR_CODES.CONNECTOR_COMMIT_FAILED,
};

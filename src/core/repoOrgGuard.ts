import { existsSync, readFileSync } from 'fs';
import { CapyError, ERROR_CODES } from '../types/index';
import { ProjectManager } from './projectManager';

/**
 * A git repo belongs to one organization: the `org_id` in the TRACKED keep.lock (the committed identity of the
 * repo, not Capy's untracked working copy under `.capy/`). `capy redeem` and `capy org` must never bring a
 * different organization into a folder that already names one.
 */

/**
 * The organization the folder's tracked keep.lock names, or undefined when there is no tracked keep.lock, it does
 * not parse, or it names no organization. Reads the file only; never writes.
 */
export function readTrackedRepoOrgId(projectRoot: string = process.cwd()): string | undefined {
  const path = new ProjectManager(projectRoot).getKeepPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const orgId = (parsed as { org_id?: unknown } | null)?.org_id;
    return typeof orgId === 'string' && orgId.length > 0 ? orgId : undefined;
  } catch {
    return undefined;
  }
}

/** Refusal for `capy redeem`: the invite targets an organization other than the repo's. Ids, because no names are local. */
export function redeemRepoOrgRefusal(projectRoot: string, invitedOrgId: string): CapyError | undefined {
  const repoOrgId = readTrackedRepoOrgId(projectRoot);
  if (repoOrgId === undefined || repoOrgId === invitedOrgId) return undefined;
  return new CapyError(
    `This git repo belongs to ${repoOrgId}. You cannot redeem an invite for ${invitedOrgId} into it.`, // COPY-FLAG
    ERROR_CODES.REPO_ORG_MISMATCH,
    { repo_org_id: repoOrgId, requested_org_id: invitedOrgId },
  );
}

/** Refusal for the `capy org` switch: the picked (or newly created) organization is not the repo's. `requestedOrgId` is undefined for "create a new organization". */
export function switchRepoOrgRefusal(
  repoOrgId: string | undefined,
  repoOrgName: string | undefined,
  requestedOrgId: string | undefined,
): CapyError | undefined {
  if (repoOrgId === undefined || repoOrgId === requestedOrgId) return undefined;
  return new CapyError(
    `This git repo belongs to ${repoOrgName ?? repoOrgId}. You cannot switch it to another organization.`, // COPY-FLAG
    ERROR_CODES.REPO_ORG_MISMATCH,
    { repo_org_id: repoOrgId, ...(requestedOrgId === undefined ? {} : { requested_org_id: requestedOrgId }) },
  );
}

/** The code and the sentence on stderr (stdout stays free for payloads), then exit 1. Same shape as the gate's refusal. */
export function exitWithRepoOrgRefusal(refusal: CapyError): never {
  console.error(`${refusal.code}: ${refusal.message}`);
  return process.exit(1);
}

/**
 * What a `capy pair` run asks for, sent with `/auth/device/authorize`.
 *
 * The org is never this CLI's to decide: it is unauthenticated. Whoever
 * approves in Keep pairs the machine into the org their Keep session is signed
 * in to, checked against their live WorkOS membership, and the service returns
 * that org with the session (`paired_org_id`). The org/project sent from here
 * (`--org`, else this checkout's keep.lock) are only hints that pick between
 * the orgs a multi-org user belongs to: Keep asks the approver to switch org
 * when the hint names another of theirs, and nobody else sees the request.
 *
 *  - Sign-in only (`capy pair` on a machine that already has keys for the
 *    org): approval goes through Keep `/pair`.
 *  - `capy pair` on a machine with no keys asks nothing and becomes a key
 *    handover: one link, and Keep decides after sign-in. An existing user
 *    approves the handover of their org's keys; a new user with no org is sent
 *    through signup, which creates the org, and comes back to approve.
 *  - Key handover (`capy pair --transport`): Keep `/transport/pair` seals the
 *    session org's keys to this run.
 *  - Fresh project (`capy pair --signup`): nothing exists yet; the approver
 *    creates the org in Keep and this machine receives its first keys.
 */
import { resolveKeepOrigin } from '../../config/keepOrigin';
import { readKeep } from '../../commands/deployCommand';
import { hasAnyUsableOrgKeys } from '../../config/globalConfig';
import { CapyError, ERROR_CODES } from '../../types/index';

export type PairMode = 'session' | 'transport';

export interface PairScope {
  readonly mode: PairMode;
  readonly orgId: string | null;
  readonly projectId: string | null;
  readonly signup: boolean;
}

export interface PairScopeOptions {
  readonly transport?: boolean;
  readonly signup?: boolean;
  /** An org hint for a multi-org account, when this folder does not give one. */
  readonly org?: string;
}

function scopeRequired(message: string): CapyError {
  return new CapyError(message, ERROR_CODES.PAIR_SCOPE_REQUIRED);
}

/** Decides what is asked for before anything is sent. Throws `PAIR_SCOPE_REQUIRED` only for `--signup` inside a project. */
export function resolvePairScope(options: PairScopeOptions, cwd: string = process.cwd(), deps: {
  readonly readProject?: typeof readKeep;
  /** Whether this machine holds usable keys for the org (any org when null). */
  readonly hasKeys?: (orgId: string | null) => boolean;
} = {}): PairScope {
  const project = (deps.readProject ?? readKeep)(cwd);
  if (options.signup === true) {
    if (project) throw scopeRequired('This folder already belongs to a Capy project. Run capy pair --transport here instead of --signup.'); // COPY-FLAG
    return { mode: 'transport', orgId: null, projectId: null, signup: true };
  }
  const org = options.org?.trim() || project?.orgId || null;
  // No keys here: signing in alone would be refused after approval, so ask for the keys instead. Nobody is asked to choose.
  if (options.transport === true || !(deps.hasKeys ?? hasAnyUsableOrgKeys)(org)) {
    // The project hint only holds when it is in the hinted org.
    const projectId = project && project.orgId === org ? project.projectId : null;
    return { mode: 'transport', orgId: org, projectId, signup: false };
  }
  return { mode: 'session', orgId: org, projectId: null, signup: false };
}

/** Whether this folder belongs to a Capy project (has a readable keep.lock). `--signup` is offered only outside one. */
export function folderHasProject(cwd: string = process.cwd(), deps: { readonly readProject?: typeof readKeep } = {}): boolean {
  return Boolean((deps.readProject ?? readKeep)(cwd));
}

/** The Keep page that approves this pairing. */
export function pairApprovalLink(scope: PairScope, userCode: string): string {
  const path = scope.mode === 'session' ? '/pair' : '/transport/pair';
  return `${resolveKeepOrigin()}${path}?code=${encodeURIComponent(userCode)}`;
}

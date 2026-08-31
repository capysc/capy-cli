/**
 * CAP-409 — install `PairMachineAnswer.session` onto ~/.capy through the
 * SAME session-file writer every other login path uses
 * (`FileSessionStorageBackend.save` -> `globalConfig.saveAuthSession`), then
 * resolve which org is active.
 *
 * Org selection deliberately mirrors `core/orgContext.ts`'s
 * `resolveOrgContext` semantics — exactly-one-org auto-selects, zero orgs is
 * a valid resting state (the same shape a genuine Wave-B zero-org session
 * already produces), many orgs prompts — rather than inventing a different
 * picker. One deliberate deviation: the multi-org prompt here gates on
 * `isInteractive()` first. `resolveOrgContext` prompts unconditionally,
 * which is fine for the commands that use it (an already-signed-in
 * developer's terminal); `capy pair`'s whole reason to exist is a
 * non-interactive/headless/agent-adjacent session, where an unconditional
 * `inquirer.prompt` would hang a scripted `capy pair --json` invocation
 * forever instead of returning a usable, org-less result.
 */
import inquirer from 'inquirer';
import { SessionStore } from '../../types/index';
import { FileSessionStorageBackend } from '../session/fileBackend';
import { AuthService } from '../authService';
import { isInteractive } from '../../ui/interactive';
import type { PairMachineAnswerSession } from './pairContract';
import { assertRuntimePairingUser } from './runtimePairing';

/** Pure: builds the on-disk `SessionStore` shape from the sealed payload's
 *  session half. No I/O — exported for direct unit testing. */
export function buildSessionStoreFromAnswer(session: PairMachineAnswerSession): SessionStore {
  const sessions: SessionStore['sessions'] = Object.fromEntries(
    Object.entries(session.sessions ?? {}).map(([orgId, orgSession]) => [
      orgId,
      { access_token: orgSession.access_token, expires_at: orgSession.expires_at },
    ]),
  );
  return {
    version: 2,
    user_id: session.user.id,
    user_email: session.user.email,
    user_first_name: typeof session.user.first_name === 'string' ? session.user.first_name : null,
    user_last_name: typeof session.user.last_name === 'string' ? session.user.last_name : null,
    refresh_token: session.refresh_token,
    organizations: session.organizations.map((org) => ({
      id: org.id,
      // The payload's Organization shape only guarantees {id, name} — a
      // missing workos_org_id falls back to our own id. This only affects
      // SessionLifecycle.validateTokenOrg's cross-check of a cached access
      // token's org_id JWT claim; a fallback that doesn't match a real claim
      // fails CLOSED into a refresh (see installPairedSession below), never
      // an incorrectly-trusted token.
      workos_org_id: typeof org.workos_org_id === 'string' ? org.workos_org_id : org.id,
      name: org.name,
    })),
    sessions,
  };
}

export interface InstallPairedSessionResult {
  orgId: string | null;
  orgName?: string;
  /** True when we hold a usable, unexpired access token for `orgId` — either
   *  supplied directly in the payload, or freshly refreshed. */
  orgTokenReady: boolean;
}

export interface InstallPairedSessionOptions {
  apiUrl?: string;
  devMode?: boolean;
  /** Overridable for tests; defaults to a real interactive list prompt. */
  selectOrg?: (orgs: SessionStore['organizations']) => Promise<string | null>;
}

async function defaultSelectOrg(orgs: SessionStore['organizations']): Promise<string | null> {
  if (!isInteractive()) return null;
  const { chosen } = await inquirer.prompt([
    {
      type: 'list',
      name: 'chosen',
      message: 'Select organization for this machine:',
      choices: orgs.map((o) => ({ name: o.name, value: o.id })),
    },
  ]);
  return chosen;
}

/**
 * Write the paired session to ~/.capy through the one existing session-file
 * writer, then resolve/ensure an active org. Returns even on a failed
 * refresh — the session is on disk and org-selected either way; the next
 * command that needs a token retries the refresh itself (same recovery path
 * every other command already has for a stale/missing token).
 */
export async function installPairedSession(
  answerSession: PairMachineAnswerSession,
  opts: InstallPairedSessionOptions = {},
): Promise<InstallPairedSessionResult> {
  // The identity check happens before the session writer. A failed attempt to
  // pair another account therefore cannot leave a second discoverable session
  // inside this environment home.
  assertRuntimePairingUser(answerSession.user.id);
  const session = buildSessionStoreFromAnswer(answerSession);

  // The one write site: FileSessionStorageBackend.save -> saveAuthSession.
  new FileSessionStorageBackend().save(session, session.user_id);

  const orgs = session.organizations;
  const orgId = orgs.length === 1
    ? orgs[0].id
    : orgs.length > 1
      ? await (opts.selectOrg ?? defaultSelectOrg)(orgs)
      : null;

  if (!orgId) {
    return { orgId: null, orgTokenReady: false };
  }

  const orgName = orgs.find((o) => o.id === orgId)?.name;
  const cached = session.sessions[orgId];
  if (cached && cached.expires_at > Date.now()) {
    return { orgId, orgName, orgTokenReady: true };
  }

  // No usable cached token for the selected org — fall through to the same
  // silent-refresh path every other post-auth command uses, reading back the
  // session we just wrote (AuthService's constructor loads it via the
  // matching sessionUserId).
  const authService = new AuthService(opts.apiUrl, opts.devMode ?? false, session.user_id);
  const result = await authService.authenticateSilent(orgId);
  return { orgId, orgName, orgTokenReady: result.success };
}

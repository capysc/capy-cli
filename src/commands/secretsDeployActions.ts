// What the `capy secrets` TUI's deploy flow (CAP-704) does outside the screen: the effects
// `ui/secretsDeployFlow.ts` asks for. Both are the engine `capy secrets deploy` uses
// (deploy/batchDeploy.ts), so the two cannot drift. Neither ever rejects: a failure comes
// back as a code.
//
// CONFLICTS (CAP-714): on a platform whose live values can be read (Dokploy), `run` first reads every
// target and compares it with what Capy last delivered. A variable someone changed on the service
// outside Capy comes back as a conflict, with nothing written; the screen asks mine or theirs for
// each and runs again with the decisions. A decision is used only where the live value is still the
// one it was made against, otherwise the conflict comes back. Mine delivers Capy's value; theirs
// leaves the service's value and records nothing for it.
//
// DRY RUN (`capy --dry-run secrets`): `loadPlan` only READS (GitHub's default branch and each
// project's deploy.json). `run` is never reached by the screen, and if it ever were it
// refuses with `DRY_RUN_UNSUPPORTED` instead of running: a dry run never runs for real.

import type { OrgRepoLink, SecretIndexRow, ServiceClient } from '../service/serviceClient';
import type { SecretsDeployActions } from '../ui/secretsScreenDriver';
import { BatchEnv, createBatchEnv, deployLocationsOf, planBatchDeploy, runBatchDeploy } from '../deploy/batchDeploy';
import {
  conflictRefusalFor,
  isConflictRefusal,
  resolveKeyOf,
  type ConflictScope,
  type Resolutions,
  type SeenResolutions,
  type TargetConflict,
} from '../sync/conflicts';
import { CapyError, ERROR_CODES } from '../types/index';

const codeOf = (err: unknown): string => (err instanceof CapyError ? err.code : ERROR_CODES.SERVICE_ERROR);

type CancelPhase = Parameters<SecretsDeployActions['cancel']>[0];

/**
 * The decider of a run (the batch engine's `decide`): given the conflicts its comparison pass found, the decisions that
 * were made for exactly these (each against the live value and the delivered value it holds now), or a
 * `ConflictRefusal` (nothing has been written) listing them. Pure.
 */
export function decideFrom(decisions: SeenResolutions | undefined): (scopes: readonly ConflictScope[]) => Resolutions {
  return (scopes) => {
    const found = scopes.flatMap((s) => s.conflicts);
    const holds = (c: (typeof found)[number]): boolean => {
      const d = decisions?.[resolveKeyOf(c)];
      return d !== undefined && d.theirs === c.theirs && d.yours === c.yours;
    };
    if (found.some((c) => !holds(c))) throw conflictRefusalFor(ERROR_CODES.SECRETS_CONFLICT, scopes);
    return Object.fromEntries(found.map((c) => [resolveKeyOf(c), (decisions as SeenResolutions)[resolveKeyOf(c)].choice]));
  };
}

/** The target conflicts of a refusal, in the order it carries them. */
const targetConflictsOf = (conflicts: readonly { readonly kind: string }[]): readonly TargetConflict[] =>
  conflicts.filter((c): c is TargetConflict => c.kind === 'target');

/**
 * The deploy flow's side effects. `cancel(phase)` aborts what is in flight for that phase. The
 * signals are made fresh for each operation and listen on one `EventTarget`, so a cancel
 * reaches exactly the operations running now.
 */
export function createDeployActionsWith(
  client: Pick<ServiceClient, 'getOrgRepos'>,
  orgId: string,
  env: BatchEnv,
  dryRun: boolean = false,
): SecretsDeployActions {
  const control = new EventTarget();
  const begin = (phase: CancelPhase): AbortSignal => {
    const controller = new AbortController();
    control.addEventListener(phase, () => controller.abort(), { once: true });
    return controller.signal;
  };
  const linksOf = async (): Promise<readonly OrgRepoLink[]> => {
    try {
      return (await client.getOrgRepos(orgId)).repos;
    } catch (err) {
      // A service that predates repo links has none to give: the plan then says there is nothing to deploy.
      if (err instanceof CapyError && err.code === ERROR_CODES.REPO_LINKS_UNSUPPORTED) return [];
      throw err;
    }
  };
  return {
    loadPlan: async (row: SecretIndexRow) => {
      try {
        const plan = await planBatchDeploy(
          env.github(),
          { names: [row.name], locations: deployLocationsOf(row) },
          await linksOf(),
          begin('planning'),
        );
        return { ok: true, plan };
      } catch (err) {
        return { ok: false, code: codeOf(err) };
      }
    },
    run: async (plan, onProgress, decisions) => {
      if (dryRun) return { ok: false, code: ERROR_CODES.DRY_RUN_UNSUPPORTED };
      try {
        const stopPushes = begin('pushing');
        // Only a platform whose live values can be read has anything to compare. A stop asked for during the comparison decides nothing.
        const decide = env.adapter.readsLiveValues === true ? (scopes: readonly ConflictScope[]) => (stopPushes.aborted ? {} : decideFrom(decisions)(scopes)) : undefined;
        return { ok: true, result: await runBatchDeploy(plan, env, { onProgress, stopPushes, stopPrs: begin('prs'), decide }) };
      } catch (err) {
        // Nothing has been written: the comparison found conflicts that are undecided, or decided against a value that has moved.
        if (isConflictRefusal(err)) return { ok: false, code: err.code, conflicts: targetConflictsOf(err.payload.conflicts) };
        return { ok: false, code: codeOf(err) };
      }
    },
    cancel: (phase) => {
      // The comparison pass stops with the pushes.
      control.dispatchEvent(new Event(phase === 'checking' ? 'pushing' : phase));
    },
  };
}

/** The real actions for a signed-in session. */
export function createDeployActions(
  orgId: string,
  userId: string,
  client: ServiceClient,
  dryRun: boolean = false,
  devMode: boolean = false,
): SecretsDeployActions {
  return createDeployActionsWith(client, orgId, createBatchEnv(orgId, userId, client, devMode), dryRun);
}

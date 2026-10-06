// What the `capy secrets` TUI's deploy flow (CAP-704) does outside the screen: the effects
// `ui/secretsDeployFlow.ts` asks for. Both are the engine `capy secrets deploy` uses
// (deploy/batchDeploy.ts), so the two cannot drift. Neither ever rejects: a failure comes
// back as a code.
//
// DRY RUN (`capy --dry-run secrets`): `loadPlan` only READS (GitHub's default branch and each
// project's deploy.json). `run` is never reached by the screen, and if it ever were it
// refuses with `DRY_RUN_UNSUPPORTED` instead of running: a dry run never runs for real.

import type { OrgRepoLink, SecretIndexRow, ServiceClient } from '../service/serviceClient';
import type { SecretsDeployActions } from '../ui/secretsScreenDriver';
import { BatchEnv, createBatchEnv, deployLocationsOf, planBatchDeploy, runBatchDeploy } from '../deploy/batchDeploy';
import { CapyError, ERROR_CODES } from '../types/index';

const codeOf = (err: unknown): string => (err instanceof CapyError ? err.code : ERROR_CODES.SERVICE_ERROR);

type CancelPhase = Parameters<SecretsDeployActions['cancel']>[0];

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
    run: async (plan, onProgress) => {
      if (dryRun) return { ok: false, code: ERROR_CODES.DRY_RUN_UNSUPPORTED };
      try {
        return { ok: true, result: await runBatchDeploy(plan, env, { onProgress, stopPushes: begin('pushing'), stopPrs: begin('prs') }) };
      } catch (err) {
        return { ok: false, code: codeOf(err) };
      }
    },
    cancel: (phase) => {
      control.dispatchEvent(new Event(phase));
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

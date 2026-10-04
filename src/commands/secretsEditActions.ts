// What the `capy secrets` TUI's edit flow (CAP-698) does outside the screen: the
// two effects `ui/secretsEditFlow.ts` asks for. Both are the same engine
// `capy secrets set` uses (commands/secretsSet.ts, and for a dry run the very
// planner `capy secrets set --dry-run` uses), so the two cannot drift.
// Neither ever rejects: a failure comes back as a code.
//
// DRY RUN (`capy --dry-run secrets`): `run` never calls `runSecretSet`. It READS
// (the branches, GitHub's default branch and keep.lock) to say what would
// happen, and writes nothing: no push, no cache, no GitHub write.

import type { ServiceClient } from '../service/serviceClient';
import type { SecretsEditActions } from '../ui/secretsScreenDriver';
import { RunProgress, SetEnv, createSetEnv, repoLabel, resolveBases, runSecretSet } from './secretsSet';
import { describePlanBody, type SetPlanBody } from './secretsSetCommand';
import type { DryRunView } from './secretsSetText';
import { CapyError, ERROR_CODES } from '../types/index';

const codeOf = (err: unknown): string => (err instanceof CapyError ? err.code : ERROR_CODES.SERVICE_ERROR);

type RunRequest = Parameters<SecretsEditActions['run']>[0];

/** The plan as the screen shows it: unchanged locations are not counted, and only repos with a changing location get a PR line. */
export function dryRunView(body: SetPlanBody, request: RunRequest): DryRunView {
  const changing = body.locations.filter((l) => l.action === 'update');
  const prs = body.prs.filter((p) => {
    const target = request.repos.find((t) => repoLabel(t) === p.repo);
    return target?.files.some((f) => changing.some((l) => l.project === f.project_name)) === true;
  });
  return {
    name: body.name,
    updateCount: changing.length,
    prs: prs.map((p) => ({ repo: p.repo, base: p.base, diverged: p.keep_lock_diverged })),
    ...(request.reposUnavailable === undefined ? {} : { reposUnavailable: request.reposUnavailable }),
  };
}

async function planOnly(env: SetEnv, request: RunRequest): Promise<DryRunView> {
  const bases = request.bases ?? (await resolveBases(request.repos.length > 0 ? env.github() : undefined, request.repos));
  const body = await describePlanBody(
    { name: request.name, located: request.locations, targets: request.repos, notLinked: [], bases },
    env,
    request.value,
  );
  return dryRunView(body, request);
}

type CancelPhase = Parameters<SecretsEditActions['cancel']>[0];

/**
 * The edit flow's side effects. `cancel(phase)` aborts what is in flight for that
 * phase. The signals are made fresh for each operation and listen on one
 * `EventTarget`, so a cancel reaches exactly the operations running now.
 */
export function createEditActionsWith(
  client: Pick<ServiceClient, 'getOrgRepos'>,
  orgId: string,
  env: SetEnv,
  dryRun: boolean = false,
): SecretsEditActions {
  const control = new EventTarget();
  const begin = (phase: CancelPhase): AbortSignal => {
    const controller = new AbortController();
    control.addEventListener(phase, () => controller.abort(), { once: true });
    return controller.signal;
  };
  return {
    // Links only, so the table can be drawn at once. The default branches (BASE) are `loadBases`, next.
    loadRepos: async () => {
      try {
        return { ok: true, links: (await client.getOrgRepos(orgId)).repos };
      } catch (err) {
        return { ok: false, code: codeOf(err) };
      }
    },
    loadBases: async (targets) => {
      try {
        return await resolveBases(env.github(), targets, begin('planning'));
      } catch {
        return {};
      }
    },
    run: async (request, onProgress?: (progress: RunProgress) => void) => {
      try {
        return dryRun
          ? { ok: true, plan: await planOnly(env, request) }
          : { ok: true, result: await runSecretSet(request, env, { onProgress, stopPushes: begin('pushing'), stopPrs: begin('prs') }) };
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
export function createEditActions(orgId: string, userId: string, client: ServiceClient, dryRun: boolean = false): SecretsEditActions {
  return createEditActionsWith(client, orgId, createSetEnv(orgId, userId, client), dryRun);
}

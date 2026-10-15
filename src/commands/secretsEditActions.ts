// What the `capy secrets` TUI's edit flow (CAP-698) does outside the screen: the
// two effects `ui/secretsEditFlow.ts` asks for. Both are the same engine
// `capy secrets set` uses (commands/secretsSet.ts, and for a dry run the very
// planner `capy secrets set --dry-run` uses), so the two cannot drift.
// Neither ever rejects: a failure comes back as a code.
//
// DRY RUN (`capy --dry-run secrets`): `run` never calls `runSecretSet`. It READS
// (the branches, GitHub's default branch and keep.lock) to say what would
// happen, and writes nothing: no push, no cache, no GitHub write.
//
// CONFLICTS (CAP-714): before any push, `run` reads every location. One whose value is neither
// the new value nor the one the row listed was changed by someone else since the person looked:
// `run` returns those as conflicts and writes nothing. The screen asks mine or theirs for each and
// runs again with the decisions; a decision holds only for the fingerprints it was made against,
// so a location that moved again comes back as a conflict. Mine writes the location bound to the
// value seen (`allowed`); theirs skips it.

import type { ServiceClient } from '../service/serviceClient';
import type { SecretsEditActions } from '../ui/secretsScreenDriver';
import {
  LocationConflict,
  LocationPreview,
  RunProgress,
  SetEnv,
  SetLocation,
  createSetEnv,
  locationKeyOf,
  previewLocations,
  repoLabel,
  resolveBases,
  runSecretSet,
  secretLocationConflict,
} from './secretsSet';
import { hashValue } from '../deploy/keepGate';
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

/** What the locations that were read allow: the run goes on with these, or it stops for decisions. */
export type SettledLocations =
  | {
      readonly kind: 'ready';
      readonly locations: readonly SetLocation[];
      /** The fingerprints a location may hold for its push to go on: what was seen and decided against. Absent: not compared. */
      readonly allowed?: (location: SetLocation) => readonly string[];
    }
  | { readonly kind: 'conflicts'; readonly conflicts: readonly LocationConflict[] };

/**
 * Pure. `reads` are the previews of `request.locations`, in order. A location holding neither the new value nor the one
 * the row listed is a conflict. All decided, each against the fingerprints it holds now: the locations to push (theirs
 * is skipped) and the binding for the push. Any undecided, or decided against a value that has moved since: the
 * conflicts, and nothing is pushed.
 */
export function settleLocations(request: RunRequest, reads: readonly LocationPreview[]): SettledLocations {
  const seen = request.seen;
  if (seen === undefined) return { kind: 'ready', locations: request.locations };
  const yours = hashValue(request.value);
  const conflicts = request.locations.flatMap((location, i): LocationConflict[] => {
    const conflict = secretLocationConflict(request.name, yours, seen, location, reads[i]);
    return conflict === undefined ? [] : [{ location, conflict }];
  });
  const decisionFor = (c: LocationConflict) => request.decisions?.[locationKeyOf(c.location)];
  const holds = (c: LocationConflict): boolean => {
    const d = decisionFor(c);
    return d !== undefined && d.theirs === c.conflict.theirs && d.yours === c.conflict.yours;
  };
  if (conflicts.some((c) => !holds(c))) return { kind: 'conflicts', conflicts };
  const kept = new Set(conflicts.filter((c) => decisionFor(c)?.choice === 'theirs').map((c) => locationKeyOf(c.location)));
  return {
    kind: 'ready',
    locations: request.locations.filter((l) => !kept.has(locationKeyOf(l))),
    allowed: (loc) => {
      const at = request.locations.findIndex((l) => locationKeyOf(l) === locationKeyOf(loc));
      return [yours, seen, reads[at]?.current?.hash ?? ''];
    },
  };
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
        if (dryRun) return { ok: true, plan: await planOnly(env, request) };
        // Made first: a stop asked for while the locations are being read must still reach the pushes.
        const stopPushes = begin('pushing');
        const stopPrs = begin('prs');
        // One unlock for the reading and the pushing.
        const keys = request.seen === undefined || request.locations.length === 0 ? undefined : env.openKeys();
        const reads = keys === undefined ? [] : await previewLocations(env, request.locations, request.name, request.value, keys);
        const settled: SettledLocations = stopPushes.aborted ? { kind: 'ready', locations: request.locations } : settleLocations(request, reads);
        if (settled.kind === 'conflicts') return { ok: false, code: ERROR_CODES.SECRETS_CONFLICT, conflicts: settled.conflicts };
        const result = await runSecretSet({ ...request, locations: settled.locations, allowed: settled.allowed, keys }, env, { onProgress, stopPushes, stopPrs });
        return { ok: true, result };
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

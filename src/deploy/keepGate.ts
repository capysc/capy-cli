/**
 * CI-deploy change-gate.
 *
 * The PR gate must answer ONE question: "does this deploy change what's recorded
 * on the target branch?" — and it must key off the SAME data the deploy pushes
 * (the decrypted `.env` values), NOT the local `keep.lock` file. Those two can
 * drift (an edit lands in `.env`/server while the local keep.lock lags), and the
 * old gate diffed the stale file, so a real secret change skipped the PR.
 *
 * Here we fold the current decrypted values into the BASE branch's keep.lock and
 * compare canonical serializations. The result is also exactly the keep.lock we
 * commit for the PR, so the gate and the committed artifact can never disagree.
 */
import { createHash } from 'crypto';
import { serializeKeep } from '../files/fileManager';
import { deriveResourceId } from '../crypto/resourceId';
import { KeepFile } from '../types/index';
import { TargetDeliveryDescriptor, isDeliveryDescriptor, upsertTargetElement } from './targetsGate';

/** keep.lock records this 16-hex-char hash per (var, branch) — never the value. */
export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export interface DeployKeep {
  /** Canonical keep.lock to commit for the deploy PR. */
  content: string;
  /** True iff it differs from the base branch — i.e. a PR is warranted. */
  changed: boolean;
}

type Entry = { resource_id: string; branch?: string; value_hash: string; [k: string]: unknown };

function entryFor(entries: readonly Entry[], branch: string): Entry | undefined {
  return entries.find((e) => (e.branch ?? '') === branch);
}

/**
 * Fold the current decrypted values for `vars` (on the Capy `branch`) into a
 * clone of `baseKeep`, then report whether anything actually changed.
 *
 * SETS NO `changed_at`. That field is the service's to assign — it derives the
 * value by diffing against stored state and discards whatever a client sends.
 * The deploy path writes keep.lock straight into a git worktree and never goes
 * through the service, so stamping here minted timestamps nothing had
 * authority over, and they collided with server-assigned ones on merge. A new
 * entry is written without the field; the next push through the service fills
 * it in.
 *
 * `delivery` (CAP-679, optional): when the caller is folding in a `capy
 * deploy` target's delivery (CI mode — see `deployCommand.ts`), every var in
 * `vars` that has a value also gets its `targets` element for
 * (`delivery.provider`, `delivery.target`) replaced, keyed to that var's own
 * freshly-computed hash. Guarded with `isDeliveryDescriptor` rather than a
 * bare truthiness check so a malformed or stray 5th argument (this parameter
 * used to sit where an ad-hoc `changedAt` override was passed in some older
 * call sites) is silently ignored instead of corrupting `targets`.
 */
export function buildDeployKeep(
  baseKeep: KeepFile,
  envValues: Record<string, string>,
  vars: string[],
  branch: string,
  delivery?: TargetDeliveryDescriptor,
  deliveredAt: string = new Date().toISOString(),
): DeployKeep {
  const validDelivery = isDeliveryDescriptor(delivery) ? delivery : undefined;

  const nextVariables = vars.reduce<Record<string, Entry[]>>((acc, name) => {
    const value = envValues[name];
    if (value === undefined) return acc; // missing var — var-set reconcile handles it
    const hash = hashValue(value);
    const existingEntries = acc[name] ?? (baseKeep.variables[name] as Entry[] | undefined) ?? [];
    const entry = entryFor(existingEntries, branch);
    const withHash: Entry = entry
      ? { ...entry, value_hash: hash }
      : { resource_id: deriveResourceId(branch, name), branch, value_hash: hash };
    const updatedEntry: Entry = validDelivery
      ? {
          ...withHash,
          targets: upsertTargetElement(
            withHash.targets as any,
            validDelivery,
            hash,
            deliveredAt,
          ),
        }
      : withHash;
    const nextEntries = entry
      ? existingEntries.map((e) => (e === entry ? updatedEntry : e))
      : [...existingEntries, updatedEntry];
    return { ...acc, [name]: nextEntries };
  }, { ...baseKeep.variables } as Record<string, Entry[]>);

  const keep: KeepFile = { ...baseKeep, variables: nextVariables };
  const content = serializeKeep(keep);
  return { content, changed: content !== serializeKeep(baseKeep) };
}

/**
 * `--force`: produce a keep.lock that differs from the base even when no value
 * changed, so a redeploy can re-trigger CI.
 *
 * IT BUMPS A DEPLOY COUNTER, NOT `changed_at`. Bumping `changed_at` was the
 * obvious trick and it was a lie: the field means "when this value last
 * changed", and on a forced redeploy no value changed. Everything downstream
 * inherited it — the UPDATED column, relative-time copy, and every keep.lock
 * merge, where a deploy-stamped timestamp met a server-stamped one over an
 * identical `value_hash` and conflicted for no reason.
 *
 * `deploy_revision` says the true thing instead: this lockfile has been
 * deployed N times. A top-level field is safe here — `computeKeepHash` covers
 * only `key:resource_id:value_hash` per variable, so this cannot perturb
 * client/server hash agreement, and the service preserves unknown file-level
 * fields through its `changed_at` rewrite.
 */
export function touchDeployKeep(baseKeep: KeepFile, _vars: string[], _branch: string): string {
  const keep = JSON.parse(JSON.stringify(baseKeep)) as KeepFile & { deploy_revision?: unknown };
  const current = typeof keep.deploy_revision === 'number' ? keep.deploy_revision : 0;
  return serializeKeep({ ...keep, deploy_revision: current + 1 } as KeepFile);
}

/**
 * Var-set reconcile: the saved target.vars can go stale when
 * the project's variables change. We need the var set KNOWN at selection time
 * (`known`) to tell a genuinely new var apart from one the user intentionally
 * left unselected:
 *   - `added`   = vars present now that didn't exist when the selection was made
 *                 (would be silently dropped from the deploy).
 *   - `removed` = selected vars that no longer exist in the project.
 */
export function reconcileVars(
  selected: string[],
  known: string[],
  current: string[],
): { added: string[]; removed: string[]; drifted: boolean } {
  const cur = new Set(current);
  const kn = new Set(known);
  const added = current.filter((v) => !kn.has(v));
  const removed = selected.filter((v) => !cur.has(v));
  return { added, removed, drifted: added.length > 0 || removed.length > 0 };
}

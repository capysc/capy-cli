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
import { KeepFile, KeepVariableEntry } from '../types/index';
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
 * One `capy edit` session save: the Capy branch being edited, and the
 * resulting keep.lock entry for each variable the save touched — `null`
 * when the save left that variable with no entry for this branch at all
 * (a deletion).
 *
 * Captured immutably per save so the exit-time PR flow
 * (commands/keepLockPr.ts) can replay every save, in order, onto whatever
 * keep.lock the chosen target git branch actually has — which can differ
 * from what this edit session saw, since other pushes may have landed on
 * other branches while the session was open.
 */
export interface EditSaveRecord {
  readonly branch: string;
  readonly entries: ReadonlyArray<{ readonly variable: string; readonly entry: KeepVariableEntry | null }>;
}

/**
 * What should land in the folded keep for one (variable, branch): a `null`
 * `saveEntry` is a deletion — drop any existing entry outright, regardless
 * of hashes. Otherwise, mirror `buildDeployKeep`'s `entry.value_hash !==
 * hash` check: the target (git) already has an entry with the SAME
 * value_hash → the value hasn't actually changed from git's perspective, so
 * keep the target's entry EXACTLY as it is — every field, including an
 * absent `changed_at` — rather than let an unrelated save move its date.
 * Different hash (or no existing entry at all) → use the save's entry,
 * which already carries the real server-assigned `changed_at` from the push
 * that produced it.
 */
function resolveEntryForFold(
  existingEntry: KeepVariableEntry | undefined,
  saveEntry: KeepVariableEntry | null,
): KeepVariableEntry | undefined {
  if (saveEntry === null) return undefined;
  if (existingEntry && existingEntry.value_hash === saveEntry.value_hash) return existingEntry;
  return saveEntry;
}

/**
 * Fold one recorded edit-session save into `keep`: resolve the
 * (variable, branch) entry per `resolveEntryForFold` above, drop a variable
 * whose entry list becomes empty as a result, and leave every other entry —
 * same variable/other branch, or any other variable — untouched. A save
 * whose every touched variable already matches the target's value_hash
 * resolves to exactly the target's own entries, so it serializes identically
 * to `keep` — the caller's no-diff check (keepLockPr.ts) skips committing it.
 */
export function foldEditSaveIntoKeep(keep: KeepFile, record: EditSaveRecord): KeepFile {
  const variables = record.entries.reduce<Record<string, KeepVariableEntry[]>>(
    (vars, { variable, entry }) => {
      const existing = vars[variable] ?? [];
      const withoutBranch = existing.filter((e) => e.branch !== record.branch);
      const existingEntry = existing.find((e) => e.branch === record.branch);
      const resolvedEntry = resolveEntryForFold(existingEntry, entry);
      const nextEntries = resolvedEntry ? [...withoutBranch, resolvedEntry] : withoutBranch;
      if (nextEntries.length === 0) {
        const { [variable]: _dropped, ...rest } = vars;
        return rest;
      }
      return { ...vars, [variable]: nextEntries };
    },
    keep.variables,
  );
  return { ...keep, variables };
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

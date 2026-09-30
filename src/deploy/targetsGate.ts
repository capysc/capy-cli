/**
 * Pure keep.lock `targets` helpers (CAP-679).
 *
 * `targets` is the OUTBOUND half of "integrations" — the record of what
 * `capy deploy` actually delivered to a platform, as opposed to `connector`
 * (inbound: what a `capy connect` import brought in). See
 * `types/index.ts#TargetDelivery` for the on-disk shape and the
 * one-per-(provider,target) rule.
 *
 * Every function here is pure: it takes a `KeepFile` and returns a new one,
 * never mutating its input. Callers (`deployCommand.ts`, `keepGate.ts`,
 * `rotateCommand.ts`) own reading the file, pushing it, and writing it back.
 */
import { ERROR_CODES, KeepFile, KeepVariableEntry, TargetDelivery } from '../types/index';

/**
 * Whether it is safe to push a keep.lock write for `targetBranch` given the
 * ACTUAL active branch `.env` is on. Pure — no filesystem/network — so every
 * caller that needs this guard (`pushKeepTransform`'s deploy-target writes,
 * `deploy revoke`'s keep.lock strip) shares one rule instead of each
 * re-deriving it.
 *
 * `null` means safe to proceed. A non-null result is always a refusal: a
 * write keyed to the wrong branch's `.env` would push that branch's secrets
 * mislabeled as `targetBranch`'s — see CAP-679's branch-check note.
 */
export interface BranchProblem {
  code: typeof ERROR_CODES.DEPLOY_BRANCH_MISMATCH | typeof ERROR_CODES.DEPLOY_BRANCH_UNKNOWN;
  activeBranch: string | null;
  targetBranch: string;
}

export function branchPushProblem(activeBranch: string | null, targetBranch: string): BranchProblem | null {
  if (!activeBranch) return { code: ERROR_CODES.DEPLOY_BRANCH_UNKNOWN, activeBranch: null, targetBranch };
  if (activeBranch !== targetBranch) {
    return { code: ERROR_CODES.DEPLOY_BRANCH_MISMATCH, activeBranch, targetBranch };
  }
  return null;
}

export function describeBranchProblem(p: BranchProblem): string {
  return p.code === ERROR_CODES.DEPLOY_BRANCH_UNKNOWN
    ? `[${p.code}] the active branch could not be determined; refusing to push keep.lock for "${p.targetBranch}" against an unknown .env branch.`
    : `[${p.code}] the active branch (${p.activeBranch}) does not match "${p.targetBranch}"; refusing to push .env's values under the wrong branch.`;
}

/** What one delivery looked like, before it's turned into a `TargetDelivery` per var. */
export interface TargetDeliveryDescriptor {
  /** Adapter id — e.g. 'dokploy'. */
  provider: string;
  /** `.capy/deploy.json` target name. */
  target: string;
  ref?: Record<string, string>;
  /** Token deploys only. */
  deployId?: string;
  /**
   * `false` for a `capy deploy --no-deploy` write — see `TargetDelivery.deployed`'s
   * own doc. Omitted (the default) means a real deploy: the element written
   * OMITS the field, which is what "deployed" means for every element,
   * including every one written before this existed.
   */
  deployed?: boolean;
}

/** Narrows `unknown` to a well-formed descriptor — guards against a caller (or a stray
 * positional argument in an older call site) passing something else. */
export function isDeliveryDescriptor(v: unknown): v is TargetDeliveryDescriptor {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { provider?: unknown }).provider === 'string' &&
    typeof (v as { target?: unknown }).target === 'string'
  );
}

type EntryWithTargets = KeepVariableEntry & { targets?: ReadonlyArray<TargetDelivery> };

/**
 * Replace-not-append: drop any existing element for this (provider, target),
 * then add the fresh one. At most one element per (provider, target) — never
 * a second entry for the same pair.
 *
 * NO-OP when the existing element for this (provider, target) already
 * carries the SAME `deployed_value_hash`, the SAME `deploy_id` (including
 * "neither has one"), and the SAME `deployed` pending-ness — returns
 * `existing` UNCHANGED (same array reference), rather than replacing it with
 * a fresh `deployed_at`. This is what makes a truly-nothing-changed redeploy
 * produce an unchanged keep.lock: `buildDeployKeep`'s CI change-gate (and
 * `recordTargetDeliveries`'s direct-mode write) both key their own "did
 * anything change" off comparing serialized keep.lock text.
 *
 * NOT a no-op when only `deploy_id` differs, even with an identical value —
 * "no untracked tokens" (CAP-679 follow-up): a same-value redeploy still
 * mints a FRESH live token, and silently keeping the old `deploy_id` here
 * (the original bug this replaced) would leave that fresh token installed on
 * the platform but recorded nowhere, so `capy deploy targets-remove` could
 * never revoke it. Instead, the OLD `deploy_id` (when there was one) is
 * carried forward into `superseded_deploy_ids` — merged with any it already
 * had, deduped, and never including the id that's current either before or
 * after this call. Nothing here revokes anything: a superseded id is a
 * "maybe still needed" fact, not an action. It is safe to sit there
 * indefinitely — `deploy targets-remove` revokes every id it finds (current
 * + superseded, see `allDeployIdsForTarget`-style callers), and
 * `deployCommand.ts`'s own post-deploy step revokes (and then clears) a
 * target's superseded ids ONLY after a REAL deploy to that same target has
 * just succeeded — never for a `--no-deploy` write (`delivery.deployed ===
 * false`, which still supersedes here exactly the same way, just isn't
 * revoked by that follow-up) and never for a failed deploy (this function is
 * never even called in that case — see `deployCommand.ts`'s call sites).
 */
export function upsertTargetElement(
  existing: ReadonlyArray<TargetDelivery> | undefined,
  delivery: TargetDeliveryDescriptor,
  deployedValueHash: string,
  deployedAt: string,
): ReadonlyArray<TargetDelivery> {
  const list = existing ?? [];
  const match = list.find((t) => t.provider === delivery.provider && t.target === delivery.target);

  const deployIdUnchanged = (match?.deploy_id ?? undefined) === (delivery.deployId ?? undefined);
  const pendingUnchanged = (match?.deployed ?? true) === (delivery.deployed ?? true);
  if (match && match.deployed_value_hash === deployedValueHash && deployIdUnchanged && pendingUnchanged) {
    return list;
  }

  const priorSuperseded = match?.superseded_deploy_ids ?? [];
  const newlySuperseded = match?.deploy_id && !deployIdUnchanged ? [match.deploy_id] : [];
  const supersededIds = Array.from(new Set([...priorSuperseded, ...newlySuperseded])).filter(
    (id) => id !== delivery.deployId,
  );

  const filtered = list.filter((t) => !(t.provider === delivery.provider && t.target === delivery.target));
  const element: TargetDelivery = {
    provider: delivery.provider,
    target: delivery.target,
    ...(delivery.ref ? { ref: delivery.ref } : {}),
    deployed_value_hash: deployedValueHash,
    deployed_at: deployedAt,
    ...(delivery.deployId ? { deploy_id: delivery.deployId } : {}),
    ...(delivery.deployed === false ? { deployed: false } : {}),
    ...(supersededIds.length > 0 ? { superseded_deploy_ids: supersededIds } : {}),
  };
  return [...filtered, element];
}

export interface VarDelivery {
  name: string;
  valueHash: string;
}

/**
 * Whether delivering `values` to (provider, target) on `branch` would be a
 * REAL change worth gating a CI deploy on — a value hash differing from
 * what's on `keep`, a var not tracked there at all yet, this (provider,
 * target) never having delivered before, or its recorded pending-ness
 * (`deployed`) differing from what THIS delivery would set. Deliberately
 * NEVER `deploy_id` — a fresh token alone must never itself reopen a PR
 * (see `upsertTargetElement`'s "no untracked tokens" doc: a fresh token is
 * tracked via `superseded_deploy_ids`, and revoked once a REAL deploy
 * confirms the new one landed — neither of which requires a PR when the
 * secret value itself is unchanged).
 *
 * Used BEFORE any token is minted — `deployCommand.ts`'s CI change-gate
 * calls this first, off a plain decrypt, so an unchanged run never mints,
 * never writes to the platform, and never opens a PR.
 */
export function deliveryWorthGating(
  keep: KeepFile,
  branch: string,
  provider: string,
  target: string,
  deployed: boolean | undefined,
  values: ReadonlyArray<VarDelivery>,
): boolean {
  return values.some(({ name, valueHash }) => {
    // NOTE (pre-existing behavior, unrelated to the checks below): a var
    // REMOVED from `target.vars`/`.env` entirely never gates here — `values`
    // only ever contains vars the CALLER is currently delivering, so a var
    // that dropped out of the selection (or vanished from `.env`) never
    // appears in `values` at all and can't trigger a "something changed"
    // decision through this function. Detecting that kind of drift is
    // `reconcileVars`'s job, not this gate's.
    const entries = keep.variables[name] ?? [];
    const entry = entries.find((e) => (e.branch ?? '') === branch);
    if (!entry) return true; // not tracked on this branch yet — a real fact to record
    if (entry.value_hash !== valueHash) return true;
    const match = ((entry as EntryWithTargets).targets ?? []).find(
      (t) => t.provider === provider && t.target === target,
    );
    if (!match) return true; // first-ever delivery to this target
    // The target itself is STALE — it delivered a DIFFERENT value than
    // what's live now (the secretsScreen `*` marker), even though the
    // CURRENT synced value hasn't moved since. Redelivering it is a real
    // change worth a PR, same as any other value_hash mismatch above —
    // `deploy_id` still never enters this decision, so a same-value,
    // already-up-to-date redeploy still gates false (no CI churn).
    if (match.deployed_value_hash !== valueHash) return true;
    return (match.deployed ?? true) !== (deployed ?? true);
  });
}

/**
 * Record one target's delivery into every (var, branch) entry it actually
 * shipped. Only entries whose name is in `values` AND whose branch matches
 * are touched — everything else in `keep` is returned unchanged (same object
 * identity, so a caller can cheaply tell "nothing changed").
 */
export function recordTargetDeliveries(
  keep: KeepFile,
  branch: string,
  delivery: TargetDeliveryDescriptor,
  deliveredAt: string,
  values: ReadonlyArray<VarDelivery>,
): KeepFile {
  const byName = new Map(values.map((v) => [v.name, v.valueHash]));
  if (byName.size === 0) return keep;

  // Built alongside a `changed` flag rather than always spreading a new
  // object: a redeploy of values that are all UNCHANGED (every
  // `upsertTargetElement` call below is itself a no-op — see its own doc)
  // must return `keep` BY REFERENCE, so callers that skip the push on
  // `nextKeep === keep` (`pushKeepTransform`) don't push a no-op.
  const built = Object.entries(keep.variables).reduce(
    (acc, [name, entries]) => {
      const valueHash = byName.get(name);
      if (valueHash === undefined) {
        return { variables: { ...acc.variables, [name]: entries }, changed: acc.changed };
      }
      const nextEntries = entries.map((e) => {
        if ((e.branch ?? '') !== branch) return e;
        const withTargets = e as EntryWithTargets;
        const nextTargets = upsertTargetElement(withTargets.targets, delivery, valueHash, deliveredAt);
        return nextTargets === withTargets.targets ? e : { ...e, targets: nextTargets };
      });
      const entryChanged = nextEntries.some((e, i) => e !== entries[i]);
      return {
        variables: { ...acc.variables, [name]: nextEntries },
        changed: acc.changed || entryChanged,
      };
    },
    { variables: {} as KeepFile['variables'], changed: false },
  );

  return built.changed ? { ...keep, variables: built.variables } : keep;
}

/** Drop every `targets` element matching `predicate`, on every entry, on every branch. */
export function stripTargetsMatching(
  keep: KeepFile,
  predicate: (t: TargetDelivery) => boolean,
): KeepFile {
  return {
    ...keep,
    variables: Object.fromEntries(
      Object.entries(keep.variables).map(([name, entries]) => [
        name,
        entries.map((e) => {
          const withTargets = e as EntryWithTargets;
          if (!withTargets.targets) return e;
          const kept = withTargets.targets.filter((t) => !predicate(t));
          if (kept.length === withTargets.targets.length) return e;
          if (kept.length === 0) {
            const { targets: _drop, ...rest } = withTargets;
            return rest as KeepVariableEntry;
          }
          return { ...e, targets: kept };
        }),
      ]),
    ),
  };
}

/** `deploy remove <target>`: strip every element for this (provider, target). */
export function stripTargetsForProviderTarget(
  keep: KeepFile,
  provider: string,
  target: string,
): KeepFile {
  return stripTargetsMatching(keep, (t) => t.provider === provider && t.target === target);
}

/** `deploy revoke <id>`: strip every element whose `deploy_id` matches. */
export function stripTargetsForDeployId(keep: KeepFile, deployId: string): KeepFile {
  return stripTargetsMatching(keep, (t) => t.deploy_id === deployId);
}

/**
 * Every `deploy_id` this (provider, target) pair has EVER delivered with and
 * might still be live — its CURRENT `deploy_id` on every element, plus every
 * `superseded_deploy_ids` entry those elements carry, deduped. `deploy
 * targets-remove` revokes every one of these — the whole point of tracking
 * superseded ids is that removal is the one place that's safe to revoke
 * everything at once, since the target itself is going away.
 */
export function allDeployIdsForTarget(keep: KeepFile, provider: string, target: string): readonly string[] {
  const ids = new Set<string>();
  for (const entries of Object.values(keep.variables)) {
    for (const entry of entries) {
      for (const t of (entry as EntryWithTargets).targets ?? []) {
        if (t.provider !== provider || t.target !== target) continue;
        if (t.deploy_id) ids.add(t.deploy_id);
        for (const id of t.superseded_deploy_ids ?? []) ids.add(id);
      }
    }
  }
  return Array.from(ids);
}

/**
 * Only the SUPERSEDED ids for (provider, target) — never the current one.
 * Used by the post-deploy revoke step (`deployCommand.ts`): a real deploy
 * just succeeded, so whatever this target's element superseded a moment ago
 * (see `upsertTargetElement`'s doc) is safe to revoke now — but the CURRENT
 * `deploy_id` obviously never is.
 */
export function supersededDeployIdsForTarget(keep: KeepFile, provider: string, target: string): readonly string[] {
  const ids = new Set<string>();
  for (const entries of Object.values(keep.variables)) {
    for (const entry of entries) {
      for (const t of (entry as EntryWithTargets).targets ?? []) {
        if (t.provider !== provider || t.target !== target) continue;
        for (const id of t.superseded_deploy_ids ?? []) ids.add(id);
      }
    }
  }
  return Array.from(ids);
}

/**
 * Drop `ids` from every `superseded_deploy_ids` list on (provider, target)'s
 * elements — called once those ids have actually been revoked, so a later
 * run never tries again. Pure, and a true no-op (same object identity via
 * `targetsChanged`-style comparison isn't attempted here — callers push
 * through `pushKeepTransform`, which already skips a same-reference result)
 * when nothing needed dropping.
 */
export function clearSupersededDeployIds(
  keep: KeepFile,
  provider: string,
  target: string,
  ids: ReadonlySet<string>,
): KeepFile {
  return {
    ...keep,
    variables: Object.fromEntries(
      Object.entries(keep.variables).map(([name, entries]) => [
        name,
        entries.map((e) => {
          const withTargets = e as EntryWithTargets;
          if (!withTargets.targets) return e;
          const nextTargets = withTargets.targets.map((t) => {
            if (t.provider !== provider || t.target !== target || !t.superseded_deploy_ids?.length) return t;
            const kept = t.superseded_deploy_ids.filter((id) => !ids.has(id));
            if (kept.length === t.superseded_deploy_ids.length) return t;
            if (kept.length === 0) {
              const { superseded_deploy_ids: _drop, ...rest } = t;
              return rest;
            }
            return { ...t, superseded_deploy_ids: kept };
          });
          const entryChanged = nextTargets.some((t, i) => t !== withTargets.targets![i]);
          return entryChanged ? { ...e, targets: nextTargets } : e;
        }),
      ]),
    ),
  };
}

/** Whether `keep` actually changed vs. `next` — cheap identity check first, deep fallback otherwise. */
export function targetsChanged(keep: KeepFile, next: KeepFile): boolean {
  return keep !== next && JSON.stringify(keep) !== JSON.stringify(next);
}

/**
 * Targets on `entry` whose `deployed_value_hash` no longer matches the
 * entry's current `value_hash` — i.e. the value moved since that target last
 * received it. Empty when the entry has no targets, or none are stale.
 */
export function staleTargets(entry: KeepVariableEntry): ReadonlyArray<TargetDelivery> {
  const targets = (entry as EntryWithTargets).targets;
  if (!targets) return [];
  return targets.filter((t) => t.deployed_value_hash !== entry.value_hash);
}

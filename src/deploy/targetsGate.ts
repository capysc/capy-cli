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
 * carries the SAME `deployed_value_hash` — returns `existing` UNCHANGED (same
 * array reference when nothing else needed updating), rather than replacing
 * it with a fresh `deployed_at`/`deploy_id`. This is what makes an unchanged
 * value produce an unchanged keep.lock: `buildDeployKeep`'s CI change-gate
 * (and `recordTargetDeliveries`'s direct-mode write) both key their own
 * "did anything change" off comparing serialized keep.lock text, and a
 * redeploy of the exact same value must not manufacture a diff by stamping a
 * new timestamp on a fact that didn't change.
 */
export function upsertTargetElement(
  existing: ReadonlyArray<TargetDelivery> | undefined,
  delivery: TargetDeliveryDescriptor,
  deployedValueHash: string,
  deployedAt: string,
): ReadonlyArray<TargetDelivery> {
  const list = existing ?? [];
  const match = list.find((t) => t.provider === delivery.provider && t.target === delivery.target);
  if (match && match.deployed_value_hash === deployedValueHash) {
    return list;
  }
  const filtered = list.filter((t) => !(t.provider === delivery.provider && t.target === delivery.target));
  const element: TargetDelivery = {
    provider: delivery.provider,
    target: delivery.target,
    ...(delivery.ref ? { ref: delivery.ref } : {}),
    deployed_value_hash: deployedValueHash,
    deployed_at: deployedAt,
    ...(delivery.deployId ? { deploy_id: delivery.deployId } : {}),
  };
  return [...filtered, element];
}

export interface VarDelivery {
  name: string;
  valueHash: string;
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

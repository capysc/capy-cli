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
import { KeepFile, KeepVariableEntry, TargetDelivery } from '../types/index';

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
 */
export function upsertTargetElement(
  existing: ReadonlyArray<TargetDelivery> | undefined,
  delivery: TargetDeliveryDescriptor,
  deployedValueHash: string,
  deployedAt: string,
): ReadonlyArray<TargetDelivery> {
  const filtered = (existing ?? []).filter(
    (t) => !(t.provider === delivery.provider && t.target === delivery.target),
  );
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
  return {
    ...keep,
    variables: Object.fromEntries(
      Object.entries(keep.variables).map(([name, entries]) => {
        const valueHash = byName.get(name);
        if (valueHash === undefined) return [name, entries];
        return [
          name,
          entries.map((e) => {
            if ((e.branch ?? '') !== branch) return e;
            const withTargets = e as EntryWithTargets;
            return {
              ...e,
              targets: upsertTargetElement(withTargets.targets, delivery, valueHash, deliveredAt),
            };
          }),
        ];
      }),
    ),
  };
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

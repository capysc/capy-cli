/**
 * CAP-702: the `not deployed` status, shared by `capy edit` and `capy secrets`.
 *
 * Capy does not track whether a release happened. `capy deploy` pushes the
 * new values to the target's store and records `deployed_value_hash` on the
 * keep entry; the next release of that repo uses them. So a target is
 * "not deployed" exactly when Capy holds a newer value than the one it last
 * pushed there: `deployed_value_hash !== value_hash`. Nothing here polls a
 * platform or claims a release ran.
 */
import type { KeepFile, TargetDelivery } from '../types/index';
import type { SecretIndexRow } from '../service/serviceClient';

export const NOT_DEPLOYED = 'not deployed';
export const NO_TARGET_LABEL = '—';

/** Every target that received `varName` on `branch`, from a keep file. `[]` when there are none. */
export function deployedHashesFor(keep: KeepFile | undefined, varName: string, branch: string): readonly string[] {
  const entry = keep?.variables[varName]?.find((e) => e.branch === branch);
  const targets: ReadonlyArray<TargetDelivery> = entry?.targets ?? [];
  return targets.map((t) => t.deployed_value_hash);
}

/** Whether at least one target holds a value other than `valueHash`. */
export function anyTargetBehind(deployedHashes: readonly string[] | undefined, valueHash: string | undefined): boolean {
  if (valueHash === undefined) return false;
  return (deployedHashes ?? []).some((h) => h !== valueHash);
}

// ── capy secrets ─────────────────────────────────────────────────────────────

/** The STATUS a `capy secrets` row can have: an org-wide row has no local copy, so only these three. */
export type SecretRowStatus =
  | { readonly kind: 'no target' }
  | { readonly kind: 'in sync' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'not deployed'; readonly behind: number; readonly total: number };

/**
 * `not deployed` when at least one target on any location lags this row's
 * value; `unknown` when a location's targets were not sent (a server that
 * predates CAP-676), so it can't be told; `no target` when the row has no
 * Capy deploy target at all — Capy only knows its own targets, so a value
 * used elsewhere (or only locally) is never called in sync (Vince,
 * 2026-10-04); `in sync` when every target has the current value.
 */
export function secretRowStatus(row: SecretIndexRow): SecretRowStatus {
  if (row.locations.some((loc) => loc.targets === undefined)) return { kind: 'unknown' };
  const targets = row.locations.flatMap((loc) => loc.targets ?? []);
  if (targets.length === 0) return { kind: 'no target' };
  const behind = targets.filter((t) => t.stale).length;
  return behind > 0 ? { kind: 'not deployed', behind, total: targets.length } : { kind: 'in sync' };
}

/** The text a person sees, without colour: `—` for no target (Vince's word), `not deployed (1 of 3)` when more than one target is involved, plain `not deployed` for one. */
export function formatSecretRowStatus(status: SecretRowStatus): string {
  if (status.kind === 'no target') return NO_TARGET_LABEL;
  if (status.kind !== 'not deployed') return status.kind;
  return status.total > 1 ? `${NOT_DEPLOYED} (${status.behind} of ${status.total})` : NOT_DEPLOYED;
}

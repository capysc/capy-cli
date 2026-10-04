/**
 * CAP-702: the `behind` status (shown as BEHIND_LABEL), shared by `capy edit` and `capy secrets`.
 *
 * Capy does not track whether a release happened. `capy deploy` pushes the
 * new values to the target's store and records `deployed_value_hash` on the
 * keep entry; the next release of that repo uses them. So a target is
 * behind exactly when Capy holds a newer value than the one it last
 * pushed there: `deployed_value_hash !== value_hash`. Nothing here polls a
 * platform or claims a release ran.
 */
import type { KeepFile, TargetDelivery } from '../types/index';
import type { SecretIndexRow } from '../service/serviceClient';
import type { TargetConfig } from '../deploy/adapter';
import { unrecordedTargetsFor } from '../deploy/configuredTargets';

// ── On-screen words: each lives in ONE constant so a wording decision is a
// one-line change. All four are Vince's words (2026-10-04).

/** A target holds an older value than Capy has, or none (code `behind`). Used by both screens. */
export const BEHIND_LABEL = 'not deployed';
/** `capy secrets`' heading for the target-status column (its details-view label is the lowercase form). */
export const TARGET_STATUS_HEADING = 'DEPLOY STATUS';
/** A row with no Capy target. */
export const NO_TARGET_LABEL = '—';
/** `capy secrets` only: every Capy target has the current value. (`capy edit` says `in sync`: it compares local with Capy.) */
export const DEPLOYED_LABEL = 'deployed';

/**
 * The value hash each of `varName`'s targets on `branch` last received, from a
 * keep file — `null` for a target that never received one: a placeholder
 * record, or a target configured in `.capy/deploy.json` (`configured`) with
 * no record at all. `[]` when there are no targets.
 */
export function deployedHashesFor(
  keep: KeepFile | undefined,
  varName: string,
  branch: string,
  configured: readonly TargetConfig[] = [],
): readonly (string | null)[] {
  const entry = keep?.variables[varName]?.find((e) => e.branch === branch);
  const targets: ReadonlyArray<TargetDelivery> = entry?.targets ?? [];
  const recorded = targets.map((t) => t.deployed_value_hash ?? null);
  const neverPushed = unrecordedTargetsFor(configured, keep, varName, branch).map(() => null);
  return [...recorded, ...neverPushed];
}

/** Whether at least one target holds a value other than `valueHash` (a target that never received one always does). */
export function anyTargetBehind(deployedHashes: readonly (string | null)[] | undefined, valueHash: string | undefined): boolean {
  if (valueHash === undefined) return false;
  return (deployedHashes ?? []).some((h) => h !== valueHash);
}

// ── capy secrets ─────────────────────────────────────────────────────────────

/** The STATUS a `capy secrets` row can have: an org-wide row has no local copy, so only these three. */
export type SecretRowStatus =
  | { readonly kind: 'no target' }
  | { readonly kind: 'deployed' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'behind'; readonly behind: number; readonly total: number };

/**
 * `not deployed` when at least one target on any location lags this row's
 * value; `unknown` when a location's targets were not sent (a server that
 * predates CAP-676), so it can't be told; `no target` when the row has no
 * Capy deploy target at all — Capy only knows its own targets, so a value
 * used elsewhere (or only locally) is never called deployed (Vince,
 * 2026-10-04); `deployed` when every target has the current value.
 */
export function secretRowStatus(row: SecretIndexRow): SecretRowStatus {
  if (row.locations.some((loc) => loc.targets === undefined)) return { kind: 'unknown' };
  const targets = row.locations.flatMap((loc) => loc.targets ?? []);
  if (targets.length === 0) return { kind: 'no target' };
  const behind = targets.filter((t) => t.stale).length;
  return behind > 0 ? { kind: 'behind', behind, total: targets.length } : { kind: 'deployed' };
}

/** The text a person sees, without colour: `—` for no target, `<BEHIND_LABEL> (1 of 3)` when more than one target is involved, plain `<BEHIND_LABEL>` for one. */
export function formatSecretRowStatus(status: SecretRowStatus): string {
  if (status.kind === 'no target') return NO_TARGET_LABEL;
  if (status.kind === 'deployed') return DEPLOYED_LABEL;
  if (status.kind !== 'behind') return status.kind;
  return status.total > 1 ? `${BEHIND_LABEL} (${status.behind} of ${status.total})` : BEHIND_LABEL;
}

/** The `--json` `status` string: the on-screen words (Vince, 2026-10-04), with `no target` for the `—` row. */
export function secretRowStatusJson(status: SecretRowStatus): string {
  if (status.kind === 'behind') return BEHIND_LABEL;
  if (status.kind === 'deployed') return DEPLOYED_LABEL;
  return status.kind;
}

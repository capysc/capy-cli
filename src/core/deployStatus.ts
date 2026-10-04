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
import type { SecretIndexLocation, SecretIndexRow } from '../service/serviceClient';
import type { TargetConfig } from '../deploy/adapter';
import { unrecordedTargetsFor } from '../deploy/configuredTargets';

// ── On-screen words: each lives in ONE constant so a wording decision is a
// one-line change. All four are Vince's words (2026-10-04).

/** A target holds an older value than Capy has, or none (code `behind`). Used by both screens. */
export const BEHIND_LABEL = 'needs deploy';
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

/**
 * The DEPLOY STATUS of a `capy secrets` row. `deployed` and `behind` carry
 * how many of the row's locations are in that state (`locations`) out of all
 * of them (`total`), so a value used in 33 places with one current target
 * reads `deployed (1 of 33)`.
 */
export type SecretRowStatus =
  | { readonly kind: 'no target' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'deployed' | 'behind'; readonly locations: number; readonly total: number };

type LocationState = 'unknown' | 'none' | 'deployed' | 'behind';

function locationState(loc: SecretIndexLocation): LocationState {
  if (loc.targets === undefined) return 'unknown';
  if (loc.targets.length === 0) return 'none';
  return loc.targets.some((t) => t.stale) ? 'behind' : 'deployed';
}

/**
 * Counted per LOCATION (Vince, 2026-10-04): `behind` when any location has a
 * target that lags (older hash, or none); else `deployed` when some location
 * has targets and all of them are current; else `no target` — Capy only knows
 * its own targets, so a value used elsewhere (or only locally) is never
 * called deployed. `unknown` when a location's targets were not sent (a
 * server that predates CAP-676), so it can't be told.
 */
export function secretRowStatus(row: SecretIndexRow): SecretRowStatus {
  const states = row.locations.map(locationState);
  if (states.includes('unknown')) return { kind: 'unknown' };
  const total = states.length;
  const behind = states.filter((s) => s === 'behind').length;
  if (behind > 0) return { kind: 'behind', locations: behind, total };
  const deployed = states.filter((s) => s === 'deployed').length;
  if (deployed > 0) return { kind: 'deployed', locations: deployed, total };
  return { kind: 'no target' };
}

/** The text a person sees, without colour: `—` for no target; the state's word, plus `(n of m)` locations when not every location is in that state. */
export function formatSecretRowStatus(status: SecretRowStatus): string {
  if (status.kind === 'no target') return NO_TARGET_LABEL;
  if (status.kind === 'unknown') return status.kind;
  const word = status.kind === 'behind' ? BEHIND_LABEL : DEPLOYED_LABEL;
  return status.locations < status.total ? `${word} (${status.locations} of ${status.total})` : word;
}

/** The `--json` `status` string: the on-screen words (Vince, 2026-10-04), with `no target` for the `—` row. */
export function secretRowStatusJson(status: SecretRowStatus): string {
  if (status.kind === 'behind') return BEHIND_LABEL;
  if (status.kind === 'deployed') return DEPLOYED_LABEL;
  return status.kind;
}

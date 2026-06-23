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

function entryFor(keep: KeepFile, name: string, branch: string): Entry | undefined {
  return (keep.variables[name] as Entry[] | undefined)?.find(
    (e) => (e.branch ?? '') === branch,
  );
}

/**
 * Fold the current decrypted values for `vars` (on the Capy `branch`) into a
 * clone of `baseKeep`, then report whether anything actually changed.
 *
 * `nowIso` is injected (not read from the clock) so the result is deterministic
 * and testable.
 */
export function buildDeployKeep(
  baseKeep: KeepFile,
  envValues: Record<string, string>,
  vars: string[],
  branch: string,
  nowIso: string,
): DeployKeep {
  const keep: KeepFile = JSON.parse(JSON.stringify(baseKeep));
  if (!keep.variables) keep.variables = {};

  for (const name of vars) {
    const value = envValues[name];
    if (value === undefined) continue; // missing var — var-set reconcile handles it
    const hash = hashValue(value);
    const entries = (keep.variables[name] ??= []) as Entry[];
    const entry = entryFor(keep, name, branch);
    if (!entry) {
      entries.push({
        resource_id: deriveResourceId(branch, name),
        branch,
        value_hash: hash,
        changed_at: nowIso,
      });
    } else if (entry.value_hash !== hash) {
      entry.value_hash = hash;
      entry.changed_at = nowIso;
    }
  }

  const content = serializeKeep(keep);
  return { content, changed: content !== serializeKeep(baseKeep) };
}

/**
 * `--force`: produce a keep.lock that differs from the base even when no value
 * changed, so a redeploy can re-trigger CI. We bump `changed_at` on the deployed
 * vars (meaningful: "re-shipped at T") rather than injecting a throwaway nonce.
 */
export function touchDeployKeep(
  baseKeep: KeepFile,
  vars: string[],
  branch: string,
  nowIso: string,
): string {
  const keep: KeepFile = JSON.parse(JSON.stringify(baseKeep));
  for (const name of vars) {
    const entry = entryFor(keep, name, branch);
    if (entry) entry.changed_at = nowIso;
  }
  return serializeKeep(keep);
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

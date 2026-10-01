/**
 * CAP-659 Phase 2 — the `capy push` preview.
 *
 * `push` only ever moves ONE direction (local `.env` → the active branch's
 * pinned state), so the diff this needs is simpler than `capy`'s own 3-way
 * sync: pinned (keep.lock, what the server already has) vs local (the
 * `.env` sitting in this directory) — no remote fetch, so a dry run never
 * contacts the service at all. The same two maps `pushCommand.ts` already
 * builds to compute hashes before pushing are the only inputs here; this
 * module just decides, per name, whether that comparison is an add, a
 * change, or a removal — and never which VALUE changed.
 */
import type { DryRunChange } from './dryRun';

export type PushDiffKind = 'add' | 'change' | 'remove';

export interface PushDiffEntry {
  readonly name: string;
  readonly kind: PushDiffKind;
}

/**
 * `pinned` and `local` are both variable name → value hash (never
 * plaintext). A name present in only one map is an add/remove; present in
 * both with different hashes is a change; equal hashes (or absent from
 * both) report nothing — there is no push to make for it.
 */
export function computePushDiff(
  pinned: Readonly<Record<string, string>>,
  local: Readonly<Record<string, string>>,
): readonly PushDiffEntry[] {
  const names = [...new Set([...Object.keys(pinned), ...Object.keys(local)])].sort();
  return names.flatMap((name): readonly PushDiffEntry[] => {
    const p = pinned[name];
    const l = local[name];
    if (p === l) return [];
    if (p === undefined) return [{ name, kind: 'add' }];
    if (l === undefined) return [{ name, kind: 'remove' }];
    return [{ name, kind: 'change' }];
  });
}

const ACTION_LABEL: Record<PushDiffKind, string> = {
  add: 'push new secret',
  change: 'push changed secret',
  remove: 'remove pinned secret',
};

/** `computePushDiff`'s output, as the shared `DryRunChange` shape the printer renders. Names only, never values. */
export function pushPlan(diffs: readonly PushDiffEntry[]): readonly DryRunChange[] {
  return diffs.map((d) => ({
    where: 'capy_service',
    action: ACTION_LABEL[d.kind],
    target: d.name,
    // A push always lands on top of whatever Keep already has for this
    // branch — the prior value is never destroyed, so every entry here is
    // reversible (another push can restore it).
    reversible: true,
  }));
}

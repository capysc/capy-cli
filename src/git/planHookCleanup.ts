/** Remove only complete, explicitly marked Capy blocks; preserve all other bytes. */
export const CAPY_HOOK_START = '# --- capy auto-sync (do not remove) ---';
export const CAPY_HOOK_END = '# --- end capy ---';

export type HookCleanupPlan =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'invalid'; readonly reason: 'unbalanced-markers' }
  | { readonly kind: 'changed'; readonly content: string; readonly removedBlocks: number };

interface Scan {
  readonly kept: readonly string[];
  readonly inside: boolean;
  readonly removed: number;
  readonly invalid: boolean;
}

export function planHookCleanup(content: string): HookCleanupPlan {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const scan = lines.reduce<Scan>((state, line) => {
    if (state.invalid) return state;
    const text = line.replace(/\r?\n$/, '');
    if (text === CAPY_HOOK_START) {
      return state.inside ? { ...state, invalid: true } : { ...state, inside: true };
    }
    if (text === CAPY_HOOK_END) {
      return state.inside ? { ...state, inside: false, removed: state.removed + 1 } : { ...state, invalid: true };
    }
    return state.inside ? state : { ...state, kept: [...state.kept, line] };
  }, { kept: [], inside: false, removed: 0, invalid: false });
  if (scan.invalid || scan.inside) return { kind: 'invalid', reason: 'unbalanced-markers' };
  if (scan.removed === 0) return { kind: 'unchanged' };
  return { kind: 'changed', content: scan.kept.join(''), removedBlocks: scan.removed };
}

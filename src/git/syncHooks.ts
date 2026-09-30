import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * The post-checkout / post-merge hooks that run `capy status` after a branch
 * switch or pull.
 *
 * The hook is informational and must never change the outcome of the git
 * command it rides on: git uses post-checkout's exit status as the exit
 * status of `git checkout` / `git switch`. The old block ended in
 * `command -v capy >/dev/null 2>&1 && capy status`, so a branch checkout
 * FAILED (exit 1) whenever capy was not on PATH, and whenever `capy status`
 * itself failed (offline, signed out, a broken install) — breaking scripts
 * and CI that run git in a Capy-managed repo. Each block now runs status
 * only when the binary exists and swallows its exit status.
 */

export const SYNC_HOOK_MARKER = '# --- capy auto-sync (do not remove) ---';
export const SYNC_HOOK_END_MARKER = '# --- end capy ---';

const BLOCK_RE = new RegExp(
  `${SYNC_HOOK_MARKER.replace(/[()]/g, '\\$&')}[\\s\\S]*?${SYNC_HOOK_END_MARKER.replace(/[()]/g, '\\$&')}\\n?`,
);

/** `capy status` if `cmd` is installed; never a non-zero status. */
function statusIfInstalled(cmd: string, indent: string): readonly string[] {
  return [
    `${indent}if command -v ${cmd} >/dev/null 2>&1; then`,
    `${indent}  ${cmd} status || true`,
    `${indent}fi`,
  ];
}

/** The capy block for each hook, keyed by hook file name. */
export function syncHookBlocks(cmd: string): Readonly<Record<string, string>> {
  return {
    'post-checkout': [
      SYNC_HOOK_MARKER,
      'if [ "$3" = "1" ] && [ ! -d "$(git rev-parse --git-dir)/rebase-merge" ] && [ ! -d "$(git rev-parse --git-dir)/rebase-apply" ]; then',
      ...statusIfInstalled(cmd, '  '),
      'fi',
      SYNC_HOOK_END_MARKER,
    ].join('\n'),
    'post-merge': [
      SYNC_HOOK_MARKER,
      ...statusIfInstalled(cmd, ''),
      SYNC_HOOK_END_MARKER,
    ].join('\n'),
  };
}

/** New content for a hook file, or null when it is already up to date. */
export function nextHookContent(existing: string | null, block: string): string | null {
  if (existing === null) return `#!/bin/sh\n${block}\n`;
  if (existing.includes(SYNC_HOOK_MARKER)) {
    // Replace the existing capy block (e.g. switching capy/capy-dev, or an
    // older block that could fail the git command).
    const updated = existing.replace(BLOCK_RE, `${block}\n`);
    return updated === existing ? null : updated;
  }
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  const shebang = existing ? '' : '#!/bin/sh\n';
  return `${existing}${separator}${shebang}${block}\n`;
}

/**
 * Install (or upgrade) the capy blocks in `<gitDir>/hooks`, and remove the
 * capy block from pre-push if an older version left one. Idempotent.
 */
export function installSyncHooks(gitDir: string, cmd: string): void {
  const hooksDir = join(gitDir, 'hooks');
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const prePushPath = join(hooksDir, 'pre-push');
  if (existsSync(prePushPath)) {
    const prePush = readFileSync(prePushPath, 'utf-8');
    if (prePush.includes(SYNC_HOOK_MARKER)) writeFileSync(prePushPath, prePush.replace(BLOCK_RE, ''), 'utf-8');
  }

  for (const [hookName, block] of Object.entries(syncHookBlocks(cmd))) {
    const hookPath = join(hooksDir, hookName);
    const next = nextHookContent(existsSync(hookPath) ? readFileSync(hookPath, 'utf-8') : null, block);
    if (next !== null) {
      writeFileSync(hookPath, next, 'utf-8');
      chmodSync(hookPath, 0o755);
    }
  }
}

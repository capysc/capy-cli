import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';

/**
 * Install git hooks (post-checkout, post-merge) that run `capy status` after
 * a checkout/merge so drift shows up without the user having to think to ask.
 * Idempotent: checks for an existing marker before appending. No pre-push
 * hook — removes one if a prior CLI version left it behind.
 *
 * Extracted, byte-for-byte, from `CapyCommand`'s own private method (which
 * now delegates here) so `SetupCommand`'s `capy setup --json --confirm`
 * apply path gets the SAME hooks a first `capy` init always installs,
 * without forking the logic into a second copy to keep in sync.
 *
 * The one behavior change from the original: `let existing = ''` followed by
 * a conditional reassignment became a single ternary (repo's no-mutation
 * rule) — same value, computed the same way, never reassigned.
 */
export function installGitHooks(devMode: boolean): void {
  try {
    const gitDir = execSync('git rev-parse --git-dir', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    const hooksDir = `${gitDir}/hooks`;

    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true });
    }

    const MARKER = '# --- capy auto-sync (do not remove) ---';
    const END_MARKER = '# --- end capy ---';
    const escMarker = MARKER.replace(/[()]/g, '\\$&');
    const escEnd = END_MARKER.replace(/[()]/g, '\\$&');
    const cmd = devMode ? 'capy-dev' : 'capy';

    const hooks: Record<string, string> = {
      'post-checkout': [
        MARKER,
        'if [ "$3" = "1" ] && [ ! -d "$(git rev-parse --git-dir)/rebase-merge" ] && [ ! -d "$(git rev-parse --git-dir)/rebase-apply" ]; then',
        `  command -v ${cmd} >/dev/null 2>&1 && ${cmd} status`,
        'fi',
        END_MARKER,
      ].join('\n'),
      'post-merge': [
        MARKER,
        `command -v ${cmd} >/dev/null 2>&1 && ${cmd} status`,
        END_MARKER,
      ].join('\n'),
    };

    // Remove pre-push capy block if it exists
    const prePushPath = `${hooksDir}/pre-push`;
    if (existsSync(prePushPath)) {
      const prePushContent = readFileSync(prePushPath, 'utf-8');
      if (prePushContent.includes(MARKER)) {
        const re = new RegExp(`${escMarker}[\\s\\S]*?${escEnd}\\n?`);
        const updated = prePushContent.replace(re, '');
        writeFileSync(prePushPath, updated, 'utf-8');
      }
    }

    for (const [hookName, content] of Object.entries(hooks)) {
      const hookPath = `${hooksDir}/${hookName}`;
      const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf-8') : '';
      if (existing.includes(MARKER)) {
        const re = new RegExp(`${escMarker}[\\s\\S]*?${escEnd}\\n?`);
        const updated = existing.replace(re, `${content}\n`);
        if (updated !== existing) {
          writeFileSync(hookPath, updated, 'utf-8');
        }
        continue;
      }

      const shebang = existing ? '' : '#!/bin/sh\n';
      const separator = existing && !existing.endsWith('\n') ? '\n' : '';
      writeFileSync(hookPath, `${existing}${separator}${shebang}${content}\n`, 'utf-8');
      chmodSync(hookPath, 0o755);
    }
  } catch {
    // Not a git repo or hooks dir inaccessible — silently skip
  }
}

/**
 * Command gating for local-only mode.
 *
 * Local-only mode has no organization, no team, and no server, so the
 * org/team/server-dependent commands are disabled. Each such command calls
 * assertNotLocalOnly() at the top of its action; the curated list of gated
 * commands is asserted by a test so a future command can't silently leak a
 * server call into local mode.
 */
import { isLocalOnly } from '../config/profileConfig';

/** Commands that are disabled in local-only mode (no org/team/server). */
export const LOCAL_ONLY_DISABLED_COMMANDS = [
  'invite',
  'kick',
  'users',
  'grant-branch',
  'revoke-branch',
  'org',
  'redeem',
  'transport',
  'deploy',
  'connect',
  'rotate',
  'recover',
  'info',
  // Branch management is entirely server-driven (listBranches/deleteBranch).
  // Local-only mode operates on the single active branch (default
  // 'development'); multi-branch support is deferred.
  'branch',
  'checkout',
] as const;

/**
 * Exit with a clear message if the active profile is local-only. No-op
 * otherwise. Call this at the very top of a disabled command's action so the
 * command never reaches any auth/server code.
 */
export function assertNotLocalOnly(command: string): void {
  if (!isLocalOnly()) return;
  console.error(
    `\n  \`capy ${command}\` is disabled in local-only mode.\n` +
    `  Local mode has no organization, team, or server — secrets live only on this machine.\n`,
  );
  process.exit(1);
}

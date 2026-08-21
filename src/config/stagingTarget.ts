import { basename } from 'path';

/** The staging entrypoint's target. Pinned, not defaulted. */
export const STAGING_API_URL = 'https://staging-api.capy.sc';
export const STAGING_KEEP_ORIGIN = 'https://staging-keep.capy.sc';
export const STAGING_GLOBAL_DIR = '.capy-staging';

/**
 * Is this process the staging entrypoint (bin/capy-staging)?
 *
 * Keyed on argv[1] — the script node was actually asked to run — and NOT on an
 * environment variable. An env-based check could be set by the very caller the
 * pin exists to defend against; the executed path cannot be.
 *
 * Every resolver that can produce an origin or a state directory calls this as
 * its FIRST statement and returns the pinned value immediately. Nothing below
 * that early return — env vars, saved profiles, config files — is reached.
 */
export function isStagingEntrypoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  return basename(script) === 'capy-staging';
}

/** The dev entrypoint's isolated state dir. */
export const DEV_GLOBAL_DIR = '.capy-dev';

/**
 * Is this process the dev entrypoint (bin/capy-dev)?
 *
 * Same argv[1] signal as {@link isStagingEntrypoint}. Dev used to isolate its
 * state by exporting CAPY_GLOBAL_DIR_NAME, but env is no longer a source of
 * truth for where key material lives, so the isolation is derived here
 * instead — otherwise `capy-dev` would write into prod's ~/.capy, which holds
 * recovery-equivalent wrapped keys.
 */
export function isDevEntrypoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  return basename(script) === 'capy-dev';
}

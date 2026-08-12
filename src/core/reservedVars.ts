/**
 * Reserved runtime variables (CAP-424).
 *
 * `SECRETS_BLOB`, `PROJECT_KEY` and their `_CAPY_`-prefixed successors are
 * machine-local runtime configuration that happens to live in a `.env`-shaped
 * file. They are NOT project secrets: they are per-deploy-target by
 * construction, they are credentials rather than payload, and every surface
 * that treats an unknown plaintext key as "a new project secret to adopt"
 * gets them wrong in a different way — sync overwrites one machine's deploy
 * credential with another's, `writeEncryptedEnvFile` encrypts the project key
 * with itself and distributes it to the whole team, `mintDeployToken` embeds
 * the previous blob inside the next one, and `capy status` reports permanent
 * phantom drift.
 *
 * Reservation is a PREFIX RULE plus two grandfathered names, not a fixed
 * list. The prefix is the point: any future runtime variable is reserved on
 * day one without touching sync, edit, status, run or the server. Only the
 * two legacy names are special-cased, and they age out on their own as people
 * re-run `capy deploy`.
 *
 * Bare `DEPLOY_KEY` is deliberately NOT reserved. It is a plausible
 * application variable name — `tests/sync/spliceKeepBranch.test.ts` already
 * uses it as one — and reserving a generic word steals it from users. The
 * per-deploy credential's real name is `_CAPY_DEPLOY_KEY`, which the prefix
 * rule already covers.
 *
 * One predicate, consumed everywhere, so a rename cannot leave a path behind.
 */

/** Prefix reserving all current and future machine-local runtime variables. */
export const RESERVED_VAR_PREFIX = '_CAPY_';

/**
 * Legacy reserved names, from before the prefix rule existed. Supported
 * indefinitely — an existing deploy artifact must keep booting unchanged.
 */
export const LEGACY_RESERVED_VARS = ['SECRETS_BLOB', 'PROJECT_KEY'] as const;

/**
 * The two credential-generation name pairs `capy run` discriminates on
 * (CAP-411). The variable NAME is the only discriminator — DT and PK are
 * both 32 random bytes rendered as 64-char hex, structurally indistinguishable
 * as values, so there is no length check, no charset check, and no trial
 * decryption. Destructured from the arrays above rather than re-literaled, so
 * a rename can't leave the two definitions disagreeing.
 *
 * `LEGACY_PROJECT_KEY_VAR`'s value is the raw project key — the same value
 * that decrypts every `capy:` line in `.env`. `CURRENT_DEPLOY_KEY_VAR`'s value
 * is a per-deploy derivation token (DT): useless on its own, and useless even
 * combined with `CURRENT_SECRETS_BLOB_VAR` without a revocation-gated server
 * round trip to recover the project key in memory.
 */
export const [LEGACY_SECRETS_BLOB_VAR, LEGACY_PROJECT_KEY_VAR] = LEGACY_RESERVED_VARS;

/** Current-generation runtime variable names emitted by new mints (CAP-411). */
export const CURRENT_SECRETS_BLOB_VAR = `${RESERVED_VAR_PREFIX}SECRETS_BLOB`;
export const CURRENT_DEPLOY_KEY_VAR = `${RESERVED_VAR_PREFIX}DEPLOY_KEY`;

/**
 * True when `name` is machine-local runtime configuration rather than a
 * project secret. Callers must skip these in sync, push, pull, conflict
 * detection, encrypt-on-write, the `capy edit` TUI, `capy status` drift, and
 * `mintDeployToken`, and must strip them from any child environment.
 */
export function isReservedRuntimeVar(name: string): boolean {
  return (
    name.startsWith(RESERVED_VAR_PREFIX) ||
    (LEGACY_RESERVED_VARS as readonly string[]).includes(name)
  );
}

/**
 * Copy of `env` with every reserved runtime variable removed.
 *
 * Used at the `capy run` spawn chokepoint (CAP-423): the CLI has already
 * consumed these by the time it spawns — that is the whole point of the
 * command — and the child is the process whose job is to be exposed to the
 * internet, where environment dumps are routine (framework debug pages,
 * `phpinfo()`, error-tracker SDKs that capture env by default,
 * `/proc/<pid>/environ`, crash dumps). Every subprocess the app spawns
 * inherits the environment too, so stripping here also covers grandchildren.
 */
export function stripReservedRuntimeVars(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!isReservedRuntimeVar(k)) out[k] = v;
  }
  return out;
}

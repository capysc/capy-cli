<!-- GENERATED FILE — do not hand-edit. Run `bun run docs:cli` to regenerate. -->

# capy CLI reference

Version `0.9.7`. Generated from `capy help --json`.

## Commands

## `capy run`

Run a command with decrypted secrets

```
capy run
```

_No options._

JSON support: no

## `capy status`

Show secret drift between local, pinned, and remote

```
capy status [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

## `capy edit`

Inspect and edit secrets in an interactive TUI

```
capy edit
```

_No options._

JSON support: no

## `capy branch`

List secret branches

```
capy branch [options]
```

| Option | Description | Default |
|---|---|---|
| `-D <name>` | Delete a branch |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

## `capy checkout`

Switch to a secret branch

```
capy checkout <branch> [options]
```

| Option | Description | Default |
|---|---|---|
| `-b, --create` | Create the branch if it does not exist |  |
| `--protected` | Mark as a protected branch (invite-only) |  |
| `--no-protected` | Create it open to the project |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

## `capy push`

Push encrypted values to Keep

```
capy push
```

_No options._

JSON support: no

## `capy deploy`

Set up secret delivery — token + docs (existing) or target deploy

```
capy deploy [target] [options]
```

| Option | Description | Default |
|---|---|---|
| `--target <id>` | adapter id; requires --yes (CI mode) |  |
| `--yes` | skip all prompts (CI) |  |
| `--dry-run` | preflight + show plan, push nothing (target mode) |  |
| `--force` | redeploy even when keep.lock is unchanged — bumps keep.lock to trigger CI |  |
| `--edit` | re-enter the picker for an existing target |  |
| `--connect` | force target mode (skip the token+docs path) |  |
| `--platform <id>` | skip platform picker (token+docs flow; e.g. github-actions, vercel) |  |
| `--mode <mode>` | skip mode picker: "target" or "token" (also accepts the old "connector" spelling) |  |
| `--scope <scope>` | gh-actions: "repo" or "env" |  |
| `--env-name <name>` | gh-actions: env name when --scope env |  |
| `--no-deploy` | write and verify the target, but skip the platform deploy/redeploy (target mode) |  |
| `--json` | describe the route (unanswered stops + any known branch problem) as JSON instead of travelling it |  |

JSON support: yes (`--json`)

### `capy deploy revoke`

Revoke a deploy token

```
capy deploy revoke <deployId>
```

_No options._

JSON support: no

### `capy deploy list`

List deploy tokens for this project

```
capy deploy list
```

_No options._

JSON support: no

### `capy deploy targets`

List configured targets (target mode)

```
capy deploy targets
```

_No options._

JSON support: no

### `capy deploy targets-remove`

Remove a configured target

```
capy deploy targets-remove <name> [options]
```

| Option | Description | Default |
|---|---|---|
| `--no-deploy` | strip the config but skip the redeploy that would apply the revert |  |

JSON support: no

## `capy logout`

End the current session

```
capy logout
```

_No options._

JSON support: no

## `capy byoc`

Connect to a self-hosted Capy (BYOC) instance

```
capy byoc [url]
```

_No options._

JSON support: no

## `capy use`

Switch to a different profile

```
capy use <profile>
```

_No options._

JSON support: no

## `capy profile`

Manage CLI profiles (cloud, BYOC, etc.)

```
capy profile
```

_No options._

JSON support: no

### `capy profile list`

List configured profiles

```
capy profile list
```

_No options._

JSON support: no

### `capy profile show`

Show profile details (defaults to active)

```
capy profile show [name]
```

_No options._

JSON support: no

### `capy profile remove`

Delete a profile

```
capy profile remove <name>
```

_No options._

JSON support: no

## `capy cleanup`

Remove Capy git hooks from this repository

```
capy cleanup
```

_No options._

JSON support: no

## `capy help`

Show help information

```
capy help [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit a machine-readable command reference instead of human help |  |

JSON support: yes (`--json`)

## `capy agents`

Tell AI coding agents in this repo how to use Capy (writes AGENTS.md / CLAUDE.md)

```
capy agents [options]
```

| Option | Description | Default |
|---|---|---|
| `--print` | print the block to stdout without writing anything |  |
| `--remove` | remove the block from AGENTS.md / CLAUDE.md |  |
| `-y, --yes` | skip the confirmation prompt (required non-interactively) |  |
| `--non-tty` | never prompt; resolve from flags or fail fast (agents/CI) |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

## `capy invite`

Invite a teammate to this organization

```
capy invite <email> [options]
```

| Option | Description | Default |
|---|---|---|
| `--role <role>` | invitee role: member | project-admin | admin |  |
| `--project <id|name>` | grant project access (repeatable, comma-ok) | `[]` |
| `--ttl <duration>` | invite lifetime, max 12h, e.g. 30m, 2h, 12h (or seconds) |  |
| `--expires <iso>` | absolute expiry (ISO date); overrides --ttl |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |
| `--non-tty` | never prompt; resolve from flags or fail fast (agents/CI) |  |

JSON support: yes (`--json`)

## `capy redeem`

Redeem an invite code to join an organization

```
capy redeem <code>
```

_No options._

JSON support: no

## `capy transport`

Move your local key to another device via Keep (prints a QR code + link)

```
capy transport [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

## `capy pair`

Pair this device via Keep; requires interactive confirmation of the returned account before installing any session or keys

```
capy pair [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |
| `--force` | overwrite a different local key already on this machine |  |

JSON support: yes (`--json`)

## `capy kick`

Remove a teammate from this organization

```
capy kick <email>
```

_No options._

JSON support: no

## `capy system`

Manage this org's system store (connector credentials, CAP-664)

```
capy system
```

_No options._

JSON support: no

### `capy system set`

Set a connector credential (hidden prompt; owners/admins only)

```
capy system set <name> [options]
```

| Option | Description | Default |
|---|---|---|
| `--org <id>` | org id, if you belong to more than one |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

### `capy system list`

List connector credential names (never values; owners/admins only)

```
capy system list [options]
```

| Option | Description | Default |
|---|---|---|
| `--org <id>` | org id, if you belong to more than one |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

### `capy system rm`

Remove a connector credential (asks for confirmation; owners/admins only)

```
capy system rm <name> [options]
```

| Option | Description | Default |
|---|---|---|
| `--org <id>` | org id, if you belong to more than one |  |
| `--yes` | skip the confirmation prompt |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

## `capy org`

Switch organization

```
capy org
```

_No options._

JSON support: no

## `capy info`

Show current session info

```
capy info [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

## `capy list`

List variable names + connector metadata for the active branch (no values)

```
capy list [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

## `capy users`

List organization members and their project access

```
capy users [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

## `capy projects`

List projects in the active organization and their branches

```
capy projects [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

## `capy secrets`

List every secret name across the active organization, grouped by value (read-only, never shows a value)

```
capy secrets [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |
| `--project <name>` | only rows with a location in this project |  |
| `--branch <name>` | only rows with a location on this branch |  |

JSON support: yes (`--json`)

## `capy grant-branch`

Grant a member wildcard access to a protected branch

```
capy grant-branch <email> <project> <branch>
```

_No options._

JSON support: no

## `capy revoke-branch`

Revoke a member's wildcard access to a protected branch

```
capy revoke-branch <email> <project> <branch>
```

_No options._

JSON support: no

## `capy decrypt`

Decrypt secrets offline using seed phrase (owner only)

```
capy decrypt
```

_No options._

JSON support: no

## `capy end-recover`

End recovery session and clean up decrypted files

```
capy end-recover
```

_No options._

JSON support: no

## `capy recover`

Reconstruct the wrapped master key from a 24-word recovery phrase

```
capy recover
```

_No options._

JSON support: no

## `capy add`

Add one or more secret values to the project (encrypts + syncs)

```
capy add <vars...> [options]
```

| Option | Description | Default |
|---|---|---|
| `--reason <text>` | short note shown on the intake page |  |
| `--help-url <NAME=URL>` | per-variable "where to find this" link, e.g. STRIPE_SECRET_KEY=https://dashboard.stripe.com/apikeys (repeatable) | `[]` |
| `--no-open` | do not auto-open the browser; print the URL only |  |
| `--no-push` | write to .env only; do not push to Capy |  |
| `-f, --force` | overwrite existing values without prompting |  |
| `--non-tty` | never prompt; resolve from flags or fail fast (agents/CI) |  |

JSON support: no

## `capy remove`

Delete one or more secret values from the active branch (encrypts + syncs)

```
capy remove <vars...> [options]
```

| Option | Description | Default |
|---|---|---|
| `-y, --yes` | skip the confirmation prompt (required non-interactively) |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |
| `--non-tty` | never prompt; resolve from flags or fail fast (agents/CI) |  |

JSON support: yes (`--json`)

## `capy connect`

Link an existing .env variable to a third-party provider

```
capy connect [provider] [options]
```

| Option | Description | Default |
|---|---|---|
| `--live` | use live mode (default: test) |  |
| `--var <name>` | which existing env var the connection describes |  |
| `--account <id>` | pick a specific provider account when multiple are configured |  |
| `--no-push` | record the link locally; do not push it to Capy |  |
| `--non-tty` | never prompt; resolve choices from flags or fail fast (agents/CI) |  |
| `--reauth` | pair with the provider again even if a usable session exists |  |
| `--base-url <url>` | dokploy import: dashboard URL |  |
| `--application <id>` | dokploy import: Application id (mutually exclusive with --compose) |  |
| `--compose <id>` | dokploy import: Compose service id (mutually exclusive with --application) |  |
| `--token-env <name>` | dokploy import: env var holding the API token |  |
| `--json` | emit machine-readable JSON instead of the human UI (import connectors) |  |
| `--dry-run` | dokploy import/discover: preview the plan only — resolve settings + read Dokploy, write/push nothing |  |
| `--discover` | dokploy: find every Dokploy service matching a repo under cwd, instead of one named --application/--compose |  |
| `-y, --yes` | dokploy import/discover: skip the confirmation prompt (import: --overwrite's clear/replace/import ask; discover: the real-run "proceed?" ask) — required non-interactively |  |
| `--overwrite` | dokploy import: set the branch's vars to EXACTLY Dokploy's set — clear names not in Dokploy, replace differing values, import new ones |  |
| `--environment <names>` | dokploy discover: restrict the plan to these Dokploy environment names, comma-separated (e.g. staging,preview) |  |

JSON support: yes (`--json`)

## `capy rotate`

Rotate a managed credential previously set up via `capy connect`

```
capy rotate [var] [options]
```

| Option | Description | Default |
|---|---|---|
| `--all` | rotate every managed credential in this project |  |
| `--no-push` | update .env only; do not push to Capy |  |
| `-y, --yes` | skip prompts; run rotate + push + deploy unattended (for CI/automation) |  |
| `--skip-prompts` | alias for --yes |  |
| `--non-tty` | never prompt; resolve choices from flags or fail fast (agents/CI) |  |
| `--provider <name>` | integration to promote an unmanaged var through (non-interactive) |  |

JSON support: no

## `capy lock`

Lock the local-only key (re-prompts the passphrase next time)

```
capy lock
```

_No options._

JSON support: no

## Error codes

Every refusal carries a stable `code` — branch on it, never on message text.

- `AUTH_FAILED`
- `NO_ENV_FILE`
- `NO_KEEP_FILE`
- `PERMISSION_DENIED`
- `MEMBERSHIP_REVOKED`
- `NETWORK_ERROR`
- `ENCRYPTION_ERROR`
- `DECRYPT_KEY_MISMATCH`
- `INVALID_FORMAT`
- `CONFLICT_RESOLUTION`
- `SERVICE_ERROR`
- `QUOTA_EXCEEDED`
- `PROJECT_NOT_FOUND`
- `BRANCH_NOT_FOUND`
- `NO_ACTIVE_BRANCH`
- `SNAPSHOT_NOT_FOUND`
- `NO_SECRETS`
- `DEPLOY_TOKEN_NOT_FOUND`
- `ORG_NOT_FOUND`
- `LOCAL_KEY_BACKEND_ERROR`
- `NO_MANAGED_KEYS`
- `NO_VARIABLES`
- `VARIABLE_NOT_FOUND`
- `NO_CONNECTORS`
- `DEV_LIVE_FIREWALL`
- `SYSTEM_STORE_ADMIN_ONLY`
- `SYSTEM_STORE_BAD_NAME`
- `SYSTEM_STORE_NEEDS_TTY`
- `PROJECT_NAME_RESERVED`
- `CANCELLED`
- `ROTATE_NOT_SUPPORTED_IMPORTED`
- `DOKPLOY_ENV_FILE_DISABLED`
- `DEPLOY_BRANCH_MISMATCH`
- `DEPLOY_BRANCH_UNKNOWN`
- `AGENTS_SETUP_NEEDS_TTY`
- `AGENTS_BLOCK_MALFORMED`
- `AGENTS_FILE_OUTSIDE_REPO`
- `DOKPLOY_TARGET_KEY_MISSING`
- `DOKPLOY_CONNECTOR_KEY_MISSING`
- `SYSTEM_STORE_REFERENCE_MISSING`
- `SYSTEM_STORE_REFERENCE_CHAIN`
- `DOKPLOY_STACK_QUOTES`
- `DOKPLOY_VERSION_UNKNOWN`
- `RUN_SECRETS_BLOB_INVALID`
- `RUN_PROJECT_KEY_INVALID`
- `DOKPLOY_VALUE_UNREPRESENTABLE`
- `DOKPLOY_VALUE_HAS_REFERENCE`
- `DOKPLOY_VALUE_INVALID`
- `DOKPLOY_AUTODEPLOY_OFF`
- `DOKPLOY_BRANCH_MISMATCH`
- `DOKPLOY_WATCH_PATHS_EXCLUDE_KEEP`
- `DOKPLOY_URL_INVALID`
- `DOKPLOY_SERVICE_NOT_FOUND`
- `TRANSPORT_NO_LOCAL_KEY`
- `TRANSPORT_KEY_FORMAT_UNSUPPORTED`
- `TRANSPORT_EXPIRED`
- `TRANSPORT_NOT_FOUND`
- `PAIRING_NOT_FOUND`
- `PAIRING_WRONG_USER`
- `PAIRING_NOT_READY`
- `PAIR_NO_KEYS`
- `PAIR_LOCAL_KEY_CONFLICT`
- `VAR_NOT_FOUND`
- `REMOVE_LOCAL_DRIFT`
- `REMOVE_NEEDS_TTY`
- `CI_DEPLOY_TARGETS_RECORD_FAILED`
- `DEPLOY_STALE_KEEP`
- `DEPLOY_TOKEN_UNTRACKED`

## Conventions

- **JSON**: Pass --json on any command whose supportsJson is true and parse stdout as JSON; prose (progress, prompts, errors) goes to stderr so stdout stays pure JSON.
- **Codes**: Branch only on the machine-readable `code` field (from --json output or a CapyError), never on human-readable message text — messages may be reworded without notice.

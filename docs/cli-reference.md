<!-- GENERATED FILE — do not hand-edit. Run `bun run docs:cli` to regenerate. -->

# capy CLI reference

Version `0.9.18`. Generated from `capy help --json`.

## Bare `capy`

Bare `capy` syncs a folder that is a Capy project. In a folder that is not one, in a terminal it asks how to set it up; with --json, --non-tty or no terminal it asks nothing: with questions left it refuses with INIT_INPUT_REQUIRED (exit 3) and one elicitation form, and when every answer is given as a flag it creates the project and first branch, links the folder (keep.lock) and pushes the .env. Linking to an existing project always needs --branch naming one of that project's branches.

```
capy [options]
```

| Option | Description | Default |
|---|---|---|
| `--org <id|name>` | the organization to set this folder up in (asked when you belong to more than one) |  |
| `--project <id|name>` | link this folder to an existing project in the organization, or "new" to create one |  |
| `--name <name>` | the name of a new project |  |
| `--branch <name>` | the first branch of a new project (offered by default: development), or the branch of an existing project to use; a Capy branch works like a git branch |  |
| `--protected [yes|no]` | whether the first branch is protected (invite-only) |  |
| `--no-protected` | Create it open to the project |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |
| `--non-tty` | same as --json: never ask, and answer in JSON (agents/CI) |  |

JSON support: yes (`--json`)

## Commands

## `capy run`

Run a command with decrypted secrets (sets CAPY_RUN=1 for that command)

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

Inspect and edit secrets in an interactive TUI, or set one variable from a hidden prompt or a piped value

```
capy edit [name] [options]
```

| Option | Description | Default |
|---|---|---|
| `--no-push` | with a name: write .env only; do not push to Capy |  |
| `--json` | emit machine-readable JSON instead of the human UI (piped value) |  |
| `--non-tty` | treat stdin as not a terminal; never prompt (agents/CI) |  |
| `--pr` | create a PR with the keep.lock change (answers the prompt) |  |
| `--no-pr` | do not create a PR with the keep.lock change |  |
| `--pr-base <branch>` | base branch for the PR (answers the prompt) |  |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

## `capy branch`

List secret branches

```
capy branch [options]
```

| Option | Description | Default |
|---|---|---|
| `-D <name>` | Delete a branch |  |
| `--yes` | skip the confirmation prompt |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |
| `--non-tty` | treat stdin as not a terminal; never prompt (agents/CI) |  |

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
| `--non-tty` | treat stdin as not a terminal; differences from Capy stop the checkout with the conflict_id (agents/CI) |  |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: yes (`--json`)

## `capy push`

Push encrypted values to Keep

```
capy push [options]
```

| Option | Description | Default |
|---|---|---|
| `--non-tty` | treat stdin as not a terminal; differences from Capy stop the push with the conflict_id (agents/CI) |  |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: no

## `capy deploy`

Set up secret delivery — token + docs (existing) or target deploy

```
capy deploy [target] [options]
```

| Option | Description | Default |
|---|---|---|
| `--target <id>` | adapter id; requires --yes (CI mode) |  |
| `--yes` | skip all prompts (CI); any difference between the folder and Capy stops the deploy with exit 3 |  |
| `--dry-run` | preflight + show plan, push nothing (target mode) |  |
| `--force` | redeploy even when keep.lock is unchanged — bumps keep.lock to trigger CI |  |
| `--edit` | re-enter the picker for an existing target |  |
| `--connect` | force target mode (skip the token+docs path) |  |
| `--platform <id>` | skip platform picker (token+docs flow; e.g. github-actions, vercel) |  |
| `--mode <mode>` | skip mode picker: "target" or "token" (also accepts the old "connector" spelling) |  |
| `--scope <scope>` | gh-actions: "repo" or "env" |  |
| `--env-name <name>` | gh-actions: env name when --scope env |  |
| `--no-deploy` | write and verify the target, but skip the platform deploy/redeploy (target mode) |  |
| `--replace-sensitive` | vercel: allow replacing a value Vercel holds as sensitive, for the first time for a target, without asking |  |
| `--json` | describe the route (unanswered stops + any known branch problem) as JSON instead of travelling it |  |
| `--discover` | dokploy/vercel: find the services that match Capy projects and print JSON (never prompts) |  |
| `--plan <file>` | dokploy/vercel --discover: the plan file to check (see schemas.deploy_dokploy_plan and schemas.deploy_vercel_plan in `capy help --json`) |  |
| `--confirm <plan_id>` | dokploy/vercel --discover: write the plan that --dry-run printed (one PR per repo) |  |
| `--base-url <url>` | dokploy --discover: the Dokploy dashboard URL (else the org system variable _CONNECTOR_DOKPLOY_BASE_URL) |  |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

Mode: `capy deploy dokploy --discover`

Find the Dokploy services that match Capy projects, check a plan for them, and write the deploy targets as one pull request per repo. Pushes no values.

- Flags: `--discover`, `--plan`, `--confirm`, `--base-url`, `--dry-run`, `--json`
- Always prints JSON: yes
- Dry run: yes
- Plan schema: `schemas.deploy_dokploy_plan` in `capy help --json`

### `capy deploy revoke`

Revoke a deploy token

```
capy deploy revoke <deployId> [options]
```

| Option | Description | Default |
|---|---|---|
| `--non-tty` | treat stdin as not a terminal; differences from Capy stop the revoke with the conflict_id (agents/CI) |  |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: no

### `capy deploy list`

List deploy tokens for this project

```
capy deploy list [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

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
| `--non-tty` | treat stdin as not a terminal; differences from Capy stop the removal with the conflict_id (agents/CI) |  |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

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

Dry run: yes (`--dry-run`)

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

Pair this device via Keep; nothing is installed until the one-time code Keep shows the approver is entered here (in agent mode the approving account must also match --email)

```
capy pair [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |
| `--force` | overwrite a different local key already on this machine |  |
| `--wait` | agent mode: wait for the pending pairing to be approved (returns only when something changes, up to 9 minutes: exits 3 with PAIR_CODE_REQUIRED once approved, PAIR_LINK_RENEWED with a new link when the old one expired, or PAIR_STILL_WAITING at the 9-minute cap; give it a tool timeout of at least 10 minutes and run it again) |  |
| `--cancel` | agent mode: drop the pending pairing |  |
| `--code <code>` | agent mode, with --wait: the one-time code Keep shows the person who approved; ask them for it |  |
| `--transport` | receive this project's keys from Keep (/transport/pair); once per machine. Without it, pair only signs in a machine that already has its keys (/pair); a machine with no keys asks for them anyway |  |
| `--signup` | a new project: the approver creates the organization in Keep and this machine gets its first keys |  |
| `--org <id>` | prefer this organization when your account has several and the folder does not say (no keep.lock); the organization you approve in Keep decides |  |
| `--title <text>` | short summary of why you are pairing, shown as the Keep pairing heading (max 120 chars) |  |
| `--description <text>` | what you will do once paired, shown under it on the Keep pairing page (max 600 chars) |  |

JSON support: yes (`--json`)

## `capy setup`

Set this folder up with Capy in one command, for agents: pair, choose the organization, project and branch, write the agent instructions, and list the integrations found. Always answers in JSON; run it again after every stop until it says "setup": "complete"

```
capy setup [options]
```

| Option | Description | Default |
|---|---|---|
| `--code <code>` | the one-time code Keep shows the person who approved the pairing; ask them for it |  |
| `--org <id|name>` | the organization to set this folder up in (asked when you belong to more than one) |  |
| `--project <id|name>` | link this folder to an existing project in the organization, or "new" to create one |  |
| `--name <name>` | the name of a new project |  |
| `--branch <name>` | the first branch of a new project (offered by default: development), or the branch of an existing project to use |  |
| `--protected [yes|no]` | whether the first branch is protected (invite-only) |  |
| `--no-protected` | Create it open to the project |  |
| `--json` | accepted for symmetry: setup always answers in JSON |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

## `capy kick`

Remove a teammate from this organization

```
capy kick <email> [options]
```

| Option | Description | Default |
|---|---|---|
| `--yes` | skip the confirmation question |  |
| `--non-tty` | same as --json: never ask, and answer in JSON (agents/CI) |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

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
capy org [options]
```

| Option | Description | Default |
|---|---|---|
| `--non-tty` | treat stdin as not a terminal; differences from Capy stop the switch with the conflict_id (agents/CI) |  |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: no

## `capy project`

Create, delete or restore a project in the active organization

```
capy project
```

_No options._

JSON support: no

### `capy project create`

Create a project and its first branch in the active organization (owners and admins only; does not link this folder)

```
capy project create [name] [options]
```

| Option | Description | Default |
|---|---|---|
| `--branch <name>` | the first branch; a Capy branch works like a git branch (offered by default: development) |  |
| `--protected <yes|no>` | whether the first branch is protected (invite-only) |  |
| `--non-tty` | same as --json: never ask, and answer in JSON (agents/CI) |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

### `capy project delete`

Delete a project (owners and admins only; hidden, not destroyed; an owner or admin can restore it)

```
capy project delete <name-or-id> [options]
```

| Option | Description | Default |
|---|---|---|
| `--force` | delete even if the project has live deploy tokens (those deploys stop on their next restart) |  |
| `--yes` | skip the confirmation question |  |
| `--non-tty` | same as --json: never ask, and answer in JSON (agents/CI) |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

### `capy project restore`

Restore a deleted project (owners and admins only)

```
capy project restore <name-or-id> [options]
```

| Option | Description | Default |
|---|---|---|
| `--yes` | skip the confirmation question |  |
| `--non-tty` | same as --json: never ask, and answer in JSON (agents/CI) |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

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

List organization users and their project access

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
| `--deleted` | also list deleted projects, marked as deleted, with the date (owners and admins only) |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

### `capy projects rename`

Rename a project and update its keep.lock: this folder's project, or the one --project-id names (owners and admins only)

```
capy projects rename [new-name] [options]
```

| Option | Description | Default |
|---|---|---|
| `--project-id <id>` | rename the project with this id instead of the one this folder belongs to |  |
| `--non-tty` | same as --json: never ask, and answer in JSON (agents/CI) |  |
| `--json` | emit machine-readable JSON instead of the human UI |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

## `capy secrets`

List every secret name across the active organization, grouped by value (read-only, never shows a value)

```
capy secrets [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |
| `--project <name>` | only rows with a location in this project |  |
| `--project-id <id>` | only rows with a location in the project with this id |  |
| `--branch <name>` | only rows with a location on this branch |  |
| `--name <NAME>` | only rows with exactly this secret name |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

### `capy secrets set`

Set one secret to a new value (read from stdin) in several locations and open keep.lock PRs. Never prompts.

```
capy secrets set <name> [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |
| `--row <row_id>` | change this row of that name (repeatable; ids from `capy secrets --name NAME --json`) | `[]` |
| `--all-rows` | change every row of that name |  |
| `--exclude <project:branch>` | leave this location out (repeatable) | `[]` |
| `--no-pr-for <owner/name>` | do not open a PR in this repo (repeatable) | `[]` |
| `--no-pr` | do not open any PR |  |
| `--pr-repo <project_id=owner/name[/folder]>` | the repo a project's PR goes to, when the project is linked to more than one (repeatable) | `[]` |
| `--confirm <plan_id>` | run the plan that --dry-run printed (required for a real run) |  |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

### `capy secrets deploy`

Deploy the Dokploy targets of one or more secrets with no project folder, and open one keep.lock PR per target. Never prompts.

```
capy secrets deploy <names...> [options]
```

| Option | Description | Default |
|---|---|---|
| `--json` | emit machine-readable JSON instead of the human UI |  |
| `--row <row_id>` | deploy this row of a name (repeatable; ids from `capy secrets --name NAME --json`) | `[]` |
| `--all-rows` | deploy every row of those names |  |
| `--exclude <project:branch>` | leave this location out (repeatable) | `[]` |
| `--pr-repo <project_id=owner/name[/folder]>` | the repo a project is deployed from and its PR goes to, when the project is linked to more than one (repeatable) | `[]` |
| `--confirm <plan_id>` | run the plan that --dry-run printed (required for a real run) |  |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

## `capy grant-branch`

Grant a user wildcard access to a protected branch

```
capy grant-branch <email> <project> <branch>
```

_No options._

JSON support: no

## `capy revoke-branch`

Revoke a user's wildcard access to a protected branch

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
| `--no-push` | write to .env only; do not push to Capy |  |
| `-f, --force` | overwrite existing values without prompting |  |
| `--non-tty` | never prompt; resolve from flags or fail fast (agents/CI) |  |
| `--json` | emit machine-readable JSON instead of the human UI (piped value) |  |
| `--pr` | create a PR with the keep.lock change (answers the prompt) |  |
| `--no-pr` | do not create a PR with the keep.lock change |  |
| `--pr-base <branch>` | base branch for the PR (answers the prompt) |  |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

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
| `--pr` | create a PR with the keep.lock change (answers the prompt) |  |
| `--no-pr` | do not create a PR with the keep.lock change |  |
| `--pr-base <branch>` | base branch for the PR (answers the prompt) |  |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

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
| `--token-env <name>` | dokploy/vercel import: env var holding the API token |  |
| `--project <project>` | vercel import: Vercel project id or name (under --discover: the project that wins a mapping collision) |  |
| `--team <team>` | vercel import/discover: Vercel team slug or id (default: the token's only team) |  |
| `--json` | emit machine-readable JSON instead of the human UI (import connectors) |  |
| `--dry-run` | dokploy import/discover: preview the plan only — resolve settings + read Dokploy, write/push nothing |  |
| `--discover` | dokploy/vercel: find every Dokploy service / Vercel project matching a repo under cwd, instead of one named --application/--compose/--project |  |
| `-y, --yes` | dokploy import/discover: skip the confirmation prompt (import: --overwrite's clear/replace/import ask) — discover never prompts and needs --yes to write |  |
| `--overwrite` | dokploy import: set the branch's vars to EXACTLY Dokploy's set — clear names not in Dokploy, replace differing values, import new ones |  |
| `--environment <names>` | dokploy/vercel discover: restrict the plan to these environment names, comma-separated (e.g. staging,preview); vercel import: which Vercel environment to read (default: the current branch's name) |  |
| `--import-environment <environment[=branch]>` | vercel discover: import only this environment, on a branch of the same name or on <branch> (repeatable; e.g. preview=staging) | `[]` |
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: yes (`--json`)

Dry run: yes (`--dry-run`)

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
| `--resolve <NAME=pinned|local|remote|delete>` | choose a source: local or remote for a folder-only setup, also pinned or delete for a Git-tracked lock; NAME@TARGET=local|remote for a platform value (repeatable, needs --conflict) | `[]` |
| `--conflict <conflict_id>` | the conflict_id a conflict returned: binds --resolve to what was seen |  |

JSON support: no

## `capy lock`

Lock the local-only key (re-prompts the passphrase next time)

```
capy lock
```

_No options._

JSON support: no

## Schemas

JSON Schemas of the files commands read, as published under `schemas` in `capy help --json`.

### `deploy_dokploy_plan`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "capy deploy dokploy --discover plan",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "version",
    "entries"
  ],
  "properties": {
    "version": {
      "const": 1
    },
    "entries": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "project_id",
          "branch",
          "service_id",
          "git_branch",
          "vars"
        ],
        "properties": {
          "project_id": {
            "type": "string",
            "minLength": 1,
            "description": "Capy project id"
          },
          "branch": {
            "type": "string",
            "minLength": 1,
            "description": "Capy branch the target ships from"
          },
          "service_id": {
            "type": "string",
            "minLength": 1,
            "description": "Dokploy application or compose service id"
          },
          "git_branch": {
            "type": "string",
            "minLength": 1,
            "description": "git branch the Dokploy service tracks (the CI deploy PR base)"
          },
          "vars": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string",
              "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
            },
            "description": "Variable names the target delivers; each must exist on the Capy branch"
          }
        }
      }
    }
  }
}
```

### `deploy_vercel_plan`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "capy deploy vercel --discover plan",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "version",
    "entries"
  ],
  "properties": {
    "version": {
      "const": 1
    },
    "entries": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "project_id",
          "branch",
          "service_id",
          "git_branch",
          "vars"
        ],
        "properties": {
          "project_id": {
            "type": "string",
            "minLength": 1,
            "description": "Capy project id"
          },
          "branch": {
            "type": "string",
            "minLength": 1,
            "description": "Capy branch the target ships from"
          },
          "service_id": {
            "type": "string",
            "minLength": 1,
            "description": "Vercel environment id from the discovery facts (a project plus one of its environments)"
          },
          "git_branch": {
            "type": "string",
            "minLength": 1,
            "description": "git branch the Vercel project deploys from (the CI deploy PR base)"
          },
          "vars": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string",
              "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"
            },
            "description": "Variable names the target delivers; each must exist on the Capy branch"
          }
        }
      }
    }
  }
}
```

## Error codes

Every refusal carries a stable `code` — branch on it, never on message text.

- `AUTH_FAILED`
- `NO_ENV_FILE`
- `NO_KEEP_FILE`
- `PERMISSION_DENIED`
- `GITIGNORE_NOT_IN_CHECKOUT`
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
- `CANNOT_DELETE_CURRENT_BRANCH`
- `NO_ACTIVE_BRANCH`
- `UNCOMMITTED_CHANGES`
- `UNPUSHED_CHANGES`
- `BRANCH_STATE_INCONSISTENT`
- `SNAPSHOT_NOT_FOUND`
- `NO_SECRETS`
- `DEPLOY_TOKEN_NOT_FOUND`
- `INVALID_CREDENTIAL_GENERATION`
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
- `FIRST_BRANCH_NEEDS_ADMIN`
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
- `RUN_DEPLOY_KEY_INVALID`
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
- `PAIR_APPROVAL_PENDING`
- `PAIR_STILL_WAITING`
- `PAIR_NOT_PENDING`
- `PAIR_EXPIRED`
- `PAIR_LINK_RENEWED`
- `PAIR_DENIED`
- `PAIR_ACCESS_DENIED`
- `PAIR_TRANSPORT_REQUIRED`
- `PAIR_SCOPE_REQUIRED`
- `PAIR_CODE_REQUIRED`
- `PAIR_CODE_MISMATCH`
- `PAIR_CODE_FAILED`
- `VAR_NOT_FOUND`
- `REMOVE_NEEDS_TTY`
- `SECRETS_STALE_BASE`
- `SECRETS_CONFLICT`
- `SECRETS_CONFLICT_STALE`
- `SECRETS_RESOLVE_INVALID`
- `SECRETS_RESOLVE_NEEDS_CONFLICT`
- `REMOVE_LOCAL_DRIFT`
- `KEEP_PR_NOT_GIT_REPO`
- `KEEP_PR_NO_GITHUB_REMOTE`
- `KEEP_PR_GH_UNAVAILABLE`
- `KEEP_PR_BASE_UNRESOLVED`
- `KEEP_PR_READ_FAILED`
- `KEEP_PR_COMMIT_FAILED`
- `KEEP_PR_BRANCH_FAILED`
- `KEEP_PR_CREATE_FAILED`
- `KEEP_LOCK_PROJECT_MISMATCH`
- `KEEP_LOCK_NOT_ON_BASE`
- `CI_DEPLOY_TARGETS_RECORD_FAILED`
- `DEPLOY_STALE_KEEP`
- `DEPLOY_TOKEN_UNTRACKED`
- `VERCEL_TOKEN_MISSING`
- `VERCEL_CONNECTOR_KEY_MISSING`
- `VERCEL_AUTH_FAILED`
- `VERCEL_API_ERROR`
- `VERCEL_RATE_LIMITED`
- `VERCEL_TEAM_REQUIRED`
- `VERCEL_TEAM_NOT_FOUND`
- `VERCEL_PROJECT_REQUIRED`
- `VERCEL_PROJECT_NOT_FOUND`
- `VERCEL_ENVIRONMENT_REQUIRED`
- `VERCEL_ENVIRONMENT_NOT_FOUND`
- `VERCEL_CONFIRMATION_REQUIRED`
- `VERCEL_MAPPING_COLLISION`
- `VERCEL_ENVIRONMENT_DUPLICATE`
- `VERCEL_BRANCH_DUPLICATE`
- `VERCEL_IMPORT_ENVIRONMENT_NOT_APPLICABLE`
- `VERCEL_TARGET_KEY_MISSING`
- `VERCEL_TOKEN_REJECTED`
- `VERCEL_NO_ACCESS`
- `VERCEL_NETWORK_ERROR`
- `VERCEL_VERIFY_MISMATCH`
- `VERCEL_OPTIONS_INVALID`
- `VERCEL_SPLIT_NOT_RESTORED`
- `VERCEL_URL_INVALID`
- `VERCEL_SENSITIVE_REPLACE_UNCONFIRMED`
- `VERCEL_PROJECT_NOT_GITHUB`
- `VERCEL_ENV_LIST_TRUNCATED`
- `VERCEL_PREVIEW_DEPLOYMENTS_UNAVAILABLE`
- `CAPY_VALUE_KEPT`
- `CONNECTOR_OPTION_NOT_APPLICABLE`
- `CONNECTOR_PUSH_FAILED`
- `CONNECTOR_FOLDER_NOT_INITIALIZED`
- `CONNECTOR_PROJECT_LOOKUP_FAILED`
- `CONNECTOR_PROJECT_NAME_EXISTS`
- `CONNECTOR_PROJECT_NOT_FOUND`
- `CONNECTOR_INIT_FAILED`
- `CONNECTOR_PROJECT_NAME_TOO_LONG`
- `CONNECTOR_KEY_RESOLUTION_FAILED`
- `CONNECTOR_FOLDER_DIRTY`
- `CONNECTOR_BRANCH_PROTECTED`
- `CONNECTOR_KEEP_MISSING`
- `CONNECTOR_CHECKOUT_FAILED`
- `CONNECTOR_REMOTE_UNREADABLE`
- `CONNECTOR_COMMIT_WOULD_MIX`
- `CONNECTOR_COMMIT_BRANCH_INVALID`
- `CONNECTOR_COMMIT_BRANCH_EXISTS`
- `CONNECTOR_GIT_IDENTITY_MISSING`
- `CONNECTOR_COMMIT_FAILED`
- `EDIT_NEEDS_TTY`
- `EDIT_STDIN_LOCAL_ONLY`
- `STDIN_EMPTY`
- `STDIN_TOO_LARGE`
- `ADD_STDIN_ONE_NAME`
- `ADD_VAR_EXISTS`
- `WEB_MODE_REMOVED`
- `KEEP_LOCK_REPO_MISMATCH`
- `SECRET_AMBIGUOUS`
- `PR_REPO_AMBIGUOUS`
- `PLAN_CHANGED`
- `PROJECT_KIND_UNSUPPORTED`
- `PLAN_CONFIRM_REQUIRED`
- `SECRET_NOT_FOUND`
- `SECRETS_NOTHING_SELECTED`
- `SECRETS_PARTIAL`
- `PROJECT_DELETED`
- `PROJECT_DELETE_OWNER_ONLY`
- `PROJECT_HAS_LIVE_DEPLOY_TOKENS`
- `PROJECT_NOT_DELETED`
- `SYSTEM_STORE_IMMUTABLE`
- `PROJECT_AMBIGUOUS`
- `CONFIRMATION_REQUIRED`
- `PROJECT_NAME_REQUIRED`
- `PROJECT_NAME_INVALID`
- `PROJECT_NAME_EXISTS`
- `BRANCH_NAME_REQUIRED`
- `BRANCH_NAME_INVALID`
- `BRANCH_CREATE_FAILED`
- `BRANCH_PROTECTION_REQUIRED`
- `BRANCH_PROTECTION_INVALID`
- `KEEP_LOCK_UPDATE_FAILED`
- `ORG_SELECTION_REQUIRED`
- `REPO_LINKS_UNSUPPORTED`
- `DRY_RUN_UNSUPPORTED`
- `GITHUB_TIMEOUT`
- `RATE_LIMITED`
- `GITHUB_RATE_LIMITED`
- `SERVICE_NOT_FOUND`
- `DUPLICATE_ENTRY`
- `TARGET_EXISTS`
- `NO_REPO_LINK`
- `REPO_MISMATCH`
- `PLAN_FILE_UNREADABLE`
- `PLAN_INVALID`
- `PLAN_REQUIRED`
- `DISCOVER_UNSUPPORTED_TARGET`
- `DISCOVER_PARTIAL`
- `DEPLOY_BATCH_PARTIAL`
- `DEPLOY_NOTHING_TO_DEPLOY`
- `DEPLOY_VARS_MISSING`
- `DEPLOY_REMOVES_ALL_VARS`
- `DEPLOY_PREFLIGHT_FAILED`
- `DEPLOY_PUSH_FAILED`
- `SECRET_NOT_PERSISTED`
- `KEEP_WRITE_CONFLICT`
- `REPO_ORG_MISMATCH`
- `INIT_INPUT_REQUIRED`
- `PROJECT_LOOKUP_FAILED`
- `SETUP_PENDING_MISMATCH`
- `MEMBER_NOT_FOUND`

## Conventions

- **JSON**: Pass --json on any command whose supportsJson is true and parse stdout as JSON; prose (progress, prompts, errors) goes to stderr so stdout stays pure JSON.
- **Codes**: Branch only on the machine-readable `code` field (from --json output or a CapyError), never on human-readable message text — messages may be reworded without notice.
- **Conflicts**: Every command that writes from a folder (edit, add, remove, connect, rotate, push, checkout, org, deploy, deploy revoke, deploy targets-remove) runs bare `capy` first; `checkout -b` is the one exception (a new branch carries the uncommitted values of the folder). Off a terminal, if the folder and Capy differ on any variable, nothing is written, the exit code is 3, and stdout is {ok:false, code:"SECRETS_CONFLICT", conflict_id, conflicts:[{name, project, branch, type, pinned, local, remote}]} (fingerprints only, never values; a Dokploy value has {name, target, pinned, local, remote}). Folder-only rows omit pinned and list their available choices. Choosing an absent side removes that name. Ask the person to select from the choices for each row, then rerun the same command with --resolve NAME=<choice> for every row (NAME@TARGET=local|remote for a Dokploy value) and --conflict <conflict_id>. A state that moved since is SECRETS_CONFLICT_STALE with the fresh rows. There is no resolve-all. `secrets set` and `secrets deploy` take the same --resolve and --conflict for a location that changed since its row was listed.
- **Organizations**: These commands work on an organization, not on a folder, and run with no project folder: users, grant-branch, revoke-branch, invite, kick, projects, projects rename --project-id, project create, project delete, project restore, secrets, secrets set, secrets deploy, system. The organization is the one in the keep.lock of the folder when it has one, else the only organization the account belongs to. With several organizations, no keep.lock and nobody to ask, `users --json`, `projects rename` and `project create|delete|restore` refuse with ORG_SELECTION_REQUIRED and `orgs:[{id, name}]`: show them to the person and stop.
- **Elicitation**: A refusal with exit code 3 can carry an `elicitation` next to its `code`: a question for the human, never for you. Write `display` (a markdown table) in your reply exactly as given, without shortening or reordering it and never inside the question. Then ask the short `question` as an elicitation with your question tool: one question per field, using the field's own `question` followed by its `description` when it has them, and its `options` or `default` as the choices; without a question tool, end your reply with the `question` and the human answers in chat. kind "confirm" is a yes/no ({kind, question, details, display, answer:{yes}}): ask the human; on yes, run the command in `answer.yes`; on no, stop. kind "form" asks for values ({kind, question, details, display, fields:[{name, type, pattern, question?, default?, description?, options?:[{value, label}]}], answer:{rerun}}): ask the human for each field, then run `answer.rerun` with the values filled in. A field with `options` is a choice: the human picks a `label`, and you fill in its `value`. A field without `options` is typed in. With a `default`, offer exactly two choices, the `default` and "Cancel"; the human types any other answer in your question tool's own free-text answer. With no `default`, leave it out of the question tool: after the other questions, ask its `question` in chat and wait for the human to type the answer. On "Cancel", stop. `details` holds names and ids only, never a value. Today: `capy project restore` without --yes refuses with CONFIRMATION_REQUIRED and a confirm (details: {org:{id,name}, project:{id,name,deleted_at}}); `capy project delete` without --yes refuses with CONFIRMATION_REQUIRED and a confirm (details: {org:{id,name}, project:{id,name}, branches:[name], variables:[{name, branches:[name]}], live_deploy_tokens:[{deploy_id, label}], unavailable?:["branches"|"variables"]}); `capy project create` missing the name, `--branch` or `--protected` in agent mode refuses with PROJECT_NAME_REQUIRED, BRANCH_NAME_REQUIRED or BRANCH_PROTECTION_REQUIRED and a form (fields: name, branch, protected (options yes/no); details: {org:{id,name}}); `capy project delete` / `project restore` with a name several projects share refuses with PROJECT_AMBIGUOUS and a form with one `project` field whose options are the projects (details: {org:{id,name}, matches:[{id, name, created_at, variables}]}); `capy kick <email>` without --yes refuses with CONFIRMATION_REQUIRED and a confirm (details: {org:{id,name}, member:{email}}); `capy projects rename` with no name refuses with PROJECT_NAME_REQUIRED and a form with one `name` field (details: {org:{id,name}, project:{id,name}}); `capy secrets set` / `capy secrets deploy` with a project that is linked to more than one repo refuses with PR_REPO_AMBIGUOUS and a form with one field per such project whose options are its repos (details: {projects:[{id, name, repos:[owner/name[/folder]]}]}); pass the same `--pr-repo` again on the run with `--confirm`. `capy branch -D NAME` without --yes in agent mode refuses with CONFIRMATION_REQUIRED and a confirm (details: {branch:{name}}); `capy remove NAME...` without --yes refuses with REMOVE_NEEDS_TTY and a confirm (details: {branch, variables:[name], removing_all}); `capy system rm NAME` without --yes refuses with SYSTEM_STORE_NEEDS_TTY and a confirm (details: {name, org?}); `capy connect vercel|dokploy` with --overwrite or --discover and without --yes refuses with VERCEL_CONFIRMATION_REQUIRED or DOKPLOY_CONFIRMATION_REQUIRED (exit 3) and a confirm whose `display` lists the terminal's lines (details: {import, replace, clear} or {folders}); `capy connect vercel` with nobody to ask refuses with VERCEL_TEAM_REQUIRED (form, one `team` field whose options are the team slugs; details: {teams:[{id, slug}]}), VERCEL_PROJECT_REQUIRED (form, one typed `project` field; details: {}) or VERCEL_ENVIRONMENT_REQUIRED (form, one `environment` field whose options are the environments; details: {branch, environments:[name]}), all exit 3; `capy connect dokploy` refuses with DOKPLOY_TARGET_AMBIGUOUS (form, one `target` field: each option's label is a saved target and its value that target's flags; details: {targets:[name]}) or DOKPLOY_SETTINGS_MISSING (form asking only what is missing: `base_url`, then `source` (option values `--application` / `--compose`) and `service_id`; details: {}); fill the values into `answer.rerun` as they are. `capy agents` (or `capy agents --remove`) without --yes in agent mode refuses with AGENTS_SETUP_NEEDS_TTY and a confirm asking the terminal's question (details: {files:[{path, action}]}); `capy checkout NAME -b --json` without --protected or --no-protected refuses with BRANCH_PROTECTION_REQUIRED and a form with one `protected` field whose option values are the flags `--protected` and `--no-protected` (details: {branch:{name}}); its `answer.rerun` uses --non-tty, because `-b --json` only describes the route. kind "link" hands the human a page to approve on ({kind, url, code, fingerprint?, purpose, expires_at, qr?:{text?, image?:{mime_type, file, data_uri?}}, instructions, answer:{wait}}): write the `url` as a clickable link, with the `code`, the `fingerprint` (the page shows the same one) and `expires_at`, as plain text, every time a link is shown (the `qr`, as `conventions.pairing` says, is only an addition, never the only way), then run `answer.wait` at once in the foreground (it can take up to 9 minutes, so give it a tool timeout of at least 10 minutes), and run it again whenever it exits 3 with PAIR_STILL_WAITING or your tool stopped it early; when it exits 3 with PAIR_LINK_RENEWED the old link expired and the elicitation is a new link: show it to the human the same way and run its `answer.wait` again. Its `instructions` say the same. Today `capy pair` in agent mode asks nothing up front (no email, no keys choice: on a machine with no keys it asks for them, and Keep decides after sign-in between the organization keys and a new organization); it refuses with PAIR_APPROVAL_PENDING and a link; once the human approves, the wait refuses with PAIR_CODE_REQUIRED (or PAIR_CODE_MISMATCH after a wrong code) and a form (field: code; details: {attempts_left?}) for the one-time code Keep shows the human; never fill in the code yourself. Bare `capy` in a folder that is not a project, in agent mode, with questions left refuses with INIT_INPUT_REQUIRED and one form that asks only what is unanswered: org (options: the organizations; asked first and alone when there are several), project (options: the existing projects, and `new`), then for a new project name, branch and protected (options yes/no), and for an existing project branch (options: that project's branches, never chosen for the human even when there is one), or, when that project has no branches yet, branch for its first one (default development; the rerun creates it open to the project); its `display` is the whole summary, so after the human answers, run `answer.rerun` with no further confirmation (details: {org?, orgs?, projects?, project?, branches?, new_project_fields?, variables}; `variables` is a count). Never answer it yourself and never add --yes on your own.

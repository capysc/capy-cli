# `--web` parity: the partition

Phase 0 output. Every interactive command gets a `--web` twin that serves a
compiled screen instead of an `inquirer` prompt. This file says who owns what,
so agents working in parallel never touch the same file.

## The rule that decides the partition

**Ownership is by FILE, never by command.** Several commands share files —
`connectors/shared.ts` is imported by connect, rotate and add; `orgCreation.ts`
by org and capy — so one-agent-per-command puts two agents in one file. The
clusters below are closed under "imports each other".

`errorScreen.ts` is deliberately excluded from every parcel: 13 files import
it, so it is not a flow, it is the global error display. It is converted last,
alone, once the flows have settled.

## The reference implementation

`src/ui/syncConflictScreen.ts` + `tests/ui/syncConflictScreen.test.ts`.

It is the only converted flow and it is the template. Follow it exactly:

- build the payload in a `buildXData(params, nonce)` function, exported so a
  test can assert its shape without standing a server up
- serve with `runBrowserWizard({ firstScreen: { html: '', standalone: true },
  renderFirst: (nonce) => renderScreen('screen-name', buildXData(p, nonce)) })`
- `standalone: true` because a compiled screen is a whole document; advancing
  is a reload, not an innerHTML swap
- refuse a malformed submit inline (`return { error: '…' }`) rather than
  applying a guess — an answer the screen cannot produce did not come from the
  screen
- strip ANSI from anything the terminal formatted before it reaches a payload
- carry the CLI's own wording verbatim; never reword a label for the browser

## What "done" means for a parcel

1. Every prompt in the parcel's commands has a `--web` path.
2. The CLI's `stops[]` is built by the command, not the screen, and the same
   array is what `--json` emits. See `src/core/branchCreatePlan.ts`.
3. A unit test on `buildXData` — shape, edge cases, no secret value in the
   payload.
4. **A browser test in `tests/ui/browserFlow.e2e.test.ts` that clicks the real
   page.** Not optional. Three inventions this session survived weeks of
   careful commenting and died on the first click; a flow with no browser test
   is a flow nobody has run.
5. `bash tests/run-tests.sh` green, `bunx tsc --noEmit` clean, deps still 6.

## Parcels

| # | Branch | Files owned | Screens | Prompts |
|---|---|---|---|---|
| P1 | `web/connectors` | `connectCommand.ts`, `rotateCommand.ts`, `connectors/*` | connect-provider, connect-setup, connect-live-gate, connect-overwrite, connect-result, rotate-plan-confirm, rotate-progress | 14 |
| P2 | `web/deploy` | `deployCommand.ts`, `deployTokenCommand.ts` | deploy-destination, deploy-target-setup, deploy-plan-confirm, deploy-targets, deploy-tokens, deploy-run-result | 20 |
| P3 | `web/org-onboarding` | `orgCommand.ts`, `orgCreation.ts`, `byocCommand.ts`, `ui/onboardingWeb.ts`, `ui/selectWeb.ts` | create-organization, local-onboarding, switch-organization, byoc-connect, local-passphrase-unlock | 16 |
| P4 | `web/init-sync` | `capyCommand.ts`, `statusCommand.ts` | init-wizard, sync-status, sync-result, secret-commit-review | 7 |
| P5 | `web/secrets` | `editCommand.ts`, `addCommand.ts`, `decryptCommand.ts`, `exportCommand.ts`, `ui/editScreen.ts` | secret-table, secret-value-editor, secret-intake, seed-phrase-decrypt | 3 |
| P6 | `web/members` | `inviteCommand.ts`, `kickCommand.ts` | invite-teammate, redeem-invite, org-members, member-branch-access | 3 |
| P7 | `web/branches` | `checkoutCommand.ts` | branch-create, branch-list | 1 |
| P8 | `web/recovery` | `recoverCommand.ts`, `endRecoverCommand.ts`, `transportCommand.ts` | recover-master-key, end-recover-cleanup, transport-machine | 3 |
| — | (coordinator, last) | `ui/errorScreen.ts` + its 13 call sites | the blocked/error views | — |

`capyCommand.ts` is P4's alone even though the sync-conflict work already
touched it: it is the largest command file and the one most likely to conflict.

## Trainstops

A command that asks more than one question draws a rail. The rail is the CLI's:
the command computes the whole route before opening anything, and the screen
renders it. A screen may say where it is STANDING and nothing else.

Stops carry `detail` and, where a step is something the user does by hand,
`manual`. Both come from the payload. Seven screens' fixtures assert these
today because no command emits them — closing that is part of each parcel.

Cross-command journeys (init → connect → deploy) are Phase 3, not a parcel.

## Hard constraints

- **Never** launch the developer's browser. `CAPY_WEB_NO_OPEN=1` in every test.
  The CLI honours it; `open: !process.env.CAPY_WEB_NO_OPEN`.
- No new runtime dependency. Currently 6.
- No secret VALUE in a payload — snippets only, the rule the TTY tables follow.
  A recovery phrase renders in the page and never travels back.
- `--web` is agent-only. It must not appear in human-facing docs.
- Run `bash tests/run-tests.sh`, never bare `bun test` over several dirs —
  Bun's `mock.module()` leaks across files in one process and invents failures.
- UI source lives in the monorepo (`packages/ui`), not here. This repo carries
  only the compiled `generated.ts`. If a screen needs changing, change it there
  and run `bun run sync-assets` from the monorepo root.

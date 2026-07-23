# CAP-274 — `capy --web` + MCP `capy_sync` — implementation plan

Branch: `cvince/cap-274-capy-web` (capy-cli, LOCAL only — never pushed). Companion MCP tool
lands in capy-mcp. Settled decisions (from CAP-274): MCP **always passes `--web`**; `--web` is
**lazy** (browser opens only at the first real interactive decision; a clean sync stays
terminal-only & silent); scope = **init trainstops AND the conflict resolver**; MCP tool name =
**`capy_sync`** (wraps bare `capy` — there is NO `capy sync` subcommand).

## Principle / no-leak
- Bare `capy` keeps gating init-vs-sync (keep.lock). `--web` only changes the *rendering* of the
  interactive steps (TTY → browser); it must NOT change the crypto / keep.lock / encryption logic.
- The conflict resolver shows value **snippets** (`formatSnippet`, first N + … + last M) — same as
  the TTY resolver shows today. Values never leave the local machine; the MCP returns `{status}` only.

## Reuse vs net-new (grounded)
**Reuse:** the loopback security primitive (`src/commands/intakeSecurity.ts`: `nonceEqual`,
`isLoopbackHost`, `isAllowedOrigin`), `open` auto-open + printed-URL fallback, `DEPLOY_PAGE_CSS` +
Capy logo + Geist styling (`src/ui/deployPage/generatedAssets.ts`), the intake-form/JS pattern
(`src/ui/intakePage.ts`), the 5-min timeout + Ctrl+C cleanup pattern.

**Net-new:** a **multi-step wizard server** (one persistent loopback server holding session state
across steps), per-step HTML forms, and a browser conflict-resolver form. `runWebIntake` is
single-step/single-submit, so it can't drive a 4-step init as-is.

## The primitive — `runBrowserWizard`
One persistent loopback server (mirrors `runWebIntake`'s security: kernel port, 32-byte nonce,
Host/Origin pinning, body cap, timeout, cleanup) that serves a SEQUENCE of steps:
- `GET /?n=<nonce>` → current step's HTML.
- `POST /submit` (nonce + Origin/Host checked) → validate payload → compute next step (may fetch
  data, e.g. projects for the chosen org) → respond `{ done?, nextStepHtml? }`; the page swaps in
  the next form without a full reload. Server stays up until the final step or timeout.
- Returns the accumulated session object (`{ orgId, projectId, projectName, branch, confirm }` for
  init; `{ choices }` for the resolver) to the caller — which then runs the SAME post-decision
  crypto/keep.lock code the TTY path runs. The browser only collects *decisions*.

## Lazy `--web` wiring
- `index.ts`: add `.option('--web', …)` to the bare `capy` program; thread `web` into `CliOptions`
  → `CapyCommand`.
- `capyCommand.ts execute()`: the gate is unchanged. `--web` just selects the renderer for the
  interactive points:
  - clean sync (`diffs.length === 0`) → unchanged, silent, **no browser**.
  - FULL INIT → `initializeProject()` renders its 4 trainstops via the wizard instead of inquirer.
  - SYNC CONFLICT → the action menu + resolver render via the wizard instead of inquirer/ResolveTable.
- Implementation approach: introduce a small `Prompter` seam so `initializeProject()` /
  `syncProject()` call `prompter.pickOrg(...)`, `prompter.resolve(rows)` etc., with a TTY impl
  (today's inquirer/ResolveTable) and a Web impl (the wizard). Keeps the crypto flow byte-identical;
  only the prompt rendering swaps. (Lowest-risk way to avoid rewriting the init control flow.)

## Phases
- **A. Primitive + flag** — `runBrowserWizard` module + `--web` flag plumbing + the `Prompter` seam.
  Net-new, no crypto touch. Boundary/round-trip tests (boot, GET step, nonce/Origin gates, POST,
  advance, final payload).
- **B. Init trainstops** — Web `Prompter`: org picker (existing + "create new"), project picker
  (existing + "create new"), project-name (regex-validated), initial-branch (dev | custom), encrypt-
  confirm. Each maps 1:1 to an existing inquirer prompt.
- **C. Conflict resolver** — browser table (variable | pinned | local | remote snippets) with a
  per-row select (pinned/local/remote/delete) → returns the same `ResolveResult` shape.
- **D. MCP `capy_sync`** (capy-mcp) — wraps bare `capy --web`; blocking; `{status}` only; lazy
  browser hand-off; terminal fallback. Then CAP-267's `init`/`sync` gap intents should flip 0%→~100%
  (the acceptance test).

## Open UX / scope decisions (for Vince)
1. **Single-page wizard vs. step-per-load** — swap forms in-page via fetch (snappier, one server
   round-trip per step) vs. full navigations. Recommend in-page swap (matches `add --web` JS feel).
2. **Org/project CREATE in browser** — render create-new inline in the wizard, or keep create flows
   (recoveryPhrase, orgCreation) in the terminal and only PICK in the browser? Create-org shows a
   recovery phrase (sensitive) — recommend: browser for *pick*, terminal hand-off for *create-new*
   on day one (smaller, avoids rendering recovery material in a browser page we just built).
3. **Conflict resolver depth** — full per-variable table on day one, or start with the bulk actions
   (retrieve_pinned/remote/commit_local/skip) in-browser and defer the per-row table? (Per CAP-276,
   non-TTY must never silently default — the web resolver is the fix.)
4. **Confirm before the big refactor** — Phase A (primitive, no crypto touch) is safe to build now;
   Phases B–C refactor the init/sync rendering (flagship, crypto-adjacent) → preview before merge.

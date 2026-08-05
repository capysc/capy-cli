# Capy `--web` demo — three headlines

A deterministic, offline demo of the agent-facing Capy flows. No live backend, no
network. Everything runs against a seeded local-only fixture so the same thing
happens every time.

## TL;DR — prove it's all green

```bash
bash scripts/demo/run-all.sh
```

Runs both `--web` E2E verifiers headless (no browser hijack). For the NL-routing
headline, run the eval in the capy-mcp repo (below).

---

## Headline 1 — resolve a sync conflict in the browser

The flagship. An agent (or `capy`) hits a conflict between your local edits and the
pinned baseline; instead of a TTY menu it can't drive, `capy --web` opens a local
page where you pick, per variable, which value to keep. Snippets only — full secret
values never leave the loopback.

**Live walkthrough:**
```bash
HOME=/tmp/capy-demo-home bun scripts/demo/seed.ts     # seed a deterministic conflict
cd /tmp/capy-demo-home/demo-project
HOME=/tmp/capy-demo-home capy --web                    # browser opens; resolve visually
```

**Headless proof (what CI runs):** `node scripts/demo/verify-web-conflict.mjs`
— plays the browser, asserts the COMMITTED values match the choices (API_KEY→pinned
baseline restored, DATABASE_URL→local edit kept).

## Headline 2 — onboard a fresh project in the browser

First-run, fully offline. `capy byoc --web` renders the setup trainstops — show /
confirm the 24-word recovery phrase, set a local passphrase — in the browser.

**Security:** the recovery phrase is generated in-process, shown only in the page,
and NEVER printed to the terminal — so an agent shelling this through the MCP never
sees it.

**Live walkthrough:**
```bash
HOME=/tmp/capy-onboard-home capy byoc --web            # browser opens; generate phrase, set passphrase
```

**Headless proof:** `node scripts/demo/verify-web-onboarding.mjs` — asserts setup
completes offline, a project bootstraps after, and the phrase never appears in the
CLI's stdout/stderr (not even a 4-word fragment).

## Headline 3 — natural-language tool routing (capy-mcp repo)

An agent picks the RIGHT capy tool from plain English. The convergence eval drives
`claude` headless with only the capy MCP tools and measures which tool it selects.

```bash
# in the capy-mcp repo:
node scripts/eval/run-eval.mjs --core-only          # all core intents
node scripts/eval/run-eval.mjs --intents=init,sync  # the capy_sync intents specifically
```

`capy_sync` (CAP-274 D) is the tie-in: "set up Capy here" / "pull the latest
secrets" route to it, and it shells `capy --web` — so the agent triggering a sync is
exactly what opens the headline-1 / headline-2 browser flows. The conflict → browser
→ resolve handoff is the whole story end to end.

## Screens

`bun scripts/demo/preview.ts <outDir>` writes a standalone HTML snapshot of each
`--web` screen (no server) for screenshots/review.

#!/usr/bin/env bash
# Rehearsable, offline end-to-end demo of the `capy --web` flows. Runs both
# headless E2E verifiers back to back so you can confirm everything is green
# before a live walkthrough. No live backend, no network — deterministic.
#
#   bash scripts/demo/run-all.sh
#
# For a LIVE demo (real browser), see DEMO.md — these verifiers run headless
# (CAPY_WEB_NO_OPEN) so they never hijack your browser.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "▶ Building capy…"
bun run build >/dev/null 2>&1
echo "✓ built"
echo

echo "═══ Headline 1: browser sync-conflict resolver ═══"
node scripts/demo/verify-web-conflict.mjs
echo

echo "═══ Headline 2: local-only onboarding in the browser ═══"
node scripts/demo/verify-web-onboarding.mjs
echo

echo "✓ All --web E2E flows pass. (NL tool-routing — headline 3 — is covered by"
echo "  the capy-mcp eval: scripts/eval/run-eval.mjs --core-only, intents init/sync"
echo "  now route to capy_sync.)"

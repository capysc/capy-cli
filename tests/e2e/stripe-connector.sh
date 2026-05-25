#!/usr/bin/env bash
# Manual runbook for the Stripe connector — exercises the full real flow
# against a real Capy service + real Stripe CLI.
#
# Prereqs (printed at startup so you don't miss them):
#   - Capy service running on :3000  (cd ~/Dev/capy/service && bun run dev)
#   - Capy CLI built + linked         (cd ~/Dev/capy/packages/cli && bun run build && bun link)
#   - Stripe CLI installed            (brew install stripe/stripe-cli/stripe)
#   - `stripe login` already done    (so config.toml has a test_mode_api_key)
#   - jq available                    (brew install jq)
#   - You are in a Capy sandbox dir   (e.g. ~/Dev/capy/sandbox/user1)
#
# This runbook uses `capy-dev` throughout — which hard-blocks live mode at the
# CLI layer. We never pass --live, never paste a live key, never touch a real
# Stripe live account.
#
# Each step prints what it expects, runs the command, asserts what it can,
# and pauses for Enter so you can eyeball the output.

set -uo pipefail
shopt -s extglob

ORANGE="\033[33m"
GREEN="\033[32m"
RED="\033[31m"
BOLD="\033[1m"
DIM="\033[90m"
RESET="\033[0m"

step() {
  echo
  echo -e "${BOLD}━━━ $1 ━━━${RESET}"
}

ok()    { echo -e "${GREEN}✓${RESET} $*"; }
warn()  { echo -e "${ORANGE}⚠${RESET} $*"; }
fail()  { echo -e "${RED}✗${RESET} $*"; exit 1; }
note()  { echo -e "${DIM}  $*${RESET}"; }

pause() {
  echo
  read -rp "Press Enter to continue (or Ctrl-C to abort)..." _
}

assert_file_contains() {
  local path="$1" needle="$2" desc="$3"
  if grep -qF "$needle" "$path"; then
    ok "$desc"
  else
    fail "$desc — \"$needle\" not found in $path"
  fi
}

assert_jq_path() {
  local path="$1" expr="$2" desc="$3"
  if jq -e "$expr" "$path" >/dev/null 2>&1; then
    ok "$desc"
  else
    fail "$desc — jq \"$expr\" did not match in $path"
  fi
}

assert_jq_not() {
  local path="$1" expr="$2" desc="$3"
  if jq -e "$expr" "$path" >/dev/null 2>&1; then
    fail "$desc — jq \"$expr\" unexpectedly matched in $path"
  else
    ok "$desc"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not on PATH (see prereqs at top of script)"
}

# Prereq checks
echo -e "${BOLD}Stripe Connector E2E Runbook${RESET}"
require_cmd capy-dev
require_cmd stripe
require_cmd jq
[ -f keep.lock ] || fail "no keep.lock in $(pwd) — run capy-dev first to initialize this sandbox"
[ -f ~/.config/stripe/config.toml ] || fail "no ~/.config/stripe/config.toml — run \`stripe login\` first"

note "Sandbox: $(pwd)"
note "Stripe config: ~/.config/stripe/config.toml"
note "Mode: test only (capy-dev hard-blocks live)"
pause

# ─────────────────────────────────────────────────────────────────────────────
step "1/8 — clean baseline (no STRIPE_* vars, no connector entries)"
# ─────────────────────────────────────────────────────────────────────────────
note "Removing any pre-existing STRIPE_* lines from .env so the test is clean."

if grep -qE "^STRIPE_" .env 2>/dev/null; then
  cp .env .env.runbook.bak
  grep -vE "^STRIPE_" .env.runbook.bak > .env
  ok "stripped existing STRIPE_* lines (backup at .env.runbook.bak)"
fi

# Re-encrypt the cleaned .env via capy-dev so we start consistent
note "Running 'capy-dev' to re-sync the cleaned .env..."
capy-dev || fail "capy-dev sync failed"

assert_jq_not keep.lock '.variables | to_entries[] | select(.key | startswith("STRIPE_")) | .value[]?.connector' \
  "no STRIPE_* connector entries in keep.lock"
pause

# ─────────────────────────────────────────────────────────────────────────────
step "2/8 — capy-dev connect stripe (test mode, CLI-managed)"
# ─────────────────────────────────────────────────────────────────────────────
note "Expected interactive prompts:"
note "  1. Which variable holds your Stripe key?"
note "     → if no existing vars, prompt asks for a name (default STRIPE_SECRET_KEY)"
note "     → otherwise picker shows stripe-pattern matches first, then others,"
note "       then 'Create new variable…' at the bottom. Pick 'Create new…' here."
note "  2. New variable name? → accept default (STRIPE_SECRET_KEY)"
note "  3. Mode? → pick 'Test'"
note "  4. (Account picker only if you have multiple stripe accounts configured)"
note "Expected outcome: STRIPE_SECRET_KEY=capy:<resourceId>:<ciphertext> in .env, connector field in keep.lock"
echo
read -rp "Run 'capy-dev connect stripe' now? Press Enter..." _

capy-dev connect stripe

assert_file_contains .env "STRIPE_SECRET_KEY=capy:" "STRIPE_SECRET_KEY in .env is encrypted"
assert_jq_path keep.lock '.variables.STRIPE_SECRET_KEY[] | select(.connector.provider == "stripe")' \
  "keep.lock has STRIPE_SECRET_KEY connector"
assert_jq_path keep.lock '.variables.STRIPE_SECRET_KEY[] | select(.connector.source == "cli")' \
  "connector.source == cli"
assert_jq_path keep.lock '.variables.STRIPE_SECRET_KEY[] | select(.connector.mode == "test")' \
  "connector.mode == test"
assert_jq_not  keep.lock '.variables.STRIPE_SECRET_KEY[] | select(.connector.mode == "live")' \
  "no live-mode connector landed (sanity check)"

OLD_FINGERPRINT=$(jq -r '.variables.STRIPE_SECRET_KEY[] | select(.connector) | .connector.fingerprint' keep.lock)
OLD_CIPHERTEXT=$(grep -E '^STRIPE_SECRET_KEY=' .env)
note "Captured: fingerprint=$OLD_FINGERPRINT"
note "Captured: ciphertext=${OLD_CIPHERTEXT:0:60}..."
pause

# ─────────────────────────────────────────────────────────────────────────────
step "3/8 — capy-dev rotate STRIPE_SECRET_KEY"
# ─────────────────────────────────────────────────────────────────────────────
note "Expected: a browser tab opens for 'stripe login' (auth/pairing confirm)."
note "After login completes, the CLI re-reads config.toml and writes the new key."
note "Expected outcome: ciphertext changes, fingerprint changes, rotated_at gets set."
echo
read -rp "Run 'capy-dev rotate STRIPE_SECRET_KEY'? Press Enter..." _

capy-dev rotate STRIPE_SECRET_KEY

NEW_FINGERPRINT=$(jq -r '.variables.STRIPE_SECRET_KEY[] | select(.connector) | .connector.fingerprint' keep.lock)
NEW_CIPHERTEXT=$(grep -E '^STRIPE_SECRET_KEY=' .env)

if [ "$OLD_FINGERPRINT" = "$NEW_FINGERPRINT" ]; then
  fail "fingerprint did not change (was=$OLD_FINGERPRINT, now=$NEW_FINGERPRINT)"
else
  ok "fingerprint changed: $OLD_FINGERPRINT → $NEW_FINGERPRINT"
fi

if [ "$OLD_CIPHERTEXT" = "$NEW_CIPHERTEXT" ]; then
  fail ".env ciphertext for STRIPE_SECRET_KEY did not change"
else
  ok ".env ciphertext changed"
fi

assert_jq_path keep.lock '.variables.STRIPE_SECRET_KEY[] | select(.connector.rotated_at != null)' \
  "rotated_at is set"
pause

# ─────────────────────────────────────────────────────────────────────────────
step "4/8 — capy-dev connect stripe --live should be blocked"
# ─────────────────────────────────────────────────────────────────────────────
note "Expected: exits 1 with 'Live mode is not allowed in dev mode' before any auth or precheck."
echo
set +e
LIVE_OUTPUT=$(capy-dev connect stripe --live 2>&1)
LIVE_EXIT=$?
set -e

if [ $LIVE_EXIT -ne 1 ]; then
  fail "expected exit 1, got $LIVE_EXIT"
fi
if ! echo "$LIVE_OUTPUT" | grep -q "Live mode is not allowed"; then
  fail "expected 'Live mode is not allowed' in output, got:\n$LIVE_OUTPUT"
fi
ok "dev-mode firewall held"
pause

# ─────────────────────────────────────────────────────────────────────────────
step "5/8 — capy-dev rotate (no args) — picker shows unmanaged vars"
# ─────────────────────────────────────────────────────────────────────────────
note "Add an unmanaged var to .env, push, then 'capy-dev rotate' (no args)."
note "Expected: picker lists STRIPE_SECRET_KEY (managed) and MY_UNMANAGED_KEY (unmanaged, dim grey)."
note "Pick MY_UNMANAGED_KEY → prompted to choose an integration (stripe) → drops into the connect flow."
note "Outcome: MY_UNMANAGED_KEY ends up tagged as connector.provider == 'stripe' in keep.lock."

echo
read -rp "Press Enter to add MY_UNMANAGED_KEY=sk_test_placeholder and push..." _
echo "MY_UNMANAGED_KEY=sk_test_placeholder" >> .env
capy-dev || fail "push of unmanaged var failed"

assert_jq_not keep.lock '.variables.MY_UNMANAGED_KEY[]?.connector' \
  "MY_UNMANAGED_KEY is unmanaged before rotate"

echo
read -rp "Run 'capy-dev rotate' (no args) — pick MY_UNMANAGED_KEY → stripe. Press Enter..." _
capy-dev rotate

assert_jq_path keep.lock '.variables.MY_UNMANAGED_KEY[] | select(.connector.provider == "stripe")' \
  "MY_UNMANAGED_KEY now tagged as stripe-managed"
pause

# ─────────────────────────────────────────────────────────────────────────────
step "6/8 — capy-dev rotate --all (both managed keys)"
# ─────────────────────────────────────────────────────────────────────────────
note "Expected: rotates every connector-tagged key by re-running 'stripe login' once per account."

PRE_SECRET_FP=$(jq -r '.variables.STRIPE_SECRET_KEY[] | select(.connector) | .connector.fingerprint' keep.lock)
PRE_UNMANAGED_FP=$(jq -r '.variables.MY_UNMANAGED_KEY[] | select(.connector) | .connector.fingerprint' keep.lock)

echo
read -rp "Run 'capy-dev rotate --all'? Press Enter..." _
capy-dev rotate --all

POST_SECRET_FP=$(jq -r '.variables.STRIPE_SECRET_KEY[] | select(.connector) | .connector.fingerprint' keep.lock)
POST_UNMANAGED_FP=$(jq -r '.variables.MY_UNMANAGED_KEY[] | select(.connector) | .connector.fingerprint' keep.lock)

[ "$PRE_SECRET_FP" != "$POST_SECRET_FP" ] && ok "STRIPE_SECRET_KEY fingerprint advanced" \
  || fail "STRIPE_SECRET_KEY fingerprint did not change"
[ "$PRE_UNMANAGED_FP" != "$POST_UNMANAGED_FP" ] && ok "MY_UNMANAGED_KEY fingerprint advanced" \
  || fail "MY_UNMANAGED_KEY fingerprint did not change"
pause

# ─────────────────────────────────────────────────────────────────────────────
step "7/8 — precheck: capy-dev connect stripe with no stripe binary on PATH"
# ─────────────────────────────────────────────────────────────────────────────
note "Expected: exits 1 with 'stripe CLI not found' before any auth."
echo
set +e
STRIPE_PATH=$(dirname "$(command -v stripe)")
NO_STRIPE_PATH=$(echo "$PATH" | tr ':' '\n' | grep -v "^$STRIPE_PATH$" | tr '\n' ':' | sed 's/:$//')
NO_STRIPE_OUTPUT=$(env PATH="$NO_STRIPE_PATH" capy-dev connect stripe 2>&1)
NO_STRIPE_EXIT=$?
set -e

if [ $NO_STRIPE_EXIT -ne 1 ]; then
  fail "expected exit 1, got $NO_STRIPE_EXIT"
fi
# Strip ANSI escapes — the install hint bolds "stripe" with escape codes,
# so the literal substring won't match without normalizing first.
PLAIN=$(echo "$NO_STRIPE_OUTPUT" | sed 's/\x1b\[[0-9;]*m//g')
if ! echo "$PLAIN" | grep -q "stripe CLI not found"; then
  fail "expected 'stripe CLI not found', got:\n$NO_STRIPE_OUTPUT"
fi
ok "precheck held"
pause

# ─────────────────────────────────────────────────────────────────────────────
step "8/8 — expiry warning at the tail of capy-dev status, then teammate-pull
        simulation"
# ─────────────────────────────────────────────────────────────────────────────
note "Manually editing keep.lock to set STRIPE_SECRET_KEY's expires_at to 3 days from now."
note "Expected: capy-dev status prints a yellow warning at its tail."

THREE_DAYS=$(( $(date +%s) + 3 * 86400 ))
TMP_KEEP=$(mktemp)
jq --argjson ts "$THREE_DAYS" '
  .variables.STRIPE_SECRET_KEY |= map(
    if .connector then .connector.expires_at = $ts else . end
  )' keep.lock > "$TMP_KEEP"
mv "$TMP_KEEP" keep.lock

set +e
STATUS_OUTPUT=$(capy-dev status 2>&1)
set -e

if echo "$STATUS_OUTPUT" | grep -q "STRIPE_SECRET_KEY"; then
  if echo "$STATUS_OUTPUT" | grep -q "expires"; then
    ok "expiry warning appeared"
  else
    fail "STRIPE_SECRET_KEY mentioned but no 'expires' phrasing"
  fi
else
  fail "no expiry warning printed by 'capy-dev status'"
fi
pause

note "Teammate-pull simulation: move keep.lock aside, then 'capy-dev' to re-pull."
note "Expected: pulled keep.lock still has the connector field."
echo
read -rp "Move keep.lock aside and pull? Press Enter..." _

mv keep.lock keep.lock.runbook.bak
capy-dev || fail "capy-dev re-sync failed"

assert_jq_path keep.lock '.variables.STRIPE_SECRET_KEY[] | select(.connector.provider == "stripe")' \
  "connector field survived the round-trip through the service"
pause

note "Backups left behind in case you want them:"
note "  .env.runbook.bak (if step 1 found pre-existing STRIPE_*)"
note "  keep.lock.runbook.bak (from teammate-pull step)"
echo
ok "Runbook complete."

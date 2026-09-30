#!/usr/bin/env bash
# Bun's mock.module() is process-wide — mocked modules leak across files in a
# single bun test run.  Work around this by running each file that uses
# mock.module() in its own subprocess, then batching the rest together.

set -euo pipefail
cd "$(dirname "$0")/.."

# Tests run with cwd inside this repo — never let a command flow's keep.lock
# auto-commit (CAP-303) create real commits here.
export CAPY_NO_AUTOCOMMIT=1

# No test may launch the developer's browser. Every `--web` call site reads
# this before calling `open()`, and the browser tests drive a downloaded
# headless shell with a throwaway profile instead. Individual tests also pass
# `open: false`; this is the backstop for the ones that go through a command,
# where the flag is not theirs to pass.
export CAPY_WEB_NO_OPEN=1

# The suite asserts default targeting (~/.capy, the cloud API URL, the
# capy-staging pin). A developer shell that exports CAPY_API_URL /
# CAPY_GLOBAL_DIR_NAME -- which the capy-dev and capy-staging workflows
# routinely do -- silently redirects those defaults and fails a dozen files
# that are testing the very thing the env var overrode. Tests must depend on
# the tree, never on the shell that launched them: scrub every targeting var
# here so a local run matches CI exactly. Anything a test needs, it sets
# itself.
unset CAPY_API_URL CAPY_KEEP_ORIGIN CAPY_GLOBAL_DIR_NAME CAPY_BIN_NAME
unset CAPY_TEST_EMAIL CAPY_TEST_PASSWORD
unset CAPY_DEVICE_KEYS CAPY_FLOW_ONBOARD CAPY_KEEP_SCREENS CAPY_KEEP_LOGIN_BRIDGE

FAIL=0

# The vendored flow contract must match what it was vendored from. Gate 1 (the
# manifest hash) runs anywhere; gate 2 (byte-compare against the source) only
# when the monorepo is alongside. A hand-edited vendored copy fails the suite.
echo "=== Checking the vendored flow contract ==="
if ! bun run scripts/sync-flow-contract.ts --check; then
  FAIL=1
fi

# Module mocks and process-wide state can survive mock.restore(). Keep every
# file in its own process so new tests cannot silently contaminate siblings.
while IFS= read -r file; do
  echo "--- $file ---"
  if ! bun test "$file" 2>&1; then
    FAIL=1
    echo "FAIL: $file"
  fi
done < <(find tests -name '*.test.ts' -not -path '*/e2e/*' -not -path '*/plugins/*' | sort)

exit $FAIL

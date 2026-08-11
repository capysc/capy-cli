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

FAIL=0

# Files that use mock.module() — must run in isolation
ISOLATED_FILES=(
  tests/auth/authService.test.ts
  tests/auth/authServiceKeepScreens.test.ts
  tests/auth/oauthServer.test.ts
  tests/auth/sessionFileBackend.test.ts
  tests/auth/sessionLifecycle.test.ts
  tests/commands/branchKeepFile.test.ts
  tests/commands/capyCommand.test.ts
  tests/commands/readOnlyRun.e2e.test.ts
  tests/commands/kickCommand.test.ts
  tests/commands/inviteCommand.test.ts
  tests/config/globalConfig.test.ts
  tests/core/projectManager.test.ts
  tests/crypto/keyResolver.test.ts
  tests/crypto/keyResolverLegacyKeychainMode.test.ts
  tests/crypto/localKey.test.ts
  tests/crypto/keyStability.test.ts
  tests/crypto/zeroTrust.test.ts
  tests/commands/logoutCleanup.test.ts
  tests/files/fileManager.test.ts
  tests/ui/promptEngine.test.ts
  tests/commands/decryptCommand.test.ts
  tests/commands/roleAccessGuards.test.ts
  tests/commands/recoverCommand.test.ts
  tests/commands/recoverKdf.test.ts
  tests/commands/cleanupOrgData.test.ts
  tests/config/profileConfig.test.ts
  tests/commands/byocCommand.test.ts
  tests/service/serviceClient.test.ts
  tests/commands/profileCommand.test.ts
  tests/commands/localOnlyFlow.test.ts
  tests/ui/deployDeadline.test.ts
  tests/commands/rotatePromotesThenRotates.test.ts
  tests/auth/deviceKeyOnboarding.test.ts
  tests/crypto/keyResolverSyncHook.test.ts
  tests/service/wrapperEndpoints.test.ts
  tests/auth/deviceKey/wiring.test.ts
  tests/commands/deviceKeyCommand.test.ts
  tests/commands/redeemCommand.test.ts
  tests/commands/doorsCommand.test.ts
  tests/commands/runCommandDeviceKeyFallback.test.ts
  tests/auth/deviceKey/brokerCeremonyTransportAutoOpen.test.ts
  tests/auth/deviceKey/capyRunEquivalence.e2e.test.ts
  tests/auth/deviceKey/syncInvariants.e2e.test.ts
  tests/auth/deviceKey/onboardingCaseMatrix.e2e.test.ts
  tests/auth/deviceKey/security.e2e.test.ts
  tests/auth/deviceKey/grantE2E.e2e.test.ts
  # <<< isolated test files (mock.module): append below >>>
)

# Build a grep pattern to exclude isolated files from the batch run
EXCLUDE_PATTERN=""
for f in "${ISOLATED_FILES[@]}"; do
  if [ -n "$EXCLUDE_PATTERN" ]; then
    EXCLUDE_PATTERN="$EXCLUDE_PATTERN|$f"
  else
    EXCLUDE_PATTERN="$f"
  fi
done

echo "=== Running isolated test files (mock.module) ==="
for f in "${ISOLATED_FILES[@]}"; do
  echo "--- $f ---"
  if ! bun test "$f" 2>&1; then
    FAIL=1
    echo "FAIL: $f"
  fi
done

echo ""
echo "=== Running batch test files ==="
# Collect non-isolated test files
BATCH_FILES=()
while IFS= read -r f; do
  SKIP=0
  for iso in "${ISOLATED_FILES[@]}"; do
    if [[ "$f" == *"$iso" ]]; then
      SKIP=1
      break
    fi
  done
  if [ "$SKIP" -eq 0 ]; then
    BATCH_FILES+=("$f")
  fi
done < <(find tests -name '*.test.ts' -not -path '*/e2e/*' -not -path '*/plugins/*' | sort)

if [ ${#BATCH_FILES[@]} -gt 0 ]; then
  if ! bun test "${BATCH_FILES[@]}" 2>&1; then
    FAIL=1
    echo "FAIL: batch run"
  fi
fi

exit $FAIL

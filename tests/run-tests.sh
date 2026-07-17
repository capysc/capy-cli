#!/usr/bin/env bash
# Bun's mock.module() is process-wide — mocked modules leak across files in a
# single bun test run.  Work around this by running each file that uses
# mock.module() in its own subprocess, then batching the rest together.

set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0

# Files that use mock.module() — must run in isolation
ISOLATED_FILES=(
  tests/auth/authService.test.ts
  tests/auth/oauthServer.test.ts
  tests/commands/branchKeepFile.test.ts
  tests/commands/capyCommand.test.ts
  tests/commands/kickCommand.test.ts
  tests/config/globalConfig.test.ts
  tests/core/projectManager.test.ts
  tests/crypto/keyResolver.test.ts
  tests/crypto/keyResolverKeychainMode.test.ts
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
  tests/commands/profileCommand.test.ts
  tests/commands/localOnlyFlow.test.ts
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

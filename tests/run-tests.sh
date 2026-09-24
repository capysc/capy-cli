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

# Files that use mock.module() — must run in isolation
ISOLATED_FILES=(
  tests/commands/cleanupCommand.test.ts
  tests/git/installGitHooksCleanup.test.ts
  tests/auth/authService.test.ts
  tests/auth/createOrganizationInstallation.test.ts
  tests/auth/deviceAuth.test.ts
  tests/auth/authServiceKeepScreens.test.ts
  tests/auth/oauthServer.test.ts
  tests/auth/sessionFileBackend.test.ts
  tests/auth/pairing/pairedSessionInstallation.test.ts
  tests/auth/sessionLifecycle.test.ts
  tests/commands/branchKeepFile.test.ts
  tests/commands/capyCommand.test.ts
  tests/commands/flowAuthenticateFileBackend.test.ts
  tests/commands/orgCreationInstallation.test.ts
  tests/commands/orgCommandRefreshReplacement.test.ts
  tests/commands/readOnlyRun.int.test.ts
  tests/commands/kickCommand.test.ts
  tests/commands/inviteCommand.test.ts
  tests/commands/deployTokenCommand.test.ts
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
  # consume.test.ts mocks os.homedir() the same way (writes real local.key/key.enc
  # under a temp home via keyResolver/globalConfig).
  tests/auth/invitePickup/consume.test.ts
  tests/crypto/keyResolverSyncHook.test.ts
  tests/service/wrapperEndpoints.test.ts
  tests/auth/deviceKey/wiring.test.ts
  tests/commands/deviceKeyCommand.test.ts
  tests/commands/redeemCommand.test.ts
  # redeemCommandPickup.test.ts mocks authService/serviceClient/invitePickup/consume the same way.
  tests/commands/redeemCommandPickup.test.ts
  tests/commands/doorsCommand.test.ts
  tests/commands/runCommandDeviceKeyFallback.test.ts
  tests/auth/deviceKey/brokerCeremonyTransportAutoOpen.test.ts
  tests/auth/deviceKey/capyRunEquivalence.int.test.ts
  tests/auth/deviceKey/syncInvariants.int.test.ts
  tests/auth/deviceKey/onboardingCaseMatrix.int.test.ts
  tests/auth/deviceKey/security.int.test.ts
  tests/auth/deviceKey/grantE2E.int.test.ts
  tests/auth/pairing/installPairedSession.test.ts
  tests/auth/pairing/runtimePairing.test.ts
  tests/auth/pairing/runtimeFilesystemPairing.test.ts
  tests/auth/pairing/pairAttemptLease.test.ts
  # The capy-staging pin tests assert behaviour that is BY DEFINITION a
  # function of process.env (CAPY_API_URL / CAPY_KEEP_ORIGIN /
  # CAPY_GLOBAL_DIR_NAME). Batched, they inherit whatever a sibling left
  # behind -- deviceKeyOnboarding, doctorCommand, capyRunEquivalence,
  # grantE2E and pairE2E all assign CAPY_GLOBAL_DIR_NAME -- so the pin
  # appears to fail when it is the leak that failed. They pass in isolation.
  tests/commands/stagingDefaults.test.ts
  tests/commands/stagingPinExhaustive.test.ts
  tests/commands/pairCommand.test.ts
  tests/auth/pairing/pairE2E.int.test.ts
  tests/files/reservedVarsWrite.test.ts
  # <<< isolated test files (mock.module): append below >>>
  "tests/ui/flowCommandFailure.test.ts"
  # setupCommand.test.ts / syncCommand.test.ts mock projectManager/fileManager/
  # authService/serviceClient/syncEngine/keyResolver/globalConfig/
  # installGitHooks the same shape as capyCommand.test.ts, for the
  # docs/cli-setup-json.md plan/confirm and sync surfaces.
  tests/commands/setupCommand.test.ts
  tests/commands/syncCommand.test.ts
  tests/commands/paidSyncRuntimeCustody.test.ts
  tests/commands/paidPushRuntimeCustody.test.ts
  tests/ui/recoveryPhrase.test.ts
  tests/auth/authServiceKeepLoginBridge.test.ts
  # doctorCommand.test.ts mocks os.homedir() the same way (getGlobalCapyDir).
  tests/commands/doctorCommand.test.ts
  tests/commands/connectors/boundIntakeContext.test.ts
  # conflictUx.test.ts mocks authService/serviceClient/keyResolver/inquirer/
  # ui/editScreen.ts and os.homedir() the same way, for the conflict-gate
  # context lines, the edit/push CAS confirm wiring, and the personal-env
  # soft warning.
  tests/commands/connectors/conflictUx.test.ts
  # flowCancelCommand.test.ts mocks authService/serviceClient/projectManager
  # (kickCommand.test.ts's shape) plus ui/interactive's isInteractive().
  tests/commands/flowCancelCommand.test.ts
  # masterKeyMint.test.ts mocks keyManager/keyResolver/ui/recoveryPhrase/
  # ui/interactive (master-key first-mint ceremony, unit-level).
  tests/auth/masterKeyMint.test.ts
  # masterKeyMintRuntimePair.test.ts mocks the runtime-pair custody selector
  # and free resolver; keep isolated from the disk/mint unit above.
  tests/auth/masterKeyMintRuntimePair.test.ts
  # flowRunCommand.test.ts mocks authService/serviceClient (flowCancelCommand.test.ts's
  # shape) plus crypto/keyResolver's resolveProjectKey.
  tests/commands/flowRunCommand.test.ts
  # pushJsonCommand.test.ts mock.module()s config/profileConfig,
  # config/globalConfig, sync/projectKeyResolver, auth/deviceKey/grantResolver
  # and git/autoCommitKeep for its dependency-injected paid-push fixture, but
  # was never added here. Batched, its grantResolver/autoCommitKeep stand-ins
  # (a bare `{}` and an always-"unchanged" fake) permanently replace the real
  # modules for every later file in the same process: tests/auth/deviceKey/
  # grantResolver.test.ts started throwing "ops.fetchKeyEnc is not a
  # function" and tests/git/autoCommitKeep.test.ts started getting
  # `{committed:false,reason:'unchanged'}` back from every call, no matter
  # what it wrote to disk — both reproduced exactly, in isolation, by pairing
  # this file with either of theirs. They pass alone and in every batch that
  # excludes this file.
  tests/commands/pushJsonCommand.test.ts
  # rotateRefusals.test.ts drives `capy rotate`'s six early `--web` refusals
  # for real: six live loopback ScreenServers, six real `fetch()` round trips,
  # each polled for up to 10s. No mock.module, and its process.exit/console
  # spies and chdir are correctly paired (try/finally, beforeEach/afterEach) —
  # nothing here is left un-restored. But queued behind ~80 other files it
  # still measures 15-20x slower than its ~1s solo run (bisected: batches
  # ending at tests/commands/rotatePicker.test.ts pass in ~30s; adding just
  # this one file pushes the SAME batch to 50s+), and that is real OS socket
  # pressure — accumulated TIME_WAIT state on 127.0.0.1 from every earlier
  # test's own loopback server — not a leak this file can restore. The
  # collateral damage lands on whichever pure/synchronous file bun happens to
  # schedule right after it: tests/commands/compareSecrets.test.ts's four
  # tests do zero I/O and zero awaits yet started timing out at the default
  # 5000ms, purely because the process was too busy draining this file's
  # backlog to schedule them in time (confirmed by swapping an unrelated file
  # into the same batch slot: compareSecrets stays green). Isolating the
  # heavy aggressor here — rather than only the one victim this run happened
  # to expose — protects every other fast test from the same fate.
  tests/commands/rotateRefusals.test.ts
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

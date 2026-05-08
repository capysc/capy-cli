#!/usr/bin/env bash
# Plugin test runner.
#
# Each tests/plugins/*.test.ts is an independent integration. Plugins do not
# share state, so they run in parallel and are aggregated at the end. Each
# plugin self-gates on credentials — a missing-creds skip is not a failure.
#
# Usage:
#   ./run-plugin-tests.sh                  # all plugins, in parallel
#   ./run-plugin-tests.sh cloudflare-workers          # named subset, parallel
#   ./run-plugin-tests.sh cloudflare-workers cloudflare-pages
#
# Optional creds: source from packages/cli/.env.plugin-tests if present.

set -uo pipefail
cd "$(dirname "$0")/../.."

# Auto-source local credentials file if present (gitignored).
if [ -f .env.plugin-tests ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.plugin-tests
  set +a
fi

# Build first — plugin tests run against dist/.
if [ ! -f dist/index.js ] || [ src/index.ts -nt dist/index.js ]; then
  echo "[plugin] building CLI..."
  bun run build > /dev/null
fi

# Resolve target plugin files.
PLUGINS=()
if [ "$#" -gt 0 ]; then
  for name in "$@"; do
    PLUGINS+=("tests/plugins/${name}.test.ts")
  done
else
  while IFS= read -r f; do
    PLUGINS+=("$f")
  done < <(find tests/plugins -maxdepth 1 -name '*.test.ts' | sort)
fi

if [ ${#PLUGINS[@]} -eq 0 ]; then
  echo "[plugin] no plugin tests found."
  exit 0
fi

# Validate all paths up front so a typo aborts before any test runs.
for f in "${PLUGINS[@]}"; do
  if [ ! -f "$f" ]; then
    echo "[plugin] missing: $f" >&2
    exit 1
  fi
done

# Run plugins in parallel, capturing each one's output to a temp log.
LOG_DIR=$(mktemp -d -t capy-plugin-logs.XXXXXX)
trap 'rm -rf "$LOG_DIR"' EXIT

declare -a PIDS=()
declare -a NAMES=()
declare -a LOGS=()

for f in "${PLUGINS[@]}"; do
  name=$(basename "$f" .test.ts)
  log="$LOG_DIR/$name.log"
  echo "[plugin] starting: $name"
  bun test "$f" > "$log" 2>&1 &
  PIDS+=("$!")
  NAMES+=("$name")
  LOGS+=("$log")
done

# Wait for each plugin and record its exit status.
declare -a STATUSES=()
for i in "${!PIDS[@]}"; do
  if wait "${PIDS[$i]}"; then
    STATUSES+=("0")
  else
    STATUSES+=("$?")
  fi
done

# Print each plugin's full output, then a summary at the bottom.
echo ""
echo "================================================================"
echo " Plugin test results"
echo "================================================================"
FAIL=0
for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  status="${STATUSES[$i]}"
  echo ""
  if [ "$status" = "0" ]; then
    echo "--- ${name} (PASS) ---"
  else
    echo "--- ${name} (FAIL exit=$status) ---"
    FAIL=1
  fi
  cat "${LOGS[$i]}"
done

echo ""
echo "================================================================"
echo " Summary"
echo "================================================================"
for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  status="${STATUSES[$i]}"
  if [ "$status" = "0" ]; then
    printf "  \033[32m✓\033[0m %s\n" "$name"
  else
    printf "  \033[31m✗\033[0m %s (exit=%s)\n" "$name" "$status"
  fi
done

exit $FAIL

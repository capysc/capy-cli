#!/usr/bin/env bash
# Capy CLI universal installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/capysc/capy-cli/main/install.sh | bash
#
# Env overrides:
#   CAPY_VERSION  — version to install (default: latest GitHub release)
#   CAPY_PREFIX   — install prefix (default: $HOME/.capy; binary → $CAPY_PREFIX/bin/capy)
#   CAPY_FORCE_NPM=1    — always use the npm fallback even if a native binary exists
#   CAPY_NO_NPM_FALLBACK=1 — never fall back to npm; fail if no native binary exists
#
# The script:
#   1. Detects OS + arch
#   2. Tries to download the matching prebuilt binary from the GitHub release
#   3. Verifies its sha256 against the release's checksums file
#   4. Installs to $CAPY_PREFIX/bin and prints shell rc instructions
#   5. If no matching binary exists (or download fails), falls back to
#      `npm install -g @capysc/cli` when npm is available

set -euo pipefail

REPO="capysc/capy-cli"
NPM_PKG="@capysc/cli"
PREFIX="${CAPY_PREFIX:-$HOME/.capy}"
BIN_DIR="$PREFIX/bin"
VERSION="${CAPY_VERSION:-latest}"

BLUE='\033[34m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

log()  { printf '%b\n' "${BLUE}==>${RESET} $*"; }
ok()   { printf '%b\n' "${GREEN}✓${RESET} $*"; }
warn() { printf '%b\n' "${YELLOW}!${RESET} $*" >&2; }
err()  { printf '%b\n' "${RED}✗${RESET} $*" >&2; }

need() {
  command -v "$1" >/dev/null 2>&1 || { err "missing dependency: $1"; exit 1; }
}

detect_os() {
  local uname_s
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  case "$uname_s" in
    Darwin)  echo darwin ;;
    Linux)   echo linux ;;
    MINGW*|MSYS*|CYGWIN*) echo win ;;
    *) echo unsupported ;;
  esac
}

detect_arch() {
  local uname_m
  uname_m="$(uname -m 2>/dev/null || echo unknown)"
  case "$uname_m" in
    x86_64|amd64) echo x64 ;;
    arm64|aarch64) echo arm64 ;;
    *) echo unsupported ;;
  esac
}

resolve_version() {
  if [ "$VERSION" = "latest" ]; then
    # No gh CLI dependency — use the public redirect on /releases/latest.
    local url
    url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
    VERSION="${url##*/}"        # e.g. v0.2.0
    VERSION="${VERSION#v}"       # → 0.2.0
  else
    VERSION="${VERSION#v}"
  fi
  [ -n "$VERSION" ] || { err "could not resolve release version"; exit 1; }
}

asset_name() {
  local os="$1" arch="$2" ver="$3"
  if [ "$os" = "win" ]; then
    echo "capy-${os}-${arch}-${ver}.zip"
  else
    echo "capy-${os}-${arch}-${ver}.tar.gz"
  fi
}

download() {
  # $1 url, $2 output path
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --output "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --output-document="$2" "$1"
  else
    err "need curl or wget to download binaries"
    return 1
  fi
}

verify_checksum() {
  # $1 binary tarball path, $2 expected-filename, $3 checksums file path
  local expected
  expected="$(grep " ${2}$" "$3" | awk '{print $1}' | head -n1)"
  if [ -z "$expected" ]; then
    warn "no checksum entry for $2 — skipping verification"
    return 0
  fi
  local actual
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$1" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$1" | awk '{print $1}')"
  else
    warn "no sha256 tool found — skipping verification"
    return 0
  fi
  if [ "$expected" != "$actual" ]; then
    err "checksum mismatch: expected $expected, got $actual"
    return 1
  fi
  ok "checksum verified"
}

install_binary() {
  local os="$1" arch="$2"
  local asset="$(asset_name "$os" "$arch" "$VERSION")"
  local base="https://github.com/$REPO/releases/download/v$VERSION"
  local asset_url="$base/$asset"
  local sums_url="$base/checksums-${VERSION}.txt"

  log "downloading $asset"

  local tmp
  tmp="$(mktemp -d)"

  if ! download "$asset_url" "$tmp/$asset"; then
    warn "no prebuilt binary for $os-$arch at v$VERSION"
    rm -rf "$tmp"
    return 2
  fi

  if download "$sums_url" "$tmp/checksums.txt" 2>/dev/null; then
    verify_checksum "$tmp/$asset" "$asset" "$tmp/checksums.txt" || { rm -rf "$tmp"; return 1; }
  else
    warn "checksums file not found — skipping verification"
  fi

  mkdir -p "$BIN_DIR"

  if [ "$os" = "win" ]; then
    need unzip
    unzip -q -o "$tmp/$asset" -d "$tmp/unpacked"
    mv "$tmp/unpacked/capy.exe" "$BIN_DIR/capy.exe"
    ok "installed $BIN_DIR/capy.exe"
  else
    tar -xzf "$tmp/$asset" -C "$tmp"
    mv "$tmp/capy" "$BIN_DIR/capy"
    chmod +x "$BIN_DIR/capy"
    ok "installed $BIN_DIR/capy"
  fi

  rm -rf "$tmp"

  printf '\n'
  log "verifying"
  "$BIN_DIR/capy" --version || {
    err "installed binary failed to run"
    return 1
  }

  print_path_hint
  return 0
}

install_via_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    err "npm not installed and no native binary is available for your platform."
    err "install Node.js (https://nodejs.org) then re-run, or set CAPY_VERSION to a release with a binary for your platform."
    return 1
  fi
  log "no native binary — falling back to: npm install -g $NPM_PKG"
  if npm install -g "$NPM_PKG@${VERSION}" 2>/dev/null \
     || npm install -g "$NPM_PKG"; then
    ok "installed via npm"
    command -v capy >/dev/null 2>&1 && capy --version || true
  else
    err "npm install failed"
    return 1
  fi
}

print_path_hint() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return ;;
  esac
  printf '\n%b %s is not on your PATH. Add this to your shell rc:\n\n' "${YELLOW}!${RESET}" "$BIN_DIR"
  printf '    %bexport PATH="%s:$PATH"%b\n\n' "${BOLD}" "$BIN_DIR" "${RESET}"
}

main() {
  printf '%b Capy CLI installer%b\n\n' "${BOLD}" "${RESET}"

  if [ "${CAPY_FORCE_NPM:-}" = "1" ]; then
    install_via_npm
    return
  fi

  local os arch
  os="$(detect_os)"
  arch="$(detect_arch)"

  if [ "$os" = "unsupported" ] || [ "$arch" = "unsupported" ]; then
    warn "unsupported platform ($(uname -s)/$(uname -m))"
    [ "${CAPY_NO_NPM_FALLBACK:-}" = "1" ] && exit 1
    install_via_npm
    return
  fi

  need curl
  resolve_version
  log "target: $os-$arch, version: v$VERSION"

  local rc=0
  install_binary "$os" "$arch" || rc=$?

  if [ "$rc" -eq 0 ]; then
    return 0
  fi

  if [ "$rc" -eq 2 ] && [ "${CAPY_NO_NPM_FALLBACK:-}" != "1" ]; then
    install_via_npm
  else
    exit "$rc"
  fi
}

main "$@"

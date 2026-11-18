#!/bin/sh
# Capy installer loader.
#
#   curl -fsSL https://raw.githubusercontent.com/capysc/capy-cli/main/install.sh | sh
#
# Downloads the install.sh published with a Capy release and runs it. That
# script carries its own version and checksums.
#
# Env:
#   CAPY_VERSION  version to install, with or without a leading v (default: latest release)
#
# Other CAPY_* variables are passed through to the release's installer.
# CAPY_NO_NPM_FALLBACK is accepted and ignored.
set -eu

if [ "${CAPY_FORCE_NPM:-}" = "1" ]; then
  printf '%s\n' 'This installer does not use npm. Nothing was installed. To install with npm, run: npm install -g @capysc/cli' >&2 # COPY-FLAG
  exit 1
fi

releases=https://github.com/capysc/capy-cli/releases

version=${CAPY_VERSION:-}
version=${version#v}
case "$version" in
  '') url="$releases/latest/download/install.sh" ;;
  *[!0-9.]*|.*|*.|*..*)
    printf '%s\n' 'CAPY_VERSION must be a version number such as 0.9.16.' >&2 # COPY-FLAG
    exit 1
    ;;
  *) url="$releases/download/v$version/install.sh" ;;
esac

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/capy-install-loader.XXXXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT
trap 'exit 1' HUP INT TERM

if command -v curl >/dev/null 2>&1; then
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 20 --max-time 300 "$url" -o "$tmp_dir/install.sh" ||
    { printf 'Could not download %s\n' "$url" >&2; exit 1; } # COPY-FLAG
elif command -v wget >/dev/null 2>&1; then
  wget -q -T 300 -O "$tmp_dir/install.sh" "$url" ||
    { printf 'Could not download %s\n' "$url" >&2; exit 1; } # COPY-FLAG
else
  printf '%s\n' 'Install curl or wget and try again.' >&2
  exit 1
fi

sh "$tmp_dir/install.sh"

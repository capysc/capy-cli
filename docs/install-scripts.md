# Install scripts

## Problem

The standalone installers used to live in two places: an old bash `install.sh` in this
repo, and separate copies on the website that were pinned by hand to one version and
its checksums. They drifted from each release, the old script could fall back to npm,
and neither updated an existing install in place.

This repo is now the single source. Every GitHub release publishes `install.sh` and
`install.ps1` as release assets, with that release's version and checksums written in.

## How it fits together

- `scripts/install/install.sh.tmpl` and `scripts/install/install.ps1.tmpl` are the
  scripts, with placeholders for the version, the source commit and the five archive
  checksums (`@@VERSION@@`, `@@COMMIT@@`, `@@SHA256_DARWIN_ARM64@@`,
  `@@SHA256_DARWIN_X64@@`, `@@SHA256_LINUX_X64@@`, `@@SHA256_LINUX_ARM64@@`,
  `@@SHA256_WIN_X64@@`).
- `scripts/install/build-install-scripts.ts` fills them in. Inputs: `--version`,
  `--commit`, `--checksums` (the release's `checksums-<version>.txt`, lines of
  `<sha256>  <file name>`) and `--out`. It exits non-zero and writes nothing if any of
  the five archive checksums is missing or not 64 hex characters, or if any
  placeholder is left unfilled. The logic is in `scripts/install/render.ts`.
- `.github/workflows/release-binaries.yml` builds the archives and checksums, runs the
  generator, and uploads `install.sh` and `install.ps1` with them. After the upload it
  runs the published `install.sh` for that tag in a clean `alpine:3` container with no
  Node and checks `capy --version`.
- `.github/workflows/windows-installer.yml` runs the generated `install.ps1` on Windows
  runners, in Windows PowerShell 5.1 and PowerShell 7. It generates the script from the
  latest published release's checksums.
- `install.sh` at the repo root is a small loader. It downloads the release's own
  `install.sh` (`releases/latest/download/install.sh`, or
  `releases/download/v<CAPY_VERSION>/install.sh`) over HTTPS to a temp file and runs it
  with `sh`.

## Behaviour of the generated scripts

- No npm fallback. A checksum failure, a missing hash tool or an unsupported system
  stops the install and nothing is installed.
- With `CAPY_INSTALL_DIR` set, that folder is used.
- With `CAPY_PREFIX` set (and `CAPY_INSTALL_DIR` not), `$CAPY_PREFIX/bin` is used, ahead of the
  existing-capy lookup and the defaults. It is the older name from the previous bash
  installer, still accepted because it is in public docs and Dockerfiles. The loader
  passes it through unchanged.
- `CAPY_NO_NPM_FALLBACK` is accepted and ignored. `CAPY_FORCE_NPM=1` stops with nothing
  installed and prints the npm command; the loader checks it before downloading, and the
  generated script checks it too.
- Notice files (`LICENSE`, `THIRD-PARTY-NOTICES.md`) are copied only when the archive holds
  them. Older archives (for example v0.9.1) have none.
- Otherwise an existing `capy` found with `command -v` decides:
  - a regular file: it is replaced in its own folder; if the folder is not writable,
    the installer stops;
  - a link whose target path has a `Cellar` segment: stop, update with Homebrew;
  - a link whose target path has a `node_modules` segment: stop, update with npm;
  - any other link: stop.
  Detection uses the file system only (link or file, and the path segments of the link
  target), never the text any tool prints.
- No existing `capy`: `/usr/local/bin` if it is on `PATH`, exists and is writable,
  otherwise `~/.local/bin`, with a `PATH` reminder.
- `install.ps1` follows the same idea: an existing standalone `capy.exe` found with
  `Get-Command` is replaced in its folder, and the user `PATH` is left alone; an npm
  shim (`capy.cmd` or `capy.ps1` with an npm package folder next to it) stops with the
  npm command; otherwise it installs to `%LOCALAPPDATA%\Programs\Capy\bin`.

## Rollout order

1. Merge this change.
2. Cut the next release. Its workflow publishes `install.sh` and `install.ps1` and runs
   the alpine smoke test.
3. Point the website's `install.sh` and `install.ps1` at
   `https://github.com/capysc/capy-cli/releases/latest/download/install.sh` and
   `.../install.ps1`, and remove the website's pinned copies and their workflow.

Until step 3 the website keeps serving its current pinned scripts.

## Older releases

Releases made before this change have no `install.sh` asset. `CAPY_VERSION=<old version>`
through the loader stops with a download error. Pinning works from the first release
that publishes the scripts.

## What is tested

- `tests/scripts/installScripts.test.ts` (`bun test`): the generator, with a good
  checksums file, a missing checksum, a malformed checksum, a conflicting checksum, a
  leftover placeholder, and the command-line wrapper.
- `tests/scripts/installShell.test.ts` (`bun test`): the generated `install.sh` and the
  root loader under `sh`, with fake `curl` and `uname` first on `PATH` and a temp
  `HOME`. The fake `curl` serves a small tarball whose real sha256 was written into the
  script by the generator, so the real verification runs. Cases: fresh install,
  `CAPY_INSTALL_DIR`, checksum mismatch, update in place, a folder that cannot be
  written, Homebrew link, npm link, other link, no hash tool, wrong binary version, and
  the loader's URLs, version validation and failed download, and `CAPY_PREFIX`,
  `CAPY_NO_NPM_FALLBACK` and `CAPY_FORCE_NPM` (including `CAPY_PREFIX` passing through the
  loader to the release installer). Run it with
  `bun run test:install`, or under another shell with
  `CAPY_TEST_SHELL=/bin/dash bun run test:install`. It also runs in `bun run test`.
- `bun run typecheck:install` type-checks the generator.
- The release workflow smoke-tests the published script in `alpine:3`.
- The Windows workflow installs, reinstalls, updates in place and stops for an npm shim.

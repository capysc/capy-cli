# Windows release: signing and winget

`release-binaries.yml` already does the Windows build. Signing and winget are
switched off until the steps below are done, and each one turns on by setting
repository variables and secrets. Nothing else changes in the release process.

## What runs on every release

1. **Build.** `capy.exe` is built on top of a copy of Node's base exe that says
   *Capy*, *Incentv Technologies Inc.* and the release version in its Windows
   version info (`scripts/windows/prepare-node-base.ts`).
2. **Sign** (once SignPath is set up). The unsigned exe is sent to SignPath,
   and the job waits for someone to approve it there. Approve within 5 hours,
   or the job times out. Signing happens before the zip and checksums are
   made.
3. **Publish.** The zip, checksums, `install.sh` and `install.ps1` are uploaded
   to the GitHub Release.
4. **Windows smoke test.** On a real Windows machine, Windows PowerShell 5.1
   runs the published `install.ps1`. The test checks `capy --version`, the
   version info and, once signing is on, that the signature is valid.
5. **winget** (once the first version is in winget). The update PR is opened
   in `microsoft/winget-pkgs`.

The `windows-binary` CI job builds and runs `capy.exe` on Windows for every PR,
so a broken Windows build shows up before release day.

## Turn on signing (after SignPath approves the project)

1. In SignPath, connect GitHub as a trusted build system for
   `capysc/capy-cli`.
2. Create the artifact configuration. The GitHub artifact is a zip that holds
   one `capy.exe`:

   ```xml
   <?xml version="1.0" encoding="utf-8"?>
   <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
     <zip-file>
       <pe-file path="capy.exe" product-name="Capy">
         <authenticode-sign />
       </pe-file>
     </zip-file>
   </artifact-configuration>
   ```

   SignPath's Foundation rules ask for metadata restrictions. Confirm in their
   UI how they want the product version restricted, because it changes every
   release.
3. Create a CI user with submitter rights, and copy its API token.
4. In GitHub → capy-cli → Settings → Secrets and variables → Actions, add:
   - Secret `SIGNPATH_API_TOKEN`
   - Variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`,
     `SIGNPATH_POLICY_SLUG`, and, if you named the configuration,
     `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`
   - Only if SignPath gives a different one: variable `SIGNPATH_CONNECTOR_URL`
     (default `https://githubactions.connector.signpath.io`)
5. Every person on the team needs two-factor login on both GitHub and SignPath.
   This is a Foundation rule.

## Turn on winget (after the first signed release)

The first version goes in by hand. After that, the workflow opens the update
PRs.

1. Fork `microsoft/winget-pkgs` under the account that will open the PRs.
2. Submit the first version from a Windows machine:

   ```powershell
   winget install wingetcreate
   wingetcreate new https://github.com/capysc/capy-cli/releases/download/v<version>/capy-win-x64-<version>.zip
   ```

   Use these answers:
   - PackageIdentifier: `Capysc.Capy`
   - Installer type: `zip`, with nested installer type `portable`
   - Nested file: `capy.exe`
   - Command alias: `capy`
   - Publisher: `Incentv Technologies Inc.`
   - License: `AGPL-3.0`

   Microsoft's review takes a few days.
3. Once it is merged, add:
   - Variable `WINGET_IDENTIFIER` = `Capysc.Capy`
   - Variable `WINGET_FORK_USER`, only if the fork is not under `capysc`
   - Secret `WINGET_TOKEN`: a classic token with the `public_repo` scope,
     belonging to the fork's owner

## The `capy.sc` redirect

`capy.sc` sends a 308 redirect to `www.capy.sc`, and Windows PowerShell 5.1
does not follow 308. The README and `install.ps1` now use the `www.` address.
To fix old links too, change the apex redirect in Vercel to 301 (Project →
Settings → Domains → `capy.sc` → Redirect to `www.capy.sc` → status 301).

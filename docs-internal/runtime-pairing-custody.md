# Runtime pairing custody

Owner ruling, 2026-09-03; implementation checkpoint, 2026-09-06:
pairing uses existing protected filesystem custody. The previous prohibition
against storing pairing key material in an ordinary 0600 file is withdrawn.
No OS keychain, native addon, or new storage dependency is required.

## Filesystem mechanism

The existing local.key stores the account's 32-byte local root under the
active Capy home's orgs/<orgId>/users/<userId>/ directory. Pairing verifies an
existing key or exclusively creates one, never silently overwriting a different
recovery key. The org identifies storage/authentication context only; it does
not attribute any repository.

auth/runtime-pair.json contains the user, credential, holder socket, lifetime,
and pairing timestamp. A version-1 record may additionally carry a validated
filesystemCustody binding: explicit environment, org, exact local.key path,
and SHA-256 digest. The record contains no raw key or PRF output. Old version-1
records remain process-only; existing recovery files never implicitly promote
them. Inactive provider-backed version-2 records retain their prior semantics.

Both files are mode 0600; custody directories are mode 0700. Restoration rejects
symlinked or insufficiently protected custody, invalid key encoding/length,
wrong digest, another user/environment, relocated custody, expired metadata,
or malformed runtime records. Errors never print file contents or secrets.

## Restart and interruption

Restoration requires the durable runtime binding, not a filesystem scan.
The existing pairing lease serializes recovery, which verifies the key,
starts the existing in-memory holder when needed, proves its user/credential
identity, and atomically updates the socket address. Key material enters the
holder through its existing private stdin, never argv, environment, chat, or
inherited output. A matching active holder is reused.

A changed/deleted runtime binding or lost lease prevents publication. A
rejected replacement holder is identity-verified and cleaned up.

The filesystem is the custody boundary, not an additional encryption-at-rest
claim: anyone able to read protected local.key has its key material. Wiped or
unavailable storage requires pairing again. The mechanism supports reboot when
storage survives, but simulated holder/process tests are not physical-reboot
acceptance evidence.

## Logout remains unchanged

Logout stops the holder and removes runtime pairing metadata and sessions.
It preserves recovery-equivalent local.key and key.enc files. Without the
runtime binding these files never silently restore a pairing. Inactive
external-provider records retain their explicit provider-cleanup contract;
no provider is selected for this filesystem path.

## Evidence

tests/auth/pairing/runtimeFilesystemPairing.test.ts covers holder recreation,
fresh-process key use, logout/no-auto-restore, wrong user/environment,
missing/corrupt/different keys, permissions and symlinks, malformed/relocated
metadata, wrong-holder cleanup, and binding deletion during restore.
Tests use disposable homes and local sockets, not WorkOS, production, OS
Keychain, or real user credentials.

The legacy runtime-pairing and inactive provider-recovery suites retain their
identity, lease, rollback, and cleanup coverage. Agent / Keep / runtime E2E
acceptance and actual reboot validation remain separate gates.

# Runtime pairing custody boundary

Status: CAP-628 process-durable slice, 2026-08-30.

## Implemented boundary

`capy pair` continues to authenticate the runtime through WorkOS RFC 8628 and
continues to recover `K_local` through the existing PRF-backed device ceremony.
The key is handed to the detached grant daemon over stdin and remains only in
that process's memory.

The CLI now writes `auth/runtime-pair.json` below the active Capy home. The
record contains only:

- the Capy user ID;
- the answering credential ID;
- the Unix-socket path;
- the daemon expiry time; and
- the pairing timestamp.

It does not contain `K_local`, the PRF output, a key derived from either value,
or a ciphertext that can be opened with data in the same file. File mode is
0600 and its parent directory is 0700. `~/.capy`, `~/.capy-dev`, and
`~/.capy-staging` remain independent because the path is derived exclusively
through `getGlobalCapyDir()`.

Later CLI processes first honor the legacy
`CAPY_DEVICE_KEY_GRANT_SOCKET` override, then discover this record. Processes
and subagents that share the protected home can therefore reuse the pair
without copying an environment variable. A stale daemon does not erase the
account binding: the same user may pair again, while a different user is
refused before its session is written. `capy logout` terminates the daemon and
removes the record. Wiping the environment home removes the association and
requires pairing again.

## Deliberate stop condition

This slice survives CLI, MCP, agent, and subagent process restarts while the
runtime and daemon remain alive. It does not survive a host reboot or a daemon
crash. The current repository has no packageable secure-at-rest primitive that
can close that gap:

- writing `K_local` to an ordinary 0600 file is explicitly prohibited;
- wrapping it with a key stored beside the ciphertext is equivalent to writing
  plaintext for this threat model;
- deriving a wrapper from the WorkOS refresh token would give the service-side
  identity plane enough material to participate in decryption and is therefore
  not zero-trust;
- the prior OS-keychain implementation used `@napi-rs/keyring` and was removed
  because native addons broke the standalone binary release pipeline.

The process-durable registry is therefore not represented as full CAP-628
completion.

## Required interface for reboot durability

The missing seam is a runtime custody provider, injected below pairing and key
resolution, with this minimal contract:

```ts
interface RuntimeCustodyProvider {
  readonly kind: 'os-secure-store' | 'orchestrator-secret-store';
  seal(input: {
    readonly environment: 'development' | 'staging' | 'production';
    readonly userId: string;
    readonly kLocal: Uint8Array;
  }): Promise<{ readonly opaqueHandle: string }>;
  unseal(input: {
    readonly environment: 'development' | 'staging' | 'production';
    readonly userId: string;
    readonly opaqueHandle: string;
  }): Promise<Uint8Array>;
  delete(input: {
    readonly environment: 'development' | 'staging' | 'production';
    readonly userId: string;
    readonly opaqueHandle: string;
  }): Promise<void>;
}
```

Security requirements:

1. The opaque handle and all ordinary files are useless without a secret held
   outside the workspace and outside the Capy service.
2. The provider binds a sealed value to the environment and user ID and refuses
   cross-user or cross-environment unseal.
3. `K_local` never appears in argv, environment variables, stdout/stderr,
   logs, chat, or service/Keep plaintext.
4. A standalone packaged binary can load the provider without unpackaged
   native addons, or the runtime/orchestrator exposes it through a protected
   inherited descriptor or authenticated local socket.
5. Logout deletes the handle and provider entry; a wiped provider behaves as
   an unpaired runtime.

The implementation test seam should supply an in-memory fake provider and pin:
seal followed by a new CLI process unseal, same-user idempotency, wrong-user and
wrong-environment refusal, deleted/wiped provider behavior, tamper refusal, and
standalone-binary packaging. A real provider must pass that corpus before the
30-minute daemon can be reconstructed after reboot without a new ceremony.

# Local Keep Cache (`~/.capy/keep/`)

## Context

Currently, encrypted env blobs only exist on S3 (content-addressed by `keep_hash`) and transiently in the local `.env` file. When a user resolves sync diffs, `keep.lock` is updated locally but the encrypted blob only lives on S3 after `capy push`. This means:
- Unpushed resolved state has no durable encrypted copy
- Every fetch requires hitting S3, even for blobs we've seen before
- No offline fallback exists

This change adds a local mirror of S3's content-addressed store at `~/.capy/keep/{keep_hash}`. Same key, same blob format. Written on every "commit" (keep.lock update), read before hitting S3.

---

## Storage Layout

```
~/.capy/keep/{keep_hash}    # 0o600, content = env blob (KEY=capy:resource_id:encrypted\n...)
```

- Directory created with `0o700`
- No eviction for now — blobs are small and bounded by distinct keep states

---

## New Module: `src/cache/keepCache.ts`

Three exports:

| Function | Description |
|----------|-------------|
| `writeKeepCache(keepHash, envBlob)` | Write blob to `~/.capy/keep/{keepHash}`. Best-effort (silent catch). |
| `readKeepCache(keepHash)` | Read blob, return `null` on miss/error. |
| `fetchSecretsWithCache(serviceClient, projectId, keepHash)` | Check local cache first → fall back to S3 → write-through on cache miss. Returns same shape as `serviceClient.getSecrets`. |

---

## Write Paths (3 sites)

These are the "commit" moments where `keep.lock` is updated and we also write the cache.

### 1. `pushCommand.ts:136` — After push to S3

After `writeKeepFile(updatedKeep)`. Both `result.keep_hash` and `envBlob` already in scope.

```ts
writeKeepCache(result.keep_hash, envBlob);
```

### 2. `capyCommand.ts:430` — Init push (first-run)

After `writeKeepFile(updatedKeep)`. `envBlob` built at line 417, `updatedKeep` and `initBranch` in scope.

```ts
const keepHash = SyncEngine.computeKeepHash(updatedKeep, initBranch);
writeKeepCache(keepHash, envBlob);
```

### 3. `capyCommand.ts:925` — Sync resolve

After `writeKeepFile(finalKeep)`. The env blob isn't constructed here, so we build it from `finalEnv`:

```ts
const cacheKeepHash = SyncEngine.computeKeepHash(finalKeep, branch);
const cacheBlob = Object.entries(finalEnv)
  .map(([k, v]) => {
    const resourceId = deriveResourceId(branch || '', k);
    const enc = Encryptor.encrypt(v, encryptionKey);
    return `${k}=capy:${resourceId}:${enc}`;
  })
  .join('\n');
writeKeepCache(cacheKeepHash, cacheBlob);
```

> **Note:** Re-encrypts with fresh nonces (different ciphertext than `.env` or S3), but that's fine — `keep_hash` is derived from plaintext hashes, and any consumer decrypts with the same project key.

---

## Read Paths (4 sites)

All currently call `serviceClient.getSecrets(projectId, keepHash)`. Each becomes:

```ts
fetchSecretsWithCache(this.serviceClient, projectId, keepHash)
```

| File | Line | Context |
|------|------|---------|
| `capyCommand.ts` | 762 | Main sync — fetch remote for 3-way comparison |
| `capyCommand.ts` | 858 | "Retrieve pinned values" action |
| `checkoutCommand.ts` | 111 | Branch switching — pull secrets |
| `statusCommand.ts` | 200 | Git hook status check |

The write-through in `fetchSecretsWithCache` means S3 responses also get cached — subsequent fetches for the same `keep_hash` hit local.

---

## Files Modified

| File | Change |
|------|--------|
| `src/config/globalConfig.ts` | Add `getKeepCachePath(keepHash)` helper |
| `src/cache/keepCache.ts` | **New** — cache read/write/fetch module |
| `src/commands/pushCommand.ts` | Write cache after push |
| `src/commands/capyCommand.ts` | Write cache on init + sync resolve; read cache on fetch (2 sites) |
| `src/commands/checkoutCommand.ts` | Read cache on fetch |
| `src/commands/statusCommand.ts` | Read cache on fetch |

---

## Verification

1. `bun run typecheck` — no type errors
2. `bun run build` — compiles
3. Manual: `capy push` → verify `~/.capy/keep/{hash}` file created
4. Manual: `capy` (sync) → resolve diffs → verify cache file written before push
5. Manual: disconnect network → `capy status` → should show remote column from cached blob

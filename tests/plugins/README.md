# Plugin tests

Per-integration health checks for capy deploy plugins. **Not part of the default
test suite.** Run periodically (cron, manual) to catch upstream API drift before
users do.

## Why a separate suite

- **Slow.** Real deploys against real providers take 30s–5min each.
- **Flaky by nature.** Network, vendor rate limits, vendor outages.
- **Needs credentials.** Each plugin requires the relevant vendor token.
- **Should not block PRs.** A Cloudflare API outage shouldn't redden every PR.

The default suite (`bun test`) excludes `tests/plugins/**`. Those tests are
unit + hermetic e2e only.

## Running

```bash
# All plugins (skips any whose credentials are missing)
bun run test:plugins

# A single plugin
bun run test:plugins:cloudflare-workers
bun run test:plugins:cloudflare-pages
```

Each plugin test has two tiers:

| Tier | Needs credentials | What it covers |
|---|---|---|
| **hermetic** | no | `wrangler deploy --dry-run`, build outputs, env-injection contract |
| **live** | yes | real deploy against vendor, smoke-test the deployed surface, cleanup |

If credentials for a plugin are missing, only the hermetic tier runs and the
live tier prints `[skipped — set $VAR1, $VAR2 to run]`.

## Credentials

Plugin tests read credentials from the inherited environment. Manage them in
Capy and invoke the runner under `capy run`, which decrypts at runtime:

```
capy run -- ./tests/plugins/run-plugin-tests.sh [plugin-name …]
```

No plaintext credential file is read from disk — Capy is the source of truth
for these secrets, by design.

### cloudflare-workers

```
CF_API_TOKEN          Cloudflare API token with Workers Scripts:Edit
CF_ACCOUNT_ID         Cloudflare account ID
CF_TEST_WORKER_NAME   (optional) Worker name to deploy. Default: capy-plugintest-worker
```

Token scope: minimum `Account → Workers Scripts → Edit` and `Workers KV
Storage → Edit` if KV is exercised. Cleanup deletes the test worker after.

### cloudflare-pages

```
CF_API_TOKEN              same token; needs Account → Cloudflare Pages → Edit
CF_ACCOUNT_ID             same
CF_TEST_PAGES_PROJECT     (optional) Pages project name. Default: capy-plugintest-pages
```

### vercel

```
VERCEL_TOKEN              Vercel personal token (Account Settings → Tokens)
VERCEL_ORG_ID             Vercel team/account ID (from the project's .vercel/project.json)
VERCEL_PROJECT_ID         Vercel project ID (from the project's .vercel/project.json)
```

Token scope: full account-level (Vercel doesn't offer fine-grained scopes
for the token API). The live tier deploys a preview build and removes it
after via `vercel remove`. Fixture lives in `tests/plugins/fixtures/nextjs-vercel/`
and mirrors `~/Dev/test-project` — Next.js 16 server component that reads
`process.env` and renders `data-capy-value={NAME}` cells the test scrapes.

> **Vercel automation status:** native `capy deploy --target=vercel` does
> not exist yet. This test exercises the *current* manual flow
> (`capy run -- next build`, then `vercel deploy`) so it doesn't drift
> while the adapter is being designed. When the adapter ships, replace
> the `vercel build` + `vercel deploy --prebuilt` steps with `capy deploy`.

## Adding a new plugin

1. Create `tests/plugins/<plugin-name>.test.ts`.
2. Top of file: declare credential env vars + a `hasCreds()` gate.
3. Hermetic tier: always runs. Validates the build path, env shape, dry-run.
4. Live tier: gated by `test.if(hasCreds())`. Deploy → assert → cleanup in
   `afterAll`.
5. Add a `test:plugins:<plugin-name>` script to `package.json`.
6. Document required credentials in this README.

## Failure semantics

- **Hermetic failure** = real bug in capy or our integration code.
- **Live failure with creds present** = either vendor API drift, expired
  credentials, or a real bug. Log the run, investigate.
- **Skipped (no creds)** = expected when running locally without secrets.

The runner exits non-zero only on actual failures, never on skips.

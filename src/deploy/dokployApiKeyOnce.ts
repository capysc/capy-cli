/**
 * Dokploy only: the org system store's API key for a target, resolved once and
 * handed to `preflight` / `deploy` as `ctx.resolvedApiKey`.
 */
import type { DeployAdapter, TargetConfig } from './adapter';
import { ERROR_CODES } from '../types/index';
import { dokployConnectionProblem, resolveDokployApiKey } from './adapters/dokploy';
import type { ResolveDokployApiKeyResult } from './adapters/dokploy';
import { DOKPLOY_CONNECTOR_SECRET_NAME, DOKPLOY_TARGET_SECRET_NAME, DokploySystemStoreCallOptions } from './dokployApi';

/**
 * Dokploy only: resolves the org system store's API key ONCE for this whole
 * command, wiring the REAL `system/systemStore.ts#getConnectorSecret` — this
 * is the production entry point for CAP-664. The result is threaded into
 * every `preflight`/`deploy`/`onRemove` call via `ctx.resolvedApiKey`, so the
 * store is asked (and an admin prompted) at most once per command no matter
 * how many of those run. `undefined` for every other adapter — they never
 * read that field.
 *
 * Never resolves (never prompts, never touches the store) when the target
 * can't even be reached — `dokployConnectionProblem` (an unusable `baseUrl`,
 * a missing `applicationId`, or a malformed `tokenEnv`): `preflight()` fails
 * on that regardless of any token, so asking for (or prompting to save) a
 * key first would be wasted at best and a needless prompt at worst.
 * Deliberately NOT the full `optionsProblem` — `onRemove` has no vars to
 * ship and must still reach a target that check would otherwise reject.
 */
export async function resolveDokployApiKeyOnce(
  adapter: DeployAdapter,
  target: TargetConfig,
  orgId: string | undefined,
  devMode: boolean | undefined,
  interactive: boolean,
): Promise<ResolveDokployApiKeyResult | undefined> {
  if (adapter.id !== 'dokploy') return undefined;
  if (dokployConnectionProblem(target)) return undefined;
  const { getDirectionalConnectorSecret } = await import('../system/systemStore');
  // CAP-679 follow-up: deploy asks for `_TARGET_DOKPLOY_API_KEY` first, and
  // — only when that's missing — offers to reuse (or shadow-refuse without a
  // TTY) `_CONNECTOR_DOKPLOY_API_KEY`, the import-side key. See
  // `system/systemStore.ts#getDirectionalConnectorSecret`'s own doc.
  const getConnectorSecret = (name: string, opts: DokploySystemStoreCallOptions) =>
    getDirectionalConnectorSecret(name, DOKPLOY_CONNECTOR_SECRET_NAME, {
      ...opts,
      missingWithFallbackCode: ERROR_CODES.DOKPLOY_TARGET_KEY_MISSING,
    });
  return resolveDokployApiKey({
    tokenEnv: (target.options as { tokenEnv?: string }).tokenEnv,
    env: process.env,
    interactive,
    orgId,
    devMode,
    storeName: DOKPLOY_TARGET_SECRET_NAME,
    deps: { getConnectorSecret },
  });
}


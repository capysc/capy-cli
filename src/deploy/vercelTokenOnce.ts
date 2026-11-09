/**
 * Vercel API mode only (CAP-696): the org system store's `_TARGET_VERCEL_TOKEN`
 * for a target, resolved once and handed to `preflight` / `deploy` as
 * `ctx.resolvedVercelToken`. Same shape as `dokployApiKeyOnce.ts`.
 */
import type { DeployAdapter, TargetConfig } from './adapter';
import { teamSlugOf } from './keyHelp';
import { ResolveVercelTokenResult, getVercelTargetSecretFromStore, isVercelApiMode, resolveVercelTargetToken } from './vercelTargetApi';

/**
 * Resolves the token ONCE for this command (the store is asked, and an admin
 * prompted, at most once). `undefined` for any other adapter, and for a Vercel
 * target still on the CLI path (no `projectId`) — those never read a token
 * from the store.
 */
export async function resolveVercelTokenOnce(
  adapter: DeployAdapter,
  target: TargetConfig,
  orgId: string | undefined,
  devMode: boolean | undefined,
  interactive: boolean,
): Promise<ResolveVercelTokenResult | undefined> {
  if (adapter.id !== 'vercel') return undefined;
  if (!isVercelApiMode(target.options)) return undefined;
  const team = teamSlugOf(typeof target.options.teamSlug === 'string' ? target.options.teamSlug : undefined);
  return resolveVercelTargetToken({
    env: process.env,
    interactive,
    orgId,
    devMode,
    getSecret: getVercelTargetSecretFromStore,
    ...(team ? { helpTeam: team } : {}),
  });
}

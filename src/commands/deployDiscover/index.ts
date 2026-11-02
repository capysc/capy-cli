/**
 * The real wiring of `capy deploy dokploy --discover` (CAP-703): silent auth,
 * the org system store, the real Dokploy API, the user's own `gh` login.
 * The behaviour lives in `./command.ts`, which takes all of it as injectable
 * seams; this file only plugs the real ones in and prints.
 */
import { readFileSync } from 'node:fs';
import { createDokployClient } from '../../deploy/dokployApi';
import { realBaseUrlStoreOpener, savedDokployTargetUrl } from '../../deploy/dokployBaseUrl';
import { dokployConnectorSecret } from '../connectors/dokploy';
import { vercelConnectorSecret } from '../connectors/vercel';
import { newPrBranchName } from '../keepLockPr';
import { realGithub } from '../secretsSet';
import { resolveSilentContext } from '../secretsSetCommand';
import { createVercelClient } from '../../deploy/vercelApi';
import { DeployDiscoverIo, DeployDiscoverOpts, runDeployDokployDiscover } from './command';
import { DeployVercelDiscoverIo, DeployVercelDiscoverOpts, runDeployVercelDiscover } from './vercel';

export async function realDeployDiscoverIo(devMode: boolean, cwd: string = process.cwd()): Promise<DeployDiscoverIo> {
  const savedBaseUrl = await savedDokployTargetUrl(cwd);
  return {
    devMode,
    env: process.env,
    savedBaseUrl: () => savedBaseUrl,
    openBaseUrlStore: (orgId) => realBaseUrlStoreOpener(orgId, devMode)(),
    readFile: (path) => readFileSync(path, 'utf-8'),
    context: async () => {
      const resolved = await resolveSilentContext(devMode);
      return resolved.ok
        ? { ok: true, orgId: resolved.context.orgId, client: resolved.context.client }
        : { ok: false, code: resolved.code, message: resolved.message };
    },
    getConnectorSecret: dokployConnectorSecret,
    dokploy: (baseUrl, token) => createDokployClient(baseUrl, token),
    github: realGithub,
    branchName: () => newPrBranchName(new Date(), undefined, 'dokploy-targets'),
    progress: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

/**
 * `capy deploy dokploy --discover`: prints ONE JSON document on stdout, in a terminal or not, and returns the exit code.
 * `io` is the seam tests use; the real command passes none.
 */
export async function deployDokployDiscoverCommand(
  opts: DeployDiscoverOpts,
  devMode: boolean = false,
  io?: DeployDiscoverIo,
): Promise<number> {
  const { exitCode, body } = await runDeployDokployDiscover(opts, io ?? (await realDeployDiscoverIo(devMode)));
  console.log(JSON.stringify(body, null, 2));
  return exitCode;
}

/** The real wiring of `capy deploy vercel --discover` (CAP-696): silent auth, the org system store, the real (read-only) Vercel API, the user's own `gh` login. */
export async function realVercelDiscoverIo(devMode: boolean): Promise<DeployVercelDiscoverIo> {
  return {
    devMode,
    env: process.env,
    readFile: (path) => readFileSync(path, 'utf-8'),
    context: async () => {
      const resolved = await resolveSilentContext(devMode);
      return resolved.ok
        ? { ok: true, orgId: resolved.context.orgId, client: resolved.context.client }
        : { ok: false, code: resolved.code, message: resolved.message };
    },
    // Discovery only reads Vercel: the import-side token, like Dokploy's discovery.
    getSecret: vercelConnectorSecret,
    // Names only: the client drops any value a response carries.
    vercel: (token) => createVercelClient(token, { dropValues: true }),
    github: realGithub,
    branchName: () => newPrBranchName(new Date(), undefined, 'vercel-targets'),
    progress: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

/**
 * `capy deploy vercel --discover`: prints ONE JSON document on stdout, in a terminal or not, and returns the exit code.
 * `io` is the seam tests use; the real command passes none.
 */
export async function deployVercelDiscoverCommand(
  opts: DeployVercelDiscoverOpts,
  devMode: boolean = false,
  io?: DeployVercelDiscoverIo,
): Promise<number> {
  const { exitCode, body } = await runDeployVercelDiscover(opts, io ?? (await realVercelDiscoverIo(devMode)));
  console.log(JSON.stringify(body, null, 2));
  return exitCode;
}

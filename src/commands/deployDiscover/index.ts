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
import { newPrBranchName } from '../keepLockPr';
import { realGithub } from '../secretsSet';
import { resolveSilentContext } from '../secretsSetCommand';
import { DeployDiscoverIo, DeployDiscoverOpts, runDeployDokployDiscover } from './command';

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

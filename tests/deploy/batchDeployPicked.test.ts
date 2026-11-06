/**
 * Batch deploy sends only the PICKED variables (CAP-715), end to end with the REAL Dokploy adapter against a
 * scripted service. The plan selects every target that ships at least one picked name; before this, such a target
 * got ALL of its deploy.json variables delivered. Now: only the picked names are written, and every other line Capy
 * already manages in the service's block is left exactly as it is, byte for byte.
 */
import { describe, test, expect, mock } from 'bun:test';
import { createDokployAdapter, mergeManagedValuesBlock, MANAGED_BEGIN, MANAGED_END } from '../../src/deploy/adapters/dokploy';
import { SKIP_CODES, deployLocationsOf, planBatchDeploy, runBatchDeploy } from '../../src/deploy/batchDeploy';
import {
  LINKS,
  NAME,
  VALUES,
  fakeGithub,
  fakeService,
  indexRows,
  makeEnv,
  standardRepos,
} from '../helpers/batchDeployWorld';

const request = { names: [NAME], locations: deployLocationsOf(indexRows()[0]) };

/** The Dokploy `api` target's service already holds DB_URL (delivered earlier, not picked now) inside Capy's block. */
const DB_LINE = "DB_URL='postgres://old-delivered/db'";
const BEFORE = `NODE_ENV=production\n${MANAGED_BEGIN}\n${DB_LINE}\n${MANAGED_END}\n`;
const AFTER = `NODE_ENV=production\n${MANAGED_BEGIN}\n${DB_LINE}\nAPI_KEY=${VALUES.API_KEY}\n${MANAGED_END}\n`;

const appJson = (env: string) => ({
  applicationId: 'app-api',
  name: 'api',
  env,
  buildArgs: null,
  buildSecrets: null,
  createEnvFile: true,
  autoDeploy: true,
  branch: 'main',
});

describe('batch deploy of picked variables, real Dokploy adapter', () => {
  test('delivering API_KEY only leaves the DB_URL line in the block byte for byte (and the bytes written are exactly that)', async () => {
    // The adapter's reads: preflight, deploy's fresh read, the read-back after the write. Only `api` is run.
    const reads = [BEFORE, BEFORE, AFTER][Symbol.iterator]();
    const saved = mock((_env: string) => undefined);
    const fetch = mock(async (url: string, init: { body?: string }) => {
      const path = new URL(url).pathname;
      if (path.endsWith('application.saveEnvironment')) {
        saved(JSON.parse(init.body ?? '{}').env as string);
        return { status: 200, ok: true, text: async () => 'true' };
      }
      if (path.endsWith('application.one')) {
        const next = reads.next();
        if (next.done) throw new Error('unscripted extra application.one read');
        return { status: 200, ok: true, text: async () => JSON.stringify(appJson(next.value)) };
      }
      throw new Error(`unscripted Dokploy request: ${path}`);
    });
    const adapter = createDokployAdapter({ fetch: fetch as never, log: () => undefined });
    const service = fakeService();
    const github = fakeGithub(standardRepos());
    const { env } = makeEnv(service, github, adapter, { resolveApiKey: async () => ({ ok: true, value: 'dk', source: 'env' }) });
    const plan = await planBatchDeploy(github, request, LINKS);
    const only = { ...plan, targets: plan.targets.filter((t) => t.config.name === 'api') };
    expect(only.targets[0].picked).toEqual([NAME]); // `api` also lists DB_URL, which is not picked

    const result = await runBatchDeploy(only, env);
    expect(result.targets[0]).toMatchObject({ kind: 'delivered' });
    expect(saved.mock.calls.map((c) => c[0])).toEqual([AFTER]);
    // What was recorded and put in the PR is the picked variable alone.
    const keepSent = JSON.parse(String(service.pushSecrets.mock.calls[0][1])) as { variables: Record<string, Array<{ targets?: Array<{ target: string }> }>> };
    expect(keepSent.variables.API_KEY[0].targets?.map((t) => t.target)).toContain('api');
    expect(keepSent.variables.DB_URL[0].targets?.map((t) => t.target) ?? []).not.toContain('api');
  });

  test('the same delivery without `keepOtherManaged` would have dropped the other line (the old behavior is what the option changes)', () => {
    const merged = mergeManagedValuesBlock(BEFORE, [{ name: NAME, value: VALUES.API_KEY }]);
    if (!merged.ok) throw new Error('fixture');
    expect(merged.env).not.toContain('DB_URL');
    expect(SKIP_CODES.KEPT_ON_PLATFORM).toBe('KEPT_ON_PLATFORM');
  });
});

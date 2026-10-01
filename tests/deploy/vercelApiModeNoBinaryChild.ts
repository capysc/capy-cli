/**
 * Child process for `vercelApiModeNoBinary.test.ts`: runs an API-mode Vercel
 * deploy in a process whose PATH holds no `vercel` binary at all, and prints
 * one JSON line. Not a test file itself.
 */
import { spawnSync } from 'child_process';
import { createVercelAdapter } from '../../src/deploy/adapters/vercel';
import { createFakeVercel } from './vercelApiModeFake';

const fake = createFakeVercel({ projectId: 'prj_1', teamId: 'team_1', token: 'tok_fake_value' });
const adapter = createVercelAdapter({ fetch: fake.fetch, env: {}, getTargetSecret: async () => 'tok_fake_value' });
const target = {
  name: 'v',
  kind: 'vercel',
  branch: 'production',
  vars: ['API_KEY'],
  mode: 'ci' as const,
  options: { projectDir: 'web', projectId: 'prj_1', teamId: 'team_1', vercelEnv: 'production' },
};

const probe = spawnSync('vercel', ['--version'], { encoding: 'utf-8' });
const pre = await adapter.preflight(target, { cwd: '/nonexistent-cwd' });
const dep = await adapter.deploy(target, { env: { API_KEY: 'v1' }, dryRun: false, cwd: '/nonexistent-cwd' });
console.log(
  JSON.stringify({
    binaryAbsent: probe.error !== undefined,
    preflightOk: pre.ok,
    deployOk: dep.ok,
    seen: fake.seenBy('production', 'API_KEY'),
  }),
);

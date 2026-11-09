/**
 * Child process for `vercelSetupNoBinary.test.ts`: runs `capy deploy`'s Vercel
 * setup in a process whose PATH holds no `vercel` binary, in an empty
 * directory (no `.vercel/project.json`), and prints one JSON line. Not a test
 * file itself.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveVercelSetup, type SetupPrompt } from '../../src/deploy/vercelSetup';
import type { VercelFetchLike } from '../../src/deploy/vercelApi';
import { fakeVercelFetch, project } from '../helpers/fakeVercel';

const dir = mkdtempSync(join(tmpdir(), 'capy-vercel-setup-nobin-'));
process.chdir(dir);

const answers: Record<string, unknown> = { projectUrl: 'https://vercel.com/acme/web', confirmed: true, vercelEnv: 'production' };
const prompt: SetupPrompt = async (questions) => ({ [String(questions[0].name)]: answers[String(questions[0].name)] });

const probe = spawnSync('vercel', ['--version'], { encoding: 'utf-8' });
const setup = await resolveVercelSetup(
  {},
  'org_1',
  {},
  {
    prompt,
    env: {},
    getSecret: async () => 'vcp_FAKE_CHILD_TOKEN',
    fetch: fakeVercelFetch({
      teams: [{ id: 'team_acme', slug: 'acme' }],
      projects: { team_acme: [project('prj_web', 'web')] },
      envs: {},
    }) as VercelFetchLike,
  },
);
console.log(
  JSON.stringify({
    binaryAbsent: probe.error !== undefined,
    noProjectFile: !existsSync(join(dir, '.vercel', 'project.json')),
    options: setup.options,
  }),
);

/**
 * The Vercel setup needs no `vercel` binary, no `.vercel/project.json` and no
 * `vercel link` (it is the REST API with a token): proven in a child process
 * whose PATH contains nothing, in an empty directory, so a stray spawn of
 * `vercel` would fail the run.
 */
import { test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

test('the setup completes with no vercel binary on PATH and no .vercel/project.json', () => {
  const child = spawnSync(process.execPath, ['run', join(import.meta.dir, 'vercelSetupNoBinaryChild.ts')], {
    encoding: 'utf-8',
    env: { PATH: '/nonexistent-bin-dir', HOME: process.env.HOME ?? '/nonexistent-home' },
  });
  expect(child.status).toBe(0);
  const out = JSON.parse(child.stdout.trim().split('\n').pop() ?? '{}');
  expect(out).toEqual({
    binaryAbsent: true,
    noProjectFile: true,
    options: { projectDir: '.', vercelEnv: 'production', projectId: 'prj_web', teamId: 'team_acme' },
  });
  expect(child.stdout).not.toContain('vcp_FAKE_CHILD_TOKEN');
  expect(child.stderr).not.toContain('vcp_FAKE_CHILD_TOKEN');
});

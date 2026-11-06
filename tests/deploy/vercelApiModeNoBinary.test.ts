/**
 * API mode needs no `vercel` binary (CAP-696): proven in a child process whose
 * PATH contains nothing, so a stray spawn of `vercel` would fail the run.
 */
import { test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

test('preflight and deploy succeed with no vercel binary on PATH', () => {
  const child = spawnSync(process.execPath, ['run', join(import.meta.dir, 'vercelApiModeNoBinaryChild.ts')], {
    encoding: 'utf-8',
    env: { PATH: '/nonexistent-bin-dir', HOME: process.env.HOME ?? '/nonexistent-home' },
  });
  expect(child.status).toBe(0);
  const out = JSON.parse(child.stdout.trim().split('\n').pop() ?? '{}');
  expect(out).toEqual({ binaryAbsent: true, preflightOk: true, deployOk: true, seen: 'v1' });
});

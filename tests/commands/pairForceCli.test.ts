/**
 * `capy pair --force`, through the BUILT cli and its real argument parser (the piped harness). Needs `bun run build` first.
 *
 * The program defines `-f/--force` ("re-encrypt"), and commander gives that flag to the program, never to `pair`: the
 * pair command's own options never hold it. The entry files read it from the merged view; the pending grant keeps
 * `force` only when the flag really arrived.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withHarness, PROD_CLI, DEV_CLI, type Harness } from '../helpers/pipedHarness';

const pendingForce = (h: Harness, globalDir: string): unknown =>
  JSON.parse(readFileSync(join(h.home, globalDir, 'pair', 'pending.json'), 'utf8')).force;

describe.each([
  ['capy', PROD_CLI, '.capy', false],
  ['capy-dev', DEV_CLI, '.capy-dev', true],
] as const)('%s pair --force', (_bin, cli, globalDir, dev) => {
  const envFor = (h: Harness): Record<string, string> => (dev ? { CAPY_API_URL: h.apiUrl } : {});

  test('--force reaches the pair command: the pending grant keeps it', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['pair', '--force', '--json'], undefined, cli, envFor(h));
      expect(result.code).toBe(3);
      expect(JSON.parse(result.stdout).code).toBe('PAIR_APPROVAL_PENDING');
      expect(pendingForce(h, globalDir)).toBe(true);
    });
  });

  test('-f, typed before the subcommand, is the same flag', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['-f', 'pair', '--json'], undefined, cli, envFor(h));
      expect(result.code).toBe(3);
      expect(pendingForce(h, globalDir)).toBe(true);
    });
  });

  test('without --force the pending grant does not keep it', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['pair', '--json'], undefined, cli, envFor(h));
      expect(result.code).toBe(3);
      expect(pendingForce(h, globalDir)).toBe(false);
    });
  });
});

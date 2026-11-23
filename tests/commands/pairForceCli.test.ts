/**
 * `capy pair --force`, through the BUILT cli and its real argument parser (the piped harness). Needs `bun run build` first.
 *
 * The program defines `-f/--force` ("re-encrypt"), and commander gives that flag to the program, never to `pair`: the
 * pair command's own options never hold it. The entry files read it from the merged view; the agent form's rerun
 * repeats `--force` only when the flag really arrived.
 */
import { describe, test, expect } from 'bun:test';
import { withHarness, PROD_CLI, DEV_CLI } from '../helpers/pipedHarness';

const rerunOf = (stdout: string): string => JSON.parse(stdout).elicitation.answer.rerun;

describe.each([
  ['capy', PROD_CLI, {}],
  ['capy-dev', DEV_CLI, { CAPY_API_URL: 'http://127.0.0.1:9' }],
] as const)('%s pair --force', (bin, cli, env) => {
  test('--force reaches the pair command: the email form repeats it', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['pair', '--force', '--json'], undefined, cli, env);
      expect(result.code).toBe(3);
      expect(rerunOf(result.stdout)).toBe(`${bin} pair --email <email> --force --json`);
    });
  });

  test('-f, typed before the subcommand, is the same flag', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['-f', 'pair', '--json'], undefined, cli, env);
      expect(rerunOf(result.stdout)).toBe(`${bin} pair --email <email> --force --json`);
    });
  });

  test('without --force the form does not repeat it', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['pair', '--json'], undefined, cli, env);
      expect(rerunOf(result.stdout)).toBe(`${bin} pair --email <email> --json`);
    });
  });
});

/**
 * `capy pair --force`, through the BUILT cli and its real argument parser (the piped harness). Needs `bun run build` first.
 *
 * The program defines `-f/--force` ("re-encrypt"), and commander gives that flag to the program, never to `pair`: the
 * pair command's own options never hold it. The entry files read it from the merged view; the agent form's rerun
 * repeats `--force` only when the flag really arrived.
 */
import { describe, test, expect } from 'bun:test';
import { withHarness, PROD_CLI, DEV_CLI } from '../helpers/pipedHarness';

/** An org this machine holds no keys for: the keys form answers before any request, so the rerun is visible offline. */
const NO_KEYS_ORG = 'org_without_keys';

const rerunOf = (stdout: string): string => JSON.parse(stdout).elicitation.answer.rerun;

describe.each([
  ['capy', PROD_CLI, {}],
  ['capy-dev', DEV_CLI, { CAPY_API_URL: 'http://127.0.0.1:9' }],
] as const)('%s pair --force', (bin, cli, env) => {
  test('--force reaches the pair command: the keys form repeats it', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['pair', '--org', NO_KEYS_ORG, '--force', '--json'], undefined, cli, env);
      expect(result.code).toBe(3);
      expect(rerunOf(result.stdout)).toBe(`${bin} pair --<keys> --org ${NO_KEYS_ORG} --force --json`);
    });
  });

  test('-f, typed before the subcommand, is the same flag', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['-f', 'pair', '--org', NO_KEYS_ORG, '--json'], undefined, cli, env);
      expect(rerunOf(result.stdout)).toBe(`${bin} pair --<keys> --org ${NO_KEYS_ORG} --force --json`);
    });
  });

  test('without --force the form does not repeat it', async () => {
    await withHarness(async (h) => {
      const result = await h.run(['pair', '--org', NO_KEYS_ORG, '--json'], undefined, cli, env);
      expect(rerunOf(result.stdout)).toBe(`${bin} pair --<keys> --org ${NO_KEYS_ORG} --json`);
    });
  });
});

/**
 * `capy run` and the repo-link report (CAP-697): the process exits with the
 * child's code, which used to kill a report still in flight, so `capy run -- true`
 * never recorded the link. `runChildThenSettle` gives the report the rest of its
 * own budget after the child ends. Real child processes, a fake slow service and
 * fake git/gh: no network.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { runChildThenSettle } from '../../src/commands/runCommand';
import { reportRepoLink, type RepoLinkDeps } from '../../src/core/repoLinkReporter';

const NODE = process.execPath;
const exits = (code: number): string[] => [NODE, '-e', `process.exit(${code})`];
const sleepsThenExits = (ms: number, code: number): string[] => [NODE, '-e', `setTimeout(() => process.exit(${code}), ${ms})`];
const diesOfSignal: string[] = [NODE, '-e', "process.kill(process.pid, 'SIGKILL')"];

function rig(clientMs: number, budgetMs: number) {
  const writeStamp = mock((_k: string, _t: number) => undefined);
  const deps: RepoLinkDeps = {
    isGitRepo: () => true,
    originUrl: () => 'git@github.com:Acme/App.git',
    showPrefix: () => '',
    githubRepoId: async () => undefined,
    readStamp: () => undefined,
    writeStamp,
    nowMs: () => 1_000_000,
    budgetMs,
    disabled: () => false,
  };
  const client = {
    putProjectRepo: mock(
      () => new Promise<never>((resolve) => setTimeout(() => (resolve as (v: unknown) => void)({ ok: true, link: {}, known_repos: [] }), clientMs)),
    ),
  };
  /** Started when the key is resolved, like in `capy run`. */
  const start = () => reportRepoLink({ cwd: '/repo', orgId: 'o', projectId: 'p', projectName: 'web', client: client as never }, deps);
  return { writeStamp, client, start };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

describe('runChildThenSettle', () => {
  test('an instant child and a slow service: the report completes and the stamp is written before exit, exit code is the child\'s', async () => {
    const r = rig(300, 1500);
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const { value, ms } = await timed(() => runChildThenSettle(exits(0), process.env, r.start()));
    const printed = err.mock.calls.length;
    err.mockRestore();
    expect(value).toBe(0);
    expect(r.writeStamp.mock.calls).toHaveLength(1); // written by the time it returned
    expect(r.client.putProjectRepo.mock.calls).toHaveLength(1);
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(1400);
    expect(printed).toBe(0);
  });

  test('a service slower than the budget: exit happens at about the budget, with the child\'s exit code and no stamp', async () => {
    const r = rig(5000, 400);
    const { value, ms } = await timed(() => runChildThenSettle(exits(7), process.env, r.start()));
    expect(value).toBe(7);
    expect(ms).toBeGreaterThanOrEqual(350);
    expect(ms).toBeLessThan(1200);
    expect(r.writeStamp.mock.calls).toHaveLength(0);
  });

  test('a long-running child adds no wait: the budget ran out while it was running', async () => {
    const withReport = rig(5000, 200);
    const baseline = await timed(() => runChildThenSettle(sleepsThenExits(700, 3), process.env, undefined));
    const settled = await timed(() => runChildThenSettle(sleepsThenExits(700, 3), process.env, withReport.start()));
    expect(settled.value).toBe(3);
    expect(Math.abs(settled.ms - baseline.ms)).toBeLessThan(200);
    expect(withReport.writeStamp.mock.calls).toHaveLength(0);
  });

  test('a long child and a fast service: nothing to wait for either', async () => {
    const r = rig(50, 1500);
    const { value, ms } = await timed(() => runChildThenSettle(sleepsThenExits(400, 0), process.env, r.start()));
    expect(value).toBe(0);
    expect(ms).toBeLessThan(900);
    expect(r.writeStamp.mock.calls).toHaveLength(1);
  });

  test('a child killed by a signal ends the run at once: no waiting for the report, exit code 1 as before', async () => {
    const r = rig(5000, 1500);
    const { value, ms } = await timed(() => runChildThenSettle(diesOfSignal, process.env, r.start()));
    expect(value).toBe(1);
    expect(ms).toBeLessThan(900);
    expect(r.writeStamp.mock.calls).toHaveLength(0);
  });

  test('no report (plain .env, deployed mode): exactly the old behaviour', async () => {
    expect(await runChildThenSettle(exits(5), process.env, undefined)).toBe(5);
  });

  test('a report that rejects is swallowed', async () => {
    expect(await runChildThenSettle(exits(0), process.env, new Promise((_, reject) => setTimeout(() => reject(new Error('x')), 30)))).toBe(0);
  });
});

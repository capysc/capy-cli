/**
 * `--dry-run` on the paths that would PROMPT (the `capy edit` TUI, an interactive
 * `capy add`, `capy remove`'s confirmation) refuses up front with
 * DRY_RUN_UNSUPPORTED: before any prompt, any screen, any auth or any file read.
 * The working directory here has no keep.lock, so anything that got past the
 * refusal would have failed differently (NO_KEEP_FILE) or prompted.
 *
 * Also the preview of the PR step and the help doc's `supportsDryRun`, with fakes.
 */
import { describe, test, expect, spyOn, mock, afterEach } from 'bun:test';
import { Command } from 'commander';
import { EditCommand } from '../../src/commands/editCommand';
import { AddCommand } from '../../src/commands/addCommand';
import { RemoveCommand } from '../../src/commands/removeCommand';
import { DRY_RUN_UNSUPPORTED_MESSAGES } from '../../src/commands/pipedValue';
import {
  previewKeepLockPrStep,
  type KeepLockPrDeps,
} from '../../src/commands/keepLockPr';
import type { ApiResult, GithubApi } from '../../src/deploy/githubApi';
import { DRY_RUN_COMMANDS, buildCliHelpDoc } from '../../src/core/cliHelpDoc';
import { renderCliReferenceMarkdown } from '../../src/core/cliReferenceMarkdown';
import { ERROR_CODES } from '../../src/types/index';

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

function setTTY(on: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
}
afterEach(() => setTTY(false));

async function capture(fn: () => Promise<void>) {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const writeSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  const thrown: unknown = await fn().then(() => null, (e: unknown) => e);
  const stdout = logSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n');
  const stderr = errSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n');
  const raw = writeSpy.mock.calls.map((c) => String(c[0])).join('');
  const exits = exitSpy.mock.calls;
  [exitSpy, logSpy, errSpy, writeSpy].forEach((s) => s.mockRestore());
  if (thrown !== null && !(thrown instanceof ExitSignal)) throw thrown;
  return { exitCode: exits.length > 0 ? (exits[exits.length - 1][0] as number | undefined) : undefined, stdout, stderr, raw };
}

describe('interactive paths refuse under --dry-run, before anything else', () => {
  test('the capy edit TUI (a terminal, no piped value): DRY_RUN_UNSUPPORTED, exit 1, JSON {ok,code,error}, no screen drawn', async () => {
    setTTY(true);
    const out = await capture(() => new EditCommand().execute({ json: true, dryRun: true }));
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toEqual({ ok: false, code: ERROR_CODES.DRY_RUN_UNSUPPORTED, error: DRY_RUN_UNSUPPORTED_MESSAGES.edit });
    expect(out.raw).not.toContain('\x1b[?1049h'); // the alt screen was never entered
  });

  test('the same with a name (the TUI would open on it), in human mode: the sentence on stderr', async () => {
    setTTY(true);
    const out = await capture(() => new EditCommand().execute({ name: 'SOME_VAR', dryRun: true }));
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe("--dry-run isn't available in the interactive editor. Pipe a value with capy edit NAME --dry-run.");
    expect(out.raw).not.toContain('\x1b[?1049h');
  });

  test('an interactive capy add (a terminal): refused before its prompts and before reading keep.lock', async () => {
    setTTY(true);
    const json = await capture(() => new AddCommand().execute(['SOME_VAR'], { json: true, dryRun: true }));
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, code: ERROR_CODES.DRY_RUN_UNSUPPORTED });
    const human = await capture(() => new AddCommand().execute(['SOME_VAR'], { dryRun: true }));
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain("--dry-run isn't available for an interactive add.");
  });

  test('an interactive capy add with no name or a bad name is the dry-run refusal too (it is first)', async () => {
    setTTY(true);
    const out = await capture(() => new AddCommand().execute([], { json: true, dryRun: true }));
    expect(JSON.parse(out.stdout).code).toBe(ERROR_CODES.DRY_RUN_UNSUPPORTED);
  });

  test('capy remove at its confirmation prompt (a terminal, no --yes, no --json): refused before anything is read', async () => {
    setTTY(true);
    const out = await capture(() => new RemoveCommand().execute(['SOME_VAR'], { dryRun: true }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(DRY_RUN_UNSUPPORTED_MESSAGES.remove);
  });

  test('capy remove with --yes, --json or --non-tty does not prompt, so it is not refused for prompting (it goes on to the normal checks)', async () => {
    setTTY(true);
    const one = (extra: object) => capture(() => new RemoveCommand().execute(['SOME_VAR'], { dryRun: true, ...extra }));
    // One after the other: each capture installs its own spies.
    const checks = [await one({ yes: true }), await one({ json: true }), await one({ nonTty: true })];
    // No keep.lock in this directory: the ordinary local check answers, not the dry-run refusal.
    checks.forEach((out) => {
      expect(out.exitCode).toBe(1);
      expect(out.stdout + out.stderr).not.toContain("--dry-run isn't available");
      expect(out.stdout + out.stderr).not.toContain(ERROR_CODES.DRY_RUN_UNSUPPORTED);
    });
  });
});

// ── the PR step's preview, with fakes ───────────────────────────────────────

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });

function previewRig(over: Partial<KeepLockPrDeps> = {}, apiOver: Partial<GithubApi> = {}) {
  const api = {
    getRepo: mock(async () => ok({ defaultBranch: 'trunk' })),
    listBranches: mock(async () => ok([] as readonly string[])),
    getBranchHead: mock(async () => ok({ commitSha: 'h', treeSha: 't' })),
    getFile: mock(async () => ok(null)),
    createBlob: mock(async () => ok({ sha: 'b' })),
    createTree: mock(async () => ok({ sha: 't2' })),
    createCommit: mock(async () => ok({ sha: 'c' })),
    createRef: mock(async () => ok({ ref: 'r' })),
    createPull: mock(async () => ok({ url: 'u' })),
    ...apiOver,
  };
  const deps: KeepLockPrDeps = {
    hasTerminal: () => true,
    confirm: mock(async () => true),
    pickBase: mock(async () => 'x'),
    isGitRepo: () => true,
    originUrl: () => 'git@github.com:acme/app.git',
    keepLockPath: () => 'keep.lock',
    github: () => api as unknown as GithubApi,
    branchName: () => 'capy/x',
    ...over,
  };
  const writes = () => [api.createBlob, api.createTree, api.createCommit, api.createRef, api.createPull].flatMap((m) => m.mock.calls);
  return { api, deps, writes };
}

describe('previewKeepLockPrStep', () => {
  test('keep.lock would not change: no PR, no questions, and GitHub is not even read', async () => {
    const r = previewRig();
    const out = await previewKeepLockPrStep({ changed: false, cwd: '/r', flags: { pr: true } }, r.deps);
    expect(out).toEqual({ keep_lock: { changed: false, committed: false, would_pr: null } });
    expect(r.api.getRepo.mock.calls).toHaveLength(0);
  });

  test('--no-pr: no PR and no questions', async () => {
    const out = await previewKeepLockPrStep({ changed: true, cwd: '/r', flags: { noPr: true } }, previewRig().deps);
    expect(out).toEqual({ keep_lock: { changed: true, committed: false, would_pr: null } });
  });

  test('no flags: the questions are left unanswered, exactly the stops a real run reports', async () => {
    const out = await previewKeepLockPrStep({ changed: true, cwd: '/r', flags: {} }, previewRig().deps);
    expect(out.keep_lock.would_pr).toBeNull();
    expect(out.unanswered).toEqual([
      { id: 'create_pr', flag: '--pr' },
      { id: 'pr_base', flag: '--pr-base' },
    ]);
    const withBase = await previewKeepLockPrStep({ changed: true, cwd: '/r', flags: { prBase: 'dev' } }, previewRig().deps);
    expect(withBase.unanswered).toEqual([{ id: 'create_pr', flag: '--pr' }]);
  });

  test('--pr: the base is --pr-base, else the default branch READ from GitHub; never a write', async () => {
    const r = previewRig();
    expect((await previewKeepLockPrStep({ changed: true, cwd: '/r', flags: { pr: true } }, r.deps)).keep_lock.would_pr).toEqual({ base: 'trunk' });
    expect((await previewKeepLockPrStep({ changed: true, cwd: '/r', flags: { pr: true, prBase: 'release/2' } }, r.deps)).keep_lock.would_pr).toEqual({ base: 'release/2' });
    expect(r.writes()).toEqual([]);
    expect(r.deps.confirm).not.toHaveBeenCalled(); // never asks, even with a terminal
  });

  test('--pr that cannot read its base: a code, never a throw', async () => {
    const notGit = await previewKeepLockPrStep({ changed: true, cwd: '/r', flags: { pr: true } }, previewRig({ isGitRepo: () => false }).deps);
    expect(notGit.keep_lock.would_pr).toEqual({ base: null, error: { code: ERROR_CODES.KEEP_PR_NOT_GIT_REPO } });
    const noRemote = await previewKeepLockPrStep({ changed: true, cwd: '/r', flags: { pr: true } }, previewRig({ originUrl: () => 'git@gitlab.com:a/b.git' }).deps);
    expect(noRemote.keep_lock.would_pr).toEqual({ base: null, error: { code: ERROR_CODES.KEEP_PR_NO_GITHUB_REMOTE } });
    const noGh = await previewKeepLockPrStep({ changed: true, cwd: '/r', flags: { pr: true } }, previewRig({ github: () => undefined }).deps);
    expect(noGh.keep_lock.would_pr).toEqual({ base: null, error: { code: ERROR_CODES.KEEP_PR_GH_UNAVAILABLE } });
    const failing = previewRig({}, { getRepo: mock(async (): Promise<ApiResult<{ defaultBranch: string }>> => ({ ok: false, kind: 'REQUEST_FAILED', status: 500 })) });
    expect((await previewKeepLockPrStep({ changed: true, cwd: '/r', flags: { pr: true } }, failing.deps)).keep_lock.would_pr).toEqual({ base: null, error: { code: ERROR_CODES.KEEP_PR_BASE_UNRESOLVED } });
    const throwing = previewRig({ originUrl: () => { throw new Error('boom'); } });
    expect((await previewKeepLockPrStep({ changed: true, cwd: '/r', flags: { pr: true } }, throwing.deps)).keep_lock.would_pr?.base).toBeNull();
  });
});

// ── the help doc ────────────────────────────────────────────────────────────

describe('help doc: supportsDryRun', () => {
  function program(): Command {
    const p = new Command().name('capy').version('1');
    ['edit', 'add', 'remove', 'status', 'agents'].forEach((n) => p.command(n).description(n));
    const secrets = p.command('secrets').description('s');
    secrets.command('set').description('s');
    return p;
  }

  test('marks the commands that honor the global --dry-run, and only those', () => {
    const doc = buildCliHelpDoc(program());
    const flag = (name: string) => doc.commands.find((c) => c.name === name)?.supportsDryRun;
    expect(['edit', 'add', 'remove', 'agents', 'secrets'].map(flag)).toEqual([true, true, true, true, true]);
    expect(flag('status')).toBe(false);
    expect(doc.commands.find((c) => c.name === 'secrets')?.subcommands[0].supportsDryRun).toBe(true);
  });

  test('every listed path exists in the real command tree (built cli)', async () => {
    const out = Bun.spawnSync(['node', `${import.meta.dir}/../../dist/index.js`, 'help', '--json']);
    const doc = JSON.parse(out.stdout.toString()) as { commands: Array<{ path: string; supportsDryRun: boolean; subcommands: Array<{ path: string; supportsDryRun: boolean }> }> };
    const all = doc.commands.flatMap((c) => [c, ...c.subcommands]);
    expect([...DRY_RUN_COMMANDS].filter((p) => !all.some((c) => c.path === p))).toEqual([]);
    expect(all.filter((c) => c.supportsDryRun).map((c) => c.path).toSorted()).toEqual([...DRY_RUN_COMMANDS].toSorted());
  });

  test('the generated reference says so for those commands and stays silent otherwise', () => {
    const md = renderCliReferenceMarkdown(buildCliHelpDoc(program()));
    expect(md).toContain('Dry run: yes (`--dry-run`)');
    const statusSection = md.slice(md.indexOf('### `capy status`') === -1 ? md.indexOf('## `capy status`') : md.indexOf('### `capy status`'));
    expect(statusSection.split('\n').slice(0, 14).join('\n')).not.toContain('Dry run: yes');
  });
});

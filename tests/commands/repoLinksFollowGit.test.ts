/**
 * A project lives where git has its keep.lock (src/commands/repoLinksFollowGit.ts): the
 * stored repo links are where it was SEEN, and they all stay. After a `git mv` there are two
 * links for one project; a write follows the base branch's own files, never scaffolds an empty
 * keep.lock at a folder the branch does not carry, and never writes into another project's
 * keep.lock. GitHub and the service are injected: no network, no `gh`.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { ERROR_CODES } from '../../src/types/index';
import { runSecretsSet, type SecretsSetIo, type SecretsSetOpts } from '../../src/commands/secretsSetCommand';
import { createEditActionsWith } from '../../src/commands/secretsEditActions';
import { MAX_PIPED_BYTES, readPipedValue } from '../../src/commands/pipedValue';
import { runSecretSet, type RepoTarget } from '../../src/commands/secretsSet';
import { followGit, followGitTargets, judgePaths, kindOfKeepText, type StoredPathKind } from '../../src/commands/repoLinksFollowGit';
import type { OrgRepoLink } from '../../src/service/serviceClient';
import {
  LINKS,
  LOCATIONS,
  NAME,
  PROJECT_NAMES,
  SENTINEL,
  fakeGithub,
  fakeService,
  githubKeep,
  indexRows,
  makeEnv,
  standardRepos,
  type RepoFixture,
} from '../helpers/secretsWorld';

// ── The scenario: pA moved from backend/deployment to backend ──────────────

const OLD = 'backend/deployment';
const NEW = 'backend';
const linkAt = (path: string, project: 'pA' | 'pB' | 'pC' = 'pA'): OrgRepoLink => ({
  project_id: project,
  project_name: PROJECT_NAMES[project],
  host: 'github.com',
  owner: 'Acme',
  name: 'mono',
  path,
  github_repo_id: 1,
  last_seen_at: '',
});
const OLD_LINK = linkAt(OLD);
const NEW_LINK = linkAt(NEW);
const FRONTEND_LINK = linkAt('frontend', 'pB');
const SOLO_LINK = LINKS.find((l) => l.project_id === 'pC') as OrgRepoLink;
const STORED: readonly OrgRepoLink[] = [OLD_LINK, NEW_LINK, FRONTEND_LINK, SOLO_LINK];

/** The mono repo as the default branch `main` holds it: the files given by repo path. */
function monoWith(files: Readonly<Record<string, string>>): readonly RepoFixture[] {
  const [, solo] = standardRepos();
  return [{ owner: 'Acme', name: 'mono', defaultBranch: 'main', files }, solo];
}

const AFTER_MOVE = monoWith({ [`${NEW}/keep.lock`]: githubKeep('pA'), 'frontend/keep.lock': githubKeep('pB') });
const BEFORE_MOVE = monoWith({ [`${OLD}/keep.lock`]: githubKeep('pA'), 'frontend/keep.lock': githubKeep('pB') });
const NO_FILE_YET = monoWith({ 'frontend/keep.lock': githubKeep('pB') });
const BOTH = monoWith({ [`${OLD}/keep.lock`]: githubKeep('pA'), [`${NEW}/keep.lock`]: githubKeep('pA'), 'frontend/keep.lock': githubKeep('pB') });
const NEW_IS_ANOTHERS = monoWith({ [`${OLD}/keep.lock`]: githubKeep('pB'), [`${NEW}/keep.lock`]: githubKeep('pA'), 'frontend/keep.lock': githubKeep('pB') });
const OLD_IS_ANOTHERS = monoWith({ [`${OLD}/keep.lock`]: githubKeep('pB'), 'frontend/keep.lock': githubKeep('pB') });

const BASES = { 'github.com/acme/mono': 'main' };

const mono = (files: readonly { project_id: string; project_name: string; path: string }[]): RepoTarget => ({ host: 'github.com', owner: 'Acme', name: 'mono', files });
const fileOf = (l: OrgRepoLink) => ({ project_id: l.project_id, project_name: l.project_name, path: l.path });

// ── The pure rule ──────────────────────────────────────────────────────────

describe('judging a project\'s stored paths', () => {
  const judge = (kinds: readonly StoredPathKind[]) => {
    const j = judgePaths(kinds.map((kind, i) => ({ item: i, kind })));
    return { keep: j.keep, foreign: j.foreign };
  };

  test('one path carries the project: only it is planned (the absent one is left out)', () => {
    expect(judge(['absent', 'present'])).toEqual({ keep: [1], foreign: [] });
  });

  test('no path carries the project: every path is kept as before (first-time setup)', () => {
    expect(judge(['absent', 'absent'])).toEqual({ keep: [0, 1], foreign: [] });
    expect(judge(['absent'])).toEqual({ keep: [0], foreign: [] });
  });

  test('both carry it: both are kept', () => {
    expect(judge(['present', 'present'])).toEqual({ keep: [0, 1], foreign: [] });
  });

  test('another project\'s keep.lock is never planned, with a present path alongside or not', () => {
    expect(judge(['other', 'present'])).toEqual({ keep: [1], foreign: [0] });
    expect(judge(['other', 'absent'])).toEqual({ keep: [1], foreign: [0] });
    expect(judge(['other'])).toEqual({ keep: [], foreign: [0] });
  });

  test('a path that could not be read is kept, whatever else is present', () => {
    expect(judge(['unknown', 'present'])).toEqual({ keep: [0, 1], foreign: [] });
    expect(judge(['unknown', 'absent'])).toEqual({ keep: [0, 1], foreign: [] });
  });

  test('a keep.lock\'s text is judged by its project_id and nothing else', () => {
    expect(kindOfKeepText('{"project_id":"pA"}', 'pA')).toBe('present');
    expect(kindOfKeepText('{"project_id":"pB"}', 'pA')).toBe('other');
    expect(kindOfKeepText('{"version":"3.0"}', 'pA')).toBe('unknown');
    expect(kindOfKeepText('not json', 'pA')).toBe('unknown');
    expect(kindOfKeepText('{"project_id":7}', 'pA')).toBe('unknown');
  });
});

// ── Over a base branch ─────────────────────────────────────────────────────

describe('the repos of a secrets set run, judged by the default branch', () => {
  const targetsFor = (links: readonly OrgRepoLink[]) => [mono(links.map(fileOf))];
  const pathsOf = (t: readonly RepoTarget[]) => t.flatMap((r) => r.files.map((f) => f.path));

  test('old and new rows, only the new one has the file: one path is planned for the project', async () => {
    const followed = (await followGitTargets(fakeGithub(AFTER_MOVE), targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]), BASES)).targets;

    expect(pathsOf(followed)).toEqual([NEW, 'frontend']);
  });

  test('neither row has the file: today\'s targets come back untouched', async () => {
    const targets = targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]);

    expect((await followGitTargets(fakeGithub(NO_FILE_YET), targets, BASES)).targets).toBe(targets);
  });

  test('both rows have the file: both are planned', async () => {
    const targets = targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]);

    expect((await followGitTargets(fakeGithub(BOTH), targets, BASES)).targets).toBe(targets);
  });

  test('the move has not landed on this branch: the old path is planned', async () => {
    const followed = (await followGitTargets(fakeGithub(BEFORE_MOVE), targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]), BASES)).targets;

    expect(pathsOf(followed)).toEqual([OLD, 'frontend']);
  });

  test('a path that holds another project\'s keep.lock is never planned; the project\'s own path still is', async () => {
    const followed = (await followGitTargets(fakeGithub(NEW_IS_ANOTHERS), targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]), BASES)).targets;

    expect(pathsOf(followed)).toEqual([NEW, 'frontend']);
  });

  test('a project whose only stored path holds another project\'s keep.lock has nothing to write: the repo is left out', async () => {
    const followed = (await followGitTargets(fakeGithub(OLD_IS_ANOTHERS), targetsFor([OLD_LINK, FRONTEND_LINK]), BASES)).targets;

    expect(pathsOf(followed)).toEqual(['frontend']);
    const alone = await followGitTargets(fakeGithub(OLD_IS_ANOTHERS), targetsFor([OLD_LINK]), BASES);
    expect(alone.targets).toEqual([]);
    expect(alone.mismatched).toEqual(['Acme/mono']);
  });

  test('a foreign path next to a present one is resolved, not reported; only a project left with nothing is', async () => {
    const resolved = await followGitTargets(fakeGithub(NEW_IS_ANOTHERS), targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]), BASES);
    const blocked = await followGitTargets(fakeGithub(OLD_IS_ANOTHERS), targetsFor([OLD_LINK, FRONTEND_LINK]), BASES);

    expect(resolved.mismatched).toEqual([]);
    expect(blocked.mismatched).toEqual(['Acme/mono']);
  });

  test('each project of a repo is judged on its own', async () => {
    const files = monoWith({ [`${NEW}/keep.lock`]: githubKeep('pA'), 'frontend/keep.lock': githubKeep('pB') });
    const followed = (await followGitTargets(fakeGithub(files), targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK, linkAt('web-old', 'pB')]), BASES)).targets;

    expect(pathsOf(followed)).toEqual([NEW, 'frontend']);
  });

  test('an unreadable keep.lock, an unknown base or no gh judges nothing: the targets come back as they were', async () => {
    const targets = targetsFor([OLD_LINK, NEW_LINK]);
    const failing = fakeGithub(AFTER_MOVE.map((r) => ({ ...r, fail: ['getFile'] })));
    expect((await followGitTargets(failing, targets, BASES)).targets).toBe(targets);
    expect((await followGitTargets(fakeGithub(AFTER_MOVE), targets, {})).targets).toBe(targets);
    expect((await followGitTargets(undefined, targets, BASES)).targets).toBe(targets);
  });

  test('a read that throws is an unknown, never a failure', async () => {
    const github = fakeGithub(AFTER_MOVE);
    github.getFile.mockImplementation(async () => {
      throw new Error('boom');
    });
    const targets = targetsFor([OLD_LINK, NEW_LINK]);

    expect((await followGitTargets(github, targets, BASES)).targets).toBe(targets);
  });

  test('every stored path is read once, from the base branch, for its own keep.lock', async () => {
    const github = fakeGithub(AFTER_MOVE);
    await followGit(github, STORED, { ...BASES, 'github.com/acme/solo': 'trunk' });

    expect(github.getFile.mock.calls.map((c) => `${(c[0] as { name: string }).name}:${c[1]}`).toSorted()).toEqual(
      [`mono:${NEW}/keep.lock`, `mono:${OLD}/keep.lock`, 'mono:frontend/keep.lock', 'solo:keep.lock'].toSorted(),
    );
  });
});

// ── The command ────────────────────────────────────────────────────────────

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

interface Captured {
  readonly exitCode: number | undefined;
  readonly returned: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

async function capture(fn: () => Promise<number>): Promise<Captured> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const outcome = await fn().then(
    (returned) => ({ returned, thrown: null as unknown }),
    (thrown: unknown) => ({ returned: undefined, thrown }),
  );
  const stdout = logSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n');
  const stderr = errSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n');
  const exits = exitSpy.mock.calls;
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  if (outcome.thrown !== null && !(outcome.thrown instanceof ExitSignal)) throw outcome.thrown;
  return { exitCode: exits.length > 0 ? (exits[exits.length - 1][0] as number | undefined) : undefined, returned: outcome.returned, stdout, stderr };
}

function rig(over: { repos: readonly RepoFixture[]; links: readonly OrgRepoLink[] }) {
  const service = fakeService();
  const github = fakeGithub(over.repos);
  const env = makeEnv(service, github);
  const io: SecretsSetIo = {
    orgId: 'org1',
    client: {
      getSecretIndex: async () => ({ org_id: 'org1', rows: indexRows(), skipped: [] }),
      getOrgRepos: async () => ({ org_id: 'org1', repos: [...over.links] }),
    },
    env,
    stdinIsTTY: false,
    readStdin: () => readPipedValue(Readable.from([`${SENTINEL}\n`]), MAX_PIPED_BYTES),
    peekStdin: async () => undefined,
  };
  return { io, service, github };
}

/** The paths one createTree call carried: several `entries`, or the one `path`. */
const pathsOfTreeCall = (params: { path?: string; entries?: ReadonlyArray<{ path: string }> }): readonly string[] => {
  if (params.entries !== undefined) return params.entries.map((e) => e.path);
  return params.path === undefined ? [] : [params.path];
};

const json = (c: Captured) => JSON.parse(c.stdout);
const run = (r: ReturnType<typeof rig>, opts: SecretsSetOpts) => capture(() => runSecretsSet(NAME, { json: true, ...opts }, r.io));
const planOf = async (r: ReturnType<typeof rig>) => json(await run(r, { dryRun: true }));
const monoPaths = (plan: { prs: ReadonlyArray<{ repo: string; keep_lock_paths: readonly string[] }> }) => plan.prs.find((p) => p.repo === 'Acme/mono')?.keep_lock_paths;
const treePaths = (r: ReturnType<typeof rig>): readonly string[] => r.github.createTree.mock.calls.flatMap((c) => pathsOfTreeCall(c[1] as Parameters<typeof pathsOfTreeCall>[0]));

describe('capy secrets set after a move', () => {
  test('the plan lists only the folder git has: the other stored folder is not a target', async () => {
    const plan = await planOf(rig({ repos: AFTER_MOVE, links: STORED }));

    expect(monoPaths(plan)).toEqual([`${NEW}/keep.lock`, 'frontend/keep.lock']);
  });

  test('the plan is the very plan a project with only the new folder gets', async () => {
    const moved = await planOf(rig({ repos: AFTER_MOVE, links: STORED }));
    const never = await planOf(rig({ repos: AFTER_MOVE, links: [NEW_LINK, FRONTEND_LINK, SOLO_LINK] }));

    expect(moved.plan_id).toBe(never.plan_id);
  });

  test('the move has landed on the default branch and both rows are still stored: one path, no scaffold, run after run', async () => {
    const r = rig({ repos: AFTER_MOVE, links: STORED });

    const first = await planOf(r);
    const one = await run(r, { confirm: first.plan_id });
    const second = await planOf(r);
    const two = await run(r, { confirm: second.plan_id });

    expect(one.returned).toBe(0);
    expect(two.returned).toBe(0);
    expect(second.plan_id).toBe(first.plan_id);
    expect(treePaths(r)).toContain(`${NEW}/keep.lock`);
    expect(treePaths(r).some((p) => p.startsWith(`${OLD}/`))).toBe(false);
    expect(r.github.createBlob.mock.calls.every((c) => !(c[1] as string).includes('"variables": {}'))).toBe(true);
    expect(json(one).prs.find((p: { repo: string }) => p.repo === 'Acme/mono').keep_lock_paths).toEqual([`${NEW}/keep.lock`, 'frontend/keep.lock']);
  });

  test('a real run on a branch where the move has not landed writes the old folder only', async () => {
    const r = rig({ repos: BEFORE_MOVE, links: STORED });
    const planId = (await planOf(r)).plan_id as string;
    await run(r, { confirm: planId });

    expect(treePaths(r)).toContain(`${OLD}/keep.lock`);
    expect(treePaths(r).some((p) => p === `${NEW}/keep.lock`)).toBe(false);
  });

  test('neither folder has a keep.lock: the plan and the writes are exactly as before', async () => {
    const r = rig({ repos: NO_FILE_YET, links: STORED });
    const plan = await planOf(r);

    expect(monoPaths(plan)).toEqual([`${OLD}/keep.lock`, `${NEW}/keep.lock`, 'frontend/keep.lock'].toSorted());
    await run(r, { confirm: plan.plan_id });
    expect(treePaths(r)).toEqual(expect.arrayContaining([`${OLD}/keep.lock`, `${NEW}/keep.lock`]));
  });

  test('both folders have a keep.lock: both are written', async () => {
    const r = rig({ repos: BOTH, links: STORED });
    const plan = await planOf(r);

    expect(monoPaths(plan)).toEqual([`${OLD}/keep.lock`, `${NEW}/keep.lock`, 'frontend/keep.lock'].toSorted());
  });

  test('a folder holding another project\'s keep.lock is never written into', async () => {
    const r = rig({ repos: NEW_IS_ANOTHERS, links: STORED });
    const plan = await planOf(r);
    await run(r, { confirm: plan.plan_id });

    expect(monoPaths(plan)).toEqual([`${NEW}/keep.lock`, 'frontend/keep.lock']);
    expect(treePaths(r).some((p) => p.startsWith(`${OLD}/`))).toBe(false);
  });
});

describe('another project\'s keep.lock at a project\'s only stored path', () => {
  const links = [OLD_LINK, FRONTEND_LINK, SOLO_LINK];
  const mismatch = { kind: 'repo', repo: 'Acme/mono', code: ERROR_CODES.KEEP_LOCK_PROJECT_MISMATCH };

  test('the plan reports the repo as failed with KEEP_LOCK_PROJECT_MISMATCH, in the same shape a run uses', async () => {
    const plan = await planOf(rig({ repos: OLD_IS_ANOTHERS, links }));

    expect(plan.failed).toEqual([mismatch]);
    expect(monoPaths(plan)).toEqual(['frontend/keep.lock']);
  });

  test('a real run reports it in `failed`, exits 1 like any failed repo, and writes nothing into the other project\'s file', async () => {
    const r = rig({ repos: OLD_IS_ANOTHERS, links });
    const planId = (await planOf(r)).plan_id as string;
    const out = await run(r, { confirm: planId });

    expect(out.returned).toBe(1);
    expect(json(out).ok).toBe(false);
    expect(json(out).failed).toContainEqual(mismatch);
    expect(treePaths(r).some((p) => p.startsWith(`${OLD}/`))).toBe(false);
  });

  test('when the only repo is the blocked one, it is in `failed` and not in prs, no_pr or not_linked', async () => {
    const r = rig({ repos: OLD_IS_ANOTHERS, links: [OLD_LINK] });
    const out = await run(r, { dryRun: true });
    const plan = json(out);

    expect(plan.failed).toEqual([mismatch]);
    expect(plan.prs.map((p: { repo: string }) => p.repo)).not.toContain('Acme/mono');
    expect(plan.not_linked).not.toContain(PROJECT_NAMES.pA);
  });

  test('a project that has its own folder next to the foreign one reports nothing', async () => {
    const plan = await planOf(rig({ repos: NEW_IS_ANOTHERS, links: STORED }));

    expect(plan.failed).toBeUndefined();
  });
});

// ── The write point ────────────────────────────────────────────────────────

describe('the write point holds the line against the files the branch has right then', () => {
  const locations = LOCATIONS.filter((l) => l.project === 'pA').map((l) => ({ project_id: l.project, project_name: PROJECT_NAMES[l.project], branch: l.branch, protected: l.protected === true }));
  const both = [OLD_LINK, NEW_LINK].map(fileOf);

  async function engine(repos: readonly RepoFixture[], files: readonly { project_id: string; project_name: string; path: string }[]) {
    const service = fakeService();
    const github = fakeGithub(repos);
    const result = await runSecretSet({ name: NAME, value: SENTINEL, locations, repos: [mono(files)], bases: BASES }, makeEnv(service, github));
    return { github, result };
  }
  const treeFiles = (github: ReturnType<typeof fakeGithub>) => github.createTree.mock.calls.flatMap((c) => pathsOfTreeCall(c[1] as Parameters<typeof pathsOfTreeCall>[0]));

  test('a path that is absent at the write, while the other stored path has the project, is skipped with a code, never scaffolded', async () => {
    const { github, result } = await engine(AFTER_MOVE, both);

    expect(treeFiles(github)).toEqual([`${NEW}/keep.lock`]);
    expect(result.prs).toHaveLength(1);
    expect(result.prs[0].keep_lock_paths).toEqual([`${NEW}/keep.lock`]);
    expect(result.prs[0].keep_lock_skipped).toEqual([{ path: `${OLD}/keep.lock`, code: ERROR_CODES.KEEP_LOCK_NOT_ON_BASE }]);
  });

  test('the same on the other side of the move', async () => {
    const { github, result } = await engine(BEFORE_MOVE, both);

    expect(treeFiles(github)).toEqual([`${OLD}/keep.lock`]);
    expect(result.prs[0].keep_lock_skipped).toEqual([{ path: `${NEW}/keep.lock`, code: ERROR_CODES.KEEP_LOCK_NOT_ON_BASE }]);
  });

  test('first-time setup (no stored path has a keep.lock yet) still creates them, with nothing skipped', async () => {
    const { github, result } = await engine(NO_FILE_YET, both);

    expect(treeFiles(github).toSorted()).toEqual([`${NEW}/keep.lock`, `${OLD}/keep.lock`].toSorted());
    expect(result.prs[0].keep_lock_skipped).toBeUndefined();
  });

  test('an alternate that exists but has no readable project id is not "present": nothing is skipped for it', async () => {
    const noId = JSON.stringify({ version: '3.0', variables: {} });
    const { github, result } = await engine(monoWith({ [`${OLD}/keep.lock`]: noId, 'frontend/keep.lock': githubKeep('pB') }), both);

    expect(treeFiles(github)).toEqual(expect.arrayContaining([`${NEW}/keep.lock`]));
    expect(result.prs[0]?.keep_lock_skipped).toBeUndefined();
  });

  test('another project\'s keep.lock at a path is refused with a code and nothing is written, even when the plan did not filter it', async () => {
    const { github, result } = await engine(NEW_IS_ANOTHERS, both);

    expect(result.failed).toEqual([{ kind: 'repo', repo: 'Acme/mono', code: ERROR_CODES.KEEP_LOCK_PROJECT_MISMATCH }]);
    expect(github.createBlob.mock.calls).toHaveLength(0);
    expect(github.createPull.mock.calls).toHaveLength(0);
  });
});

// ── The screen ─────────────────────────────────────────────────────────────

describe('the capy secrets screen after a move', () => {
  const request = (repos: readonly RepoTarget[], bases?: Readonly<Record<string, string>>) => ({
    name: NAME,
    value: SENTINEL,
    locations: LOCATIONS.filter((l) => l.project === 'pA').map((l) => ({ project_id: l.project, project_name: PROJECT_NAMES[l.project], branch: l.branch, protected: l.protected === true })),
    repos,
    ...(bases === undefined ? {} : { bases }),
  });
  const actionsFor = (github: ReturnType<typeof fakeGithub>, dryRun = false) =>
    createEditActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [] }) }, 'org1', makeEnv(fakeService(), github), dryRun);
  const files = [OLD_LINK, NEW_LINK].map(fileOf);
  const pathsOfTree = (github: ReturnType<typeof fakeGithub>) => github.createTree.mock.calls.map((c) => (c[1] as { path: string }).path);

  test('a run with the default branches read writes the folder git has', async () => {
    const github = fakeGithub(AFTER_MOVE);
    const finished = await actionsFor(github).run(request([mono(files)], BASES));

    expect(finished.ok).toBe(true);
    expect(pathsOfTree(github)).toEqual([`${NEW}/keep.lock`]);
  });

  test('a run whose default-branch read failed (no base known) still writes only where the branch has the project', async () => {
    const github = fakeGithub(AFTER_MOVE);
    const finished = await actionsFor(github).run(request([mono(files)], {}));

    expect(finished.ok).toBe(true);
    expect(pathsOfTree(github)).toEqual([`${NEW}/keep.lock`]);
  });

  test('a run handed no bases at all has them read first, and is judged the same way', async () => {
    const github = fakeGithub(AFTER_MOVE);
    const finished = await actionsFor(github).run(request([mono(files)]));

    expect(finished.ok).toBe(true);
    expect(pathsOfTree(github)).toEqual([`${NEW}/keep.lock`]);
  });

  test('a project whose only stored path holds another project\'s keep.lock is a failed repo in the run result', async () => {
    const github = fakeGithub(OLD_IS_ANOTHERS);
    const finished = await actionsFor(github).run(request([mono([OLD_LINK].map(fileOf))], BASES));

    expect(finished.ok && 'result' in finished ? finished.result.failed : undefined).toContainEqual({ kind: 'repo', repo: 'Acme/mono', code: ERROR_CODES.KEEP_LOCK_PROJECT_MISMATCH });
    expect(github.createTree.mock.calls).toHaveLength(0);
  });

  test('a dry run reads only', async () => {
    const github = fakeGithub(AFTER_MOVE);
    const finished = await actionsFor(github, true).run(request([mono(files)], BASES));

    expect(finished.ok).toBe(true);
    expect(github.createTree.mock.calls).toHaveLength(0);
  });
});

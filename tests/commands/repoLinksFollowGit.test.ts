/**
 * A project lives where git has its keep.lock (src/commands/repoLinksFollowGit.ts): the
 * stored repo links are where it was SEEN. After a `git mv` there are two links for one
 * project; a write must follow the base branch's own files, never scaffold an empty keep.lock
 * at a folder the branch does not carry, never write into another project's keep.lock, and a
 * stale link is forgotten only on default-branch evidence, best effort and silently.
 * GitHub and the service are injected: no network, no `gh`.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import { runSecretsSet, type SecretsSetIo, type SecretsSetOpts } from '../../src/commands/secretsSetCommand';
import { createEditActionsWith } from '../../src/commands/secretsEditActions';
import { MAX_PIPED_BYTES, readPipedValue } from '../../src/commands/pipedValue';
import type { RepoTarget } from '../../src/commands/secretsSet';
import {
  deleteStaleLinks,
  followGit,
  followGitTargets,
  judgePaths,
  kindOfKeepText,
  type StoredPath,
  type StoredPathKind,
} from '../../src/commands/repoLinksFollowGit';
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

const pointOf = (path: string) => ({ host: 'github.com', owner: 'Acme', name: 'mono', path });

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
    return { keep: j.keep, stale: j.stale, foreign: j.foreign };
  };

  test('one path carries the project: only it is written, and the absent ones are stale', () => {
    expect(judge(['absent', 'present'])).toEqual({ keep: [1], stale: [0], foreign: [] });
  });

  test('no path carries the project: every path is kept as before and none is stale (first-time setup)', () => {
    expect(judge(['absent', 'absent'])).toEqual({ keep: [0, 1], stale: [], foreign: [] });
    expect(judge(['absent'])).toEqual({ keep: [0], stale: [], foreign: [] });
  });

  test('both carry it: both are kept, none is stale', () => {
    expect(judge(['present', 'present'])).toEqual({ keep: [0, 1], stale: [], foreign: [] });
  });

  test('another project\'s keep.lock is never written, and never stale; with a present path alongside or not', () => {
    expect(judge(['other', 'present'])).toEqual({ keep: [1], stale: [], foreign: [0] });
    expect(judge(['other', 'absent'])).toEqual({ keep: [1], stale: [], foreign: [0] });
    expect(judge(['other'])).toEqual({ keep: [], stale: [], foreign: [0] });
  });

  test('a path that could not be read is kept and never stale, whatever else is present', () => {
    expect(judge(['unknown', 'present'])).toEqual({ keep: [0, 1], stale: [], foreign: [] });
    expect(judge(['unknown', 'absent'])).toEqual({ keep: [0, 1], stale: [], foreign: [] });
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

  test('old and new rows, only the new one has the file: one path is written, no keep.lock is read as missing-then-scaffolded at the old one', async () => {
    const github = fakeGithub(AFTER_MOVE);
    const followed = await followGitTargets(github, targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]), BASES, 'default');

    expect(pathsOf(followed.targets)).toEqual([NEW, 'frontend']);
    expect(followed.stale.map((s) => s.path)).toEqual([OLD]);
  });

  test('neither row has the file: today\'s targets come back untouched, and nothing is stale', async () => {
    const github = fakeGithub(NO_FILE_YET);
    const targets = targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]);
    const followed = await followGitTargets(github, targets, BASES, 'default');

    expect(followed.targets).toBe(targets);
    expect(followed.stale).toEqual([]);
  });

  test('both rows have the file: both are written, nothing is stale', async () => {
    const targets = targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]);
    const followed = await followGitTargets(fakeGithub(BOTH), targets, BASES, 'default');

    expect(followed.targets).toBe(targets);
    expect(followed.stale).toEqual([]);
  });

  test('the move has not landed on this branch: the old path is written, and the new row is the stale one', async () => {
    const followed = await followGitTargets(fakeGithub(BEFORE_MOVE), targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]), BASES, 'default');

    expect(pathsOf(followed.targets)).toEqual([OLD, 'frontend']);
    expect(followed.stale.map((s) => s.path)).toEqual([NEW]);
  });

  test('a path that holds another project\'s keep.lock is never written and never stale; the project\'s own path still is', async () => {
    const followed = await followGitTargets(fakeGithub(NEW_IS_ANOTHERS), targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]), BASES, 'default');

    expect(pathsOf(followed.targets)).toEqual([NEW, 'frontend']);
    expect(followed.stale).toEqual([]);
  });

  test('a project whose only stored path holds another project\'s keep.lock has nothing to write: the repo is left out, not stale', async () => {
    const followed = await followGitTargets(fakeGithub(OLD_IS_ANOTHERS), targetsFor([OLD_LINK, FRONTEND_LINK]), BASES, 'default');

    expect(pathsOf(followed.targets)).toEqual(['frontend']);
    expect(followed.stale).toEqual([]);
    const alone = await followGitTargets(fakeGithub(OLD_IS_ANOTHERS), targetsFor([OLD_LINK]), BASES, 'default');
    expect(alone.targets).toEqual([]);
  });

  test('the same filter applies on any base branch, but only the default branch may make a link stale', async () => {
    const targets = targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK]);
    const elsewhere = await followGitTargets(fakeGithub(AFTER_MOVE), targets, BASES, 'other');

    expect(pathsOf(elsewhere.targets)).toEqual([NEW, 'frontend']);
    expect(elsewhere.stale).toEqual([]);
  });

  test('a project\'s last stored link is never stale, present or not', async () => {
    const alone = await followGitTargets(fakeGithub(NO_FILE_YET), targetsFor([OLD_LINK]), BASES, 'default');
    expect(alone.stale).toEqual([]);
    const present = await followGitTargets(fakeGithub(BEFORE_MOVE), targetsFor([OLD_LINK]), BASES, 'default');
    expect(present.stale).toEqual([]);
  });

  test('each project of a repo is judged on its own', async () => {
    const files = monoWith({ [`${NEW}/keep.lock`]: githubKeep('pA'), 'frontend/keep.lock': githubKeep('pB') });
    const followed = await followGitTargets(fakeGithub(files), targetsFor([OLD_LINK, NEW_LINK, FRONTEND_LINK, linkAt('web-old', 'pB')]), BASES, 'default');

    expect(followed.stale.map((s) => `${s.project_id}:${s.path}`)).toEqual([`pA:${OLD}`, 'pB:web-old']);
  });

  test('an unreadable keep.lock, an unknown base or no gh judges nothing: the targets come back as they were', async () => {
    const targets = targetsFor([OLD_LINK, NEW_LINK]);
    const failing = fakeGithub(AFTER_MOVE.map((r) => ({ ...r, fail: ['getFile'] })));
    expect((await followGitTargets(failing, targets, BASES, 'default')).targets).toBe(targets);
    expect((await followGitTargets(fakeGithub(AFTER_MOVE), targets, {}, 'default')).targets).toBe(targets);
    expect((await followGitTargets(undefined, targets, BASES, 'default')).targets).toBe(targets);
  });

  test('a read that throws is an unknown, never a failure', async () => {
    const github = fakeGithub(AFTER_MOVE);
    github.getFile.mockImplementation(async () => {
      throw new Error('boom');
    });
    const targets = targetsFor([OLD_LINK, NEW_LINK]);

    expect((await followGitTargets(github, targets, BASES, 'default')).targets).toBe(targets);
  });

  test('every stored path is read once, from the base branch, for its own keep.lock', async () => {
    const github = fakeGithub(AFTER_MOVE);
    await followGit(github, STORED, { ...BASES, 'github.com/acme/solo': 'trunk' }, 'default');

    expect(github.getFile.mock.calls.map((c) => `${(c[0] as { name: string }).name}:${c[1]}`).toSorted()).toEqual(
      [`mono:${NEW}/keep.lock`, `mono:${OLD}/keep.lock`, 'mono:frontend/keep.lock', 'solo:keep.lock'].toSorted(),
    );
  });
});

// ── Forgetting stale links ─────────────────────────────────────────────────

describe('forgetting a stale link', () => {
  const stale: readonly StoredPath[] = [OLD_LINK];

  test('asks the service to delete exactly the stale row, by host, owner, name and path', async () => {
    const deleteProjectRepo = mock(async () => ({ ok: true as const, deleted: true }));

    await deleteStaleLinks({ deleteProjectRepo }, 'org1', stale);

    expect(deleteProjectRepo.mock.calls.map((c) => c.slice(0, 3))).toEqual([['org1', 'pA', pointOf(OLD)]]);
  });

  test('a failing delete (network, 403, an older service) is swallowed', async () => {
    const failures = [new CapyError('no', ERROR_CODES.PERMISSION_DENIED), new CapyError('gone', ERROR_CODES.NETWORK_ERROR), new Error('plain'), 'string'];
    const results = await Promise.all(
      failures.map((failure) =>
        deleteStaleLinks(
          {
            deleteProjectRepo: async () => {
              throw failure;
            },
          },
          'org1',
          stale,
        ),
      ),
    );

    expect(results).toEqual([undefined, undefined, undefined, undefined]);
  });

  test('a client without the call, and an empty list, do nothing', async () => {
    expect(await deleteStaleLinks({}, 'org1', stale)).toBeUndefined();
    expect(await deleteStaleLinks(undefined, 'org1', stale)).toBeUndefined();
    const deleteProjectRepo = mock(async () => ({ ok: true as const, deleted: true }));
    await deleteStaleLinks({ deleteProjectRepo }, 'org1', []);
    expect(deleteProjectRepo.mock.calls).toHaveLength(0);
  });

  test('the same row listed twice is deleted once', async () => {
    const deleteProjectRepo = mock(async () => ({ ok: true as const, deleted: true }));

    await deleteStaleLinks({ deleteProjectRepo }, 'org1', [OLD_LINK, { ...OLD_LINK }]);

    expect(deleteProjectRepo.mock.calls).toHaveLength(1);
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

type DeleteFn = NonNullable<SecretsSetIo['client']['deleteProjectRepo']>;

function rig(over: { repos: readonly RepoFixture[]; links: readonly OrgRepoLink[]; deleteProjectRepo?: DeleteFn | 'absent' }) {
  const service = fakeService();
  const github = fakeGithub(over.repos);
  const env = makeEnv(service, github);
  const deleteProjectRepo = mock<DeleteFn>(async () => ({ ok: true, deleted: true }));
  const chosen = over.deleteProjectRepo === 'absent' ? undefined : (over.deleteProjectRepo ?? deleteProjectRepo);
  const io: SecretsSetIo = {
    orgId: 'org1',
    client: {
      getSecretIndex: async () => ({ org_id: 'org1', rows: indexRows(), skipped: [] }),
      getOrgRepos: async () => ({ org_id: 'org1', repos: [...over.links] }),
      ...(chosen === undefined ? {} : { deleteProjectRepo: chosen }),
    },
    env,
    stdinIsTTY: false,
    readStdin: () => readPipedValue(Readable.from([`${SENTINEL}\n`]), MAX_PIPED_BYTES),
    peekStdin: async () => undefined,
  };
  return { io, service, github, deleteProjectRepo: chosen === undefined ? deleteProjectRepo : chosen };
}

const json = (c: Captured) => JSON.parse(c.stdout);
const run = (r: ReturnType<typeof rig>, opts: SecretsSetOpts) => capture(() => runSecretsSet(NAME, { json: true, ...opts }, r.io));
const planOf = async (r: ReturnType<typeof rig>) => json(await run(r, { dryRun: true }));
const monoPaths = (plan: { prs: ReadonlyArray<{ repo: string; keep_lock_paths: readonly string[] }> }) => plan.prs.find((p) => p.repo === 'Acme/mono')?.keep_lock_paths;
const treePaths = (r: ReturnType<typeof rig>): readonly string[] =>
  r.github.createTree.mock.calls.flatMap((c) => {
    const params = c[1] as { path?: string; entries?: ReadonlyArray<{ path: string }> };
    return params.entries === undefined ? (params.path === undefined ? [] : [params.path]) : params.entries.map((e) => e.path);
  });

describe('capy secrets set after a move', () => {
  test('the plan lists only the folder git has: the stale one is not a target', async () => {
    const plan = await planOf(rig({ repos: AFTER_MOVE, links: STORED }));

    expect(monoPaths(plan)).toEqual([`${NEW}/keep.lock`, 'frontend/keep.lock']);
  });

  test('the plan is the very plan a project with only the new folder gets', async () => {
    const moved = await planOf(rig({ repos: AFTER_MOVE, links: STORED }));
    const never = await planOf(rig({ repos: AFTER_MOVE, links: [NEW_LINK, FRONTEND_LINK, SOLO_LINK] }));

    expect(moved.plan_id).toBe(never.plan_id);
  });

  test('a real run writes the new folder only: no keep.lock is created at the old one', async () => {
    const r = rig({ repos: AFTER_MOVE, links: STORED });
    const planId = (await planOf(r)).plan_id as string;
    const out = await run(r, { confirm: planId });

    expect(out.returned).toBe(0);
    expect(treePaths(r)).toContain(`${NEW}/keep.lock`);
    expect(treePaths(r).some((p) => p.startsWith(`${OLD}/`))).toBe(false);
    const written = r.github.createBlob.mock.calls.map((c) => c[1] as string);
    expect(written.every((content) => !content.includes('"variables": {}'))).toBe(true);
    expect(json(out).prs.find((p: { repo: string }) => p.repo === 'Acme/mono').keep_lock_paths).toEqual([`${NEW}/keep.lock`, 'frontend/keep.lock']);
  });

  test('a real run on a branch where the move has not landed writes the old folder only', async () => {
    const r = rig({ repos: BEFORE_MOVE, links: STORED });
    const planId = (await planOf(r)).plan_id as string;
    await run(r, { confirm: planId });

    expect(treePaths(r)).toContain(`${OLD}/keep.lock`);
    expect(treePaths(r).some((p) => p === `${NEW}/keep.lock`)).toBe(false);
  });

  test('neither folder has a keep.lock: the plan and the writes are exactly as before, and nothing is deleted', async () => {
    const r = rig({ repos: NO_FILE_YET, links: STORED });
    const plan = await planOf(r);

    expect(monoPaths(plan)).toEqual([`${OLD}/keep.lock`, `${NEW}/keep.lock`, 'frontend/keep.lock'].toSorted());
    await run(r, { confirm: plan.plan_id });
    expect(r.deleteProjectRepo.mock.calls).toHaveLength(0);
    expect(treePaths(r)).toEqual(expect.arrayContaining([`${OLD}/keep.lock`, `${NEW}/keep.lock`]));
  });

  test('both folders have a keep.lock: both are written, nothing is deleted', async () => {
    const r = rig({ repos: BOTH, links: STORED });
    const plan = await planOf(r);
    await run(r, { confirm: plan.plan_id });

    expect(monoPaths(plan)).toEqual([`${OLD}/keep.lock`, `${NEW}/keep.lock`, 'frontend/keep.lock'].toSorted());
    expect(r.deleteProjectRepo.mock.calls).toHaveLength(0);
  });

  test('a folder holding another project\'s keep.lock is never written into, and its row is not deleted', async () => {
    const r = rig({ repos: NEW_IS_ANOTHERS, links: STORED });
    const plan = await planOf(r);
    await run(r, { confirm: plan.plan_id });

    expect(monoPaths(plan)).toEqual([`${NEW}/keep.lock`, 'frontend/keep.lock']);
    expect(treePaths(r).some((p) => p.startsWith(`${OLD}/`))).toBe(false);
    expect(r.deleteProjectRepo.mock.calls).toHaveLength(0);
  });

  test('a real run forgets the stale row, once, with the same row the plan skipped', async () => {
    const r = rig({ repos: AFTER_MOVE, links: STORED });
    const plan = await planOf(r);
    await run(r, { confirm: plan.plan_id });

    expect(r.deleteProjectRepo.mock.calls.map((c) => c.slice(0, 3))).toEqual([['org1', 'pA', pointOf(OLD)]]);
  });

  test('a dry run, a refused confirm and --no-pr never delete anything', async () => {
    const r = rig({ repos: AFTER_MOVE, links: STORED });
    const plan = await planOf(r);
    const refused = await run(r, { confirm: 'deadbeefdeadbeef' });
    const noPrPlan = json(await run(r, { noPr: true, dryRun: true }));
    await run(r, { confirm: noPrPlan.plan_id, noPr: true });

    expect(plan.ok).toBe(true);
    expect(json(refused).code).toBe(ERROR_CODES.PLAN_CHANGED);
    expect(r.deleteProjectRepo.mock.calls).toHaveLength(0);
  });

  test('a project\'s only row is never deleted', async () => {
    const r = rig({ repos: NO_FILE_YET, links: [OLD_LINK, FRONTEND_LINK, SOLO_LINK] });
    const plan = await planOf(r);
    await run(r, { confirm: plan.plan_id });

    expect(r.deleteProjectRepo.mock.calls).toHaveLength(0);
  });

  test('a delete that fails changes neither the output nor the exit code', async () => {
    const quiet = rig({ repos: AFTER_MOVE, links: STORED, deleteProjectRepo: 'absent' });
    const failing = rig({
      repos: AFTER_MOVE,
      links: STORED,
      deleteProjectRepo: async () => {
        throw new CapyError('not allowed', ERROR_CODES.PERMISSION_DENIED);
      },
    });
    const planId = (await planOf(quiet)).plan_id as string;

    const a = await run(quiet, { confirm: planId });
    const b = await run(failing, { confirm: planId });

    expect(b.stdout).toBe(a.stdout);
    expect(b.stderr).toBe(a.stderr);
    expect([b.returned, b.exitCode]).toEqual([a.returned, a.exitCode]);
    expect(a.returned).toBe(0);
  });
});

// ── The TUI's engine ───────────────────────────────────────────────────────

describe('the capy secrets screen after a move', () => {
  const request = (repos: readonly RepoTarget[]) => ({
    name: NAME,
    value: SENTINEL,
    locations: LOCATIONS.filter((l) => l.project === 'pA').map((l) => ({ project_id: l.project, project_name: PROJECT_NAMES[l.project], branch: l.branch, protected: l.protected === true })),
    repos,
    bases: BASES,
  });

  test('a run writes the folder git has and forgets the other row', async () => {
    const service = fakeService();
    const github = fakeGithub(AFTER_MOVE);
    const env = makeEnv(service, github);
    const deleteProjectRepo = mock<DeleteFn>(async () => ({ ok: true, deleted: true }));
    const actions = createEditActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [] }), deleteProjectRepo }, 'org1', env);

    const finished = await actions.run(request([mono([OLD_LINK, NEW_LINK].map(fileOf))]));

    expect(finished.ok).toBe(true);
    expect(github.createTree.mock.calls.map((c) => (c[1] as { path: string }).path)).toEqual([`${NEW}/keep.lock`]);
    expect(deleteProjectRepo.mock.calls.map((c) => c.slice(0, 3))).toEqual([['org1', 'pA', pointOf(OLD)]]);
  });

  test('a dry run reads only: nothing is deleted', async () => {
    const service = fakeService();
    const github = fakeGithub(AFTER_MOVE);
    const deleteProjectRepo = mock<DeleteFn>(async () => ({ ok: true, deleted: true }));
    const actions = createEditActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [] }), deleteProjectRepo }, 'org1', makeEnv(service, github), true);

    const finished = await actions.run(request([mono([OLD_LINK, NEW_LINK].map(fileOf))]));

    expect(finished.ok).toBe(true);
    expect(deleteProjectRepo.mock.calls).toHaveLength(0);
    expect(github.createTree.mock.calls).toHaveLength(0);
  });
});

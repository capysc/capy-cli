/**
 * Project -> repo links (CAP-697), the reporter's own rules with everything
 * external injected: no git, no gh, no network, no home directory.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { parseGithubRemote, parseRemote, treeEntriesOf, createGhApi, type GhRunner } from '../../src/deploy/githubApi';
import {
  buildReport,
  folderFromPrefix,
  isThrottled,
  mismatchWarning,
  printRepoLinkWarnings,
  reportRepoLink,
  reportRepoLinkForCommand,
  repoLinkWarningsField,
  throttleKey,
  type RepoLinkClient,
  type RepoLinkDeps,
  type RepoLinkInput,
} from '../../src/core/repoLinkReporter';
import { ERROR_CODES } from '../../src/types/index';

describe('parseRemote: origin parsing (the githubApi parser, reused)', () => {
  const cases: ReadonlyArray<readonly [string, string, { host: string; owner: string; name: string } | null]> = [
    ['scp-like', 'git@github.com:Owner/Repo.git', { host: 'github.com', owner: 'Owner', name: 'Repo' }],
    ['scp-like without .git', 'git@github.com:Owner/Repo', { host: 'github.com', owner: 'Owner', name: 'Repo' }],
    ['ssh://', 'ssh://git@github.com/Owner/Repo.git', { host: 'github.com', owner: 'Owner', name: 'Repo' }],
    ['ssh:// with a port', 'ssh://git@github.com:22/Owner/Repo.git', { host: 'github.com', owner: 'Owner', name: 'Repo' }],
    ['https', 'https://github.com/Owner/Repo', { host: 'github.com', owner: 'Owner', name: 'Repo' }],
    ['https with .git and a slash', 'https://github.com/Owner/Repo.git/', { host: 'github.com', owner: 'Owner', name: 'Repo' }],
    ['https with userinfo', 'https://user:ghp_token@github.com/Owner/Repo.git', { host: 'github.com', owner: 'Owner', name: 'Repo' }],
    ['https with a token as the user', 'https://ghp_token@github.com/Owner/Repo.git', { host: 'github.com', owner: 'Owner', name: 'Repo' }],
    ['git://', 'git://github.com/Owner/Repo.git', { host: 'github.com', owner: 'Owner', name: 'Repo' }],
    ['a GitHub Enterprise host', 'git@ghe.example.com:Owner/Repo.git', { host: 'ghe.example.com', owner: 'Owner', name: 'Repo' }],
    ['the host is lowercased', 'https://GitHub.com/Owner/Repo', { host: 'github.com', owner: 'Owner', name: 'Repo' }],
    ['a GitLab subgroup (not owner/name)', 'git@gitlab.com:group/sub/Repo.git', null],
    ['garbage', 'not a url', null],
    ['empty', '', null],
    ['only an owner', 'https://github.com/Owner', null],
    ['a traversal', 'https://github.com/../Repo', null],
  ];
  test.each(cases)('%s', (_label, url, expected) => {
    expect(parseRemote(url)).toEqual(expected);
  });

  test('the result carries no userinfo anywhere', () => {
    expect(JSON.stringify(parseRemote('https://user:ghp_secrettoken@github.com/Owner/Repo.git'))).not.toContain('secrettoken');
    expect(JSON.stringify(parseRemote('https://user:ghp_secrettoken@github.com/Owner/Repo.git'))).not.toContain('user');
  });

  test('parseGithubRemote still accepts github.com only', () => {
    expect(parseGithubRemote('git@github.com:Owner/Repo.git')).toEqual({ owner: 'Owner', name: 'Repo' });
    expect(parseGithubRemote('git@ghe.example.com:Owner/Repo.git')).toBeNull();
  });
});

describe('folder and validation', () => {
  test('folderFromPrefix: root is ".", nested folders lose the trailing slash, backslashes become slashes', () => {
    expect(folderFromPrefix('')).toBe('.');
    expect(folderFromPrefix('\n')).toBe('.');
    expect(folderFromPrefix('services/api/')).toBe('services/api');
    expect(folderFromPrefix('services\\api\\')).toBe('services/api');
  });

  test('buildReport: root and nested paths, optional repo id', () => {
    expect(buildReport('git@github.com:Acme/app.git', '.')).toEqual({ host: 'github.com', owner: 'Acme', name: 'app', path: '.' });
    expect(buildReport('git@github.com:Acme/app.git', 'a/b', 7)).toEqual({ host: 'github.com', owner: 'Acme', name: 'app', path: 'a/b', github_repo_id: 7 });
  });

  test('buildReport refuses what the service would refuse, so a bad report is never sent', () => {
    expect(buildReport(null, '.')).toBeNull();
    expect(buildReport('git@github.com:Acme/app.git', '../x')).toBeNull();
    expect(buildReport('git@github.com:Acme/app.git', 'a//b')).toBeNull();
    expect(buildReport('git@github.com:Acme/app.git', `${'a/'.repeat(300)}b`)).toBeNull();
    expect(buildReport(`git@github.com:${'o'.repeat(40)}/app.git`, '.')).toBeNull(); // owner > 39
    expect(buildReport('git@github.com:ow.ner/app.git', '.')).toBeNull(); // dot in an owner
    expect(buildReport(`git@github.com:Acme/${'n'.repeat(101)}.git`, '.')).toBeNull(); // name > 100
    expect(buildReport('git@gitlab.com:group/sub/app.git', '.')).toBeNull();
  });
});

describe('throttling', () => {
  const report = { host: 'github.com', owner: 'Acme', name: 'App', path: '.' };

  test('the key is per project, repo (case-insensitive) and path', () => {
    const key = throttleKey('p1', report);
    expect(throttleKey('p1', { ...report, owner: 'acme', name: 'app' })).toBe(key);
    expect(throttleKey('p2', report)).not.toBe(key);
    expect(throttleKey('p1', { ...report, path: 'x' })).not.toBe(key);
    expect(throttleKey('p1', { ...report, host: 'ghe.example.com' })).not.toBe(key);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  test('once per 24h: inside the day it is throttled, at 24h it is not', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(isThrottled(undefined, 1000)).toBe(false);
    expect(isThrottled(1000, 1000 + day - 1)).toBe(true);
    expect(isThrottled(1000, 1000 + day)).toBe(false);
    expect(isThrottled(5000, 1000)).toBe(false); // a stamp from the future (clock moved) does not suppress forever
  });
});

describe('mismatchWarning', () => {
  const mine = { host: 'github.com', owner: 'Acme', name: 'App', path: '.' };

  test('other repos known and none is this one: one warning naming them once each', () => {
    const warning = mismatchWarning(
      [
        { host: 'github.com', owner: 'a', name: 'b', path: '.' },
        { host: 'github.com', owner: 'a', name: 'b', path: 'sub' },
        { host: 'github.com', owner: 'c', name: 'd', path: '.' },
      ],
      mine,
    );
    expect(warning?.code).toBe(ERROR_CODES.KEEP_LOCK_REPO_MISMATCH);
    expect(warning?.repos).toEqual(['a/b', 'c/d']);
    expect(warning?.message).toBe('keep.lock project is also linked to other repos: a/b, c/d');
  });

  test('no warning for no other repos, or when one is this repo (case-insensitive, any folder)', () => {
    expect(mismatchWarning([], mine)).toBeNull();
    expect(mismatchWarning([{ host: 'github.com', owner: 'acme', name: 'APP', path: 'other-folder' }], mine)).toBeNull();
    expect(mismatchWarning([{ host: 'github.com', owner: 'acme', name: 'app', path: '.' }, { host: 'github.com', owner: 'x', name: 'y', path: '.' }], mine)).toBeNull();
  });

  test('the same owner/name on a DIFFERENT host is a different repo', () => {
    expect(mismatchWarning([{ host: 'ghe.example.com', owner: 'Acme', name: 'App', path: '.' }], mine)).not.toBeNull();
  });
});

// ── the reporter with fakes ─────────────────────────────────────────────────

const INPUT_BASE: Omit<RepoLinkInput, 'client'> = { cwd: '/repo', orgId: 'org1', projectId: 'proj1', projectName: 'web' };

interface Rig {
  readonly deps: RepoLinkDeps;
  readonly put: ReturnType<typeof mock>;
  readonly client: RepoLinkClient;
  readonly stamps: Record<string, number>;
  readonly writeStamp: ReturnType<typeof mock>;
  readonly githubRepoId: ReturnType<typeof mock>;
}

function rig(
  over: Partial<RepoLinkDeps> & {
    put?: (...a: unknown[]) => Promise<unknown>;
    stamps?: Record<string, number>;
  } = {},
): Rig {
  const stamps = over.stamps ?? {};
  const put = mock(over.put ?? (async () => ({ ok: true, link: {}, known_repos: [] })));
  const writeStamp = mock((_k: string, _t: number) => undefined);
  const githubRepoId = mock(async () => 99 as number | undefined);
  const deps: RepoLinkDeps = {
    isGitRepo: () => true,
    originUrl: () => 'git@github.com:Acme/App.git',
    showPrefix: () => '',
    githubRepoId,
    readStamp: (k) => stamps[k],
    writeStamp,
    nowMs: () => 1_000_000,
    budgetMs: 1500,
    disabled: () => false,
    ...over,
  };
  return { deps, put, client: { putProjectRepo: put as never }, stamps, writeStamp, githubRepoId };
}

describe('reportRepoLink', () => {
  test('reports the origin at the repo root with the gh repo id, then stamps', async () => {
    const r = rig();
    const result = await reportRepoLink({ ...INPUT_BASE, client: r.client }, r.deps);
    expect(result.status).toBe('reported');
    expect(r.put.mock.calls).toHaveLength(1);
    const [orgId, projectId, link] = r.put.mock.calls[0];
    expect([orgId, projectId]).toEqual(['org1', 'proj1']);
    expect(link).toEqual({ host: 'github.com', owner: 'Acme', name: 'App', path: '.', github_repo_id: 99 });
    expect(r.writeStamp.mock.calls).toHaveLength(1);
  });

  test('a nested keep.lock folder is the path; a monorepo with two keep.locks is two links', async () => {
    const backend = rig({ showPrefix: () => 'services/backend/' });
    const frontend = rig({ showPrefix: () => 'services/frontend/' });
    await reportRepoLink({ ...INPUT_BASE, client: backend.client }, backend.deps);
    await reportRepoLink({ ...INPUT_BASE, client: frontend.client }, frontend.deps);
    expect((backend.put.mock.calls[0][2] as { path: string }).path).toBe('services/backend');
    expect((frontend.put.mock.calls[0][2] as { path: string }).path).toBe('services/frontend');
    expect(throttleKey('proj1', { host: 'github.com', owner: 'Acme', name: 'App', path: 'services/backend' })).not.toBe(
      throttleKey('proj1', { host: 'github.com', owner: 'Acme', name: 'App', path: 'services/frontend' }),
    );
  });

  test('only github.com asks gh for an id; another host is reported without one', async () => {
    const r = rig({ originUrl: () => 'git@ghe.example.com:Acme/App.git' });
    await reportRepoLink({ ...INPUT_BASE, client: r.client }, r.deps);
    expect(r.githubRepoId.mock.calls).toHaveLength(0);
    expect(r.put.mock.calls[0][2]).toEqual({ host: 'ghe.example.com', owner: 'Acme', name: 'App', path: '.' });
  });

  test('no gh id (gh missing): reported without `github_repo_id`, silently', async () => {
    const r = rig({ githubRepoId: mock(async () => undefined) as never });
    await reportRepoLink({ ...INPUT_BASE, client: r.client }, r.deps);
    expect(r.put.mock.calls[0][2]).toEqual({ host: 'github.com', owner: 'Acme', name: 'App', path: '.' });
  });

  test('throttled inside 24h: no request; after 24h it reports again', async () => {
    const key = throttleKey('proj1', { host: 'github.com', owner: 'Acme', name: 'App', path: '.' });
    const fresh = rig({ stamps: { [key]: 1_000_000 - 60_000 } });
    expect((await reportRepoLink({ ...INPUT_BASE, client: fresh.client }, fresh.deps)).status).toBe('throttled');
    expect(fresh.put.mock.calls).toHaveLength(0);
    expect(fresh.githubRepoId.mock.calls).toHaveLength(0);
    const old = rig({ stamps: { [key]: 1_000_000 - 25 * 60 * 60 * 1000 } });
    expect((await reportRepoLink({ ...INPUT_BASE, client: old.client }, old.deps)).status).toBe('reported');
  });

  test.each([
    ['--dry-run', { dryRun: true }, {}],
    ['outside git', {}, { isGitRepo: () => false }],
    ['no origin', {}, { originUrl: () => null }],
    ['an unparseable origin', {}, { originUrl: () => 'not a remote' }],
    ['a GitLab subgroup', {}, { originUrl: () => 'git@gitlab.com:a/b/c.git' }],
    ['a system project', { projectName: '_system' }, {}],
    ['the off switch', {}, { disabled: () => true }],
  ] as const)('skipped: %s', async (_label, inputOver, depsOver) => {
    const r = rig(depsOver as Partial<RepoLinkDeps>);
    const result = await reportRepoLink({ ...INPUT_BASE, ...inputOver, client: r.client }, r.deps);
    expect(result).toEqual({ status: 'skipped', warnings: [] });
    expect(r.put.mock.calls).toHaveLength(0);
    expect(r.writeStamp.mock.calls).toHaveLength(0);
  });

  test('a service that fails is dropped silently: no throw, no output, no stamp', async () => {
    const out = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const r = rig({ put: async () => { throw new Error('HTTP 500 boom'); } });
    const result = await reportRepoLink({ ...INPUT_BASE, client: r.client }, r.deps);
    const printed = out.mock.calls.length + err.mock.calls.length;
    out.mockRestore();
    err.mockRestore();
    expect(result).toEqual({ status: 'dropped', warnings: [] });
    expect(printed).toBe(0);
    expect(r.writeStamp.mock.calls).toHaveLength(0);
  });

  test('a service that never answers is given up on inside the budget', async () => {
    const r = rig({ budgetMs: 40, put: () => new Promise(() => undefined) });
    const started = Date.now();
    const result = await reportRepoLink({ ...INPUT_BASE, client: r.client }, r.deps);
    expect(result.status).toBe('dropped');
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('a git or gh helper that throws is dropped too', async () => {
    const r = rig({ originUrl: () => { throw new Error('git exploded'); } });
    expect((await reportRepoLink({ ...INPUT_BASE, client: r.client }, r.deps)).status).toBe('dropped');
  });

  test('known_repos that exclude this repo come back as the warning; the repo itself does not', async () => {
    const other = rig({ put: async () => ({ ok: true, link: {}, known_repos: [{ host: 'github.com', owner: 'x', name: 'y', path: '.' }] }) });
    const warned = await reportRepoLink({ ...INPUT_BASE, client: other.client }, other.deps);
    expect(warned.warnings.map((w) => w.code)).toEqual([ERROR_CODES.KEEP_LOCK_REPO_MISMATCH]);
    const same = rig({ put: async () => ({ ok: true, link: {}, known_repos: [{ host: 'github.com', owner: 'ACME', name: 'app', path: 'x' }] }) });
    expect((await reportRepoLink({ ...INPUT_BASE, client: same.client }, same.deps)).warnings).toEqual([]);
  });

  test('a response that arrives after the budget gives no warning (it is not even seen)', async () => {
    const late = rig({
      budgetMs: 30,
      put: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, link: {}, known_repos: [{ host: 'github.com', owner: 'x', name: 'y', path: '.' }] }), 120)),
    });
    const result = await reportRepoLink({ ...INPUT_BASE, client: late.client }, late.deps);
    expect(result).toEqual({ status: 'dropped', warnings: [] });
  });
});

describe('what it prints', () => {
  const warned = rig({ put: async () => ({ ok: true, link: {}, known_repos: [{ host: 'github.com', owner: 'x', name: 'y', path: '.' }] }) });

  test('human mode: exactly one stderr line; nothing on stdout', async () => {
    const out = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    await reportRepoLinkForCommand({ ...INPUT_BASE, client: warned.client }, {}, warned.deps);
    const lines = err.mock.calls.map((c) => String(c[0]));
    const stdoutCalls = out.mock.calls.length;
    out.mockRestore();
    err.mockRestore();
    expect(stdoutCalls).toBe(0);
    expect(lines).toEqual(['  ! keep.lock project is also linked to other repos: x/y']);
  });

  test('--json / quiet: nothing printed; the caller carries `warnings` in its envelope', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const result = await reportRepoLinkForCommand({ ...INPUT_BASE, client: warned.client }, { json: true }, warned.deps);
    await reportRepoLinkForCommand({ ...INPUT_BASE, client: warned.client }, { quiet: true }, warned.deps);
    const printed = err.mock.calls.length;
    err.mockRestore();
    expect(printed).toBe(0);
    expect(repoLinkWarningsField(result)).toEqual({ warnings: [expect.objectContaining({ code: 'KEEP_LOCK_REPO_MISMATCH', repos: ['x/y'] })] });
    expect(repoLinkWarningsField({ status: 'reported', warnings: [] })).toEqual({});
  });

  test('printRepoLinkWarnings prints nothing for no warnings', () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    printRepoLinkWarnings({ status: 'reported', warnings: [] });
    const n = err.mock.calls.length;
    err.mockRestore();
    expect(n).toBe(0);
  });
});

describe('githubApi: several files in one tree', () => {
  test('treeEntriesOf accepts both shapes; createGhApi posts every entry in one tree', async () => {
    expect(treeEntriesOf({ baseTree: 't', path: 'a', blobSha: 'x' })).toEqual([{ path: 'a', blobSha: 'x' }]);
    expect(treeEntriesOf({ baseTree: 't', entries: [{ path: 'a', blobSha: 'x' }, { path: 'b', blobSha: 'y' }] })).toHaveLength(2);

    const seen = mock((_args: readonly string[], _stdin?: string) => ({
      spawned: true,
      status: 0,
      stdout: `HTTP/2.0 201 Created\r\n\r\n${JSON.stringify({ sha: 'new-tree' })}`,
    }));
    const api = createGhApi(seen as unknown as GhRunner);
    const res = await api.createTree({ owner: 'o', name: 'n' }, { baseTree: 'base', entries: [{ path: 'a/keep.lock', blobSha: 'b1' }, { path: 'b/keep.lock', blobSha: 'b2' }] });
    expect(res).toEqual({ ok: true, value: { sha: 'new-tree' } });
    const body = JSON.parse(String(seen.mock.calls[0][1])) as { base_tree: string; tree: Array<{ path: string; sha: string; mode: string }> };
    expect(body.base_tree).toBe('base');
    expect(body.tree.map((t) => [t.path, t.sha, t.mode])).toEqual([['a/keep.lock', 'b1', '100644'], ['b/keep.lock', 'b2', '100644']]);
    expect(seen.mock.calls).toHaveLength(1);
  });
});

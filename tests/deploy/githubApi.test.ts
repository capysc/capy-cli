/**
 * The `gh api` wrapper behind the keep.lock PR step. A fake runner stands in
 * for `gh`: no process is spawned and nothing reaches the network.
 */
import { describe, test, expect, mock } from 'bun:test';
import {
  createGhApi,
  isValidBranchName,
  parseGithubRemote,
  type GhRunResult,
  type GhRunner,
} from '../../src/deploy/githubApi';

const REPO = { owner: 'acme', name: 'app' };

interface Call {
  readonly args: readonly string[];
  readonly stdin?: string;
}

/** A runner that answers from `reply`; the mock library records every call. */
function recordingRunner(reply: (args: readonly string[]) => GhRunResult): { run: GhRunner; calls: () => Call[] } {
  const run = mock((args: readonly string[], _stdin?: string) => reply(args));
  return {
    run,
    calls: () => run.mock.calls.map(([args, stdin]): Call => ({ args, stdin })),
  };
}

const http = (status: number, body: unknown, exit = status >= 400 ? 1 : 0): GhRunResult => ({
  spawned: true,
  status: exit,
  stdout: `HTTP/2.0 ${status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
});

describe('parseGithubRemote', () => {
  const expected = { owner: 'acme', name: 'app' };

  test.each([
    'git@github.com:acme/app.git',
    'git@github.com:acme/app',
    'https://github.com/acme/app.git',
    'https://github.com/acme/app',
    'https://github.com/acme/app/',
    'ssh://git@github.com/acme/app.git',
    'ssh://git@github.com:22/acme/app',
    'git://github.com/acme/app.git',
    'https://x-access-token:ghp_secret@github.com/acme/app.git',
    'https://user@GitHub.com/acme/app',
  ])('%s -> acme/app', (url) => {
    expect(parseGithubRemote(url)).toEqual(expected);
  });

  test.each([
    'git@gitlab.com:acme/app.git',
    'https://github.example.com/acme/app',
    'https://github.com.evil.test/acme/app',
    'https://github.com/acme',
    'https://github.com/acme/app/extra',
    '/tmp/origin.git',
    'file:///tmp/origin.git',
    '',
    'not a url',
  ])('%s is not a github.com repository', (url) => {
    expect(parseGithubRemote(url)).toBeNull();
  });

  test('userinfo never appears in the result', () => {
    const parsed = parseGithubRemote('https://x-access-token:ghp_secret@github.com/acme/app.git');
    expect(JSON.stringify(parsed)).not.toContain('ghp_secret');
  });
});

describe('isValidBranchName (git ref rules)', () => {
  test.each(['main', 'dev', 'release/1.2', 'capy/keep-lock-20260101-120000-ab12', 'feat/x_y'])('%s is valid', (n) => {
    expect(isValidBranchName(n)).toBe(true);
  });
  test.each(['', '-x', '/x', 'x/', 'a..b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', '@', 'x.', 'a//b', '.hidden', 'x/.y', 'x.lock', 'a/x.lock'])(
    '%j is invalid',
    (n) => {
      expect(isValidBranchName(n)).toBe(false);
    },
  );
});

describe('createGhApi', () => {
  test('every call is an argv array to `gh api` on github.com and bodies go on stdin, never in argv', async () => {
    const { run, calls } = recordingRunner(() => http(201, { sha: 'b1' }));
    const api = createGhApi(run);
    await api.createBlob(REPO, 'SECRET-LOOKING-CONTENT');
    const [call] = calls();
    expect(call.args.slice(0, 3)).toEqual(['api', '--hostname', 'github.com']);
    expect(call.args).toContain('--input');
    expect(call.args.join(' ')).not.toContain('SECRET-LOOKING-CONTENT');
    expect(JSON.parse(call.stdin ?? '')).toEqual({ content: 'SECRET-LOOKING-CONTENT', encoding: 'utf-8' });
    expect(call.args[call.args.length - 1]).toBe('repos/acme/app/git/blobs');
  });

  test('getRepo reads default_branch', async () => {
    const { run } = recordingRunner(() => http(200, { default_branch: 'develop' }));
    expect(await createGhApi(run).getRepo(REPO)).toEqual({ ok: true, value: { defaultBranch: 'develop' } });
  });

  test('a response without default_branch is a failed request, not an empty branch', async () => {
    const { run } = recordingRunner(() => http(200, {}));
    expect(await createGhApi(run).getRepo(REPO)).toEqual({ ok: false, kind: 'REQUEST_FAILED' });
  });

  test('listBranches: one name per line, --paginate, decided by exit status only', async () => {
    const { run, calls } = recordingRunner(() => ({ spawned: true, status: 0, stdout: 'main\ndev\n\nfeat/x\n' }));
    const result = await createGhApi(run).listBranches(REPO);
    expect(result).toEqual({ ok: true, value: ['main', 'dev', 'feat/x'] });
    expect(calls()[0].args).toContain('--paginate');
  });

  test('listBranches: non-zero exit is REQUEST_FAILED; exit 4 is GH_UNAVAILABLE', async () => {
    const failed = createGhApi(() => ({ spawned: true, status: 1, stdout: 'main' }));
    expect(await failed.listBranches(REPO)).toEqual({ ok: false, kind: 'REQUEST_FAILED' });
    const auth = createGhApi(() => ({ spawned: true, status: 4, stdout: '' }));
    expect(await auth.listBranches(REPO)).toEqual({ ok: false, kind: 'GH_UNAVAILABLE' });
  });

  test('gh that cannot be started, or exits 4 (auth required), is GH_UNAVAILABLE', async () => {
    const missing = createGhApi(() => ({ spawned: false, status: null, stdout: '' }));
    expect(await missing.getRepo(REPO)).toEqual({ ok: false, kind: 'GH_UNAVAILABLE' });
    const auth = createGhApi(() => ({ spawned: true, status: 4, stdout: '' }));
    expect(await auth.getRepo(REPO)).toEqual({ ok: false, kind: 'GH_UNAVAILABLE' });
  });

  test('HTTP statuses decide: 401 -> GH_UNAVAILABLE, 404 -> NOT_FOUND, 422/500 -> REQUEST_FAILED with the status', async () => {
    expect(await createGhApi(() => http(401, {})).getRepo(REPO)).toEqual({ ok: false, kind: 'GH_UNAVAILABLE', status: 401 });
    expect(await createGhApi(() => http(404, {})).getRepo(REPO)).toEqual({ ok: false, kind: 'NOT_FOUND', status: 404 });
    expect(await createGhApi(() => http(422, {})).createRef(REPO, 'b', 'sha')).toEqual({ ok: false, kind: 'REQUEST_FAILED', status: 422 });
    expect(await createGhApi(() => http(500, {})).getRepo(REPO)).toEqual({ ok: false, kind: 'REQUEST_FAILED', status: 500 });
  });

  test('the wording of an error body is never consulted', async () => {
    const reworded = createGhApi(() => http(404, { message: 'Branch not found' }));
    const other = createGhApi(() => http(404, { message: 'zzz' }));
    expect(await reworded.getRepo(REPO)).toEqual(await other.getRepo(REPO));
  });

  test('getBranchHead: ref lookup then commit lookup; the branch is URL-encoded per segment', async () => {
    const { run, calls } = recordingRunner((args) => {
      const endpoint = args[args.length - 1];
      return endpoint.includes('/git/ref/heads/')
        ? http(200, { object: { sha: 'c0ffee' } })
        : http(200, { tree: { sha: 'f00d' } });
    });
    const result = await createGhApi(run).getBranchHead(REPO, 'release/v 1');
    expect(result).toEqual({ ok: true, value: { commitSha: 'c0ffee', treeSha: 'f00d' } });
    expect(calls().map((c) => c.args[c.args.length - 1])).toEqual([
      'repos/acme/app/git/ref/heads/release/v%201',
      'repos/acme/app/git/commits/c0ffee',
    ]);
  });

  test('getBranchHead: a missing branch is NOT_FOUND', async () => {
    expect(await createGhApi(() => http(404, {})).getBranchHead(REPO, 'nope')).toMatchObject({ ok: false, kind: 'NOT_FOUND' });
  });

  test('getFile: decodes base64 content at the ref, with the nested path encoded', async () => {
    const { run, calls } = recordingRunner(() =>
      http(200, { type: 'file', encoding: 'base64', content: Buffer.from('{"a":1}\n').toString('base64') }),
    );
    expect(await createGhApi(run).getFile(REPO, 'svc/api/keep.lock', 'release/1')).toEqual({ ok: true, value: '{"a":1}\n' });
    expect(calls()[0].args[calls()[0].args.length - 1]).toBe('repos/acme/app/contents/svc/api/keep.lock?ref=release%2F1');
  });

  test('getFile: 404 means the file does not exist (value null); other failures stay failures', async () => {
    expect(await createGhApi(() => http(404, {})).getFile(REPO, 'keep.lock', 'main')).toEqual({ ok: true, value: null });
    expect(await createGhApi(() => http(500, {})).getFile(REPO, 'keep.lock', 'main')).toMatchObject({ ok: false });
  });

  test('createTree sends one 100644 blob entry on the base tree', async () => {
    const { run, calls } = recordingRunner(() => http(201, { sha: 't1' }));
    await createGhApi(run).createTree(REPO, { baseTree: 'base', path: 'svc/keep.lock', blobSha: 'b1' });
    expect(JSON.parse(calls()[0].stdin ?? '')).toEqual({
      base_tree: 'base',
      tree: [{ path: 'svc/keep.lock', mode: '100644', type: 'blob', sha: 'b1' }],
    });
  });

  test('createCommit has exactly one parent and createPull returns the html_url', async () => {
    const commit = recordingRunner(() => http(201, { sha: 'c1' }));
    await createGhApi(commit.run).createCommit(REPO, { message: 'm', tree: 't', parent: 'p' });
    expect(JSON.parse(commit.calls()[0].stdin ?? '')).toEqual({ message: 'm', tree: 't', parents: ['p'] });

    const pull = recordingRunner(() => http(201, { html_url: 'https://github.com/acme/app/pull/7' }));
    expect(await createGhApi(pull.run).createPull(REPO, { title: 't', body: 'b', head: 'h', base: 'main' })).toEqual({
      ok: true,
      value: { url: 'https://github.com/acme/app/pull/7' },
    });
    expect(JSON.parse(pull.calls()[0].stdin ?? '')).toEqual({ title: 't', body: 'b', head: 'h', base: 'main' });
  });

  test('createRef targets refs/heads/<branch>', async () => {
    const { run, calls } = recordingRunner(() => http(201, { ref: 'refs/heads/capy/x' }));
    await createGhApi(run).createRef(REPO, 'capy/x', 'c1');
    expect(JSON.parse(calls()[0].stdin ?? '')).toEqual({ ref: 'refs/heads/capy/x', sha: 'c1' });
  });
});

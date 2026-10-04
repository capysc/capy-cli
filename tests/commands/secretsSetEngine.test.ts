/**
 * The `capy secrets` edit engine (src/commands/secretsSet.ts): pushing one
 * secret to many locations and opening the keep.lock PRs. Everything external
 * is injected (tests/helpers/secretsWorld.ts): no network, no `gh`, no git.
 */
import { describe, test, expect } from 'bun:test';
import { Encryptor } from '../../src/crypto/encryptor';
import { FileManager } from '../../src/files/fileManager';
import { ERROR_CODES, KeepFile } from '../../src/types/index';
import {
  keepDiverged,
  keepLockPathOf,
  planRepos,
  previewLocation,
  runSecretSet,
  type RepoTarget,
  type SetLocation,
} from '../../src/commands/secretsSet';
import { buildPrBody } from '../../src/commands/keepLockPr';
import {
  KEYS,
  LINKS,
  LOCATIONS,
  NAME,
  OLD_VALUE,
  OTHER_NAME,
  PROJECT_NAMES,
  SENTINEL,
  everythingSentTo,
  fakeGithub,
  fakeService,
  githubKeep,
  makeEnv,
  standardRepos,
  type Loc,
  type ProjectId,
} from '../helpers/secretsWorld';

const loc = (project: ProjectId, branch: string, isProtected = false): SetLocation => ({
  project_id: project,
  project_name: PROJECT_NAMES[project],
  branch,
  protected: isProtected,
});

const MONO: RepoTarget = {
  host: 'github.com',
  owner: 'Acme',
  name: 'mono',
  files: [
    { project_id: 'pA', project_name: PROJECT_NAMES.pA, path: 'backend' },
    { project_id: 'pB', project_name: PROJECT_NAMES.pB, path: 'frontend' },
  ],
};
const SOLO: RepoTarget = {
  host: 'github.com',
  owner: 'Acme',
  name: 'solo',
  files: [{ project_id: 'pC', project_name: PROJECT_NAMES.pC, path: '.' }],
};

const ALL: readonly SetLocation[] = [
  loc('pA', 'production', true),
  loc('pA', 'staging'),
  loc('pB', 'production', true),
  loc('pC', 'development'),
];

function world(over: Parameters<typeof fakeService>[0] = {}, locs: readonly Loc[] = LOCATIONS) {
  const service = fakeService({ locs, ...over });
  const github = fakeGithub(standardRepos(locs));
  return { service, github, env: makeEnv(service, github) };
}

const pushedBranches = (service: ReturnType<typeof fakeService>) =>
  service.pushSecrets.mock.calls.map((c) => `${c[0]}/${c[3]}`);

/** Decrypts what a push wrote for NAME, with the project's key. */
function pushedValue(service: ReturnType<typeof fakeService>, project: ProjectId, branch: string): string | undefined {
  const call = service.pushSecrets.mock.calls.find((c) => c[0] === project && c[3] === branch);
  const line = String(call?.[2] ?? '')
    .split('\n')
    .find((l) => l.startsWith(`${NAME}=`));
  return line === undefined ? undefined : new FileManager().decryptValue(line.slice(NAME.length + 1), KEYS[project]);
}

describe('pushing locations', () => {
  test('one push per branch, each with the new value (decrypt round-trip), and protected locations included', async () => {
    const { service, env } = world();
    const result = await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [] }, env);

    expect(pushedBranches(service)).toEqual(['pA/production', 'pA/staging', 'pB/production', 'pC/development']);
    expect(pushedValue(service, 'pA', 'production')).toBe(SENTINEL);
    expect(pushedValue(service, 'pC', 'development')).toBe(SENTINEL);
    expect(result.updated).toEqual([
      { project: PROJECT_NAMES.pA, branch: 'production', protected: true },
      { project: PROJECT_NAMES.pA, branch: 'staging', protected: false },
      { project: PROJECT_NAMES.pB, branch: 'production', protected: true },
      { project: PROJECT_NAMES.pC, branch: 'development', protected: false },
    ]);
    expect(result.failed).toEqual([]);
    // The cache is written for every push, keyed by the response's keep hash.
    expect(env.writeCache.mock.calls).toHaveLength(4);
  });

  test('only this variable changes: the other variable line is carried over byte for byte and its keep entry is untouched', async () => {
    const { service, env } = world();
    await runSecretSet({ name: NAME, value: SENTINEL, locations: [loc('pA', 'staging')], repos: [] }, env);

    const [, keepJson, blob] = service.pushSecrets.mock.calls[0];
    const before = String((await service.getDecryptData('pA', 'staging')).env_content).split('\n');
    const after = String(blob).split('\n');
    expect(after[0]).toBe(before[0]); // OTHER_VAR line: identical ciphertext
    expect(after[1]).not.toBe(before[1]);
    const keep = JSON.parse(String(keepJson)) as KeepFile;
    const beforeKeep = JSON.parse(String((await service.getDecryptData('pA', 'staging')).keep_file)) as KeepFile;
    expect(keep.variables[OTHER_NAME]).toEqual(beforeKeep.variables[OTHER_NAME]);
    expect(keep.variables[NAME].find((e) => e.branch === 'staging')?.value_hash).not.toBe(
      beforeKeep.variables[NAME].find((e) => e.branch === 'staging')?.value_hash,
    );
  });

  test('a location that already has the new value is `unchanged` and is not pushed', async () => {
    const locs: readonly Loc[] = LOCATIONS.map((l) => (l.project === 'pC' ? { ...l, value: SENTINEL } : l));
    const { service, env } = world({}, locs);
    const result = await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [] }, env);

    expect(result.unchanged).toEqual([{ project: PROJECT_NAMES.pC, branch: 'development', protected: false }]);
    expect(pushedBranches(service)).not.toContain('pC/development');
    expect(result.updated).toHaveLength(3);
  });

  test('one location failing does not block the others, and the failure is a code', async () => {
    const { service, env } = world({
      failPush: { 'pA/staging': ERROR_CODES.SERVICE_ERROR },
      failRead: { 'pB/production': ERROR_CODES.PERMISSION_DENIED },
    });
    const result = await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [] }, env);

    expect(result.failed).toEqual([
      { kind: 'location', project: PROJECT_NAMES.pA, branch: 'staging', protected: false, code: ERROR_CODES.SERVICE_ERROR },
      { kind: 'location', project: PROJECT_NAMES.pB, branch: 'production', protected: true, code: ERROR_CODES.PERMISSION_DENIED },
    ]);
    expect(result.updated.map((l) => `${l.project}/${l.branch}`)).toEqual([
      `${PROJECT_NAMES.pA}/production`,
      `${PROJECT_NAMES.pC}/development`,
    ]);
  });

  test('a branch with no line for NAME fails VARIABLE_NOT_FOUND and nothing is pushed there', async () => {
    const { service, env } = world();
    const noName = { ...service, getDecryptData: async () => ({ env_content: 'OTHER=capy:x:y', decrypt_key: '', expires_at: '', keep_file: JSON.stringify({ version: '3.0', org_id: 'o', project_id: 'pA', project_name: 'n', variables: {} }) }) };
    const result = await runSecretSet(
      { name: NAME, value: SENTINEL, locations: [loc('pA', 'staging')], repos: [] },
      { ...env, client: noName as never },
    );
    expect(result.failed).toEqual([
      { kind: 'location', project: PROJECT_NAMES.pA, branch: 'staging', protected: false, code: ERROR_CODES.VARIABLE_NOT_FOUND },
    ]);
    expect(service.pushSecrets.mock.calls).toHaveLength(0);
  });
});

describe('opening PRs', () => {
  test('a monorepo is ONE PR with several keep.lock paths in one tree, on the repo default branch', async () => {
    const { github, env } = world();
    const result = await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [MONO] }, env);

    expect(result.prs).toHaveLength(1);
    const pr = result.prs[0];
    expect(pr.repo).toBe('Acme/mono');
    expect(pr.base).toBe('main');
    expect([...pr.keep_lock_paths].sort()).toEqual(['backend/keep.lock', 'frontend/keep.lock']);
    expect(github.createCommit.mock.calls).toHaveLength(1);
    expect(github.createPull.mock.calls).toHaveLength(1);
    expect(github.createBlob.mock.calls).toHaveLength(2);
    const treeParams = github.createTree.mock.calls[0][1] as { entries: ReadonlyArray<{ path: string }> };
    expect(treeParams.entries.map((e) => e.path).sort()).toEqual(['backend/keep.lock', 'frontend/keep.lock']);
    expect(pr.locations).toEqual([
      { project: PROJECT_NAMES.pA, branch: 'production', protected: true },
      { project: PROJECT_NAMES.pA, branch: 'staging', protected: false },
      { project: PROJECT_NAMES.pB, branch: 'production', protected: true },
    ]);
  });

  test('several branch entries land in ONE keep.lock, and only this variable changed there', async () => {
    const { github, env } = world();
    await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [MONO] }, env);

    const blobs = github.createBlob.mock.calls.map((c) => JSON.parse(String(c[1])) as KeepFile);
    const backend = blobs.find((k) => k.project_id === 'pA') as KeepFile;
    const before = JSON.parse(githubKeep('pA')) as KeepFile;
    expect(backend.variables[NAME].map((e) => e.branch).sort()).toEqual(['production', 'staging']);
    expect(backend.variables[NAME].every((e) => e.changed_at === '2026-10-02T00:00:00.000Z')).toBe(true);
    expect(backend.variables[OTHER_NAME]).toEqual(before.variables[OTHER_NAME]);
  });

  test('a repo with its own default branch gets its own PR; both repos in one run', async () => {
    const { github, env } = world();
    const result = await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [MONO, SOLO] }, env);

    expect(result.prs.map((p) => [p.repo, p.base])).toEqual([
      ['Acme/mono', 'main'],
      ['Acme/solo', 'trunk'],
    ]);
    expect(github.createPull.mock.calls.map((c) => (c[1] as { base: string }).base)).toEqual(['main', 'trunk']);
  });

  test('a repo with no pushed location gets no PR', async () => {
    const { github, env } = world();
    const result = await runSecretSet({ name: NAME, value: SENTINEL, locations: [loc('pC', 'development')], repos: [MONO, SOLO] }, env);
    expect(result.prs.map((p) => p.repo)).toEqual(['Acme/solo']);
    // Only the repo with a pushed location is asked about, in ONE batched read.
    expect(github.getDefaultBranches.mock.calls).toHaveLength(1);
    expect((github.getDefaultBranches.mock.calls[0][0] as Array<{ name: string }>).map((r) => r.name)).toEqual(['solo']);
    expect(github.getRepo.mock.calls).toHaveLength(0);
  });

  test('one repo failing does not block the other, and its failure is a code', async () => {
    const service = fakeService();
    const github = fakeGithub(standardRepos().map((r) => (r.name === 'mono' ? { ...r, fail: ['createPull'] } : r)));
    const result = await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [MONO, SOLO] }, makeEnv(service, github));

    expect(result.prs.map((p) => p.repo)).toEqual(['Acme/solo']);
    expect(result.failed).toEqual([{ kind: 'repo', repo: 'Acme/mono', code: ERROR_CODES.KEEP_PR_CREATE_FAILED }]);
    expect(result.updated).toHaveLength(4); // the values were pushed regardless
  });

  test('without gh the repo fails KEEP_PR_GH_UNAVAILABLE and the values are still saved', async () => {
    const service = fakeService();
    const result = await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [SOLO] }, makeEnv(service, undefined));
    expect(result.failed).toEqual([{ kind: 'repo', repo: 'Acme/solo', code: ERROR_CODES.KEEP_PR_GH_UNAVAILABLE }]);
    expect(result.updated).toHaveLength(4);
  });

  test('GitHub already carrying the entries is reported as no_pr, not a failure', async () => {
    const service = fakeService();
    // Pre-fold GitHub's keep.lock with what the push will produce.
    const first = fakeGithub(standardRepos());
    const run1 = await runSecretSet({ name: NAME, value: SENTINEL, locations: [loc('pC', 'development')], repos: [SOLO] }, makeEnv(service, first));
    const folded = String(first.createBlob.mock.calls[0][1]);
    const second = fakeGithub([{ owner: 'Acme', name: 'solo', defaultBranch: 'trunk', files: { 'keep.lock': folded } }]);
    const run2 = await runSecretSet({ name: NAME, value: SENTINEL, locations: [loc('pC', 'development')], repos: [SOLO] }, makeEnv(fakeService(), second));
    // run2 pushes again (the fake server still has the old value) and finds GitHub already equal.
    expect(run1.prs).toHaveLength(1);
    expect(run2.prs).toEqual([]);
    expect(run2.no_pr).toEqual([{ repo: 'Acme/solo', reason: 'NO_DIFF_VS_BASE' }]);
    expect(run2.failed).toEqual([]);
  });

  test('PR title/commit/body are names only: no value, no hash of it', async () => {
    const { github, env } = world();
    await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [MONO] }, env);
    const pull = github.createPull.mock.calls[0][1] as { title: string; body: string };
    const commit = github.createCommit.mock.calls[0][1] as { message: string };
    expect(pull.body).toContain(`\`${NAME}\``);
    expect(pull.body).toContain('`backend/keep.lock`');
    expect(pull.title + pull.body + commit.message).not.toContain(SENTINEL);
    expect(buildPrBody('secrets', [{ branch: 'x', entries: [{ variable: NAME, entry: null }] }])).toContain('`capy secrets`');
  });
});

describe('keep_lock_diverged', () => {
  test('true when GitHub disagrees with the server about ANOTHER variable, and the PR still carries only this change', async () => {
    const diverged: readonly Loc[] = LOCATIONS.map((l) => (l.project === 'pC' ? { ...l, githubOtherHash: 'ffffffffffffffff' } : l));
    const service = fakeService();
    const github = fakeGithub(standardRepos(diverged));
    const result = await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [MONO, SOLO] }, makeEnv(service, github));

    expect(result.prs.find((p) => p.repo === 'Acme/solo')?.keep_lock_diverged).toBe(true);
    expect(result.prs.find((p) => p.repo === 'Acme/mono')?.keep_lock_diverged).toBe(false);
    // Only NAME moved: GitHub's own (different) OTHER_VAR pin is carried as it was.
    const solo = github.createBlob.mock.calls
      .map((c) => JSON.parse(String(c[1])) as KeepFile)
      .find((k) => k.project_id === 'pC') as KeepFile;
    expect(solo.variables[OTHER_NAME][0].value_hash).toBe('ffffffffffffffff');
  });

  test('keepDiverged: other variables only, the named branches only, one-sided entries count', () => {
    const entry = (branch: string, hash: string) => ({ resource_id: 'r', branch, value_hash: hash });
    const keep = (variables: KeepFile['variables']): KeepFile => ({ version: '3', org_id: 'o', project_id: 'p', project_name: 'n', variables });
    const base = keep({ [NAME]: [entry('b', '1')], X: [entry('b', 'a')] });
    expect(keepDiverged(base, keep({ [NAME]: [entry('b', '2')], X: [entry('b', 'a')] }), NAME, ['b'])).toBe(false);
    expect(keepDiverged(base, keep({ [NAME]: [entry('b', '1')], X: [entry('b', 'z')] }), NAME, ['b'])).toBe(true);
    expect(keepDiverged(base, keep({ [NAME]: [entry('b', '1')], X: [entry('b', 'a')], Y: [entry('b', 'q')] }), NAME, ['b'])).toBe(true);
    expect(keepDiverged(base, keep({ [NAME]: [entry('b', '1')], X: [entry('b', 'z')] }), NAME, ['other'])).toBe(false);
  });
});

describe('planRepos and previews', () => {
  test('groups projects by repo (case-insensitive), one file per project folder, and lists unlinked projects', () => {
    const planning = planRepos(
      [loc('pA', 'production'), loc('pA', 'staging'), loc('pB', 'production'), loc('pC', 'development'), loc('pD', 'development')],
      LINKS,
    );
    expect(planning.targets.map((t) => [t.owner + '/' + t.name, t.files.map((f) => f.path)])).toEqual([
      ['Acme/mono', ['backend', 'frontend']],
      ['Acme/solo', ['.']],
    ]);
    expect(planning.notLinked).toEqual([PROJECT_NAMES.pD]);
  });

  test('only GitHub repos can get a PR: another host counts as not linked', () => {
    const planning = planRepos([loc('pC', 'development')], [{ ...LINKS[2], host: 'gitlab.com' }]);
    expect(planning.targets).toEqual([]);
    expect(planning.notLinked).toEqual([PROJECT_NAMES.pC]);
  });

  test('keepLockPathOf: root and nested folders', () => {
    expect(keepLockPathOf('.')).toBe('keep.lock');
    expect(keepLockPathOf('services/api')).toBe('services/api/keep.lock');
  });

  test('previewLocation needs a value to know `unchanged`, and reads without writing', async () => {
    const { service, env } = world();
    expect((await previewLocation(env, loc('pC', 'development'), NAME, undefined)).action).toBe('update');
    expect((await previewLocation(env, loc('pC', 'development'), NAME, OLD_VALUE)).action).toBe('unchanged');
    expect((await previewLocation(env, loc('pC', 'development'), NAME, SENTINEL)).action).toBe('update');
    expect(service.pushSecrets.mock.calls).toHaveLength(0);
  });
});

describe('the value never leaks', () => {
  test('across success, a failed location and a failed repo: nothing sent to GitHub, nothing in the result, the service only saw ciphertext', async () => {
    const service = fakeService({ failPush: { 'pA/staging': ERROR_CODES.SERVICE_ERROR } });
    const github = fakeGithub(standardRepos().map((r) => (r.name === 'mono' ? { ...r, fail: ['createRef'] } : r)));
    const env = makeEnv(service, github);
    const result = await runSecretSet({ name: NAME, value: SENTINEL, locations: ALL, repos: [MONO, SOLO] }, env);

    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(everythingSentTo(github.getRepo, github.getFile, github.createBlob, github.createTree, github.createCommit, github.createRef, github.createPull)).not.toContain(SENTINEL);
    expect(everythingSentTo(service.pushSecrets)).not.toContain(SENTINEL);
    expect(everythingSentTo(env.writeCache)).not.toContain(SENTINEL);
    // …and it did arrive, encrypted: decrypting what was pushed gives it back.
    const line = String(service.pushSecrets.mock.calls[0][2]).split('\n').find((l) => l.startsWith(`${NAME}=`)) as string;
    expect(Encryptor.decrypt(line.split(':').slice(2).join(':'), KEYS.pA)).toBe(SENTINEL);
  });
});

/**
 * The small pure pieces under `capy deploy dokploy --discover` (CAP-703): repo-relative paths,
 * the deploy.json reader and the merge. No fakes needed.
 */
import { describe, test, expect } from 'bun:test';
import { deployJsonPathOf, parseDeployJson, relPathOf, servicePathOf, envVarNamesOf, isSameOrAncestorPath } from '../../src/commands/deployDiscover/facts';
import { mergeDeployJson } from '../../src/commands/deployDiscover/apply';
import { dokployTargetOf, targetBaseName } from '../../src/commands/deployDiscover/evaluate';
import { runDeployDokployDiscover } from '../../src/commands/deployDiscover/command';
import { BASE_URL, GITHUB_REPOS, ENTRY_SOLO, SENTINEL_DOKPLOY, makeWorld, planFile } from '../helpers/deployDiscoverWorld';

describe('repo-relative paths, never a local path', () => {
  test('the root is ".", slashes and "./" are normalized', () => {
    expect(relPathOf('')).toBe('.');
    expect(relPathOf('/')).toBe('.');
    expect(relPathOf('./api/')).toBe('api');
    expect(relPathOf(undefined)).toBe('.');
    expect(relPathOf('a\\b')).toBe('a/b');
  });

  test('a compose service lives in its compose file\'s folder; an Application in its build path', () => {
    expect(servicePathOf({ serviceKind: 'compose', composePath: 'docker-compose.yml' })).toBe('.');
    expect(servicePathOf({ serviceKind: 'compose', composePath: './backend/deployment/prod/docker-compose.yml' })).toBe('backend/deployment/prod');
    expect(servicePathOf({ serviceKind: 'compose' })).toBe('.');
    expect(servicePathOf({ serviceKind: 'application', buildPath: '/' })).toBe('.');
    expect(servicePathOf({ serviceKind: 'application', buildPath: '/api' })).toBe('api');
    expect(servicePathOf({ serviceKind: 'application' })).toBe('.');
  });

  test('deploy.json sits under the project path', () => {
    expect(deployJsonPathOf('.')).toBe('.capy/deploy.json');
    expect(deployJsonPathOf('backend/api')).toBe('backend/api/.capy/deploy.json');
  });

  test('a folder is above another only on a whole path segment', () => {
    expect(isSameOrAncestorPath('.', 'a/b')).toBe(true);
    expect(isSameOrAncestorPath('a', 'a/b')).toBe(true);
    expect(isSameOrAncestorPath('a', 'ab/c')).toBe(false);
    expect(isSameOrAncestorPath('a/b', 'a')).toBe(false);
  });
});

describe('env names', () => {
  test('only NAMES are taken from a Dokploy env: sorted, unique, the Capy block and runtime pair left out, the value dropped', () => {
    const env = [`B=${SENTINEL_DOKPLOY}`, `A=${SENTINEL_DOKPLOY}`, `A=again`, '_SECRETS_BLOB=x', 'PROJECT_KEY=y'].join('\n');
    const names = envVarNamesOf(env);
    expect(names).toEqual(['A', 'B']);
    expect(JSON.stringify(names)).not.toContain(SENTINEL_DOKPLOY);
    expect(envVarNamesOf(null)).toEqual([]);
  });
});

describe('deploy.json reading and merging', () => {
  test('no file is an empty, valid answer; a non-version-1 or non-JSON file is not', () => {
    expect(parseDeployJson(null)).toEqual({ ok: true, targets: [], raw: null });
    expect(parseDeployJson('{nope')).toEqual({ ok: false });
    expect(parseDeployJson(JSON.stringify({ version: '2', targets: {} }))).toEqual({ ok: false });
    expect(parseDeployJson('[]')).toEqual({ ok: false });
  });

  test('targets are read with their kind, branch and Dokploy service id', () => {
    const parsed = parseDeployJson(
      JSON.stringify({
        version: '1',
        targets: {
          a: { kind: 'dokploy', branch: 'production', options: { composeId: 'c1' } },
          b: { kind: 'dokploy', branch: 'staging', options: { applicationId: 'a1' } },
          c: { kind: 'aws-ssm', branch: 'production', options: {} },
        },
      }),
    );
    expect(parsed.ok && parsed.targets).toEqual([
      { name: 'a', kind: 'dokploy', branch: 'production', service_id: 'c1' },
      { name: 'b', kind: 'dokploy', branch: 'staging', service_id: 'a1' },
      { name: 'c', kind: 'aws-ssm', branch: 'production', service_id: null },
    ]);
  });

  test('a new file gets version 1 and the targets; an existing one keeps every other field, target and its order', () => {
    const target = dokployTargetOf({
      name: 'dokploy-production',
      entry: { project_id: 'p', branch: 'production', service_id: 'c9', git_branch: 'main', vars: ['B', 'A'] },
      service: { service_id: 'c9', kind: 'compose', name: 'x', dokploy_project: 'd', environment: 'production', repo: null, branch: null, path: null, env_var_names: [] },
      baseUrl: BASE_URL,
      knownVars: ['A', 'B', 'C'],
    });
    const fresh = parseDeployJson(null);
    if (!fresh.ok) throw new Error('unreachable');
    expect(JSON.parse(mergeDeployJson(fresh, [target]))).toEqual({ version: '1', targets: { 'dokploy-production': target } });
    expect(mergeDeployJson(fresh, [target]).endsWith('\n')).toBe(true);

    const existing = parseDeployJson(JSON.stringify({ version: '1', note: 'keep me', targets: { zeta: { kind: 'x' }, alpha: { kind: 'y' } } }));
    if (!existing.ok) throw new Error('unreachable');
    const merged = JSON.parse(mergeDeployJson(existing, [target]));
    expect(merged.note).toBe('keep me');
    expect(Object.keys(merged.targets)).toEqual(['zeta', 'alpha', 'dokploy-production']);
    expect(target.vars).toEqual(['A', 'B']);
  });

  test('a target name restricted to what deploy allows (lowercase alphanumerics and dashes)', () => {
    expect(targetBaseName('production')).toBe('dokploy-production');
    expect(targetBaseName('Feature/X_1')).toBe('dokploy-feature-x-1');
    expect(targetBaseName('///')).toBe('dokploy');
  });
});

describe('an unreadable deploy.json is a coded error, never a silent overwrite', () => {
  test('a malformed file on the default branch: the plan is invalid with KEEP_PR_READ_FAILED, and nothing is written', async () => {
    const repos = { ...GITHUB_REPOS, 'acme/solo': { ...GITHUB_REPOS['acme/solo'], files: { '.capy/deploy.json': '{not json' } } };
    const text = planFile([ENTRY_SOLO]);
    const world = makeWorld({ files: { 'p.json': text }, repos });
    const result = await runDeployDokployDiscover({ baseUrl: BASE_URL, plan: 'p.json', dryRun: true }, world.io);
    expect((result.body as any).errors).toEqual([{ path: 'entries[0].project_id', code: 'KEEP_PR_READ_FAILED' }]);
    expect(world.github.createPull).not.toHaveBeenCalled();
  });
});

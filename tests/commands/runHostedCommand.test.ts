import { expect, test } from 'bun:test';
import { executeHostedRun, requireHostedRunArguments, type HostedRunDependencies } from '../../src/commands/runHostedCommand';
import { CURRENT_DEPLOY_KEY_VAR } from '../../src/core/reservedVars';

const keep = { version: '3.0', org_id: 'org_one', project_id: 'project_one', project_name: 'default', variables: {} };
function dependencies(overrides: Partial<HostedRunDependencies> = {}): HostedRunDependencies {
  return {
    authenticate: async () => ({ success: true, user_id: 'user_one', organization_id: 'org_one' }),
    billing: async () => ({ tier: 'free' }), projects: async () => [{ id: 'project_one', name: 'default', organization_id: 'org_one' }],
    snapshot: async () => ({ keep_file: JSON.stringify(keep) }), keep: () => keep, branch: () => 'development',
    env: () => ({ SECRET: 'capy:encrypted', PLAIN: 'file' }), envIdentity: () => ({ org_id: 'org_one', project_id: 'project_one', branch: 'development' }),
    encrypted: (value) => value.startsWith('capy:'), key: async () => 'key', decrypt: () => 'decrypted',
    spawn: async () => { throw new Error('UNEXPECTED_CHILD'); }, ...overrides,
  };
}

test('hosted run blocks common dumpers, shells and inline evaluators before identity or file access', async () => {
  for (const args of [[], ['env'], ['/usr/bin/printenv'], ['bash', '-c', 'echo'], ['node', '-e', 'process.env'], ['python3', '-c', 'code'], ['pwsh.exe'], ['node', '--eval=code'], ['bun', 'eval', 'code'], ['node', 'bad\0path']]) {
    expect(() => requireHostedRunArguments(args)).toThrow();
    await expect(executeHostedRun(args, 'user_one', dependencies({ keep: () => { throw new Error('SHOULD_NOT_READ'); } }), {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  }
  for (const args of [['npm', 'run', 'dev'], ['node', 'server.js'], ['python3', 'app.py']]) expect(() => requireHostedRunArguments(args)).not.toThrow();
});

test('hosted run pins the caller before local env or key access', async () => {
  await expect(executeHostedRun(['node', 'server.js'], 'wrong_user', dependencies({
    env: () => { throw new Error('SHOULD_NOT_READ'); }, key: async () => { throw new Error('SHOULD_NOT_UNLOCK'); },
  }), {})).rejects.toMatchObject({ code: 'AUTH_FAILED' });
});

test('invalid identity, attached evaluation flags, malformed ciphertext, stale branch or unavailable project never spawn', async () => {
  for (const identity of ['', 'not-a-user', 'user_']) await expect(executeHostedRun(['node', 'server.js'], identity, dependencies(), {})).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  for (const args of [['node', '-pJSON.stringify(process.env)'], ['python3', '-cCODE']]) expect(() => requireHostedRunArguments(args)).toThrow();
  await expect(executeHostedRun(['node', 'server.js'], 'user_one', dependencies({ env: () => ({ SECRET: 'capy:broken' }), encrypted: () => false }), {})).rejects.toMatchObject({ code: 'DECRYPT_KEY_MISMATCH' });
  await expect(executeHostedRun(['node', 'server.js'], 'user_one', dependencies({ envIdentity: () => ({ org_id: 'org_one', project_id: 'project_one', branch: 'other' }) }), {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await expect(executeHostedRun(['node', 'server.js'], 'user_one', dependencies({ projects: async () => [] }), {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
});

test('reserved-only configuration does not trigger a project-key requirement', async () => {
  expect(await executeHostedRun(['node', 'server.js'], 'user_one', dependencies({
    keep: () => null, env: () => ({ [CURRENT_DEPLOY_KEY_VAR]: 'capy:malformed' }),
    key: async () => { throw new Error('SHOULD_NOT_UNLOCK'); }, spawn: async (_args, env) => { expect(env).toEqual({}); return 0; },
  }), {})).toBe(0);
});

test('hosted run fails mismatched file identity and partial decryption without spawning', async () => {
  await expect(executeHostedRun(['node', 'server.js'], 'user_one', dependencies({
    envIdentity: () => ({ org_id: 'other', project_id: 'other' }),
  }), {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await expect(executeHostedRun(['node', 'server.js'], 'user_one', dependencies({
    decrypt: () => { throw new Error('DECRYPT_FAILED'); },
  }), {})).rejects.toThrow('DECRYPT_FAILED');
});

test('hosted run preserves encrypted precedence, shell plaintext precedence, strips reserved vars, and forwards child exit', async () => {
  const exit = await executeHostedRun(['node', 'server.js'], 'user_one', dependencies({
    spawn: async (args, env) => {
      expect(args).toEqual(['node', 'server.js']);
      expect(env).toEqual({ SECRET: 'decrypted', PLAIN: 'shell' });
      return 7;
    },
  }), { SECRET: 'stale', PLAIN: 'shell', [CURRENT_DEPLOY_KEY_VAR]: 'must-not-reach-child' });
  expect(exit).toBe(7);
});

test('free mode resolves default authoritatively; paid missing-lock mode stops before reading env', async () => {
  expect(await executeHostedRun(['node', 'server.js'], 'user_one', dependencies({ keep: () => null, spawn: async () => 0 }), {})).toBe(0);
  await expect(executeHostedRun(['node', 'server.js'], 'user_one', dependencies({
    keep: () => null, billing: async () => ({ tier: 'business' }), env: () => { throw new Error('SHOULD_NOT_READ'); },
  }), {})).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
});

test('free plaintext-only state is not reported as onboarded; unavailable grant never spawns', async () => {
  await expect(executeHostedRun(['node', 'server.js'], 'user_one', dependencies({ keep: () => null, env: () => ({ PLAIN: 'value' }) }), {})).rejects.toMatchObject({ code: 'SYNC_NOT_INITIALIZED' });
  await expect(executeHostedRun(['node', 'server.js'], 'user_one', dependencies({ key: async () => { throw new Error('GRANT_UNAVAILABLE'); } }), {})).rejects.toThrow('GRANT_UNAVAILABLE');
});

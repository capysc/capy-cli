import { describe, it, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installSyncHooks, nextHookContent, syncHookBlocks, SYNC_HOOK_MARKER } from '../../src/git/syncHooks';

// Hooks are shell run by real git, so the property is asserted by running git:
// a branch checkout / merge in a Capy-managed repo must succeed whatever
// `capy status` does, and whether or not capy is installed.

const ROOT = mkdtempSync(join(tmpdir(), 'capy-hooks-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function tempDir(prefix: string): string {
  return mkdtempSync(join(ROOT, prefix));
}

/** PATH with only the system dirs (git, sh) plus `extra`. No real capy. */
function isolatedEnv(home: string, extra: string | null): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: [extra, '/usr/bin', '/bin'].filter(Boolean).join(':'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function git(repo: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync('git', args, { cwd: repo, env, encoding: 'utf-8' });
}

function makeRepo(env: NodeJS.ProcessEnv): string {
  const repo = tempDir('capy-hooks-repo-');
  expect(git(repo, env, 'init', '-q', '-b', 'main').status).toBe(0);
  expect(git(repo, env, 'commit', '-q', '--allow-empty', '-m', 'init').status).toBe(0);
  return repo;
}

/** A fake `capy` that records it ran, then exits with `code`. */
function fakeCapyBin(code: number): { bin: string; ranMarker: string } {
  const bin = tempDir('capy-hooks-bin-');
  const ranMarker = join(bin, 'ran');
  writeFileSync(join(bin, 'capy'), `#!/bin/sh\necho "$@" >> "${ranMarker}"\nexit ${code}\n`);
  chmodSync(join(bin, 'capy'), 0o755);
  return { bin, ranMarker };
}

describe('capy sync hooks never fail the git command', () => {
  it('branch checkout succeeds when capy status fails, and status did run', () => {
    const { bin, ranMarker } = fakeCapyBin(1);
    const env = isolatedEnv(tempDir('capy-hooks-home-'), bin);
    const repo = makeRepo(env);
    installSyncHooks(join(repo, '.git'), 'capy');

    const res = git(repo, env, 'checkout', '-q', '-b', 'feature');
    expect(res.status).toBe(0);
    expect(readFileSync(ranMarker, 'utf-8').trim()).toBe('status');
  });

  it('branch checkout succeeds when capy is not installed', () => {
    const env = isolatedEnv(tempDir('capy-hooks-home-'), null);
    const repo = makeRepo(env);
    installSyncHooks(join(repo, '.git'), 'capy');
    expect(spawnSync('sh', ['-c', 'command -v capy'], { env }).status).not.toBe(0);

    expect(git(repo, env, 'checkout', '-q', '-b', 'feature').status).toBe(0);
  });

  it('merge succeeds when capy status fails', () => {
    const { bin, ranMarker } = fakeCapyBin(2);
    const env = isolatedEnv(tempDir('capy-hooks-home-'), bin);
    const repo = makeRepo(env);
    installSyncHooks(join(repo, '.git'), 'capy');
    expect(git(repo, env, 'checkout', '-q', '-b', 'side').status).toBe(0);
    expect(git(repo, env, 'commit', '-q', '--allow-empty', '-m', 'side').status).toBe(0);
    expect(git(repo, env, 'checkout', '-q', 'main').status).toBe(0);

    expect(git(repo, env, 'merge', '-q', '--no-edit', 'side').status).toBe(0);
    expect(existsSync(ranMarker)).toBe(true);
  });

  it('upgrades a pre-existing failing block in place and keeps user hook lines', () => {
    const env = isolatedEnv(tempDir('capy-hooks-home-'), null);
    const repo = makeRepo(env);
    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const oldBlock = [
      SYNC_HOOK_MARKER,
      'if [ "$3" = "1" ]; then',
      '  command -v capy >/dev/null 2>&1 && capy status',
      'fi',
      '# --- end capy ---',
    ].join('\n');
    writeFileSync(join(hooksDir, 'post-checkout'), `#!/bin/sh\necho user-hook\n${oldBlock}\n`);
    chmodSync(join(hooksDir, 'post-checkout'), 0o755);
    // The old block really did fail the checkout without capy installed.
    expect(git(repo, env, 'checkout', '-q', '-b', 'before').status).not.toBe(0);

    installSyncHooks(join(repo, '.git'), 'capy');
    const content = readFileSync(join(hooksDir, 'post-checkout'), 'utf-8');
    expect(content).toContain('echo user-hook');
    expect(content.split(SYNC_HOOK_MARKER).length).toBe(2);
    expect(git(repo, env, 'checkout', '-q', '-b', 'after').status).toBe(0);
  });

  it('is idempotent', () => {
    const block = syncHookBlocks('capy')['post-merge'];
    const once = nextHookContent(null, block);
    expect(once).not.toBeNull();
    expect(nextHookContent(once, block)).toBeNull();
  });
});

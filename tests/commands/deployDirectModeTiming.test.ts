/**
 * Direct-mode deploy's tracked-keep sync must run immediately before the
 * commit, not earlier in the run — otherwise every exit between an early
 * sync and the commit (confirm cancel/delete/edit-cancel, a failed
 * preflight recheck, a failed mint/decrypt) leaves the tracked keep.lock
 * modified and uncommitted: a teammate's next `git pull` then refuses with
 * "local changes would be overwritten".
 *
 * These drive the real, exported `deployCommand()` end to end against a
 * real git repo (no mocks) — the cf-worker adapter needs a real `wrangler`
 * binary on PATH for preflight (gated below, same as
 * tests/commands/deployCommand.test.ts), but never needs real Cloudflare
 * credentials: preflight only checks the binary exists, and the vendor push
 * itself (which fails without real auth) runs AFTER the keep.lock commit —
 * exactly the part these tests aren't checking.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { deployCommand } from '../../src/commands/deployCommand';

const HAS_WRANGLER = spawnSync('which', ['wrangler']).status === 0;

function git(args: string[], cwd: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const TMP = join(tmpdir(), `capy-deploy-timing-${process.pid}`);
const REPO = join(TMP, 'repo');

function frozenTrackedKeep(): string {
  return JSON.stringify({
    version: '3.0',
    org_id: 'org-1',
    project_id: 'proj-1',
    project_name: 'test-project',
    variables: {}, // frozen at init — no variables, exactly what capy leaves behind
  });
}

function workingKeepWithPins(): string {
  return JSON.stringify({
    version: '3.0',
    org_id: 'org-1',
    project_id: 'proj-1',
    project_name: 'test-project',
    variables: {
      SUPABASE_URL: [{ resource_id: 'r1', branch: 'production', value_hash: 'h1' }],
    },
  });
}

// The exact set ensureCapyGitignore() (fileManager.ts) requires — deploy.json
// reads call it on every run, and a fixture missing any of these would get it
// silently appended, showing up as an incidental ".gitignore modified" that
// has nothing to do with what these tests are checking.
const GITIGNORE = ['.env', '!/.capy/', '/.capy/*', '!/.capy/deploy.json', '.env.pre-capy.old', '.env.*.decrypted'].join('\n') + '\n';

function setUpRepo(): void {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  git(['init', '-q', '-b', 'main', REPO], TMP);
  git(['config', 'user.email', 't@e.com'], REPO);
  git(['config', 'user.name', 'T'], REPO);
  git(['config', 'commit.gpgsign', 'false'], REPO);

  // Everything except keep.lock's two copies is tracked and committed up
  // front, so the only thing any of these tests can see change in git status
  // is keep.lock itself.
  writeFileSync(join(REPO, '.gitignore'), GITIGNORE);
  writeFileSync(join(REPO, 'keep.lock'), frozenTrackedKeep());

  const workerDir = join(REPO, 'worker');
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, 'wrangler.toml'), 'name = "api"\nmain = "src/index.ts"\ncompatibility_date = "2026-01-01"\n');

  mkdirSync(join(REPO, '.capy'), { recursive: true });
  writeFileSync(
    join(REPO, '.capy', 'deploy.json'),
    JSON.stringify({
      version: '1',
      targets: {
        'worker-prod': {
          name: 'worker-prod',
          kind: 'cf-worker',
          branch: 'production',
          vars: ['SUPABASE_URL'],
          mode: 'direct',
          options: { workerName: 'api', workerDir: 'worker' },
        },
      },
    }),
  );

  git(['add', '-A'], REPO);
  git(['commit', '-q', '-m', 'init'], REPO);

  // capy's regular flows since then only wrote the untracked working copy.
  writeFileSync(join(REPO, '.capy', 'keep.lock'), workingKeepWithPins());

  // Plaintext .env (gitignored) so decryptCurrentBranch never needs a real
  // project key — it only decrypts values that start with `capy:`.
  writeFileSync(join(REPO, '.env'), 'SUPABASE_URL=https://x.supabase.co\n');
}

describe.if(HAS_WRANGLER)('deploy direct mode: keep.lock timing (real git, no mocks)', () => {
  beforeEach(setUpRepo);
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  test('cancelled confirm (non-TTY default) leaves the tracked keep.lock untouched', async () => {
    const headBefore = git(['rev-parse', 'HEAD'], REPO).stdout.trim();
    const trackedBefore = readFileSync(join(REPO, 'keep.lock'), 'utf-8');

    // No --yes: the confirm loop runs. bun test's stdin isn't a TTY, so
    // keypressConfirm resolves to its non-interactive default, 'cancel'.
    const code = await deployCommand('worker-prod', {}, REPO);

    expect(code).toBe(0);
    expect(git(['rev-parse', 'HEAD'], REPO).stdout.trim()).toBe(headBefore);
    expect(readFileSync(join(REPO, 'keep.lock'), 'utf-8')).toBe(trackedBefore);
    expect(git(['status', '--porcelain'], REPO).stdout.trim()).toBe('');
  });

  test('a failed commit (pre-commit hook rejects it) restores the tracked keep.lock to HEAD', async () => {
    const headBefore = git(['rev-parse', 'HEAD'], REPO).stdout.trim();
    const trackedBefore = readFileSync(join(REPO, 'keep.lock'), 'utf-8');

    const hooksDir = join(REPO, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
    chmodSync(hookPath, 0o755);

    const code = await deployCommand('worker-prod', { yes: true }, REPO);

    expect(code).toBe(1);
    // HEAD never moved (the commit was rejected)...
    expect(git(['rev-parse', 'HEAD'], REPO).stdout.trim()).toBe(headBefore);
    // ...and the tracked file — which the sync modified before the failed
    // commit attempt, and `git add` may have staged — is back to exactly
    // what HEAD has, not left dirty.
    expect(readFileSync(join(REPO, 'keep.lock'), 'utf-8')).toBe(trackedBefore);
    expect(git(['status', '--porcelain'], REPO).stdout.trim()).toBe('');
  });

  test('success: the commit carries the up-to-date pins from .capy/keep.lock', async () => {
    const headBefore = git(['rev-parse', 'HEAD'], REPO).stdout.trim();

    await deployCommand('worker-prod', { yes: true }, REPO);
    // (exit code is not asserted here — the actual `wrangler secret bulk` /
    // `wrangler deploy` push after the commit has no real Cloudflare
    // credentials and is expected to fail; that failure is irrelevant to
    // whether the keep.lock commit itself — made before the push — is correct.)

    expect(git(['rev-parse', 'HEAD'], REPO).stdout.trim()).not.toBe(headBefore);
    const committed = JSON.parse(git(['show', 'HEAD:keep.lock'], REPO).stdout);
    expect(Object.keys(committed.variables)).toEqual(['SUPABASE_URL']);
    expect(committed.variables.SUPABASE_URL[0].value_hash).toBe('h1');

    // The working copy itself was never written to by any of this.
    expect(readFileSync(join(REPO, '.capy', 'keep.lock'), 'utf-8')).toBe(workingKeepWithPins());
  });
});

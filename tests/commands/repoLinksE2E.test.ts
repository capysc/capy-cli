/**
 * Project -> repo links (CAP-697), end to end through the BUILT cli
 * (`dist/index.js`) against an isolated HOME, a mock service and a fake `gh`
 * (tests/helpers). Needs `bun run build` first.
 *
 * The property under test: reporting the repo link NEVER changes a command's
 * exit code or output, whether the service answers, answers 500, or never
 * answers; and it reports exactly the origin's host/owner/name and the folder.
 */
import { describe, test, expect } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHarness, type CliResult, type Harness } from '../helpers/pipedHarness';

const FAKE_GH_SCRIPT = join(__dirname, '../helpers/fake-gh.cjs');
const NAME = 'LINK_TEST_TOKEN';

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf-8' });

/** A fake `gh` first on PATH, answering from fixtures and logging every call. */
function installFakeGh(h: Harness): Record<string, string> {
  const bin = join(h.root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(FAKE_GH_SCRIPT)});\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(h.root, 'gh-config.json'), JSON.stringify({ repos: { 'acme/solo': { id: 42, default_branch: 'main', files: {} } } }));
  return { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_GH_DIR: h.root, CAPY_NO_REPO_LINK: '' };
}

/** `git init` at `at` (the project folder itself, or a parent of it) with an `origin`. */
function makeRepo(at: string, origin: string | null): void {
  git(at, 'init', '-q');
  if (origin !== null) git(at, 'remote', 'add', 'origin', origin);
}

const putsOf = (h: Harness) => h.repoPuts() as Array<Record<string, unknown>>;

async function runEdit(h: Harness, env: Record<string, string>, ...extra: string[]): Promise<CliResult> {
  return h.run(['edit', NAME, ...extra], 'v\n', undefined, env);
}

/** What the command prints and exits with, with no repo reporting at all. */
async function baseline(...extra: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const h = await createHarness();
  try {
    const out = await h.run(['edit', NAME, ...extra], 'v\n', undefined, { CAPY_NO_REPO_LINK: '1' });
    return { stdout: out.stdout, stderr: out.stderr, code: out.code };
  } finally {
    await h.dispose();
  }
}

async function withRepo<T>(origin: string | null, at: 'project' | 'parent', fn: (h: Harness, env: Record<string, string>) => Promise<T>): Promise<T> {
  const h = await createHarness();
  try {
    makeRepo(at === 'project' ? h.project : join(h.project, '..'), origin);
    return await fn(h, installFakeGh(h));
  } finally {
    await h.dispose();
  }
}

describe('reporting the link', () => {
  test('a repo at the project folder reports origin host/owner/name, path ".", and the gh repo id', async () => {
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h, env) => {
      const out = await runEdit(h, env, '--json');
      expect(out.code).toBe(0);
      expect(putsOf(h)).toEqual([{ host: 'github.com', owner: 'Acme', name: 'solo', path: '.', github_repo_id: 42 }]);
    });
  });

  test('a keep.lock folder inside the repo reports its folder; userinfo in the remote never leaves the machine', async () => {
    await withRepo('https://x-access-token:ghp_SECRETTOKEN@github.com/Acme/solo.git', 'parent', async (h, env) => {
      const out = await runEdit(h, env, '--json');
      expect(out.code).toBe(0);
      expect(putsOf(h)).toEqual([{ host: 'github.com', owner: 'Acme', name: 'solo', path: 'project', github_repo_id: 42 }]);
      expect(JSON.stringify(h.requests())).not.toContain('SECRETTOKEN');
      expect(out.stdout + out.stderr).not.toContain('SECRETTOKEN');
    });
  });

  test('throttled: a second run the same day does not report again', async () => {
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h, env) => {
      await runEdit(h, env, '--json');
      await h.run(['edit', 'OTHER_TOKEN', '--json'], 'v\n', undefined, env);
      expect(putsOf(h)).toHaveLength(1);
    });
  });

  test('nothing is reported outside git, with no origin, or when reporting is switched off', async () => {
    const h = await createHarness();
    try {
      await runEdit(h, installFakeGh(h), '--json'); // not a git repo
      expect(putsOf(h)).toHaveLength(0);
    } finally {
      await h.dispose();
    }
    await withRepo(null, 'project', async (h2, env) => {
      await runEdit(h2, env, '--json');
      expect(putsOf(h2)).toHaveLength(0);
    });
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h3, env) => {
      await runEdit(h3, { ...env, CAPY_NO_REPO_LINK: '1' }, '--json');
      expect(putsOf(h3)).toHaveLength(0);
    });
  });
});

describe('never blocks, never changes the command', () => {
  test('a service that answers 500 leaves exit code and output exactly as without reporting', async () => {
    const expected = await baseline('--json');
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h, env) => {
      h.setRepoPutMode('500');
      const out = await runEdit(h, env, '--json');
      expect({ stdout: out.stdout, stderr: out.stderr, code: out.code }).toEqual(expected);
      expect(putsOf(h)).toHaveLength(1);
    });
  });

  test('a service that never answers is dropped after the budget: same output, same exit code', async () => {
    const expected = await baseline('--json');
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h, env) => {
      h.setRepoPutMode('hang');
      const out = await runEdit(h, env, '--json');
      expect({ stdout: out.stdout, stderr: out.stderr, code: out.code }).toEqual(expected);
      expect(putsOf(h)).toHaveLength(1); // it WAS sent, and given up on
      expect(out.elapsedMs).toBeLessThan(8000);
    });
  }, 20000);

  test('a successful report with nothing to warn about changes nothing either (human mode too)', async () => {
    const expectedJson = await baseline('--json');
    const expectedHuman = await baseline();
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h, env) => {
      const json = await runEdit(h, env, '--json');
      expect({ stdout: json.stdout, stderr: json.stderr, code: json.code }).toEqual(expectedJson);
    });
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h, env) => {
      const human = await runEdit(h, env);
      expect({ stdout: human.stdout, stderr: human.stderr, code: human.code }).toEqual(expectedHuman);
    });
  });
});

describe('the mismatch warning', () => {
  test('human mode: one stderr line, nothing else changes', async () => {
    const expected = await baseline();
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h, env) => {
      h.setRepoPutMode('mismatch');
      const out = await runEdit(h, env);
      expect(out.code).toBe(0);
      expect(out.stdout).toBe(expected.stdout);
      const extra = out.stderr.replace(expected.stderr, '');
      expect(extra.trim().split('\n')).toHaveLength(1);
      expect(extra).toContain('keep.lock project is also linked to other repos: someone-else/copied-from');
    });
  });

  test('--json: the envelope gains `warnings` with the code, and stdout stays pure JSON', async () => {
    const expected = JSON.parse((await baseline('--json')).stdout) as Record<string, unknown>;
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h, env) => {
      h.setRepoPutMode('mismatch');
      const out = await runEdit(h, env, '--json');
      expect(out.code).toBe(0);
      expect(out.stderr).toBe('');
      const body = JSON.parse(out.stdout) as Record<string, unknown>;
      expect(body.warnings).toEqual([
        { code: 'KEEP_LOCK_REPO_MISMATCH', message: expect.any(String), repos: ['someone-else/copied-from'] },
      ]);
      expect({ ...body, warnings: undefined }).toEqual({ ...expected, warnings: undefined });
    });
  });

  test('no warning when the report is the repo the project is already linked to', async () => {
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h, env) => {
      h.setRepoPutMode('ok');
      const out = await runEdit(h, env, '--json');
      expect(JSON.parse(out.stdout).warnings).toBeUndefined();
      expect(readFileSync(join(h.root, 'repo-put-mode'), 'utf8')).toBe('ok');
    });
  });
});

describe('capy run records the link even when the child exits at once', () => {
  test('`capy run -- true` with a slow-ish service: the PUT is made, finished and the stamp written before capy exits; exit code and output are the child\'s', async () => {
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h, env) => {
      // An encrypted variable in .env, written with reporting off, so `run` has something to decrypt (and so reaches the key step).
      await h.run(['edit', NAME, '--json'], 'v\n', undefined, { ...env, CAPY_NO_REPO_LINK: '1' });
      expect(putsOf(h)).toHaveLength(0);

      const out = await h.run(['run', '--', 'node', '-e', 'process.stdout.write("hi"); process.exit(4)'], undefined, undefined, env);
      expect(out.code).toBe(4);
      expect(out.stdout).toBe('hi');
      expect(out.stderr).toBe('');
      expect(putsOf(h)).toEqual([{ host: 'github.com', owner: 'Acme', name: 'solo', path: '.', github_repo_id: 42 }]);

      // Stamped: a second run the same day does not report again.
      await h.run(['run', '--', 'true'], undefined, undefined, env);
      expect(putsOf(h)).toHaveLength(1);
    });
  }, 30000);

  test('a service that never answers adds at most the budget to an instant child, and changes nothing else', async () => {
    await withRepo('git@github.com:Acme/solo.git', 'project', async (h, env) => {
      await h.run(['edit', NAME, '--json'], 'v\n', undefined, { ...env, CAPY_NO_REPO_LINK: '1' });
      h.setRepoPutMode('hang');
      const out = await h.run(['run', '--', 'node', '-e', 'process.exit(6)'], undefined, undefined, env);
      expect(out.code).toBe(6);
      expect(out.stderr).toBe('');
      expect(putsOf(h)).toHaveLength(1);
      expect(out.elapsedMs).toBeLessThan(6000);
    });
  }, 30000);
});

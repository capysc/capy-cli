/**
 * `capy deploy`'s target picker for Vercel (the wiring around
 * `deploy/vercelSetup.ts`, which `tests/deploy/vercelSetup.test.ts` covers on
 * its own): the target that gets saved, the PR base branch defaulting to the
 * project's production branch, a legacy target coming out in API mode when
 * re-edited, the setup staying in the terminal, and no `.vercel/project.json`
 * or `vercel` anywhere.
 *
 * `mock.module('inquirer')` and `mock.module('…/systemStore')` are
 * process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, mock, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

const promptMock = mock(async (_questions: unknown) => ({}));
mock.module('inquirer', () => ({
  default: { prompt: promptMock, Separator: class {} },
}));

const getSecret = mock(async (..._args: unknown[]) => 'vcp_FAKE_PICKER_TOKEN' as string | null);
mock.module('../../src/system/systemStore', () => ({ getDirectionalConnectorSecret: getSecret }));

import { runPicker, resolveAdapterOptions } from '../../src/commands/deployCommand';
import { getAdapter } from '../../src/deploy/registry';
import type { TargetConfig } from '../../src/deploy/adapter';
import { fakeVercelFetch, project } from '../helpers/fakeVercel';
import { captureConsole } from '../helpers/testSandbox';

afterEach(() => {
  promptMock.mockReset();
  getSecret.mockClear();
});

const DATA = {
  teams: [{ id: 'team_acme', slug: 'acme' }],
  projects: { team_acme: [project('prj_web', 'web', { link: { type: 'github', org: 'acme', repo: 'widgets', productionBranch: 'trunk' } })] },
  envs: {},
  custom: {},
};

/** A throwaway git repo on branch `feature-x` with a `.env` holding two variables. */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'capy-vercel-picker-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'feature-x');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, '.env'), 'API_KEY=v1\nDB_URL=v2\n');
  writeFileSync(join(dir, 'README.md'), 'x');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  return dir;
}

const KEEP = { orgId: 'org_1', projectId: 'proj_1', variables: ['API_KEY', 'DB_URL'], branches: ['production', 'development'] };

/** Answers each question by its name: `script[name]` (or its default when the script has none). */
function answerBy(script: Record<string, unknown>) {
  promptMock.mockImplementation(async (questions: unknown) => {
    const q = (questions as ReadonlyArray<{ name: string; default?: unknown }>)[0];
    return { [q.name]: q.name in script ? script[q.name] : q.default };
  });
}

const questionsAsked = () => promptMock.mock.calls.map(([qs]) => (qs as ReadonlyArray<{ name: string; default?: unknown; message?: string }>)[0]);

const withFakeVercel = async <T>(fn: () => Promise<T>): Promise<T> => {
  const fake = fakeVercelFetch(DATA);
  const spy = spyOn(globalThis, 'fetch').mockImplementation(((url: string, init: never) => fake(url, init)) as never);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
};

describe('capy deploy picker — Vercel (API mode)', () => {
  test('a NEW Vercel target: one link question, checked live, saved in API mode; the PR base defaults to the project\'s production branch; no .vercel/project.json', async () => {
    const cwd = repo();
    try {
      answerBy({ branch: 'production', projectUrl: 'https://vercel.com/acme/web', confirmed: true, vercelEnv: 'production', vars: ['API_KEY'], name: 'vercel-production' });
      const saved = await withFakeVercel(() => captureConsole(() => runPicker(cwd, KEEP, undefined, 'vercel')));
      const target = saved.result as TargetConfig;
      expect(target).toMatchObject({
        name: 'vercel-production',
        kind: 'vercel',
        branch: 'production',
        vars: ['API_KEY'],
        mode: 'ci',
        options: { projectDir: '.', vercelEnv: 'production', projectId: 'prj_web', teamId: 'team_acme' },
      });
      // The question asked about the base branch defaults to Vercel's production branch, not the checked-out branch (feature-x).
      const baseQuestion = questionsAsked().find((q) => q.name === 'gitBaseBranch');
      expect(baseQuestion?.default).toBe('trunk');
      expect(target.gitBaseBranch).toBe('trunk');
      // None of the old CLI-path questions exist.
      expect(questionsAsked().map((q) => q.name)).not.toContain('projectDir');
      expect(questionsAsked().map((q) => q.message).join('\n')).not.toContain('.vercel/project.json');
      expect(existsSync(join(cwd, '.vercel'))).toBe(false);
      expect(saved.stdout.join('\n') + saved.stderr.join('\n')).not.toContain('vcp_FAKE_PICKER_TOKEN');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('re-editing a LEGACY target (no projectId) goes through the new setup and is saved in API mode', async () => {
    const cwd = repo();
    try {
      const legacy: TargetConfig = {
        name: 'old-vercel',
        kind: 'vercel',
        branch: 'production',
        vars: ['API_KEY'],
        mode: 'ci',
        gitBaseBranch: 'main',
        options: { projectDir: 'web', vercelEnv: 'preview', gitBranch: 'develop' },
      };
      answerBy({ branch: 'production', projectUrl: 'web', confirmed: true, vercelEnv: 'preview', gitBranch: 'develop', vars: ['API_KEY'], name: 'old-vercel' });
      const saved = await withFakeVercel(() => captureConsole(() => runPicker(cwd, KEEP, legacy)));
      expect((saved.result as TargetConfig).options).toEqual({ projectDir: '.', vercelEnv: 'preview', projectId: 'prj_web', teamId: 'team_acme', gitBranch: 'develop' });
      expect(questionsAsked().find((q) => q.name === 'gitBranch')?.default).toBe('develop');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a dry run (readOnly) never lets the store ask for or save a token', async () => {
    const cwd = repo();
    try {
      answerBy({ branch: 'production', projectUrl: 'https://vercel.com/acme/web', confirmed: true, vercelEnv: 'production', vars: ['API_KEY'], name: 'v' });
      await withFakeVercel(() => captureConsole(() => runPicker(cwd, KEEP, undefined, 'vercel', { readOnly: true })));
      expect(getSecret.mock.calls[0][2]).toMatchObject({ interactive: false });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('resolveAdapterOptions for Vercel returns the same API-mode options (what a caller saves verbatim)', async () => {
    answerBy({ projectUrl: 'https://vercel.com/acme/web', confirmed: true, vercelEnv: 'production' });
    const adapter = getAdapter('vercel');
    if (!adapter) throw new Error('vercel adapter not registered');
    const options = await withFakeVercel(() => resolveAdapterOptions(adapter, '/tmp', [], {}, {}, 'org_1'));
    expect(options).toEqual({ projectDir: '.', vercelEnv: 'production', projectId: 'prj_web', teamId: 'team_acme' });
  });
});

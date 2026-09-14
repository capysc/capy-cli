import { expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deployCommand } from '../../src/commands/deployCommand';
import { FileManager } from '../../src/files/fileManager';
import * as registry from '../../src/deploy/registry';
import * as git from '../../src/deploy/git';
import type { DeployAdapter, TargetConfig } from '../../src/deploy/adapter';
import { hashValue } from '../../src/deploy/keepGate';
import { ExitPromptError, runWithInteraction, type InteractionQuestion } from '../../src/ui/interaction';

const value = 'synthetic-value-never-render';
const keep = { version: '3.0', org_id: 'org_fixture', project_id: 'project_fixture', variables: {
  API_KEY: [{ branch: 'development', resource_id: 'resource_fixture', value_hash: hashValue(value) }],
} };
const target: TargetConfig = { name: 'fixture', kind: 'cf-worker', branch: 'development', vars: ['API_KEY'], knownVars: ['API_KEY'],
  mode: 'direct', gitBaseBranch: 'fixture-base', options: { workerName: 'fixture-worker', workerDir: '.' } };
type View = Readonly<{ text: string; input: Readonly<{ kind: string; choices?: readonly Readonly<{ value: string; label: string }>[]; default?: unknown }> }>;
type Scenario = Readonly<{ action?: 'Cancel' | 'Delete' | 'Edit' | 'Confirm'; cancelTransport?: boolean; failPreflight?: boolean;
  failDeploy?: boolean; failCommit?: boolean; failPush?: boolean; failPr?: boolean; manualPr?: boolean; ci?: boolean; unchanged?: boolean;
  force?: boolean; yes?: boolean; dryRun?: boolean; removed?: boolean; added?: boolean; editPreflightFails?: boolean; multiple?: boolean }>;

async function journey(scenario: Scenario = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'capy-deploy-main-'));
  mkdirSync(join(cwd, '.capy'));
  writeFileSync(join(cwd, 'keep.lock'), JSON.stringify(keep));
  const selected = { ...target, ...(scenario.ci ? { mode: 'ci' as const } : {}),
    ...(scenario.removed ? { vars: ['API_KEY', 'REMOVED'], knownVars: ['API_KEY', 'REMOVED'] } : {}),
    ...(scenario.added ? { vars: [], knownVars: [] } : {}) };
  writeFileSync(join(cwd, '.capy/deploy.json'), JSON.stringify({ version: '1', targets: {
    fixture: selected, ...(scenario.multiple ? { second: { ...selected, name: 'second' } } : {}),
  } }));
  const event = mock((_name: string) => {});
  const output = mock((_event: unknown) => {});
  const preflight = mock(async () => {
    event('preflight');
    return scenario.failPreflight || (scenario.editPreflightFails && preflight.mock.calls.length > 1)
      ? { ok: false, reason: 'Fixture preflight refused.', hint: 'Fixture remediation.' } : { ok: true };
  });
  const deploy = mock(async (_target: TargetConfig, _ctx: unknown) => {
    event('deploy'); return { ok: !scenario.failDeploy, steps: [{ label: 'fixture push', status: scenario.failDeploy ? 'fail' as const : 'ok' as const }] };
  });
  const adapter: DeployAdapter = { id: 'cf-worker', label: 'Fixture worker', description: 'Fixture only', varKind: 'runtime',
    defaultMode: 'direct', requires: { binaries: [] }, detect: async () => ({ options: target.options }), preflight, deploy };
  const resolve = spyOn(registry, 'getAdapter').mockReturnValue(adapter);
  const env = spyOn(FileManager.prototype, 'readEnvFile').mockImplementation(() => { event('read-env'); return { API_KEY: value }; });
  const repo = spyOn(git, 'isGitRepo').mockReturnValue(true);
  const dirty = spyOn(git, 'hasKeepLockChanges').mockReturnValue(true);
  const stash = spyOn(git, 'stashOtherChanges').mockImplementation(() => { event('stash'); return { ok: true, stashed: true }; });
  const pop = spyOn(git, 'popStash').mockImplementation(() => { event('restore'); return { ok: true }; });
  const commit = spyOn(git, 'stageAndCommit').mockImplementation(() => { event('commit'); return scenario.failCommit ? { ok: false, error: 'Fixture commit failure.' } : { ok: true }; });
  const fetch = spyOn(git, 'fetchRemoteBranch').mockImplementation(() => { event('fetch'); return { ok: true }; });
  const relative = spyOn(git, 'repoRelPath').mockReturnValue('keep.lock');
  const readBase = spyOn(git, 'readFileAtRef').mockImplementation(() => { event('read-base'); return JSON.stringify(scenario.unchanged ? keep : { ...keep, variables: {} }); });
  const addTree = spyOn(git, 'worktreeAddNewBranch').mockImplementation((_cwd, path) => { event('worktree-add'); mkdirSync(path); return { ok: true }; });
  const removeTree = spyOn(git, 'worktreeRemove').mockImplementation((_cwd, path) => { event('worktree-remove'); rmSync(path, { recursive: true, force: true }); return { ok: true }; });
  const deleteBranch = spyOn(git, 'deleteLocalBranch').mockImplementation(() => { event('branch-delete'); return { ok: true }; });
  const push = spyOn(git, 'pushBranch').mockImplementation(() => { event('push'); return scenario.failPush ? { ok: false, error: 'Fixture push failure.' } : { ok: true }; });
  const pr = spyOn(git, 'createPr').mockImplementation(() => { event('pr'); return scenario.failPr ? { ok: false, error: 'Fixture PR failure.' }
    : scenario.manualPr ? { ok: false, manualHint: 'Fixture manual PR required.' } : { ok: true, url: 'https://example.test/pr/fixture' }; });
  const prompts = mock(async <T>(question: InteractionQuestion<T>): Promise<T | null> => {
    event('prompt');
    if (scenario.cancelTransport) return null;
    const view = question.view as View;
    const action = scenario.action === 'Edit' && preflight.mock.calls.length > 1 ? 'Confirm' : scenario.action ?? 'Confirm';
    const selection = view.input.choices?.find(choice => choice.label === action);
    const answer = view.input.kind === 'confirm' ? scenario.force ?? false
      : view.text.startsWith('Worker name') ? 'edited-worker'
      : selection ? selection.value
      : view.input.default ?? view.input.choices?.[0]?.value;
    const decision = question.decide({ value: answer });
    if ('error' in decision) throw new Error(`Fixture invalid answer for ${view.text}: ${decision.error}`);
    return decision.value;
  });
  try {
    const code = await runWithInteraction({ output, progress: output, goal: output, prompt: prompts }, () => deployCommand(
      scenario.multiple ? undefined : 'fixture', { yes: scenario.yes, dryRun: scenario.dryRun, nonTty: true }, cwd));
    expect(JSON.stringify(output.mock.calls)).not.toContain(value);
    return { code, events: event.mock.calls.map(([name]) => name), prompts: prompts.mock.calls.map(([question]) => question.view as View),
      deploy: deploy.mock.calls, preflights: preflight.mock.calls.length,
      saved: JSON.parse(readFileSync(join(cwd, '.capy/deploy.json'), 'utf8')).targets,
      output: JSON.stringify(output.mock.calls),
      worktreesRemoved: addTree.mock.calls.every(([, path]) => !existsSync(path)) };
  } finally {
    for (const spy of [resolve, env, repo, dirty, stash, pop, commit, fetch, relative, readBase, addTree, removeTree, deleteBranch, push, pr]) spy.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('shared Interaction confirms deployment off-TTY and restores stashed work after success or failure', async () => {
  for (const failDeploy of [false, true]) {
    const result = await journey({ failDeploy });
    expect(result.code).toBe(failDeploy ? 1 : 0);
    expect(result.events).toEqual(['read-env', 'preflight', 'prompt', 'read-env', 'stash', 'commit', 'deploy', 'restore']);
    expect(result.deploy[0][1]).toMatchObject({ env: { API_KEY: value }, dryRun: false, secretsOnly: false });
    expect(result.output).toContain('restored stashed');
  }
});

test('cancel and delete stop before secret loading or deployment; transport cancellation propagates', async () => {
  for (const action of ['Cancel', 'Delete'] as const) {
    const result = await journey({ action });
    expect(result.code).toBe(0);
    expect(result.events).toEqual(['read-env', 'preflight', 'prompt']);
    expect(result.saved.fixture === undefined).toBe(action === 'Delete');
  }
  await expect(journey({ cancelTransport: true })).rejects.toBeInstanceOf(ExitPromptError);
});

test('preflight and commit failures stop before deployment; commit failure restores the stash', async () => {
  const preflight = await journey({ failPreflight: true });
  expect(preflight.code).toBe(1);
  expect(preflight.events).toEqual(['read-env', 'preflight']);
  expect(preflight.output).toContain('Fixture remediation.');
  const commit = await journey({ failCommit: true, yes: true });
  expect(commit.code).toBe(1);
  expect(commit.events).toEqual(['read-env', 'preflight', 'read-env', 'stash', 'commit', 'restore']);
});

test('editing preserves settings and rechecks preflight before any deploy', async () => {
  const result = await journey({ action: 'Edit', editPreflightFails: true });
  expect(result.code).toBe(1);
  expect(result.saved.fixture.options.workerName).toBe('edited-worker');
  expect(result.preflights).toBe(2);
  expect(result.deploy).toEqual([]);
});

test('editing then confirming deploys the new target after its second preflight', async () => {
  const result = await journey({ action: 'Edit' });
  expect(result.code).toBe(0);
  expect(result.preflights).toBe(2);
  expect(result.deploy[0][0].options.workerName).toBe('edited-worker');
  expect(result.events.slice(-5)).toEqual(['read-env', 'stash', 'commit', 'deploy', 'restore']);
});

test('multiple saved targets are selected through the shared prompt even off-TTY', async () => {
  const result = await journey({ multiple: true, dryRun: true });
  expect(result.code).toBe(0);
  expect(result.prompts[0].text).toBe('Which target?');
  expect(result.deploy[0][0].name).toBe('fixture');
  expect(result.deploy[0][1]).toMatchObject({ env: {}, dryRun: true });
});

test('automatic target drift drops removed vars immutably and refuses silently dropping newly added vars', async () => {
  const removed = await journey({ removed: true, yes: true, dryRun: true });
  expect(removed.code).toBe(0);
  expect(removed.deploy[0][0].vars).toEqual(['API_KEY']);
  expect(removed.saved.fixture.vars).toEqual(['API_KEY', 'REMOVED']);
  const added = await journey({ added: true, yes: true });
  expect(added.code).toBe(1);
  expect(added.events).toEqual(['read-env']);
});

test('CI publishes only after successful deploy and always removes its temporary worktree on partial failures', async () => {
  for (const flags of [{}, { failCommit: true }, { failPush: true }, { failPr: true }, { manualPr: true }]) {
    const result = await journey({ ci: true, yes: true, ...flags });
    expect(result.code).toBe('failCommit' in flags || 'failPush' in flags || 'failPr' in flags ? 1 : 0);
    expect(result.events.indexOf('deploy')).toBeLessThan(result.events.indexOf('worktree-add'));
    expect(result.events.slice(-2)).toEqual(['worktree-remove', 'branch-delete']);
    expect(result.worktreesRemoved).toBe(true);
    expect(result.events).not.toContain('stash');
  }
  const failed = await journey({ ci: true, yes: true, failDeploy: true });
  expect(failed.code).toBe(1);
  expect(failed.events).not.toContain('worktree-add');
});

test('unchanged CI asks the CLI force question via Interaction; refusal pushes secrets only', async () => {
  for (const force of [false, true]) {
    const result = await journey({ ci: true, unchanged: true, force });
    expect(result.code).toBe(0);
    expect(result.prompts.at(-1)?.text).toContain('force a redeploy');
    expect(result.prompts.at(-1)?.input.default).toBe(false);
    expect(result.events.includes('worktree-add')).toBe(force);
    expect(result.deploy[0][1]).toMatchObject({ secretsOnly: true });
  }
});

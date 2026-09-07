import { describe, expect, mock, test } from 'bun:test';
import { executeFlowSetup, type RepositoryView, type RepositoryReceipt, type SetupExecutorDependencies } from '../../src/commands/flowSetupCommand';

const FLOW = 'c41107c9-5646-4bb6-8f90-694ca5c3d836';
const USER = 'user_test';
const options = { expectedUserId: USER, serviceOrigin: 'https://dev.example.test' };
const target = { org_id: 'org_1', project_id: 'p1', project_name: 'default', branch: 'development', sync_mode: 'free' as const };
const plan = { plan_hash: 'sha256:test', cli_plan_hash: 'sha256:test', operation: 'setup' as const };
const view: RepositoryView = { flow_id: FLOW, user_id: USER, runtime_id: 'runtime', repo_fingerprint: 'repo',
  next_action: 'apply', attribution: target, approval: 'approved', plan };
const receipt: RepositoryReceipt = { flowId: FLOW, userId: USER, serviceOrigin: options.serviceOrigin,
  fingerprint: 'repo', runtimeId: 'runtime', planHash: plan.cli_plan_hash, receiptId: 'receipt', target, phase: 'applied', localHash: 'local' };
function harness(change: Partial<RepositoryView> = {}, saved: RepositoryReceipt | null = null) {
  const current = { ...view, ...change };
  const deps = {
    runtimeId: 'runtime', fingerprint: 'repo', view: mock(async () => current),
    report: mock(async (_body: Readonly<Record<string, unknown>>) => ({ ...current, next_action: 'sync' as const })),
    observe: mock(() => ({ keep_lock: null, env: { exists: false, variable_names: [] } })),
    plan: mock(async () => ({ ok: true, action: 'adopt_project', plan_hash: plan.cli_plan_hash,
      env: { variable_names: [] }, will_write: [], sync_action: 'create_empty_remote_marker', removed_remote_variable_names: [] })),
    apply: mock(async () => ({ ok: true })), read: mock(() => saved), save: mock((_receipt: RepositoryReceipt) => undefined),
    localDigest: mock(() => 'local'),
    verify: mock(async () => ({ remote_keep_hash: 'remote' })),
  } satisfies SetupExecutorDependencies;
  return deps;
}
describe('Keep-owned repository executor', () => {
  test('observation contains names only and returns to the service', async () => {
    const deps = harness({ next_action: 'observe' });
    await executeFlowSetup(FLOW, options, deps);
    expect(deps.report.mock.calls[0]?.[0]).toEqual({ action: 'observe', runtime_id: 'runtime', repo_fingerprint: 'repo',
      keep_lock: null, env: { exists: false, variable_names: [] } });
    expect(deps.apply).not.toHaveBeenCalled();
  });
  test('planning publishes existing CLI hash without granting approval', async () => {
    const deps = harness({ next_action: 'plan', plan: null });
    await executeFlowSetup(FLOW, options, deps);
    expect(deps.report.mock.calls[0]?.[0]).toMatchObject({ action: 'plan', cli_plan_hash: plan.cli_plan_hash, operation: 'setup' });
    expect(deps.apply).not.toHaveBeenCalled();
  });
  test('planning forwards the names-only discovery summary without consent', async () => {
    const deps = harness({ next_action: 'plan', plan: null });
    const summary = { stack: ['Next.js'], services: [], file_changes: [{ path: 'package.json', description: 'Wrap dev script.' }], env_files: ['.env'] };
    const result = { ok: true, action: 'adopt_project', plan_hash: plan.cli_plan_hash,
      env: { variable_names: [] }, will_write: ['package.json'], sync_action: 'create_empty_remote_marker',
      removed_remote_variable_names: [], summary };
    await executeFlowSetup(FLOW, options, { ...deps, plan: async () => result });
    expect(deps.report.mock.calls[0]?.[0]).toMatchObject({ summary, will_write: ['package.json'] });
    expect(deps.apply).not.toHaveBeenCalled();
  });
  test('local apply uses CLI hash but reports the separately bound service approval hash', async () => {
    const deps = harness({ plan: { ...plan, plan_hash: 'sha256:service-bound' } });
    await executeFlowSetup(FLOW, options, deps);
    expect(deps.apply).toHaveBeenCalledWith(target, 'setup', plan.cli_plan_hash);
    expect(deps.report.mock.calls[0]?.[0]).toMatchObject({ plan_hash: 'sha256:service-bound' });
  });
  test('human attribution and approval always return control without local mutation', async () => {
    for (const next_action of ['choose_attribution', 'approve_plan'] as const) {
      const deps = harness({ next_action, approval: null });
      expect(await executeFlowSetup(FLOW, options, deps)).toMatchObject({ continuation: { tool: 'capy_onboard', args: { flow_id: FLOW } } });
      expect(deps.save).not.toHaveBeenCalled();
      expect(deps.apply).not.toHaveBeenCalled();
    }
  });
  test('wrong repository fails before observations or writes', async () => {
    const deps = harness({ repo_fingerprint: 'other' });
    await expect(executeFlowSetup(FLOW, options, deps)).rejects.toThrow('SETUP_FLOW_BINDING_MISMATCH');
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.report).not.toHaveBeenCalled();
  });
  test('missing approval is never inferred', async () => {
    const deps = harness({ approval: null });
    await expect(executeFlowSetup(FLOW, options, deps)).rejects.toThrow('SETUP_APPROVAL_REQUIRED');
    expect(deps.apply).not.toHaveBeenCalled();
  });
  test('changed local plan requires fresh owner consent', async () => {
    const deps = harness({ plan: { ...plan, cli_plan_hash: 'changed' } });
    await expect(executeFlowSetup(FLOW, options, deps)).rejects.toThrow('PLAN_CHANGED');
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });
  test('approved apply saves checkpoint before execution and durable receipt before report', async () => {
    const deps = harness();
    await executeFlowSetup(FLOW, options, deps);
    expect(deps.save.mock.calls.map(([saved]) => saved.phase)).toEqual(['applying', 'applied']);
    expect(deps.apply).toHaveBeenCalledWith(target, 'setup', plan.cli_plan_hash);
    expect(deps.report.mock.calls[0]?.[0]).toMatchObject({ action: 'applied', remote_keep_hash: 'remote' });
    expect(deps.save.mock.calls[0]?.[0].receiptId).toBe(deps.save.mock.calls[1]?.[0].receiptId);
  });
  test('replaying delivered apply receipt does not repeat local mutation', async () => {
    const deps = harness({}, receipt);
    await executeFlowSetup(FLOW, options, deps);
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.report.mock.calls[0]?.[0]).toMatchObject({ action: 'applied', receipt_id: 'receipt' });
  });
  test('saved target key ordering does not invalidate the same attributed project', async () => {
    const reordered = { sync_mode: target.sync_mode, branch: target.branch, project_name: target.project_name,
      project_id: target.project_id, org_id: target.org_id };
    const deps = harness({ attribution: reordered }, receipt);
    await executeFlowSetup(FLOW, options, deps);
    expect(deps.report.mock.calls[0]?.[0]).toMatchObject({ action: 'applied', receipt_id: 'receipt' });
    expect(deps.apply).not.toHaveBeenCalled();
  });
  test('a genuinely different saved target still cannot reuse an applied receipt', async () => {
    const deps = harness({ attribution: { ...target, project_id: 'different' } }, receipt);
    await expect(executeFlowSetup(FLOW, options, deps)).rejects.toThrow('SETUP_RECEIPT_MISMATCH');
    expect(deps.report).not.toHaveBeenCalled();
  });
  test('sync and verify are verified milestones, not duplicate executions', async () => {
    for (const next_action of ['sync', 'verify'] as const) {
      const deps = harness({ next_action }, receipt);
      await executeFlowSetup(FLOW, options, deps);
      expect(deps.apply).not.toHaveBeenCalled();
      expect(deps.verify).toHaveBeenCalledWith(target);
      expect(deps.report.mock.calls[0]?.[0]).toMatchObject({ action: next_action === 'sync' ? 'synced' : 'verify', receipt_id: 'receipt' });
    }
  });
  test('a crash inside apply is actionable, not a blind repeated write', async () => {
    const deps = harness({}, { ...receipt, phase: 'applying' });
    await expect(executeFlowSetup(FLOW, options, deps)).rejects.toThrow('SETUP_APPLY_INTERRUPTED');
    expect(deps.apply).not.toHaveBeenCalled();
  });
  test('changed local files cannot reuse a completed receipt to claim success', async () => {
    const deps = harness({}, { ...receipt, localHash: 'before-edit' });
    await expect(executeFlowSetup(FLOW, options, deps)).rejects.toThrow('SETUP_LOCAL_STATE_CHANGED');
    expect(deps.report).not.toHaveBeenCalled();
  });
  test('only service done can report overall completion', async () => {
    const deps = harness({ next_action: 'done' }, receipt);
    expect(await executeFlowSetup(FLOW, options, deps)).toEqual({ ok: true, flow_id: FLOW, stage: 'done', message: 'Capy is ready for this repository.',
      continuation: { tool: 'capy_onboard', args: { flow_id: FLOW } } });
    expect(deps.apply).not.toHaveBeenCalled();
  });
});

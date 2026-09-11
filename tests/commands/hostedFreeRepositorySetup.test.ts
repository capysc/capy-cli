import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { AuthService } from '../../src/auth/authService';
import type { ServiceClient } from '../../src/service/serviceClient';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import type { HostedInitWizardSession } from '../../src/ui/hostedInitWizardSession';
import { SetupCommand, type SetupCommandOptions } from '../../src/commands/setupCommand';
import { hostedFreeSetupPresentation, runHostedFreeRepositorySetup } from '../../src/commands/hostedFreeRepositorySetup';

afterEach(() => mock.restore());
const now = Date.parse('2026-09-11T17:00:00.000Z');
const planHash = `sha256:${'a'.repeat(64)}`;
const target = { orgId: 'org-test', orgName: 'automatic-name', projectId: 'project-test',
  projectName: 'default', branch: 'development' } as const;
const binding = {
  run_id: '11111111-1111-4111-8111-111111111111', subject_user_id: 'user_test',
  service_origin: 'https://mabels-mac-mini.tailcbfb49.ts.net:3444',
  runtime_id: '77777777-7777-4777-8777-777777777777',
  repository_fingerprint: `sha256:${'b'.repeat(64)}`, cli_key_fingerprint: `sha256:${'c'.repeat(64)}`,
};
const request = { flow_id: binding.run_id, kind: 'onboard_plan', decision_id: planHash } as const;
const result = {
  ok: true, action: 'adopt_project', org: { id: target.orgId, name: target.orgName },
  project: { id: target.projectId, name: target.projectName, status: 'existing' },
  branch: 'development', sync_mode: 'free', sync_action: 'push_root_env', keep_lock_path: null,
} as const;
const plan = { ...result, plan_hash: planHash, env: { variable_names: ['SENTINEL'] },
  will_write: ['.env'], removed_remote_variable_names: [], confirm_command: 'must not reach browser' } as const;
const connection = (index: number) => ({
  connectionId: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
  expiresAt: new Date(now + 900_000).toISOString(), keypair: mintConnectionKeypair(),
});
const harness = (answer: Readonly<Record<string, unknown>> = { request, approved: true },
  options: Readonly<{ origin?: string; clock?: () => number; lost?: boolean }> = {}) => {
  const sendRequest = mock(async () => ({ kind: 'sent' as const }));
  const connections = [connection(1), connection(2), connection(3)] as const;
  const session: HostedInitWizardSession = {
    channel: {
      broker: {
        createConnection: async () => connections[2],
        pollExchange: async () => ({ kind: 'pending' as const, pagePubkeyB64: 'dummy-page-key' }),
        pollAnswer: async () => options.lost ? { kind: 'indeterminate' as const } : ({
          kind: 'answered' as const, plaintext: JSON.stringify({ v: 1, flow: 'init-wizard', binding,
            sequence: 0, attempt_id: 'approval_1', kind: 'answer', answer }),
        }),
        sendRequest, cancel: async () => undefined,
      },
      binding, current: connections[0], successor: connections[1], sequence: 0,
      deadline: now + 7_200_000, now: options.clock ?? (() => now), attemptId: () => 'approval_1',
      pause: async () => undefined, cleanupTimeoutMs: 10,
    },
    input: {}, step: 'encrypt', block: null, encryptView: null, ended: false,
  };
  const authService = {
    assertRefreshAuthorityAvailable: () => undefined,
    getServiceApiUrl: () => options.origin ?? binding.service_origin,
    getOrganizationId: () => target.orgId,
    getToken: () => ({ user_id: binding.subject_user_id, organization_id: target.orgId }),
  } as unknown as AuthService;
  const execute = mock(async (confirm?: string) => confirm === undefined ? plan : result);
  return { input: { target, authService, serviceClient: {} as ServiceClient, session, devMode: true, execute },
    execute, sendRequest, connections };
};

test('uses exact hosted approval before applying the existing setup plan hash', async () => {
  const h = harness();
  const completed = await runHostedFreeRepositorySetup(h.input);
  expect(completed.kind).toBe('applied');
  expect(h.execute.mock.calls).toEqual([[], [planHash]]);
  expect(completed.session.channel.current.connectionId).toBe(h.connections[2].connectionId);
  expect(completed.session.input.encrypt).toBe(true);
  const frames = h.sendRequest.mock.calls.map(call => JSON.parse(call[2] as string));
  expect(frames.map(frame => [frame.screen, frame.kind])).toEqual([['flow-confirm', 'view'], ['flow-confirm', 'progress']]);
  expect(frames[0].data.request).toEqual(request);
  expect(frames[0].data.summary.write_paths).toEqual(['.env']);
  expect(JSON.stringify(frames)).not.toContain('must not reach browser');
});

test('declining or losing an approval does not apply or replay it', async () => {
  for (const options of [{ answer: { request, approved: false } }, { lost: true }] as const) {
    const h = harness('answer' in options ? options.answer : undefined, options);
    const completed = await runHostedFreeRepositorySetup(h.input);
    expect(completed.kind).toBe('answer' in options ? 'cancelled' : 'failed');
    expect(h.execute.mock.calls).toEqual([[]]);
  }
});

test('rejects foreign approval identities and widened answers before apply', async () => {
  for (const answer of [
    { request: { ...request, decision_id: `sha256:${'d'.repeat(64)}` }, approved: true },
    { request: { ...request, flow_id: binding.runtime_id }, approved: true },
    { request: { ...request, extra: true }, approved: true },
    { request, approved: 'true' }, { request, approved: true, command: 'unexpected' },
  ]) {
    const h = harness(answer);
    expect((await runHostedFreeRepositorySetup(h.input)).kind).toBe('failed');
    expect(h.execute).toHaveBeenCalledTimes(1);
  }
});

test('refuses paid, foreign, widened-file and malformed plans before presentation', () => {
  for (const invalid of [
    { ...plan, sync_mode: 'paid' }, { ...plan, keep_lock_path: 'keep.lock' },
    { ...plan, will_write: ['keep.lock'] }, { ...plan, removed_remote_variable_names: ['SENTINEL'] },
    { ...plan, project: { ...plan.project, id: 'other' } },
    { ...plan, env: { variable_names: ['SENTINEL', 'SENTINEL'] } },
    { ...plan, env: { variable_names: ['bad\nname'] } }, { ...plan, plan_hash: 'not-hash' },
    { ...plan, env: { variable_names: ['bad\u0085name'] } }, { ...plan, sync_action: ['push_root_env'] },
  ]) expect(() => hostedFreeSetupPresentation(invalid, target, binding.run_id)).toThrow();
});

test('preserves existing executor plan-changed refusal and current origin checks', async () => {
  const h = harness();
  const execute = mock(async (confirm?: string) => confirm === undefined ? plan : { ok: false, code: 'PLAN_CHANGED' });
  const failed = await runHostedFreeRepositorySetup({ ...h.input, execute });
  expect(failed.kind).toBe('failed');
  if (failed.kind === 'failed') expect(failed.error).toMatchObject({ code: 'PLAN_CHANGED' });
  const foreign = harness(undefined, { origin: 'http://127.0.0.1:3501' });
  expect((await runHostedFreeRepositorySetup(foreign.input)).kind).toBe('failed');
  expect(foreign.execute).not.toHaveBeenCalled();
});

test('default adapter calls the real SetupCommand interface with exact free target and hash', async () => {
  const execute = spyOn(SetupCommand.prototype, 'execute').mockImplementation(async function (
    this: SetupCommand, options: SetupCommandOptions,
  ) {
    const command = this as unknown as Readonly<{ printResult: (value: Readonly<Record<string, unknown>>) => void }>;
    command.printResult(options.confirm === undefined ? plan : result);
  });
  const h = harness();
  const { execute: omitted, ...input } = h.input;
  expect(omitted).toBe(h.execute);
  expect((await runHostedFreeRepositorySetup(input)).kind).toBe('applied');
  expect(execute.mock.calls).toEqual([
    [{ org: target.orgId, project: target.projectId, expectedUserId: binding.subject_user_id, expectedSyncMode: 'free', confirm: undefined }],
    [{ org: target.orgId, project: target.projectId, expectedUserId: binding.subject_user_id, expectedSyncMode: 'free', confirm: planHash }],
  ]);
});

import { beforeEach, expect, mock, test } from 'bun:test';
import { runWithInteraction, type Interaction, type InteractionQuestion } from '../../src/ui/interaction';

const connector = { provider: 'workos', source: 'dashboard', mode: 'test', created_at: 1, fingerprint: 'synthetic' };
const keep = { version: '3.0', org_id: 'fixture-org', project_id: 'fixture-project', project_name: 'fixture',
  variables: { WORKOS_API_KEY: [{ branch: 'development', resource_id: 'fixture-resource', value_hash: 'fixture-hash', connector }] } };
const readKeep = mock(() => keep);
const gate = mock(async () => 'in-sync');
const rotate = mock(async () => ({ value: 'synthetic-fixture-value', entry: connector }));
const write = mock(async () => undefined);
mock.module('../../src/core/projectManager', () => ({ ProjectManager: class {
  readKeepFile = readKeep;
  deriveActiveBranch = () => 'development';
} }));
mock.module('../../src/sync/gate', () => ({ gateFirst: gate }));
mock.module('../../src/commands/connectors/registry', () => ({
  loadProvider: async () => ({ kind: 'link', rotate, requiresAuth: true }), listProviders: () => ['workos'],
}));
mock.module('../../src/commands/connectors/shared', () => ({
  resolveContext: async () => ({ keep: readKeep(), branch: 'development', localPlaintext: {} }),
  writeAndSync: write,
  listManagedKeys: (value: typeof keep) => Object.entries(value.variables).flatMap(([varName, entries]) => entries.filter(entry => entry.connector).map(entry => ({ varName, connector: entry.connector }))),
  listAllVarsOnBranch: (value: typeof keep) => Object.keys(value.variables),
  findManagedConnector: () => readKeep().variables.WORKOS_API_KEY[0].connector,
}));
import { RotateCommand } from '../../src/commands/rotateCommand';

beforeEach(() => { readKeep.mockReset(); readKeep.mockImplementation(() => keep); gate.mockClear(); rotate.mockReset();
  rotate.mockImplementation(async () => ({ value: 'synthetic-fixture-value', entry: connector })); write.mockClear(); });
const fixture = (approved: boolean) => {
  const controller = new AbortController();
  const goal = mock(async () => undefined);
  const output = mock(async () => undefined);
  const prompt = mock(async <T>(question: InteractionQuestion<T>) => {
    const decision = question.decide({ value: approved });
    if ('error' in decision) throw new Error(decision.error);
    return decision.value;
  });
  const interaction: Interaction = { signal: controller.signal, binding: { userId: 'fixture-user', organizationId: 'fixture-org' }, goal, output, prompt, progress: async () => undefined };
  return { controller, interaction, goal, output, prompt };
};

test('browser approval completes the actual local rotation and persists once', async () => {
  const f = fixture(true);
  const result = await runWithInteraction(f.interaction, () => new RotateCommand(true).execute('WORKOS_API_KEY', { noPush: true, allowedProviders: ['workos'] }));
  expect(result).toEqual(['WORKOS_API_KEY']);
  expect(gate).toHaveBeenCalledTimes(1);
  expect(f.prompt).toHaveBeenCalledTimes(1);
  expect(rotate).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0][3]).toEqual({ push: false, connector });
  expect(JSON.stringify(f.output.mock.calls)).not.toContain('synthetic-fixture-value');
});

test('declining browser approval prevents provider mutation and persistence', async () => {
  const f = fixture(false);
  await expect(runWithInteraction(f.interaction, () => new RotateCommand(true).execute('WORKOS_API_KEY', { noPush: true, allowedProviders: ['workos'] }))).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
  expect(rotate).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(f.goal).not.toHaveBeenCalled();
});

test('a failed provider request cannot persist a value or return completed variables', async () => {
  const f = fixture(true);
  const failure = new Error('synthetic provider refusal');
  rotate.mockRejectedValueOnce(failure);
  await expect(runWithInteraction(f.interaction, () => new RotateCommand(true).execute('WORKOS_API_KEY', { noPush: true, allowedProviders: ['workos'] }))).rejects.toBe(failure);
  expect(write).not.toHaveBeenCalled();
  expect(f.goal).not.toHaveBeenCalled();
});

test('a changed provider read after synchronization is refused before approval or mutation', async () => {
  const f = fixture(true);
  readKeep.mockReturnValue({ ...keep, variables: { WORKOS_API_KEY: [{ ...keep.variables.WORKOS_API_KEY[0], connector: { ...connector, provider: 'stripe' } }] } });
  await expect(runWithInteraction(f.interaction, () => new RotateCommand(true).execute('WORKOS_API_KEY', { noPush: true, allowedProviders: ['workos'] }))).rejects.toMatchObject({ code: 'ROTATE_FLOW_PROVIDER_UNSUPPORTED' });
  expect(f.prompt).not.toHaveBeenCalled();
  expect(rotate).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});


test('cancellation after provider completion cannot write local or remote project state', async () => {
  const f = fixture(true);
  const reason = new Error('synthetic cancellation');
  rotate.mockImplementationOnce(async () => {
    f.controller.abort(reason);
    return {value:'synthetic-fixture-value',entry:connector};
  });
  await expect(runWithInteraction(f.interaction, () => new RotateCommand(true).execute('WORKOS_API_KEY', {noPush:true,allowedProviders:['workos']}))).rejects.toBe(reason);
  expect(write).not.toHaveBeenCalled();
  expect(f.goal).not.toHaveBeenCalled();
});


test('a target removed by synchronization cannot become an implicit connect operation', async () => {
  const f = fixture(true);
  readKeep.mockReturnValue({...keep,variables:{}} as typeof keep);
  await expect(runWithInteraction(f.interaction, () => new RotateCommand(true).execute('WORKOS_API_KEY', {noPush:true,allowedProviders:['workos']}))).rejects.toMatchObject({code:'ROTATE_FLOW_MANAGED_TARGET_REQUIRED'});
  expect(f.prompt).not.toHaveBeenCalled();
  expect(rotate).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

test('all refuses a managed client ID before rotating any key', async () => {
  const f = fixture(true);
  readKeep.mockReturnValue({...keep,variables:{WORKOS_API_KEY:[{...keep.variables.WORKOS_API_KEY[0],connector:{...connector,source:'client-id'}}]}});
  await expect(runWithInteraction(f.interaction, () => new RotateCommand(true).execute(undefined, {all:true,noPush:true,allowedProviders:['workos']}))).rejects.toMatchObject({code:'ROTATE_FLOW_TARGET_NOT_ROTATABLE'});
  expect(f.prompt).not.toHaveBeenCalled();
  expect(rotate).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

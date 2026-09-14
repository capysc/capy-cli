import { describe, test, expect, mock, spyOn } from 'bun:test';
import * as shared from '../../src/commands/connectors/shared';
import * as registry from '../../src/commands/connectors/registry';
import * as config from '../../src/deploy/config';
import * as deploy from '../../src/commands/deployCommand';
import * as readiness from '../../src/commands/rotateReadiness';
import { ProjectManager } from '../../src/core/projectManager';
import { ConnectCommand } from '../../src/commands/connectCommand';
import { RotateCommand } from '../../src/commands/rotateCommand';
import { runWithInteraction, InteractionCommandError, type Interaction, type InteractionQuestion, type InteractionGoal } from '../../src/ui/interaction';
import type { ConnectorMetadata, KeepFile } from '../../src/types';

const connector: ConnectorMetadata = { provider: 'workos', source: 'api', mode: 'sandbox', account_id: 'env_fixture', created_at: 1 };
const target = { name: 'fixture', kind: 'cf-worker', mode: 'direct' as const, branch: 'development', vars: ['KEY_ONE'], options: {} };
const fixture = (connected: boolean): KeepFile => ({ version: '3.0', org_id: 'org_fixture', project_id: 'project_fixture', project_name: 'Fixture', variables: Object.fromEntries(
  ['KEY_ONE', 'KEY_TWO'].map(name => [name, [{ resource_id: name, branch: 'development', value_hash: 'hash_fixture', ...(connected ? { connector } : {}) }]])) });

type Scenario = Readonly<{ unconnected?: boolean; fatal?: boolean; failSync?: boolean; failDeploy?: boolean; decline?: boolean; noPush?: boolean; foreign?: boolean; missingProject?: boolean; connectDeclined?: boolean }>;
async function journey(options: Scenario = {}) {
  const event = mock((_name: string) => undefined);
  const output = mock((_event: unknown) => undefined);
  const goal = mock((_outcome: InteractionGoal) => undefined);
  const connect = spyOn(ConnectCommand.prototype, 'execute').mockImplementation(async (_provider, opts) => {
    expect(opts.subStep).toBe(true); expect(opts.web).toBe(false); event('connect'); return { linked: !options.connectDeclined };
  });
  const keep = spyOn(ProjectManager.prototype, 'readKeepFile').mockImplementation(() => {
    if (options.missingProject) return null;
    const base = fixture(!options.unconnected || connect.mock.calls.length > 0);
    return options.foreign ? { ...base, variables: Object.fromEntries(Object.entries(base.variables).map(([name, entries]) =>
      [name, entries.map(entry => ({ ...entry, connector: { ...connector, provider: 'stripe' } }))])) } : base;
  });
  const branch = spyOn(ProjectManager.prototype, 'deriveActiveBranch').mockReturnValue('development');
  const resolve = spyOn(shared, 'resolveContext').mockImplementation(async () => ({ userId: 'user_fixture', keep: fixture(true), branch: 'development' } as shared.ResolvedContext));
  const write = spyOn(shared, 'writeAndSync').mockImplementation(async () => { event('write-sync'); if (options.failSync) throw new Error('do-not-persist-secret'); });
  const rotate = mock(async (_ctx: unknown, name: string, _connector: unknown, opts: registry.RotateOpts) => {
    expect(opts.nonTty).toBe(true); event(`create:${name}`);
    if (options.fatal) throw new InteractionCommandError('WORKOS_FATAL', 'WorkOS refused the operation.');
    event(`expire:${name}`); return { value: 'synthetic-secret-do-not-persist', entry: connector };
  });
  const load = spyOn(registry, 'loadProvider').mockImplementation(async () => ({ name: 'workos', description: 'Fixture', rotate,
    connect: async () => { throw new Error('unused'); } }));
  const targets = spyOn(config, 'listTargets').mockReturnValue([target]);
  const inspect = spyOn(readiness, 'inspectRotateDeployment').mockResolvedValue({ checks: [], choices: [] });
  const ship = spyOn(deploy, 'deployCommand').mockImplementation(async () => { event('deploy'); return options.failDeploy ? 1 : 0; });
  const interaction: Interaction = { output, progress: output, goal,
    prompt: async <T>(question: InteractionQuestion<T>) => {
      event('approve');
      const result = question.decide({ value: !options.decline });
      if ('error' in result) throw new Error(result.error);
      return result.value;
    },
  };
  const exitCode = process.exitCode;
  try {
    await runWithInteraction(interaction, () => new RotateCommand().execute(options.fatal ? undefined : 'KEY_ONE', {
      all: options.fatal, provider: 'workos', nonTty: true, web: false, noPush: options.noPush,
      deployTarget: 'fixture', expectedUserId: 'user_fixture', flowProvider: 'workos',
    }));
    expect(goal).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output.mock.calls)).not.toContain('synthetic-secret-do-not-persist');
    expect(JSON.stringify(goal.mock.calls)).not.toContain('do-not-persist-secret');
    return { events: event.mock.calls.map(([name]) => name), outcome: goal.mock.calls[0][0] };
  } finally {
    for (const spy of [connect, keep, branch, resolve, write, load, targets, inspect, ship]) spy.mockRestore();
    Reflect.set(process, 'exitCode', exitCode ?? 0);
  }
}

describe('ordinary rotate using shared Interaction with fake providers', () => {
  test('approve → create → expiry → write/sync → deployment', async () => {
    const result = await journey();
    expect(result.events).toEqual(['approve', 'create:KEY_ONE', 'expire:KEY_ONE', 'write-sync', 'deploy']);
    expect(result.outcome.status).toBe('succeeded');
  });
  test('unconnected credential composes Connect and then the same rotation', async () => {
    const result = await journey({ unconnected: true });
    expect(result.events).toEqual(['connect', 'approve', 'create:KEY_ONE', 'expire:KEY_ONE', 'write-sync', 'deploy']);
    expect(result.outcome.status).toBe('succeeded');
  });
  test('fatal WorkOS error stops --all before the next credential or deployment', async () => {
    const result = await journey({ fatal: true });
    expect(result.events).toEqual(['approve', 'create:KEY_ONE']);
    expect(result.outcome).toMatchObject({ status: 'failed', code: 'WORKOS_FATAL' });
  });
  test('sync failure reports provider changes without retrying or deploying', async () => {
    const result = await journey({ failSync: true });
    expect(result.events).toEqual(['approve', 'create:KEY_ONE', 'expire:KEY_ONE', 'write-sync']);
    expect(result.outcome.code).toBe('ROTATE_WRITE_SYNC_FAILED');
  });
  test('deployment failure tells the user to retry deployment', async () => {
    const result = await journey({ failDeploy: true });
    expect(result.outcome.code).toBe('ROTATE_DEPLOY_FAILED');
    expect(result.outcome.message).toContain('rather than rotating again');
  });
  test('declined plan cancels with no provider operations', async () => {
    const result = await journey({ decline: true });
    expect(result.events).toEqual(['approve']); expect(result.outcome.status).toBe('cancelled');
  });
  test('--no-push still confirms in Flow and skips deployment', async () => {
    const result = await journey({ noPush: true });
    expect(result.events).toEqual(['approve', 'create:KEY_ONE', 'expire:KEY_ONE', 'write-sync']);
    expect(result.outcome.status).toBe('succeeded');
  });
  test('a different provider selection fails before setup, approval or mutation', async () => {
    const result = await journey({ foreign: true });
    expect(result.events).toEqual([]); expect(result.outcome.code).toBe('ROTATE_FLOW_WORKOS_REQUIRED');
  });
  test('missing project produces one terminal failed outcome', async () => {
    const result = await journey({ missingProject: true });
    expect(result.events).toEqual([]); expect(result.outcome.status).toBe('failed');
  });
  test('Connect declining cancels the composed run without rotation', async () => {
    const result = await journey({ unconnected: true, connectDeclined: true });
    expect(result.events).toEqual(['connect']); expect(result.outcome.status).toBe('cancelled');
  });

});

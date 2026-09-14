import { describe, test, expect, spyOn, mock } from 'bun:test';
import { runRotateFlow } from '../../src/commands/rotateFlow';
import { RotateCommand } from '../../src/commands/rotateCommand';
import * as readiness from '../../src/commands/rotateReadiness';
import * as flow from '../../src/ui/flowInteraction';
import { ProjectManager } from '../../src/core/projectManager';
import type { KeepFile } from '../../src/types';

const keep: KeepFile = { version: '3.0', org_id: 'org_fixture', project_id: 'project_fixture', project_name: 'Fixture',
  variables: { KEY: [{ branch: 'development', resource_id: 'resource_fixture', value_hash: 'hash_fixture',
    connector: { provider: 'workos', source: 'api', created_at: 1 } }] } };

describe('rotate conversation entry', () => {
  test.each([true, false])('readiness=%s is inspected before any conversation is created', async ready => {
    const event = mock((_name: string) => undefined);
    const read = spyOn(ProjectManager.prototype, 'readKeepFile').mockReturnValue(keep);
    const branch = spyOn(ProjectManager.prototype, 'deriveActiveBranch').mockReturnValue('development');
    const inspect = spyOn(readiness, 'inspectLocalRotateReadiness').mockImplementation(async opts => {
      expect(opts.expectedUserId).toBe('user_fixture'); event('readiness');
      return { v: 1, command: 'rotate', ready, checks: [{ code: 'FIXTURE', ready, detail: 'fixture' }], deploymentChoices: [] };
    });
    const transport = spyOn(flow, 'runWithFlowInteraction').mockImplementation(async (operation, devMode, descriptor) => {
      expect(devMode).toBe(true);
      expect(descriptor).toEqual({ command: 'rotate', continuationTool: 'capy_rotate_continue', expectedUserId: 'user_fixture' });
      event('conversation'); await operation();
    });
    const execute = spyOn(RotateCommand.prototype, 'execute').mockImplementation(async (_name, opts) => {
      expect(opts.web).toBe(false); expect(opts.flowProvider).toBe('workos'); event('execute');
    });
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitCode = process.exitCode;
    try {
      await runRotateFlow('KEY', { provider: 'workos', expectedUserId: 'user_fixture', noPush: true }, true);
      expect(event.mock.calls.map(([name]) => name)).toEqual(ready ? ['readiness', 'conversation', 'execute'] : ['readiness']);
      if (!ready) expect(JSON.parse(String(stdout.mock.calls[0][0])).ready).toBe(false);
    } finally {
      for (const spy of [read, branch, inspect, transport, execute, stdout]) spy.mockRestore();
      Reflect.set(process, 'exitCode', exitCode ?? 0);
    }
  });
});

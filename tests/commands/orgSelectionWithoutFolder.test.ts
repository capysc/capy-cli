/**
 * `capy secrets` and `capy projects` in a folder with no keep.lock, for a person in several organizations.
 *
 * The organization is never guessed. At a terminal the person picks (`resolveOrgContext`'s own picker); under
 * `--json`, or with no terminal, nobody can answer a picker, so the picker is not opened and the run ends with
 * ORG_SELECTION_REQUIRED and the orgs for the agent to show the human. Only org resolution is replaced here.
 *
 * Isolated: `mock.module()` is process-wide (tests/run-tests.sh).
 */
import { describe, it, expect, spyOn, mock, afterAll, beforeEach } from 'bun:test';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const ORGS = [{ id: 'org_1', name: 'Acme' }, { id: 'org_2', name: 'Other' }];

const resolveOrgContext = mock(async (..._args: unknown[]): Promise<never> => {
  throw new CapyError('pick one', ERROR_CODES.ORG_SELECTION_REQUIRED, { orgs: ORGS });
});
mock.module('../../src/core/orgContext', () => ({ resolveOrgContext }));

afterAll(() => {
  mock.restore();
});

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

async function capture(fn: () => Promise<void>): Promise<{ readonly exitCode?: number; readonly stdout: string }> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const thrown: unknown = await fn().then(() => null, (err: unknown) => err);
  const stdout = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  if (thrown !== null && !(thrown instanceof ExitSignal)) throw thrown;
  return { exitCode: thrown instanceof ExitSignal ? thrown.code : undefined, stdout };
}

beforeEach(() => {
  resolveOrgContext.mockClear();
});

describe('several organizations, no keep.lock, nobody to ask', () => {
  it('capy secrets --json does not open the picker and refuses with the code and the orgs', async () => {
    const { SecretsCommand } = await import('../../src/commands/secretsCommand');
    const out = await capture(() => new SecretsCommand().execute({ json: true }));
    expect(resolveOrgContext.mock.calls[0][2]).toEqual({ promptForOrg: false });
    expect(out.exitCode).toBe(3);
    expect(JSON.parse(out.stdout)).toEqual({ ok: false, code: 'ORG_SELECTION_REQUIRED', message: 'pick one', orgs: ORGS });
  });

  it('capy projects --json does not open the picker and refuses with the code and the orgs', async () => {
    const { ProjectsCommand } = await import('../../src/commands/projectsCommand');
    const out = await capture(() => new ProjectsCommand().execute({ json: true }));
    expect(resolveOrgContext.mock.calls[0][2]).toEqual({ promptForOrg: false });
    expect(out.exitCode).toBe(3);
    expect(JSON.parse(out.stdout)).toEqual({ ok: false, code: 'ORG_SELECTION_REQUIRED', message: 'pick one', orgs: ORGS });
  });

  it('capy projects without --json, off a terminal, refuses the same way: the code and the orgs on stdout', async () => {
    const { ProjectsCommand } = await import('../../src/commands/projectsCommand');
    const out = await capture(() => new ProjectsCommand().execute({}));
    expect(resolveOrgContext.mock.calls[0][2]).toEqual({ promptForOrg: false });
    expect(out.exitCode).toBe(3);
    expect(JSON.parse(out.stdout)).toEqual({ ok: false, code: 'ORG_SELECTION_REQUIRED', message: 'pick one', orgs: ORGS });
  });

  it('capy secrets without --json, off a terminal, refuses the same way', async () => {
    const { SecretsCommand } = await import('../../src/commands/secretsCommand');
    const out = await capture(() => new SecretsCommand().execute({}));
    expect(resolveOrgContext.mock.calls[0][2]).toEqual({ promptForOrg: false });
    expect(out.exitCode).toBe(3);
    expect(JSON.parse(out.stdout)).toEqual({ ok: false, code: 'ORG_SELECTION_REQUIRED', message: 'pick one', orgs: ORGS });
  });
});

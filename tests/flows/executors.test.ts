import { mock, jest, describe, test, expect, beforeEach, afterAll } from 'bun:test';

// ---------------------------------------------------------------------------
// The executors are ADAPTERS over entry points this CLI already has, so what
// matters is which entry point each one reaches and what it reports back — not
// what those entry points do, which their own tests cover. Both are mocked
// here so nothing authenticates, writes or shells out.
// ---------------------------------------------------------------------------

const initializeProjectForFlow = jest.fn();
const bootstrapProjectForFlow = jest.fn();
const syncForFlow = jest.fn();
const execute = jest.fn();
const authenticateSilent = jest.fn();
const authenticate = jest.fn();
const getValidToken = jest.fn(async () => null);

mock.module('../../src/commands/capyCommand', () => ({
  CapyCommand: class {
    initializeProjectForFlow = initializeProjectForFlow;
    bootstrapProjectForFlow = bootstrapProjectForFlow;
    syncForFlow = syncForFlow;
    execute = execute;
  },
}));

mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    authenticateSilent = authenticateSilent;
    authenticate = authenticate;
    getValidToken = getValidToken;
  },
}));

const applyPlan = jest.fn();
mock.module('../../src/flows/onboard/apply', () => ({ applyPlan }));

afterAll(() => {
  mock.restore();
});

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import { EXECUTORS, codeFor, ExecutorContext } from '../../src/flows/onboard/executors';
import { FlowStep } from '../../src/flows/validate';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capy-exec-'));
  initializeProjectForFlow.mockReset();
  bootstrapProjectForFlow.mockReset();
  syncForFlow.mockReset();
  execute.mockReset();
  authenticateSilent.mockReset();
  authenticate.mockReset();
  applyPlan.mockReset();
  authenticateSilent.mockResolvedValue({ success: true, user_id: 'user_1', organization_id: 'org_1' });
});

const ctx = (over: Partial<ExecutorContext> = {}): ExecutorContext => ({
  targetDir: dir,
  devMode: false,
  consented: true,
  ...over,
});

const step = (over: Partial<FlowStep> = {}): FlowStep =>
  ({
    contract_version: '1',
    flow_id: 'f',
    flow_type: 'onboard',
    step_id: 's',
    kind: 'local_action',
    resumed: false,
    params: {},
    ...over,
  }) as FlowStep;

describe('codeFor — the reason travels as a code', () => {
  test('carries a CapyError code through untouched', () => {
    expect(codeFor(new CapyError('no key here', ERROR_CODES.KEY_NOT_ON_DEVICE))).toBe('KEY_NOT_ON_DEVICE');
    expect(codeFor(new CapyError('nope', ERROR_CODES.PERMISSION_DENIED))).toBe('PERMISSION_DENIED');
  });

  test('an error with no code is a service error, never a guess', () => {
    expect(codeFor(new Error('something'))).toBe(ERROR_CODES.SERVICE_ERROR);
    expect(codeFor('a string')).toBe(ERROR_CODES.SERVICE_ERROR);
  });

  test('the device-key dead end reaches the service as its own code', async () => {
    // The condition the whole Case-C remedy hangs off: it must not arrive as a
    // generic auth failure, or the user is told to sign in again — which cannot
    // fix it.
    initializeProjectForFlow.mockRejectedValue(
      new CapyError('You have access ... but no encryption key on this device.', ERROR_CODES.KEY_NOT_ON_DEVICE),
    );
    const result = await EXECUTORS.write_keep_lock(step({ verb: 'write_keep_lock', params: { source: 'select_or_create' } }), ctx());
    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('KEY_NOT_ON_DEVICE');
  });
});

describe('write_keep_lock — pinned ids are adopted, never re-picked', () => {
  test('with org_id + project_id in the step, it adopts and never runs the picker', async () => {
    const result = await EXECUTORS.write_keep_lock(
      step({
        verb: 'write_keep_lock',
        params: { source: 'select_or_create', org_id: 'org_1', project_id: 'proj_1', branch: 'development' },
      }),
      ctx(),
    );

    expect(bootstrapProjectForFlow).toHaveBeenCalledTimes(1);
    // The whole point: a retry after a crash must not walk the user back
    // through a picker that can create a SECOND project.
    expect(initializeProjectForFlow).not.toHaveBeenCalled();
    expect(result.result).toEqual({ org_id: 'org_1', project_id: 'proj_1', branch: 'development' });
  });

  test('without pins it runs the initialization, and reports ids resolved before a failure', async () => {
    initializeProjectForFlow.mockImplementation(async (opts: any) => {
      opts.onProjectResolved({ org_id: 'org_1', project_id: 'proj_new' });
      throw new CapyError('died after creating the project', ERROR_CODES.SERVICE_ERROR);
    });

    const result = await EXECUTORS.write_keep_lock(
      step({ verb: 'write_keep_lock', params: { source: 'select_or_create' } }),
      ctx(),
    );

    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('SERVICE_ERROR');
    // The id exists on the service now; losing it here is what creates a second project.
    expect(result.result?.project_id).toBe('proj_new');
  });

  test('env_header adopts the project the .env header names', async () => {
    writeFileSync(
      join(dir, '.env'),
      '# capy:org_id=org_1\n# capy:project_id=proj_1\n# capy:branch=development\nFOO=capy:r:ct\n',
    );
    const result = await EXECUTORS.write_keep_lock(step({ verb: 'write_keep_lock', params: { source: 'env_header' } }), ctx());
    expect(bootstrapProjectForFlow).toHaveBeenCalledTimes(1);
    expect(result.result).toEqual({ org_id: 'org_1', project_id: 'proj_1', branch: 'development' });
  });

  test('reports WHY a silent auth failed rather than a bare failure', async () => {
    writeFileSync(join(dir, '.env'), '# capy:org_id=org_1\n# capy:project_id=proj_1\nFOO=capy:r:ct\n');
    authenticateSilent.mockResolvedValue({ success: false, error_code: 'network' });
    const result = await EXECUTORS.write_keep_lock(step({ verb: 'write_keep_lock', params: { source: 'env_header' } }), ctx());
    expect(result.code).toBe(ERROR_CODES.NETWORK_ERROR);
  });

  test('an unimplemented source is refused, never guessed at', async () => {
    const result = await EXECUTORS.write_keep_lock(step({ verb: 'write_keep_lock', params: { source: 'from_the_future' } }), ctx());
    expect(result.outcome).toBe('failed');
    expect(result.code).toBe(ERROR_CODES.INVALID_FORMAT);
    expect(initializeProjectForFlow).not.toHaveBeenCalled();
    expect(bootstrapProjectForFlow).not.toHaveBeenCalled();
  });
});

describe('wrap_run_commands — consent is for the plan that was shown', () => {
  test('refuses to apply when the plan has changed since approval', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    const result = await EXECUTORS.wrap_run_commands(
      step({ verb: 'wrap_run_commands', params: { plan_hash: 'approved-something-else', kinds: ['run-wrap'] } }),
      ctx(),
    );
    expect(result.outcome).toBe('failed');
    expect(result.code).toBe(ERROR_CODES.PLAN_CHANGED);
    // Nothing is written under an approval that was for different edits.
    expect(applyPlan).not.toHaveBeenCalled();
  });

  test('applies when the hash matches what was approved', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    const { buildPlan } = require('../../src/flows/onboard/plan') as typeof import('../../src/flows/onboard/plan');
    const hash = buildPlan({ targetDir: dir }).planHash;

    const result = await EXECUTORS.wrap_run_commands(
      step({ verb: 'wrap_run_commands', params: { plan_hash: hash, kinds: ['run-wrap'] } }),
      ctx(),
    );
    expect(result.outcome).toBe('ok');
    expect(applyPlan).toHaveBeenCalledTimes(1);
  });
});

describe('encrypt_env — a failure is reported, never fatal', () => {
  test('uses the throwing entry point, not the one that exits the process', async () => {
    writeFileSync(join(dir, 'keep.lock'), '{}');
    await EXECUTORS.encrypt_env(step({ verb: 'encrypt_env', params: { branch: 'development', variable_count: 1 } }), ctx());
    expect(syncForFlow).toHaveBeenCalledTimes(1);
    // `execute()` ends in displayErrorAndExit → process.exit, which would kill
    // the driver instead of returning an outcome.
    expect(execute).not.toHaveBeenCalled();
  });

  test('returns a failed outcome with the code rather than throwing out', async () => {
    writeFileSync(join(dir, 'keep.lock'), '{}');
    syncForFlow.mockRejectedValue(new CapyError('push failed', ERROR_CODES.NETWORK_ERROR));
    const result = await EXECUTORS.encrypt_env(
      step({ verb: 'encrypt_env', params: { branch: 'development', variable_count: 1 } }),
      ctx(),
    );
    expect(result).toMatchObject({ outcome: 'failed', code: ERROR_CODES.NETWORK_ERROR });
  });

  test('refuses when there is no keep.lock to sync against', async () => {
    const result = await EXECUTORS.encrypt_env(
      step({ verb: 'encrypt_env', params: { branch: 'development', variable_count: 0 } }),
      ctx(),
    );
    expect(result.code).toBe(ERROR_CODES.NO_KEEP_FILE);
    expect(syncForFlow).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// `--json` is the mode an agent drives, and an agent has no terminal. Nothing
// in it may reach for a prompt: a run that blocks on inquirer with nobody there
// hangs until the caller's timeout, which looks exactly like a hung service.
// ---------------------------------------------------------------------------
describe('capy onboard --json --web never prompts', () => {
  test('reaches a stopping step and touches no prompt module', async () => {
    const prompt = jest.fn(async () => {
      throw new Error('inquirer must not be reached in --json mode');
    });
    mock.module('inquirer', () => ({ default: { prompt }, prompt }));

    const confirmStep = {
      contract_version: '1',
      flow_id: 'f-1',
      flow_type: 'onboard',
      step_id: 's-1',
      kind: 'confirm',
      dialog: 'onboard_plan',
      resumed: false,
      params: { plan_hash: 'h', target_dir: dir },
    };
    mock.module('../../src/flows/client', () => ({
      // driver.ts re-exports this; the module shape has to stay complete.
      FlowHttpError: class extends Error {},
      FlowClient: class {
        async create() {
          return {
            flow_id: 'f-1',
            flow_type: 'onboard',
            contract_version: '1',
            binding: 'anonymous',
            flow_secret: 's',
            step: null,
          };
        }
        async next() {
          return { step: confirmStep };
        }
        async confirm() {
          return { recorded: true };
        }
        async cancel() {}
      },
    }));

    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.join(' '));
    };
    try {
      const { runOnboardCommand } = await import('../../src/commands/onboardCommand');
      await runOnboardCommand({ json: true, web: true, targetDir: dir });
    } finally {
      console.log = originalLog;
    }

    expect(prompt).not.toHaveBeenCalled();
    const out = JSON.parse(logged.join('\n'));
    expect(out.step.kind).toBe('confirm');
    expect(out.flow_id).toBe('f-1');
  });
});

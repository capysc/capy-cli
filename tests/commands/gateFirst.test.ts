/**
 * Every command that writes from a folder runs bare `capy` as its VERY FIRST step (src/sync/gate.ts;
 * docs/conflict-resolution.md): before any prompt, preflight, plan or confirm screen, with nothing letting it be
 * skipped; and when the person cancels (or chooses "Continue working") the command writes nothing and ends, exit 0.
 *
 * The vehicle: each command's REAL `execute` over a throwaway project directory, with the gate replaced by a recorder and
 * everything the command could do next (an inquirer prompt, `resolveContext`, a deploy adapter's preflight, the deploy
 * confirm screen, the edit screen) replaced by a recorder too. One shared, ordered log of those events is the assertion:
 *   - run to the first thing after the gate: the log STARTS with `gate`;
 *   - cancelled: the log IS `['gate']` and the exit code is 0, so no prompt, no context, no preflight, no upload.
 *
 * `mock.module()` is process-wide: this file runs isolated (tests/run-tests.sh).
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realGate from '../../src/sync/gate';
import * as realShared from '../../src/commands/connectors/shared';
import * as realRegistry from '../../src/deploy/registry';
import * as realPipedValue from '../../src/commands/pipedValue';

/** The ordered log of what happened. A `mock`, so the log itself is never mutated by the test. */
const event = mock((_name: string) => undefined);
const events = (): readonly string[] => event.mock.calls.map((c) => String(c[0]));

/** What the gate answers this time: `in-sync` (go on) or `stopped` (the person cancelled). */
const verdict = mock((): 'in-sync' | 'stopped' => 'in-sync');

mock.module('../../src/sync/gate', () => ({
  ...realGate,
  gateFirst: async () => {
    event('gate');
    if (verdict() === 'stopped') realGate.stopWithNothingWritten();
  },
  ensureInSync: async () => {
    event('gate');
    return verdict();
  },
}));

/** Ends the command at the first thing after the gate, so nothing real runs. */
class Halt extends Error {}

mock.module('../../src/commands/connectors/shared', () => ({
  ...realShared,
  resolveContext: async () => {
    event('resolveContext');
    throw new Halt('resolveContext');
  },
}));
// A command that gets past the gate and wants to sign in on its own is as far as these runs go.
mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    constructor() {
      event('auth');
      throw new Halt('auth');
    }
  },
  silentAuthFailureMessage: () => 'no session',
}));
mock.module('inquirer', () => ({
  default: {
    prompt: async () => {
      event('prompt');
      throw new Halt('prompt');
    },
    Separator: class {},
  },
}));
mock.module('../../src/commands/pipedValue', () => ({
  ...realPipedValue,
  readPipedValue: async () => ({ ok: true, value: 'a-value' }),
}));
mock.module('../../src/ui/keypressConfirm', () => ({
  keypressConfirm: async () => {
    event('confirm');
    return 'cancel';
  },
}));
const fakeAdapter = {
  id: 'fake',
  kind: 'fake',
  label: 'Fake',
  requires: { binaries: [] },
  async preflight() {
    event('preflight');
    return { ok: true as const };
  },
  async deploy() {
    event('adapter.deploy');
    return { ok: true as const, steps: [] };
  },
  async detect() {
    return {};
  },
  async prompt() {
    event('adapter.prompt');
    return {};
  },
};
mock.module('../../src/deploy/registry', () => ({
  ...realRegistry,
  getAdapter: (kind: string) => (kind === 'fake' ? fakeAdapter : realRegistry.getAdapter(kind)),
}));
// The edit screen is the TUI: it must not open before the gate (or at all in these runs).
mock.module('../../src/ui/editScreen', () => ({
  ...require('../../src/ui/editScreen'),
  EditScreen: class {
    async run() {
      event('screen');
      throw new Halt('screen');
    }
  },
}));

import { AddCommand } from '../../src/commands/addCommand';
import { ConnectCommand } from '../../src/commands/connectCommand';
import { EditCommand } from '../../src/commands/editCommand';
import { PushCommand } from '../../src/commands/pushCommand';
import { RemoveCommand } from '../../src/commands/removeCommand';
import { RotateCommand } from '../../src/commands/rotateCommand';
import { deployCommand, deployRemove } from '../../src/commands/deployCommand';
import { DeployCommand, DeployRevokeCommand } from '../../src/commands/deployTokenCommand';
import { routeDeployDiscover } from '../../src/commands/deployDiscover/route';

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

const ORIGINAL_CWD = process.cwd();
const dirs = mock((_: string) => undefined);

/** A project folder: keep.lock with X on `development`, `.capy/branch`, a deploy target `t` of the recorded adapter. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'capy-gate-first-'));
  dirs(dir);
  mkdirSync(join(dir, '.capy'), { recursive: true });
  writeFileSync(join(dir, '.capy', 'branch'), 'development');
  writeFileSync(
    join(dir, 'keep.lock'),
    JSON.stringify({
      version: '3.0',
      org_id: 'org',
      project_id: 'proj',
      project_name: 'demo',
      variables: { X: [{ resource_id: 'r-x', branch: 'development', value_hash: 'aaaaaaaaaaaaaaaa' }] },
    }),
  );
  writeFileSync(
    join(dir, '.capy', 'deploy.json'),
    JSON.stringify({ version: '1', targets: { t: { name: 't', kind: 'fake', branch: 'development', vars: ['X'], options: {} } } }),
  );
  process.chdir(dir);
  return dir;
}

beforeEach(() => {
  event.mockClear();
  verdict.mockReset();
  verdict.mockImplementation(() => 'in-sync');
});
afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  dirs.mock.calls.forEach(([dir]) => rmSync(dir, { recursive: true, force: true }));
  dirs.mockClear();
});

/** Runs `fn` with `process.exit` trapped and the terminal quiet; resolves to the exit code if it exited (else undefined). */
async function ran(fn: () => Promise<unknown>, tty: boolean = false): Promise<number | undefined> {
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const isTTY = spyOn(process.stdin, 'isTTY', 'get' as never).mockReturnValue(tty as never);
  try {
    await fn();
    return undefined;
  } catch (thrown) {
    if (thrown instanceof ExitSignal) return thrown.code;
    if (thrown instanceof Halt) return undefined;
    throw thrown;
  } finally {
    exit.mockRestore();
    log.mockRestore();
    err.mockRestore();
    isTTY.mockRestore();
  }
}

/** Each folder write command, driven to the first thing it would do after the gate. `tty`: the terminal path of that command. */
const COMMANDS: ReadonlyArray<readonly [string, () => Promise<unknown>, boolean]> = [
  ['capy edit (the TUI)', () => new EditCommand().execute({}), true],
  ['capy edit NAME (piped)', () => new EditCommand().execute({ name: 'X', json: true }), false],
  ['capy add NAME (piped)', () => new AddCommand().execute(['X'], { json: true, force: true }), false],
  ['capy add NAME (the terminal prompts)', () => new AddCommand().execute(['X'], {}), true],
  ['capy remove NAME (its confirmation is a prompt)', () => new RemoveCommand().execute(['X'], {}), true],
  ['capy remove NAME --yes', () => new RemoveCommand().execute(['X'], { yes: true, json: true }), false],
  ['capy connect stripe', () => new ConnectCommand().execute('stripe', { nonTty: true, json: true }), false],
  ['capy rotate NAME', () => new RotateCommand().execute('X', { nonTty: true }), false],
  ['capy push', () => new PushCommand().execute({}), false],
  ['capy deploy t (its preflight and confirm screen)', () => deployCommand('t', {}, process.cwd()), true],
  ['capy deploy t --yes', () => deployCommand('t', { yes: true }, process.cwd()), false],
  // The default `capy deploy` (token + docs): it mints a deploy token from the folder's .env, so it is gated first too.
  ['capy deploy (token + docs, its platform picker is a prompt)', () => new DeployCommand(undefined, false, {}).execute(), true],
  ['capy deploy --platform other --mode token --yes', () => new DeployCommand(undefined, false, { platform: 'other', mode: 'token', yes: true }).execute(), false],
  ['capy deploy revoke ID', () => new DeployRevokeCommand().execute('dep_0123456789ab', { nonTty: true }), false],
  ['capy deploy targets-remove t', () => deployRemove('t', process.cwd(), { nonTty: true }), false],
  ['capy deploy dokploy --discover', () => routeDeployDiscover('dokploy', { discover: true }, false, false), false],
  // Discovery has no conditional skip: the working directory is gated, then each discovered folder is synced before it is written.
  ['capy connect dokploy --discover', () => new ConnectCommand().execute('dokploy', { discover: true, nonTty: true, json: true }), false],
];

describe.each(COMMANDS)('%s', (_name, run, tty) => {
  test('bare capy runs first: before any prompt, context, preflight, adapter, confirm or screen', async () => {
    project();
    await ran(run, tty);
    const log = events();
    expect(log[0]).toBe('gate');
    // The gate is asked once at the start; whatever follows it came after.
    expect(log.filter((e) => e === 'gate').length).toBeGreaterThanOrEqual(1);
  });

  test('cancelled ("Continue working", or q): the command writes nothing and ends, exit 0 - the log is the gate alone', async () => {
    project();
    verdict.mockImplementation(() => 'stopped');
    const code = await ran(run, tty);
    expect(code).toBe(0);
    expect(events()).toEqual(['gate']);
  });
});

describe('what comes after the gate comes after it', () => {
  test('capy edit (the TUI): signing in follows the gate, and the screen opens after both', async () => {
    project();
    await ran(() => new EditCommand().execute({}), true);
    expect(events()).toEqual(['gate', 'auth']);
  });

  test('capy deploy: the preflight and then the confirm screen follow the gate', async () => {
    project();
    await ran(() => deployCommand('t', {}, process.cwd()), true);
    expect(events()).toEqual(['gate', 'preflight', 'confirm']);
  });

  test('capy remove (a terminal): the confirmation prompt follows the gate', async () => {
    project();
    await ran(() => new RemoveCommand().execute(['X'], {}), true);
    expect(events()).toEqual(['gate', 'prompt']);
  });

  test('capy add (a terminal): the context, and with it every prompt for a value, follows the gate', async () => {
    project();
    await ran(() => new AddCommand().execute(['X'], {}), true);
    expect(events()).toEqual(['gate', 'resolveContext']);
  });

  test('capy push: the repo-link context follows the gate', async () => {
    project();
    await ran(() => new PushCommand().execute({}), false);
    expect(events()[0]).toBe('gate');
  });
});

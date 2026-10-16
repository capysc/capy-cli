/**
 * The whole `capy secrets` edit with a conflict (CAP-714): real keystrokes through the driver and the reducer, the real
 * edit actions and engine over the fake service. One of the row's two locations was changed by someone else after the
 * row was listed. Nothing is written until it is decided: local writes it, remote leaves it alone.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { runSecretsScreen } from '../../src/ui/secretsScreenDriver';
import { createEditActionsWith } from '../../src/commands/secretsEditActions';
import { NAME, SENTINEL, fakeGithub, fakeService, indexRows, makeEnv, type Loc } from '../helpers/secretsWorld';

const ESC = '\x1b';
const CTRL_E = '\x05';
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const LISTED: readonly Loc[] = [{ project: 'pA', branch: 'staging' }, { project: 'pC', branch: 'development' }];
const NOW: readonly Loc[] = [{ project: 'pA', branch: 'staging', value: 'moved-by-someone-else-2222' }, { project: 'pC', branch: 'development' }];

async function session(choose: readonly string[]) {
  const service = fakeService({ locs: NOW });
  const env = makeEnv(service, fakeGithub([]));
  const actions = createEditActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [] }) }, 'org1', env);
  const out = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const frames = (): string => strip(out.mock.calls.map((c) => String(c[0])).join('\u0000'));
  const lastFrame = (): string => strip(String(out.mock.calls[out.mock.calls.length - 1]?.[0] ?? ''));
  const done = runSecretsScreen(indexRows(LISTED), async () => ({ ok: false, code: 'NO' }), actions);
  await wait();
  const send = async (key: string) => {
    process.stdin.emit('data', Buffer.from(key));
    await wait();
  };
  // Open the edit dialog on the row, type the value, accept all locations, accept the (empty) repo list: the run starts.
  await send(CTRL_E);
  await send(SENTINEL);
  await send('\r');
  await send('\r');
  await wait(60);
  await send('\r');
  await wait(80);
  const atConflicts = lastFrame();
  const pushedBeforeDeciding = service.pushSecrets.mock.calls.length;
  for (const key of choose) await send(key);
  await wait(80);
  const afterRun = lastFrame();
  // Leave: Esc on the result (or the conflicts step) and Ctrl-C.
  await send(ESC);
  await send('\x03');
  await done;
  const logged = log.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  out.mockRestore();
  log.mockRestore();
  return { service, atConflicts, pushedBeforeDeciding, afterRun, logged, frames: frames() };
}

describe('capy secrets edit, with a location someone else changed', () => {
  test('the conflict is shown and nothing has been written until it is decided', async () => {
    const s = await session([]);
    expect(s.atConflicts).toContain('changed since you looked in 1 location');
    expect(s.atConflicts).toContain('staging');
    expect(s.pushedBeforeDeciding).toBe(0);
    // Cancelled out of the conflicts step: still nothing written.
    expect(s.service.pushSecrets.mock.calls).toHaveLength(0);
    expect(s.frames).not.toContain('moved-by-someone-else-2222');
  });

  test('local: both locations are written, and the confirmation says so', async () => {
    const s = await session(['l', '\r']);
    expect(s.service.pushSecrets.mock.calls.map((c) => c[0]).toSorted()).toEqual(['pA', 'pC']);
    expect(`${s.logged}\n${s.afterRun}`).toContain(NAME);
  });

  test('remote: only the other location is written; the confirmation notes the one that kept its value', async () => {
    const s = await session(['r', '\r']);
    expect(s.service.pushSecrets.mock.calls.map((c) => c[0])).toEqual(['pC']);
    expect(`${s.logged}\n${s.afterRun}`).toContain('Kept the other value in 1 location.');
  });
});

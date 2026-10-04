/**
 * Ctrl+C and Esc work while an edit runs, and the running step shows live
 * progress. Reducer-level (what each key does in each phase) and through the real
 * driver (a run that is stopped part way prints the honest confirmation).
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import {
  SecretsScreenState,
  applyBases,
  applyRepos,
  applyRunProgress,
  handleKey,
  initialSecretsScreenState,
  render,
  tokenizeKeys,
} from '../../src/ui/secretsScreen';
import { runSecretsScreen, type SecretsEditActions } from '../../src/ui/secretsScreenDriver';
import { createEditActionsWith } from '../../src/commands/secretsEditActions';
import { CANCELLED_NOTHING } from '../../src/commands/secretsSetText';
import type { OrgRepoLink, SecretIndexRow } from '../../src/service/serviceClient';
import type { RunProgress } from '../../src/commands/secretsSet';
import { LINKS, NAME, SENTINEL, fakeGithub, fakeService, indexRows, makeEnv, manyLocs, standardRepos } from '../helpers/secretsWorld';

const ESC = '\x1b';
const CTRL_C = '\x03';
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const press = (s: SecretsScreenState, ...keys: readonly string[]): SecretsScreenState => keys.reduce((a, k) => handleKey(a, k).state, s);
const type = (s: SecretsScreenState, text: string): SecretsScreenState => press(s, ...tokenizeKeys(text));
const frame = (s: SecretsScreenState): string => strip(render(s, 100, 30));
const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

const row: SecretIndexRow = {
  name: 'API_KEY',
  value_hash: 'h',
  locations: [
    { project_id: 'p1', project_name: 'web', branch: 'production', protected: false, service: null },
    { project_id: 'p2', project_name: 'api', branch: 'development', protected: false, service: null },
  ],
  users: [],
};
const link = (project_id: string, project_name: string, name: string): OrgRepoLink => ({
  project_id, project_name, host: 'github.com', owner: 'Acme', name, path: '.', github_repo_id: 1, last_seen_at: '',
});
const TABLE_LINKS = [link('p1', 'web', 'web-app'), link('p2', 'api', 'api-server')];
const BASES = { 'github.com/acme/web-app': 'main', 'github.com/acme/api-server': 'trunk' };

const atLocations = (dryRun = false): SecretsScreenState =>
  press(type(press(initialSecretsScreenState([row], dryRun), '\x05'), 'v'), '\r');
/** On the repo table, bases still loading, Enter pressed: the run is waiting for them. */
const waitingForBases = (dryRun = false): SecretsScreenState =>
  handleKey(applyRepos(handleKey(atLocations(dryRun), '\r').state, { ok: true, links: TABLE_LINKS }), '\r').state;
/** The run is going (bases known). */
const running = (): SecretsScreenState =>
  handleKey(applyRepos(handleKey(atLocations(), '\r').state, { ok: true, links: TABLE_LINKS, bases: BASES }), '\r').state;

describe('Ctrl+C / Esc before anything was pushed (waiting for the default branches)', () => {
  test.each([['Ctrl+C', CTRL_C], ['Esc', ESC], ['Esc Esc', `${ESC}${ESC}`]])('%s: straight back to the list with a dim note, nothing changed, the read is cancelled', (_l, key) => {
    const waiting = waitingForBases();
    expect(frame(waiting)).toContain('Reading default branches…');
    const r = handleKey(waiting, key);
    expect(r.effect).toEqual({ type: 'cancelRun', phase: 'planning' });
    expect(r.state.edit).toBeNull();
    expect(r.state.quit).toBe(false);
    expect(r.state.note).toBe(CANCELLED_NOTHING);
    const text = frame(r.state);
    expect(text).toContain('Cancelled. Nothing was changed.');
    expect(text).toContain('API_KEY'); // the list is back
    expect(`${render(r.state, 100, 30)}`).toContain(`${ESC}[90mCancelled. Nothing was changed.${ESC}[0m`); // dim
  });

  test('the note lasts until the next key; the late bases are dropped; no run ever starts', () => {
    const cancelled = handleKey(waitingForBases(), CTRL_C).state;
    expect(applyBases(cancelled, BASES)).toEqual({ state: cancelled, effect: null });
    expect(frame(press(cancelled, 'x'))).not.toContain('Cancelled.');
  });

  test('a dry run is stopped just as immediately', () => {
    const dry = handleKey(waitingForBases(true), CTRL_C);
    expect(dry.state.edit).toBeNull();
    expect(dry.state.note).toBe(CANCELLED_NOTHING);
    // …even after its (read-only) plan started
    const planning = handleKey(applyRepos(handleKey(atLocations(true), '\r').state, { ok: true, links: TABLE_LINKS, bases: BASES }), '\r').state;
    expect(handleKey(planning, ESC).state.edit).toBeNull();
  });

  test('leaving the repo table (Esc) while its bases are loading stops that read; with the bases known it has nothing to stop', () => {
    const table = applyRepos(handleKey(atLocations(), '\r').state, { ok: true, links: TABLE_LINKS });
    expect(handleKey(table, ESC).effect).toEqual({ type: 'cancelRun', phase: 'planning' });
    expect(handleKey(applyBases(table, BASES).state, ESC).effect).toBeNull();
  });
});

describe('progress frames', () => {
  const progress = (p: RunProgress) => (s: SecretsScreenState) => applyRunProgress(s, p);

  test('the running step counts locations as they complete, then PRs, redrawn each time', () => {
    const s0 = running();
    expect(frame(s0)).toContain('Updating API_KEY in 2 locations…'); // before the first report
    const frames = [0, 1, 2].map((n) => frame(progress({ phase: 'pushing', done: n, total: 2 })(s0)));
    expect(frames[0]).toContain('Updating API_KEY… 0 of 2 locations');
    expect(frames[1]).toContain('Updating API_KEY… 1 of 2 locations');
    expect(frames[2]).toContain('Updating API_KEY… 2 of 2 locations');
    const prs = frame(progress({ phase: 'prs', done: 1, inFlight: 4, total: 4 })(s0));
    expect(prs).toContain('Opening pull requests… 1 of 4');
    expect(prs).not.toContain('Updating');
  });

  test('a single location reads "1 location"; the footer offers ctrl+c stop', () => {
    expect(frame(progress({ phase: 'pushing', done: 0, inFlight: 6, total: 1 })(running()))).toContain('0 of 1 location');
    expect(frame(running())).toContain('ctrl+c stop');
  });

  test('progress that arrives after the flow ended is dropped', () => {
    const cancelled = handleKey(waitingForBases(), CTRL_C).state;
    expect(applyRunProgress(cancelled, { phase: 'pushing', done: 1, inFlight: 6, total: 2 })).toEqual(cancelled);
  });
});

describe('Ctrl+C while pushing and while opening PRs', () => {
  test('pushing: asks the push in flight to be the last; the screen says so; nothing quits', () => {
    const pushing = applyRunProgress(running(), { phase: 'pushing', done: 3, inFlight: 6, total: 15 });
    const r = handleKey(pushing, CTRL_C);
    expect(r.effect).toEqual({ type: 'cancelRun', phase: 'pushing' });
    expect(r.state.quit).toBe(false);
    expect(frame(r.state)).toContain('Stopping after the 6 in progress…');
    expect(frame(r.state)).not.toContain('Still waiting');
    expect(frame(r.state)).not.toContain('ctrl+c stop'); // no longer offered once asked
  });

  test('a second Ctrl+C says it is still waiting for the push in flight; it stays running and still does not quit', () => {
    const once = handleKey(applyRunProgress(running(), { phase: 'pushing', done: 3, inFlight: 6, total: 15 }), CTRL_C).state;
    const twice = handleKey(once, CTRL_C);
    expect(twice.effect).toEqual({ type: 'cancelRun', phase: 'pushing' });
    expect(frame(twice.state)).toContain('Stopping after the 6 in progress… Still waiting for the push in flight.');
    expect(twice.state.quit).toBe(false);
    expect(handleKey(twice.state, ESC).state.edit).not.toBeNull();
  });

  test('before any progress report the stop is a stop of the pushes (nothing started yet)', () => {
    expect(handleKey(running(), CTRL_C).effect).toEqual({ type: 'cancelRun', phase: 'pushing' });
  });

  test('with nothing in flight at the moment the line just says it is stopping', () => {
    const idle = applyRunProgress(running(), { phase: 'pushing', done: 3, inFlight: 0, total: 15 });
    expect(frame(handleKey(idle, CTRL_C).state)).toContain('Stopping…');
  });

  test('the number follows the pushes as they finish: 6, then 5 after one completes', () => {
    const six = handleKey(applyRunProgress(running(), { phase: 'pushing', done: 0, inFlight: 6, total: 15 }), CTRL_C).state;
    expect(frame(six)).toContain('Stopping after the 6 in progress…');
    expect(frame(applyRunProgress(six, { phase: 'pushing', done: 1, inFlight: 5, total: 15 }))).toContain('Stopping after the 5 in progress…');
  });

  test('PR phase: stops after the PR call in flight; a stop asked for earlier does not carry into the next phase', () => {
    const stopping = handleKey(applyRunProgress(running(), { phase: 'pushing', done: 5, inFlight: 6, total: 15 }), CTRL_C).state;
    expect(frame(stopping)).toContain('Stopping after the 6 in progress…');
    const prs = applyRunProgress(stopping, { phase: 'prs', done: 0, inFlight: 4, total: 3 });
    expect(frame(prs)).toContain('Opening pull requests… 0 of 3');
    const r = handleKey(prs, CTRL_C);
    expect(r.effect).toEqual({ type: 'cancelRun', phase: 'prs' });
    expect(frame(r.state)).toContain('Stopping after the 4 in progress…');
  });

  test('other keys are ignored while running; Ctrl+C on the list (nothing running) still quits', () => {
    const pushing = applyRunProgress(running(), { phase: 'pushing', done: 1, inFlight: 6, total: 2 });
    expect(press(pushing, 'a', 'x', '\r', ' ').edit).toEqual(pushing.edit);
    expect(handleKey(initialSecretsScreenState([row]), CTRL_C).state.quit).toBe(true);
  });
});

describe('through the real driver: a run stopped part way', () => {
  const TEN = manyLocs(10);
  const rows = indexRows(TEN);

  test('the actions\' own cancel stops after the pushes in flight and the screen prints what happened, with the cancelled list', async () => {
    const deferred = Promise.withResolvers<SecretsEditActions>();
    const base = fakeService({ locs: TEN });
    const pushes = mock((..._a: unknown[]) => undefined);
    const service = {
      ...base,
      pushSecrets: mock(async (...a: Parameters<typeof base.pushSecrets>) => {
        pushes(...a);
        await wait(200); // a push takes a moment; Ctrl+C lands while it is in flight
        return base.pushSecrets(...a);
      }),
    };
    const env = makeEnv(service as never, fakeGithub(standardRepos(TEN)));
    const actions = createEditActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [...LINKS] }) }, 'org1', env);
    deferred.resolve(actions);

    const outSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const done = runSecretsScreen(rows, async () => ({ ok: false, code: 'NO' }), actions);
    await wait();
    // Ctrl+E, value, Enter, Enter (all locations), wait for the table and its bases, Enter (run), 60ms into the 1st push: Ctrl+C, wait, any key.
    const keys: ReadonlyArray<string | number> = ['\x05', SENTINEL, '\r', '\r', 200, '\r', 60, CTRL_C, 900, 'x'];
    await keys.reduce<Promise<void>>(async (prev, k) => {
      await prev;
      if (typeof k === 'number') return wait(k);
      process.stdin.emit('data', Buffer.from(k));
      return wait();
    }, Promise.resolve());
    await done;
    const frames = outSpy.mock.calls.map((c) => strip(String(c[0])));
    const printed = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    [outSpy, logSpy].forEach((s) => s.mockRestore());

    expect(pushes.mock.calls).toHaveLength(6); // the six in flight finished; no other started
    expect(frames.some((f) => f.includes('Stopping after the 6 in progress…'))).toBe(true);
    expect(frames.some((f) => /Updating .*… \d+ of 10 locations/.test(f))).toBe(true); // live progress was drawn
    expect(printed).toContain(`✓ ${NAME} updated in 6 of 10 locations (cancelled).`);
    expect(printed).toContain('Cancelled:');
    expect(printed).not.toContain(SENTINEL);
    expect(frames.join('')).not.toContain(SENTINEL);
  });

  test('Ctrl+C while the default branches are still being read: back to the list at once, zero pushes, then Ctrl+C quits', async () => {
    const service = fakeService();
    const base = fakeGithub(standardRepos());
    const github = {
      ...base,
      getDefaultBranches: mock(
        (_repos: unknown, opts?: { signal?: AbortSignal }) =>
          new Promise((resolve) => opts?.signal?.addEventListener('abort', () => resolve({ ok: false, kind: 'REQUEST_FAILED' }), { once: true })),
      ),
    };
    const actions = createEditActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [...LINKS] }) }, 'org1', makeEnv(service, github as never));
    const outSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const done = runSecretsScreen(rows, async () => ({ ok: false, code: 'NO' }), actions);
    await wait();
    const keys: ReadonlyArray<string | number> = ['\x05', 'v', '\r', '\r', 100, '\r', 50, CTRL_C, 80, CTRL_C];
    await keys.reduce<Promise<void>>(async (prev, k) => {
      await prev;
      if (typeof k === 'number') return wait(k);
      process.stdin.emit('data', Buffer.from(k));
      return wait();
    }, Promise.resolve());
    await done; // the second Ctrl+C quit the list: the screen is not hanging
    const frames = outSpy.mock.calls.map((c) => strip(String(c[0])));
    [outSpy, logSpy].forEach((s) => s.mockRestore());
    expect(frames.some((f) => f.includes('Reading default branches…'))).toBe(true);
    expect(frames.some((f) => f.includes('Cancelled. Nothing was changed.'))).toBe(true);
    expect(service.pushSecrets.mock.calls).toHaveLength(0);
    expect(github.createPull.mock.calls).toHaveLength(0);
  });
});

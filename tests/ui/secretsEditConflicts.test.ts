/**
 * The `capy secrets` edit flow and conflicts (CAP-714), through the screen's own pure reducer: a run that finds
 * locations someone else changed since the row was listed comes back to a `conflicts` step with one line per location;
 * m / t decide each; Enter runs again only once every one is decided, with each decision bound to the fingerprints it
 * was made against; Esc leaves with nothing written. Names and places only on screen, never a value.
 */
import { describe, test, expect } from 'bun:test';
import {
  SecretsScreenState,
  applyRepos,
  applyRunDone,
  handleKey,
  initialSecretsScreenState,
  render,
  tokenizeKeys,
} from '../../src/ui/secretsScreen';
import type { EditFlow, RunRequest } from '../../src/ui/secretsEditFlow';
import type { LocationConflict, SetLocation } from '../../src/commands/secretsSet';
import type { OrgRepoLink, SecretIndexRow } from '../../src/service/serviceClient';
import { ERROR_CODES } from '../../src/types/index';

const ESC = '\x1b';
const DOWN = `${ESC}[B`;
const ENTER = '\r';
const CTRL_E = '\x05';
const VALUE = 'SENTINEL-typed-value-77';
const ROW_HASH = 'rowhash1';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const row: SecretIndexRow = {
  name: 'API_KEY',
  value_hash: ROW_HASH,
  locations: [
    { project_id: 'p1', project_name: 'web', branch: 'production', protected: true, service: null },
    { project_id: 'p2', project_name: 'api', branch: 'development', protected: false, service: null },
  ],
  users: [],
};

const LINKS: readonly OrgRepoLink[] = [];

const press = (state: SecretsScreenState, ...keys: readonly string[]): SecretsScreenState => keys.reduce((s, k) => handleKey(s, k).state, state);
const type = (state: SecretsScreenState, text: string): SecretsScreenState => press(state, ...tokenizeKeys(text));
const frame = (state: SecretsScreenState): string => strip(render(state, 100, 30));
const flowOf = (state: SecretsScreenState): EditFlow => state.edit as EditFlow;

/** Value typed, locations accepted (all), no repos: Enter on the (empty) repo list starts the run. */
const running = (): { state: SecretsScreenState; request: RunRequest } => {
  const atLocations = press(type(press(initialSecretsScreenState([row]), CTRL_E), VALUE), ENTER);
  const loading = handleKey(atLocations, ENTER).state;
  const atRepos = applyRepos(loading, { ok: true, links: LINKS, bases: {} });
  const started = handleKey(atRepos, ENTER);
  const effect = started.effect as { type: 'runSet'; request: RunRequest };
  return { state: started.state, request: effect.request };
};

const loc = (p: 'p1' | 'p2'): SetLocation =>
  p === 'p1'
    ? { project_id: 'p1', project_name: 'web', branch: 'production', protected: true }
    : { project_id: 'p2', project_name: 'api', branch: 'development', protected: false };

const conflict = (p: 'p1' | 'p2', remote: string, changedAt?: string): LocationConflict => ({
  location: loc(p),
  conflict: {
    name: 'API_KEY',
    project: loc(p).project_name,
    branch: loc(p).branch,
    type: 'changed',
    pinned: ROW_HASH,
    local: 'local-fp',
    remote,
  },
  ...(changedAt === undefined ? {} : { changedAt }),
});

const found = (...conflicts: LocationConflict[]) => ({ ok: false as const, code: ERROR_CODES.SECRETS_CONFLICT, conflicts });

describe('a run that finds conflicts', () => {
  test('the run asks for the row\'s fingerprint, so the engine can tell what moved', () => {
    expect(running().request.seen).toBe(ROW_HASH);
  });

  test('comes back to the conflicts step, listing each location by project and branch, before anything is written', () => {
    const { state } = running();
    const shown = applyRunDone(state, found(conflict('p1', 'aaaa'), conflict('p2', 'bbbb')));
    expect(flowOf(shown).step).toBe('conflicts');
    const text = frame(shown);
    expect(text).toContain('API_KEY');
    expect(text).toContain('web production');
    expect(text).toContain('api development');
    expect(text).toContain('changed since you looked in 2 locations');
    expect(text).toContain('l local');
    expect(text).toContain('r remote');
    // Never a value, never a fingerprint.
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain('aaaa');
    expect(text).not.toContain('local-fp');
  });

  test('says when the other value was set, if the service says', () => {
    const shown = applyRunDone(running().state, found(conflict('p1', 'aaaa', new Date(Date.now() - 3 * 3600_000).toISOString())));
    expect(frame(shown)).toContain('changed 3 hours ago');
  });

  test('a failure that is not a conflict is still the plain failure line', () => {
    const shown = applyRunDone(running().state, { ok: false, code: ERROR_CODES.SERVICE_ERROR });
    expect(flowOf(shown).step).toBe('done');
  });
});

describe('deciding', () => {
  const atConflicts = () => applyRunDone(running().state, found(conflict('p1', 'aaaa'), conflict('p2', 'bbbb')));

  test('m and t decide the location under the cursor; ↓ moves; each choice is shown on its line', () => {
    const decided = press(atConflicts(), 'l', DOWN, 'r');
    const lines = frame(decided).split('\n');
    expect(lines.find((l) => l.includes('web production'))).toContain('local');
    expect(lines.find((l) => l.includes('api development'))).toContain('remote');
  });

  test('Enter does nothing until every location is decided, and the footer offers it only then', () => {
    const half = press(atConflicts(), 'l');
    const blocked = handleKey(half, ENTER);
    expect(blocked.effect).toBeNull();
    expect(flowOf(blocked.state).step).toBe('conflicts');
    expect(frame(half)).not.toContain('enter continue');
    expect(frame(press(half, DOWN, 'r'))).toContain('enter continue');
  });

  test('Enter runs again with each decision bound to the fingerprints it was made against', () => {
    const decided = press(atConflicts(), 'l', DOWN, 'r');
    const again = handleKey(decided, ENTER);
    expect(flowOf(again.state).step).toBe('running');
    const effect = again.effect as { type: 'runSet'; request: RunRequest };
    expect(effect.type).toBe('runSet');
    expect(effect.request.decisions).toEqual({
      'p1/production': { choice: 'local', remote: 'aaaa', local: 'local-fp' },
      'p2/development': { choice: 'remote', remote: 'bbbb', local: 'local-fp' },
    });
    // The rest of the request is what was asked the first time.
    expect(effect.request.locations.map((l) => `${l.project_id}/${l.branch}`)).toEqual(['p1/production', 'p2/development']);
    expect(effect.request.value).toBe(VALUE);
  });

  test('Esc leaves with nothing written: no effect, the list is back with the cancelled note', () => {
    const left = handleKey(press(atConflicts(), 'l'), ESC);
    expect(left.effect).toBeNull();
    expect(left.state.edit).toBeNull();
    expect(frame(left.state)).toContain('Cancelled');
  });

  test('Ctrl+C quits the screen from the conflicts step: nothing was running, nothing was written', () => {
    const left = handleKey(atConflicts(), '\x03');
    expect(left.effect).toBeNull();
    expect(left.state.quit).toBe(true);
  });
});

describe('a decision never carries over to a value it was not made against', () => {
  const decidedBoth = () => handleKey(press(applyRunDone(running().state, found(conflict('p1', 'aaaa'), conflict('p2', 'bbbb'))), 'l', DOWN, 'r'), ENTER);

  test('the run comes back with the location moved again: that location is undecided, the unmoved one keeps its answer', () => {
    const { state } = decidedBoth();
    // p1 moved again (cccc), p2 did not.
    const back = applyRunDone(state, found(conflict('p1', 'cccc'), conflict('p2', 'bbbb')));
    expect(flowOf(back).step).toBe('conflicts');
    const lines = frame(back).split('\n');
    expect(lines.find((l) => l.includes('web production'))).not.toMatch(/local|remote/);
    expect(lines.find((l) => l.includes('api development'))).toContain('remote');
    // Not continuable until the moved one is decided again.
    expect(handleKey(back, ENTER).effect).toBeNull();
  });

  test('keeping the other value says so under the result', () => {
    const { state } = decidedBoth();
    const done = applyRunDone(state, {
      ok: true,
      result: { name: 'API_KEY', updated: [{ project: 'web', branch: 'production', protected: true }], unchanged: [], prs: [], no_pr: [], failed: [] },
    });
    expect(frame(done)).toContain('Kept the other value in 1 location.');
  });
});

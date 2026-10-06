/**
 * The repo step draws its table as soon as the Capy repo links arrive, with BASE
 * showing `…`; the default branches are read once, in the background (one batched
 * call), and fill BASE in with a single re-render. Keys work meanwhile, and Enter
 * during the read waits for that same read: no second one.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import {
  SecretsScreenState,
  applyBases,
  applyRepos,
  handleKey,
  initialSecretsScreenState,
  pendingBasesEffect,
  render,
  tokenizeKeys,
} from '../../src/ui/secretsScreen';
import { runSecretsScreen, type SecretsEditActions } from '../../src/ui/secretsScreenDriver';
import type { OrgRepoLink, SecretIndexRow } from '../../src/service/serviceClient';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const press = (s: SecretsScreenState, ...keys: readonly string[]): SecretsScreenState => keys.reduce((a, k) => handleKey(a, k).state, s);
const type = (s: SecretsScreenState, text: string): SecretsScreenState => press(s, ...tokenizeKeys(text));
const frame = (s: SecretsScreenState): string => strip(render(s, 100, 30));
const lineWith = (text: string, needle: string): string => text.split('\n').find((l) => l.includes(needle)) ?? '';
const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

const loc = (project_id: string, project_name: string, branch: string) => ({ project_id, project_name, branch, protected: false, service: null });
const row: SecretIndexRow = {
  name: 'API_KEY',
  value_hash: 'h',
  locations: [loc('p1', 'web', 'production'), loc('p2', 'api', 'development')],
  users: [],
};
const link = (project_id: string, project_name: string, name: string): OrgRepoLink => ({
  project_id,
  project_name,
  host: 'github.com',
  owner: 'Acme',
  name,
  path: '.',
  github_repo_id: 1,
  last_seen_at: '',
});
const LINKS = [link('p1', 'web', 'web-app'), link('p2', 'api', 'api-server')];
const BASES = { 'github.com/acme/web-app': 'main', 'github.com/acme/api-server': 'trunk' };

const atLocations = (): SecretsScreenState => press(type(press(initialSecretsScreenState([row]), '\x05'), 'v'), '\r');
/** The table is up (links arrived), the bases are still being read. */
const loadingBases = (): SecretsScreenState => applyRepos(handleKey(atLocations(), '\r').state, { ok: true, links: LINKS });

describe('the table before the bases resolve', () => {
  test('rows are drawn at once with BASE showing …; the bases read is the next effect, asked for exactly once', () => {
    const s = loadingBases();
    const text = frame(s);
    expect(text).toContain('BASE');
    expect(lineWith(text, 'Acme/web-app')).toMatch(/\(1 change\)\s+…$/);
    expect(lineWith(text, 'Acme/api-server')).toMatch(/\(1 change\)\s+…$/);
    const effect = pendingBasesEffect(s);
    expect(effect).toMatchObject({ type: 'loadBases' });
    expect(effect && effect.type === 'loadBases' && effect.targets.map((t) => t.name)).toEqual(['web-app', 'api-server']);
  });

  test('when they arrive BASE fills in, and nothing asks for them again', () => {
    const filled = applyBases(loadingBases(), BASES);
    expect(filled.effect).toBeNull();
    const text = frame(filled.state);
    expect(lineWith(text, 'Acme/web-app')).toMatch(/\(1 change\)\s+main$/);
    expect(lineWith(text, 'Acme/api-server')).toMatch(/\(1 change\)\s+trunk$/);
    expect(text).not.toContain('…');
    expect(pendingBasesEffect(filled.state)).toBeNull();
  });

  test('a repo the batch could not read shows — once the read is done', () => {
    const text = frame(applyBases(loadingBases(), { 'github.com/acme/web-app': 'main' }).state);
    expect(lineWith(text, 'Acme/api-server')).toMatch(/\s+—$/);
  });

  test('nothing to read (no repos linked): no loading state, no effect', () => {
    const none = applyRepos(handleKey(atLocations(), '\r').state, { ok: true, links: [] });
    expect(pendingBasesEffect(none)).toBeNull();
    expect(frame(none)).toContain('No linked repos.');
  });

  test('keys work while BASE is loading: space, a, i and the filter', () => {
    const s = loadingBases();
    const ticked = (st: SecretsScreenState) => frame(st).split('\n').filter((l) => l.includes('◉')).length;
    expect(ticked(s)).toBe(2);
    expect(ticked(press(s, ' '))).toBe(1);
    expect(ticked(press(s, 'a'))).toBe(0);
    expect(ticked(press(s, ' ', 'i'))).toBe(1);
    expect(frame(type(press(s, '/'), 'api'))).toContain('Acme/api-server');
    expect(frame(type(press(s, '/'), 'api'))).not.toContain('Acme/web-app');
    // still loading after all that
    expect(pendingBasesEffect(press(s, ' '))).toMatchObject({ type: 'loadBases' });
  });

  test('a late result after the flow moved on (Esc back) is dropped', () => {
    const back = press(loadingBases(), '\x1b');
    const dropped = applyBases(back, BASES);
    expect(dropped.effect).toBeNull();
    expect(frame(dropped.state)).toContain('PROTECTED'); // still the location step
  });
});

describe('Enter while the bases are loading', () => {
  test('starts no run yet and no second read; the run starts when THE SAME read arrives, with its bases', () => {
    const pressed = handleKey(loadingBases(), '\r');
    expect(pressed.effect).toBeNull(); // nothing yet: waiting
    expect(frame(pressed.state)).toContain('Reading default branches…');
    expect(pendingBasesEffect(pressed.state)).toBeNull(); // not asked for again
    const arrived = applyBases(pressed.state, BASES);
    expect(arrived.effect).toMatchObject({
      type: 'runSet',
      request: { name: 'API_KEY', value: 'v', bases: BASES },
    });
    // The run it starts carries the chosen repos and locations as usual.
    const request = (arrived.effect as { request: { repos: unknown[]; locations: unknown[] } }).request;
    expect(request.repos).toHaveLength(2);
    expect(request.locations).toHaveLength(2);
    // And it starts exactly once: the screen is now plainly running.
    expect(applyBases(arrived.state, BASES).effect).toBeNull();
  });

  test('with the bases already known Enter runs at once, as before', () => {
    const known = applyBases(loadingBases(), BASES).state;
    expect(handleKey(known, '\r').effect).toMatchObject({ type: 'runSet', request: { bases: BASES } });
  });
});

describe('through the real driver: one read, table first', () => {
  const rows: readonly SecretIndexRow[] = [row];
  const run = mock(async (request: Parameters<SecretsEditActions['run']>[0]): ReturnType<SecretsEditActions['run']> => ({
    ok: true,
    result: { name: request.name, updated: [], unchanged: [], prs: [], no_pr: [], failed: [] },
  }));

  async function drive(loadBases: SecretsEditActions['loadBases'], keys: ReadonlyArray<string | number>) {
    const outSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const actions: SecretsEditActions = { loadRepos: async () => ({ ok: true, links: LINKS }), loadBases, run };
    const done = runSecretsScreen(rows, async () => ({ ok: false, code: 'NO' }), actions);
    await wait();
    await keys.reduce<Promise<void>>(async (prev, k) => {
      await prev;
      if (typeof k === 'number') return wait(k);
      process.stdin.emit('data', Buffer.from(k));
      return wait();
    }, Promise.resolve());
    await done;
    const frames = outSpy.mock.calls.map((c) => strip(String(c[0])));
    [outSpy, logSpy].forEach((s) => s.mockRestore());
    return frames;
  }

  test('the table is drawn with … first and the filled-in table after, with ONE read', async () => {
    const loadBases = mock(async (): Promise<Readonly<Record<string, string>>> => {
      await wait(150);
      return BASES;
    });
    // Ctrl+E, value, Enter, Enter (locations), 40ms: table up (read in flight), 250ms: read done, Ctrl+C.
    const frames = await drive(loadBases, ['\x05', 'v', '\r', '\r', 40, 250, '\x03']);
    const repoFrames = frames.filter((f) => f.includes('REPO') && f.includes('Acme/web-app'));
    expect(repoFrames.length).toBeGreaterThanOrEqual(2);
    expect(lineWith(repoFrames[0], 'Acme/web-app')).toMatch(/…$/); // drawn before the read finished
    expect(lineWith(repoFrames[repoFrames.length - 1], 'Acme/web-app')).toMatch(/main$/); // then filled in
    expect(loadBases.mock.calls).toHaveLength(1);
  });

  test('Enter during the read waits for it: one read, one run, with the bases', async () => {
    run.mockClear();
    const loadBases = mock(async (): Promise<Readonly<Record<string, string>>> => {
      await wait(150);
      return BASES;
    });
    // Ctrl+E, value, Enter, Enter (locations), then Enter AT ONCE on the table (read still in flight), wait, then Esc to leave.
    await drive(loadBases, ['\x05', 'v', '\r', '\r', 30, '\r', 400, '\x1b']);
    expect(loadBases.mock.calls).toHaveLength(1);
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0][0].bases).toEqual(BASES);
  });
});

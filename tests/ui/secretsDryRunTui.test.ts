/**
 * `capy --dry-run secrets` (the TTY flow): the same screen and edit flow, but it
 * only plans. Every screen carries the DRY RUN marker; at the end nothing was
 * pushed, no cache was written, no GitHub write call was made; the plan screen
 * replaces the confirmation; the value is in no output. The service and GitHub
 * are the fakes of tests/helpers/secretsWorld.ts (no network, no gh).
 */
import { describe, test, expect, spyOn } from 'bun:test';
import {
  SecretsScreenState,
  applyBases,
  applyRepos,
  pendingBasesEffect,
  applyRunDone,
  handleKey,
  initialSecretsScreenState,
  render,
  tokenizeKeys,
} from '../../src/ui/secretsScreen';
import { runSecretsScreen } from '../../src/ui/secretsScreenDriver';
import { createEditActionsWith } from '../../src/commands/secretsEditActions';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import {
  LINKS,
  LOCATIONS,
  NAME,
  OLD_VALUE,
  SENTINEL,
  everythingSentTo,
  fakeGithub,
  fakeService,
  indexRows,
  makeEnv,
  standardRepos,
  type Loc,
} from '../helpers/secretsWorld';

const ESC = '\x1b';
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const press = (s: SecretsScreenState, ...keys: readonly string[]): SecretsScreenState => keys.reduce((a, k) => handleKey(a, k).state, s);
const type = (s: SecretsScreenState, text: string): SecretsScreenState => press(s, ...tokenizeKeys(text));
const frame = (s: SecretsScreenState): string => strip(render(s, 100, 30));

const MARKER = 'DRY RUN';

function world(locs: readonly Loc[] = LOCATIONS, gh: ReturnType<typeof standardRepos> = standardRepos(locs)) {
  const service = fakeService({ locs });
  const github = fakeGithub(gh);
  const env = makeEnv(service, github);
  const actions = createEditActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [...LINKS] }) }, 'org1', env, true);
  return { service, github, env, actions };
}

/** Nothing that writes was called: no push, no cache, no GitHub write. */
function expectNoWrites(w: ReturnType<typeof world>): void {
  expect(w.service.pushSecrets.mock.calls).toHaveLength(0);
  expect(w.env.writeCache.mock.calls).toHaveLength(0);
  expect(w.github.createBlob.mock.calls).toHaveLength(0);
  expect(w.github.createTree.mock.calls).toHaveLength(0);
  expect(w.github.createCommit.mock.calls).toHaveLength(0);
  expect(w.github.createRef.mock.calls).toHaveLength(0);
  expect(w.github.createPull.mock.calls).toHaveLength(0);
}

/** The BASE column's read, performed the way the driver does after the table is up. */
async function settle(state: SecretsScreenState, actions: ReturnType<typeof world>['actions']): Promise<SecretsScreenState> {
  const effect = pendingBasesEffect(state);
  return effect !== null && effect.type === 'loadBases' ? applyBases(state, await actions.loadBases(effect.targets)).state : state;
}

/** Walks the whole flow for the first row of `locs`, collecting a frame after each step and performing the effects with the real dry-run actions. */
async function walk(w: ReturnType<typeof world>, locs: readonly Loc[] = LOCATIONS, value = SENTINEL) {
  const s0 = initialSecretsScreenState(indexRows(locs), true);
  const list = frame(s0);
  const valueStep = press(s0, '\x05');
  const typed = type(valueStep, value);
  const locations = press(typed, '\r');
  const loading = handleKey(locations, '\r');
  const loadingFrame = frame(loading.state);
  const shown = applyRepos(loading.state, await w.actions.loadRepos(['pA', 'pB', 'pC', 'pD']));
  const repos = await settle(shown, w.actions);
  const reposFrame = frame(repos);
  const running = handleKey(repos, '\r');
  const runningFrame = frame(running.state);
  const request = (running.effect as { request: Parameters<typeof w.actions.run>[0] }).request;
  const done = applyRunDone(running.state, await w.actions.run(request));
  return {
    frames: { list, value: frame(typed), locations: frame(locations), loading: loadingFrame, repos: reposFrame, running: runningFrame, done: frame(done) },
    left: press(done, ESC),
    request,
  };
}

describe('the marker', () => {
  test('is in the list header and in every step of the edit flow, and absent from a normal run', async () => {
    const w = world();
    const { frames } = await walk(w);
    Object.entries(frames).forEach(([step, text]) => expect({ step, marked: text.includes(MARKER) }).toEqual({ step, marked: true }));
    expect(frame(initialSecretsScreenState(indexRows()))).not.toContain(MARKER);
    expect(frame(press(initialSecretsScreenState(indexRows()), '\x05'))).not.toContain(MARKER);
  });

  test('the running step says it is planning, not updating', async () => {
    const { frames } = await walk(world());
    expect(frames.running).toContain('Planning');
    expect(frames.running).not.toContain('Updating');
  });
});

describe('the walk-through changes nothing', () => {
  test('zero pushes, zero cache writes, zero GitHub write calls; reads did happen', async () => {
    const w = world();
    await walk(w);
    expectNoWrites(w);
    expect(w.service.getDecryptData.mock.calls.length).toBeGreaterThan(0);
    expect(w.github.getDefaultBranches.mock.calls.length).toBeGreaterThan(0);
    expect(w.github.getFile.mock.calls.length).toBeGreaterThan(0);
  });

  test('the plan replaces the approved confirmation: counts and base branches, no URLs', async () => {
    const w = world();
    const { frames, left } = await walk(w);
    expect(frames.done).toContain('Dry run: nothing was changed.');
    expect(frames.done).toContain(`Would update ${NAME} in 5 locations.`);
    expect(frames.done).toContain('Would open pull requests in:');
    expect(frames.done).toContain('Acme/mono (main)');
    expect(frames.done).toContain('Acme/solo (trunk)');
    expect(frames.done).not.toMatch(/https?:\/\//);
    expect(frames.done).not.toContain('Pull requests (merge each');
    expect(frames.done).not.toContain('plan_id');
    expect(left.quit).toBe(true);
    expect(left.exitText).toBe(
      ['Dry run: nothing was changed.', `Would update ${NAME} in 5 locations.`, 'Would open pull requests in:', '  Acme/mono (main)', '  Acme/solo (trunk)'].join('\n'),
    );
  });

  test('locations already holding the value are not counted, and a repo with no changing location is not listed', async () => {
    const locs: readonly Loc[] = LOCATIONS.map((l) => (l.project === 'pC' ? { ...l, value: SENTINEL } : l));
    const w = world(locs);
    // The row of the OLD value: the three old-value locations plus pD. pC is its own row, so build the flow from the old-value row and add pC by hand.
    const { request } = await walk(w, locs);
    const withUnchanged = { ...request, locations: [...request.locations, { project_id: 'pC', project_name: 'solo-server', branch: 'development', protected: false }] };
    const view = await w.actions.run(withUnchanged);
    expect(view.ok && 'plan' in view ? view.plan.updateCount : -1).toBe(request.locations.length);
    expect(view.ok && 'plan' in view ? view.plan.prs.map((p) => p.repo) : []).toEqual(request.repos.filter((t) => t.name !== 'solo').map((t) => `${t.owner}/${t.name}`));
    expectNoWrites(w);
  });

  test('keep.lock differs is shown for a repo whose GitHub keep.lock disagrees with the server', async () => {
    const diverged: readonly Loc[] = LOCATIONS.map((l) => (l.project === 'pC' ? { ...l, githubOtherHash: 'ffffffffffffffff' } : l));
    const w = world(LOCATIONS, standardRepos(diverged));
    const { frames } = await walk(w);
    expect(frames.done).toContain('Acme/solo (trunk)  keep.lock differs');
    expect(frames.done).not.toContain('Acme/mono (main)  keep.lock differs');
    expectNoWrites(w);
  });

  test('with no repo selected the plan has no PR section', async () => {
    const w = world();
    const s = press(type(press(initialSecretsScreenState(indexRows(), true), '\x05'), SENTINEL), '\r');
    const repos = await settle(applyRepos(handleKey(s, '\r').state, await w.actions.loadRepos([])), w.actions);
    const running = handleKey(press(repos, 'a'), '\r');
    const done = applyRunDone(running.state, await w.actions.run((running.effect as { request: never }).request));
    expect(frame(done)).toContain(`Would update ${NAME} in 5 locations.`);
    expect(frame(done)).not.toContain('Would open pull requests in:');
  });

  test('repo links the service does not have (404): the repo step says REPO_LINKS_UNSUPPORTED, and the plan still plans the locations and says why', async () => {
    const w = world();
    const actions = createEditActionsWith(
      { getOrgRepos: async () => { throw new CapyError('x', ERROR_CODES.REPO_LINKS_UNSUPPORTED, { status: 404 }); } },
      'org1',
      w.env,
      true,
    );
    const typed = press(type(press(initialSecretsScreenState(indexRows(), true), '\x05'), SENTINEL), '\r');
    const loading = handleKey(typed, '\r');
    const repos = applyRepos(loading.state, await actions.loadRepos(['pA']));
    expect(frame(repos)).toContain(`Repos unavailable (${ERROR_CODES.REPO_LINKS_UNSUPPORTED})`);
    expect(frame(repos)).toContain(MARKER);
    const running = handleKey(repos, '\r');
    const done = applyRunDone(running.state, await actions.run((running.effect as { request: never }).request));
    expect(frame(done)).toContain(`Would update ${NAME} in 5 locations.`);
    expect(frame(done)).toContain(`Repos unavailable (${ERROR_CODES.REPO_LINKS_UNSUPPORTED}).`);
    expect(frame(done)).not.toContain('Would open pull requests in:');
    expectNoWrites(w);
  });
});

describe('the repo step\'s BASE column', () => {
  test('loadRepos reads no GitHub at all (the table is drawn from the Capy links); loadBases is ONE batched call for every repo', async () => {
    const w = world();
    const loaded = await w.actions.loadRepos(['pA', 'pB', 'pC', 'pD']);
    expect(loaded.ok).toBe(true);
    expect(w.github.getRepo.mock.calls).toHaveLength(0);
    expect(w.github.getDefaultBranches.mock.calls).toHaveLength(0);
    const shown = applyRepos(handleKey(press(type(press(initialSecretsScreenState(indexRows(), true), '\x05'), SENTINEL), '\r'), '\r').state, loaded);
    expect(frame(shown)).toMatch(/Acme\/mono\s+.*\(\d+ changes?\)\s+…/); // up, BASE still loading
    const effect = pendingBasesEffect(shown);
    expect(effect?.type).toBe('loadBases');
    const bases = effect && effect.type === 'loadBases' ? await w.actions.loadBases(effect.targets) : {};
    expect(bases).toEqual({ 'github.com/acme/mono': 'main', 'github.com/acme/solo': 'trunk' });
    expect(w.github.getDefaultBranches.mock.calls).toHaveLength(1); // two repos, one call
    expect(w.github.getRepo.mock.calls).toHaveLength(0);
    expect(frame(applyBases(shown, bases).state)).toMatch(/Acme\/mono\s+.*\(\d+ changes?\)\s+main/);
  });

  test('the walk reads the default branches once; the run (the plan) reuses them', async () => {
    const w = world();
    const { frames } = await walk(w);
    expect(frames.repos).toMatch(/Acme\/mono\s+.*\(\d+ changes?\)\s+main/);
    expect(frames.repos).toMatch(/Acme\/solo\s+.*\(1 change\)\s+trunk/);
    expect(w.github.getDefaultBranches.mock.calls).toHaveLength(1);
    expect(w.github.getRepo.mock.calls).toHaveLength(0);
    expectNoWrites(w);
  });
});

describe('the value never appears', () => {
  test('in any frame, in the plan, in the exit text, or in anything sent to the service or GitHub', async () => {
    const w = world();
    const { frames, left } = await walk(w);
    Object.values(frames).forEach((text) => {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain('SENTINEL');
    });
    expect(left.exitText).not.toContain(SENTINEL);
    const sent = everythingSentTo(w.github.getRepo, w.github.getDefaultBranches, w.github.getFile, w.github.getBranchHead, w.service.getDecryptData, w.service.pushSecrets, w.env.writeCache);
    expect(sent).not.toContain(SENTINEL);
    expect(OLD_VALUE.length).toBeGreaterThan(0);
  });
});

describe('through the real driver', () => {
  test('keystrokes on stdin: the marker is drawn, the plan is printed after the screen is left, nothing is written', async () => {
    const w = world();
    const outSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));
    const done = runSecretsScreen(indexRows(), async () => ({ ok: false, code: 'NO' }), w.actions, true);
    await wait();
    // Ctrl+E, the value as a bracketed paste, Enter, Enter (all locations), wait for repos, Enter (plan), wait, Esc.
    await [`\x05`, `${ESC}[200~${SENTINEL}${ESC}[201~`, '\r', '\r', 40, '\r', 60, ESC].reduce<Promise<void>>(async (prev, k) => {
      await prev;
      if (typeof k === 'number') return wait(k);
      process.stdin.emit('data', Buffer.from(k));
      return wait();
    }, Promise.resolve());
    await done;
    const screen = outSpy.mock.calls.map((c) => String(c[0])).join('');
    const printed = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    outSpy.mockRestore();
    logSpy.mockRestore();
    expect(strip(screen)).toContain(MARKER);
    expect(screen).not.toContain(SENTINEL);
    expect(printed).toContain('Dry run: nothing was changed.');
    expect(printed).toContain(`Would update ${NAME} in 5 locations.`);
    expect(printed).not.toContain(SENTINEL);
    expectNoWrites(w);
  });
});

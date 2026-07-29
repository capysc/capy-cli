/**
 * The parity claim, made checkable.
 *
 * The design contract's §8 says the rail a person reads in the browser and the
 * array a headless caller parses from `--json` are the same object. Until this
 * file that was an aspiration: nothing computed a route, so nothing could be
 * compared, and the fixtures under packages/ui asserted a shape no command
 * produced.
 *
 * These tests pin the shape and — the point of the whole exercise — assert
 * that the two surfaces are fed by ONE builder, by comparing what each would
 * emit for the same run.
 */
import { describe, test, expect } from 'bun:test';
import { branchCreatePlan, unansweredStops } from '../../src/core/branchCreatePlan';
import { renderScreen } from '../../src/ui/screens/serve';

describe('branchCreatePlan', () => {
  test('an unanswered run stands on the first stop', () => {
    const stops = branchCreatePlan({});
    expect(stops.map((s) => s.id)).toEqual(['name', 'protection', 'create']);
    expect(stops[0].state).toBe('current');
    expect(stops[1].state).toBe('upcoming');
    expect(stops[2].state).toBe('upcoming');
    // Nothing was answered, so nothing claims a flag settled it.
    expect(stops.some((s) => s.flag)).toBe(false);
  });

  test('the whole route is declared even when a stop will not be reached', () => {
    // The plan is the plan: a run that stops early still declared three
    // stations, which is what makes "how many questions is this" answerable
    // before the first one.
    expect(branchCreatePlan({}).length).toBe(3);
    expect(branchCreatePlan({ branchName: 'x', isProtected: true }).length).toBe(3);
  });

  test('a name from argv arrives done, and the cursor moves on', () => {
    const stops = branchCreatePlan({ branchName: 'feature/checkout' });
    expect(stops[0]).toMatchObject({ state: 'done', answer: 'feature/checkout' });
    // Marked as settled before anything opened, so "why was I never asked?"
    // has an answer on the rail itself.
    expect(stops[0].flag).toBe('argument');
    expect(stops[1].state).toBe('current');
  });

  test('a flag-answered stop is done and marked, never skipped', () => {
    const stops = branchCreatePlan({ branchName: 'x', isProtected: true });
    expect(stops[1]).toMatchObject({ state: 'done', answer: 'protected', flag: '--protected' });
    // Skipped would say the plan dropped it. A flag resolved it.
    expect(stops.some((s) => s.state === 'skipped')).toBe(false);
  });

  test('--no-protected is an answer, not an absence', () => {
    const stops = branchCreatePlan({ branchName: 'x', isProtected: false });
    expect(stops[1]).toMatchObject({ state: 'done', answer: 'open', flag: '--no-protected' });
  });

  test('a whitespace-only name is not a name', () => {
    const stops = branchCreatePlan({ branchName: '   ' });
    expect(stops[0].state).toBe('current');
    expect(stops[0].answer).toBeUndefined();
  });

  test('unansweredStops is what a headless run would have to refuse over', () => {
    expect(unansweredStops(branchCreatePlan({}))).toEqual(['name', 'protection']);
    expect(unansweredStops(branchCreatePlan({ branchName: 'x' }))).toEqual(['protection']);
    // Fully specified: nothing left to ask, so a headless run can proceed.
    expect(unansweredStops(branchCreatePlan({ branchName: 'x', isProtected: false }))).toEqual([]);
  });

  test('§8 parity: the browser payload and --json carry the same array', () => {
    // The claim this whole file exists to make checkable. Both surfaces are
    // built from one call, so they cannot describe different routes.
    const input = { branchName: 'feature/checkout' };
    const stops = branchCreatePlan(input);

    const jsonSurface = JSON.parse(JSON.stringify({ stops }));

    const html = renderScreen('branch-create', {
      nonce: 'test-nonce',
      projectName: 'mikes-market',
      stops,
      existingBranches: [],
      name: input.branchName,
    } as never);

    // The payload the browser receives is inlined into the page verbatim, so
    // the array can be read back out of the served HTML and compared.
    const match = html.match(/window\.__CAPY_DATA__ = (\{.*?\});/s);
    expect(match).not.toBeNull();
    const browserSurface = JSON.parse(match![1].replace(/\\u003c/g, '<'));

    expect(browserSurface.stops).toEqual(jsonSurface.stops);
  });

  test('§8 parity holds for a run where flags settled everything', () => {
    const stops = branchCreatePlan({ branchName: 'hotfix', isProtected: true });
    const html = renderScreen('branch-create', {
      nonce: 'n',
      projectName: 'p',
      stops,
      existingBranches: [],
      name: 'hotfix',
    } as never);
    const match = html.match(/window\.__CAPY_DATA__ = (\{.*?\});/s);
    const browserStops = JSON.parse(match![1].replace(/\\u003c/g, '<')).stops;

    expect(browserStops).toEqual(JSON.parse(JSON.stringify(stops)));
    // And the markers survive the round trip — they are the part a rail needs
    // to explain itself, and the easiest thing to lose in a serialization.
    expect(browserStops[1].flag).toBe('--protected');
    expect(browserStops[1].answer).toBe('protected');
  });

  test('every stop carries the detail the screens used to invent', () => {
    // These strings lived in a lookup table inside Screen.svelte, keyed by stop
    // id, which meant the browser drew a route the CLI had never described.
    for (const stop of branchCreatePlan({})) {
      expect(typeof stop.detail).toBe('string');
      expect(stop.detail!.length).toBeGreaterThan(0);
    }
  });
});

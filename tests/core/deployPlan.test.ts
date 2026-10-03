/**
 * The deploy route, made checkable.
 *
 * `capy deploy --json` emits this route. These tests pin its shape: the whole
 * route is declared, and each stop says what settled it.
 */
import { describe, test, expect } from 'bun:test';
import { deployPlan, unansweredDeployStops } from '../../src/core/deployPlan';

const ROUTE = [
  'platform',
  'mode',
  'signin',
  'branch',
  'settings',
  'variables',
  'delivery',
  'name',
  'review',
  'deploy',
];

describe('deployPlan', () => {
  test('declares the whole ten-stop route before anything is answered', () => {
    const stops = deployPlan({ at: 'platform' });
    expect(stops.map((s) => s.id)).toEqual(ROUTE);
    expect(stops[0].state).toBe('current');
    // Everything after the traveller is ahead of them, not absent.
    expect(stops.slice(1).every((s) => s.state === 'upcoming')).toBe(true);
  });

  test('the route is the same length however much a run answers', () => {
    // The plan is the plan: a run that skips five stations still declared ten,
    // which is what makes "how many questions is this" answerable up front.
    expect(deployPlan({}).length).toBe(10);
    expect(
      deployPlan({
        at: 'review',
        answers: { platform: 'Vercel', branch: 'production', name: 'vercel-prod' },
        skipped: ['mode', 'settings'],
      }).length,
    ).toBe(10);
  });

  test('a stop this run cannot reach is skipped, not dropped', () => {
    // The terminal skips the mode question for twenty-six of the thirty-one
    // platforms and says nothing, so the flow just gets shorter.
    const stops = deployPlan({ at: 'platform', skipped: ['mode'] });
    expect(stops.find((s) => s.id === 'mode')!.state).toBe('skipped');
    expect(stops).toHaveLength(10);
  });

  test('an answered stop carries what answered it', () => {
    const stops = deployPlan({
      at: 'branch',
      answers: { platform: 'Cloudflare Workers' },
    });
    expect(stops[0]).toMatchObject({ state: 'done', answer: 'Cloudflare Workers' });
    expect(stops.find((s) => s.id === 'branch')!.state).toBe('current');
  });

  test('a skipped stop stays skipped even if something answered it', () => {
    // Skipping is the stronger claim: it says the question did not happen.
    const stops = deployPlan({ answers: { mode: 'Connector' }, skipped: ['mode'] });
    expect(stops.find((s) => s.id === 'mode')!.state).toBe('skipped');
  });

  test('sign-in is drawn as a stop the user performs by hand', () => {
    // A vendor login happens in a terminal Capy does not drive, so the track
    // either side of it is broken and the stop is badged. A screen inventing
    // that would change the route a human reads and not the one an agent
    // parses, which is the parity claim being quietly false.
    const signin = deployPlan({}).find((s) => s.id === 'signin')!;
    expect(signin.manual).toBe(true);
    expect(deployPlan({}).filter((s) => s.manual).length).toBe(1);
  });

  test('a dry run marks the terminus blank, not upcoming', () => {
    // ◌ rather than ○: under --dry-run nothing is decrypted and nothing is
    // pushed, so the last station is unreachable by construction.
    const dry = deployPlan({ at: 'review', dryRun: true });
    expect(dry.find((s) => s.id === 'deploy')!.blank).toBe(true);
    expect(deployPlan({ at: 'review' }).find((s) => s.id === 'deploy')!.blank).toBeUndefined();
    // And only the terminus: a blank anywhere else would be a glyph nobody
    // planned.
    expect(dry.filter((s) => s.blank).length).toBe(1);
  });

  test('every stop carries the detail the three screens used to invent', () => {
    for (const stop of deployPlan({})) {
      expect(typeof stop.detail).toBe('string');
      expect(stop.detail!.length).toBeGreaterThan(0);
    }
  });

  test('unansweredDeployStops is what a headless run would refuse over', () => {
    expect(unansweredDeployStops(deployPlan({ at: 'platform' }))).toEqual(
      ROUTE.filter((id) => id !== 'deploy'),
    );
    const settled = deployPlan({
      at: 'review',
      answers: {
        platform: 'Vercel',
        signin: 'vercel link',
        branch: 'production',
        settings: 'web · preview',
        variables: '12 variables',
        delivery: 'CI',
        name: 'vercel-prod',
      },
      skipped: ['mode'],
    });
    // Only the gate is left, which is the one thing --yes answers.
    expect(unansweredDeployStops(settled)).toEqual(['review']);
  });
});

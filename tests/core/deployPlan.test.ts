/**
 * The deploy route, made checkable.
 *
 * `capy deploy` draws its rail on three screens, and until this file each of
 * them carried its own copy of the station list in a lookup table inside its
 * Screen.svelte. Three copies of one route is three chances for the rail to say
 * something different depending on which page you happen to be standing on —
 * and none of the three was the CLI's, which is the surface that decides how
 * many questions there are.
 *
 * These tests pin the route and — the point of the exercise — assert that the
 * browser payload and a headless caller are fed by ONE builder, by comparing
 * what each emits for the same run.
 */
import { describe, test, expect } from 'bun:test';
import { deployPlan, unansweredDeployStops, SIGNIN_COMMAND } from '../../src/core/deployPlan';
import { renderScreen } from '../../src/ui/screens/serve';

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

  test('§8 parity: the browser payload and a headless caller carry one array', () => {
    const stops = deployPlan({
      at: 'review',
      answers: { platform: 'Vercel', branch: 'production', name: 'vercel-prod' },
      skipped: ['mode'],
      dryRun: true,
    });
    const jsonSurface = JSON.parse(JSON.stringify({ stops }));

    const html = renderScreen('deploy-plan-confirm', {
      nonce: 'test-nonce',
      stops,
      target: {
        name: 'vercel-prod',
        adapterId: 'vercel',
        adapterLabel: 'Vercel',
        branch: 'production',
        mode: 'ci',
        options: [],
        vars: ['DATABASE_URL'],
        saved: true,
      },
      action: 'ci',
      dryRun: true,
      preflight: [],
    } as never);

    // The payload is inlined into the page verbatim, so the array can be read
    // back out of the served HTML and compared.
    const match = html.match(/window\.__CAPY_DATA__ = (\{.*?\});/s);
    expect(match).not.toBeNull();
    const browserSurface = JSON.parse(match![1].replace(/\\u003c/g, '<'));
    expect(browserSurface.stops).toEqual(jsonSurface.stops);
    // And the modifiers survive the round trip — they are the part a rail
    // needs to explain itself, and the easiest thing to lose in a serialize.
    expect(browserSurface.stops.find((s: any) => s.id === 'signin').manual).toBe(true);
    expect(browserSurface.stops.find((s: any) => s.id === 'deploy').blank).toBe(true);
    expect(browserSurface.stops.find((s: any) => s.id === 'mode').state).toBe('skipped');
  });

  test('the manual sign-in command is known for every shipped adapter', () => {
    for (const id of ['cf-worker', 'cf-pages', 'vercel', 'aws-ssm']) {
      expect(typeof SIGNIN_COMMAND[id]).toBe('string');
    }
  });
});

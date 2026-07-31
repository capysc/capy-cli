/**
 * The parity claim for `capy invite`, made checkable.
 *
 * §8 says the rail a person reads in the browser and the array a headless
 * caller parses from `--json` are the same object. These tests pin the shape
 * and — the point of the exercise — assert the two surfaces are fed by ONE
 * builder, by comparing what each emits for the same run.
 *
 * The expiry stop gets the most attention here because it is the one station
 * with no terminal counterpart: `resolveNotAfter` reads four sources in order
 * and never asks, so on a terminal run the rail's job is to say which of the
 * four decided. Getting that wrong would put "you chose this" next to a
 * lifetime an environment variable chose.
 */
import { describe, test, expect } from 'bun:test';
import {
  invitePlan,
  unansweredInviteStops,
  roleNeedsProjects,
  grantedProjects,
  parseTtl,
  formatTtl,
  formatRelativeFuture,
} from '../../src/core/invitePlan';
import { renderScreen } from '../../src/ui/screens/serve';

/** A terminal run: nothing settled by argv, and nowhere to ask about expiry. */
const TTY = { defaultTtl: '7d', canAskExpiry: false };
/** A `--web` run: the expiry stop becomes a question. */
const WEB = { defaultTtl: '7d', canAskExpiry: true };

describe('invitePlan', () => {
  test('an unanswered run stands on the first stop and declares all four', () => {
    const stops = invitePlan(WEB);
    expect(stops.map((s) => s.id)).toEqual(['role', 'projects', 'expiry', 'code']);
    expect(stops[0].state).toBe('current');
    expect(stops[1].state).toBe('upcoming');
    expect(stops[2].state).toBe('upcoming');
    expect(stops[3].state).toBe('upcoming');
  });

  test('the whole route is declared even when a stop will not be reached', () => {
    // A run that skips projects still declared four stations, which is what
    // makes "how many questions is this" answerable before the first one.
    expect(invitePlan(WEB).length).toBe(4);
    expect(invitePlan({ ...WEB, role: { value: 'admin', flag: '--role admin' } }).length).toBe(4);
  });

  test('--role settles the stop, marked with the flag that settled it', () => {
    const stops = invitePlan({ ...WEB, role: { value: 'admin', flag: '--role admin' } });
    expect(stops[0]).toMatchObject({ state: 'done', answer: 'admin', flag: '--role admin' });
  });

  test('an org-wide role skips the project stop rather than dropping it', () => {
    // `admin` reaches every project, so the run never visits that station —
    // and the rail says so up front instead of the stop silently vanishing.
    const stops = invitePlan({ ...WEB, role: { value: 'admin', flag: '--role admin' } });
    expect(stops[1].state).toBe('skipped');
    expect(stops[1].detail).toContain('every project');
    // The traveller moves past it to the next real question.
    expect(stops[2].state).toBe('current');
  });

  test('a scoped role keeps its project stop', () => {
    for (const role of ['member', 'project-admin']) {
      const stops = invitePlan({ ...WEB, role: { value: role, flag: `--role ${role}` } });
      expect(stops[1].state).toBe('current');
      expect(roleNeedsProjects(role)).toBe(true);
    }
    expect(roleNeedsProjects('admin')).toBe(false);
  });

  test('an inherited membership is a source, and says so', () => {
    // A re-issue answers two stops before the command starts. Without the
    // marker, `Role member` on a re-issue is indistinguishable from an answer
    // the user gave two seconds ago.
    const stops = invitePlan({
      ...WEB,
      role: { value: 'member', flag: 'existing membership' },
      projects: { names: ['storefront'], flag: 'existing membership' },
    });
    expect(stops[0]).toMatchObject({ state: 'done', flag: 'existing membership' });
    expect(stops[1]).toMatchObject({ state: 'done', answer: 'storefront', flag: 'existing membership' });
  });

  test('an answer the browser gave carries no flag', () => {
    // Nobody has to be told why they were not asked a question they just
    // answered — and claiming `--role` settled it would be a lie about a run.
    const stops = invitePlan({ ...WEB, role: { value: 'member' } });
    expect(stops[0]).toMatchObject({ state: 'done', answer: 'member' });
    expect(stops[0].flag).toBeUndefined();
  });

  test('a terminal run has its expiry settled before it starts', () => {
    // The whole reason this stop exists. `resolveNotAfter` never prompts, so
    // on a TTY the question is already answered — by the 7-day default here.
    const stops = invitePlan(TTY);
    expect(stops[2]).toMatchObject({ state: 'done', answer: '7d', flag: 'default' });
    expect(unansweredInviteStops(stops)).toEqual(['role', 'projects']);
  });

  test('the environment variable that shortens an invite is named on the rail', () => {
    // CAPY_INVITE_TTL_SECONDS is honoured in silence today, so "why does this
    // invite last an hour" cannot be answered from the terminal at all.
    const stops = invitePlan({ ...TTY, envTtl: '1h', defaultTtl: '1h' });
    expect(stops[2]).toMatchObject({ state: 'done', answer: '1h', flag: 'CAPY_INVITE_TTL_SECONDS' });
  });

  test('--expires outranks --ttl, the way resolveNotAfter reads them', () => {
    const stops = invitePlan({
      ...WEB,
      expiry: { value: '2026-08-01T00:00:00Z', flag: '--expires 2026-08-01T00:00:00Z' },
    });
    expect(stops[2]).toMatchObject({ state: 'done', flag: '--expires 2026-08-01T00:00:00Z' });
  });

  test('only --web makes expiry a question', () => {
    expect(unansweredInviteStops(invitePlan(WEB))).toEqual(['role', 'projects', 'expiry']);
    expect(unansweredInviteStops(invitePlan(TTY))).toEqual(['role', 'projects']);
  });

  test('unansweredInviteStops is what decides whether a browser opens at all', () => {
    // Fully specified: nothing left to ask, so `--web` asks nothing.
    const settled = invitePlan({
      ...WEB,
      role: { value: 'admin', flag: '--role admin' },
      expiry: { value: '7d', flag: '--ttl 7d' },
    });
    expect(unansweredInviteStops(settled)).toEqual([]);
    // …and the run is then standing on the code, which is the only stop left.
    expect(settled[3].state).toBe('current');
  });

  test('a skipped stop is settled, not outstanding', () => {
    const stops = invitePlan({ ...WEB, role: { value: 'admin' }, expiry: { value: '7d' } });
    expect(stops[1].state).toBe('skipped');
    expect(unansweredInviteStops(stops)).toEqual([]);
  });

  test('every stop carries a detail, in the CLI\'s own words', () => {
    // These strings used to live in a lookup table inside the screen, keyed by
    // stop id, which meant the browser drew a route the CLI never described.
    for (const stop of invitePlan(WEB)) {
      expect(typeof stop.detail).toBe('string');
      expect(stop.detail!.length).toBeGreaterThan(0);
    }
    const stops = invitePlan(WEB);
    // Lifted verbatim from `--role` / `--project` / `--ttl`'s own help text.
    expect(stops[0].detail).toBe('invitee role: member | project-admin | admin');
    expect(stops[1].detail).toBe('grant project access');
    expect(stops[2].detail).toBe('invite lifetime, e.g. 30m, 24h, 7d');
  });

  test('a stop only names what the run actually got, and says what it did not', () => {
    // The fan-out assigns one project at a time and can fail one at a time. A
    // stop is a claim about what this run DID, so a project the service refused
    // cannot appear in `answer` — and dropping it silently would hide the
    // failure rather than report it, which is what `note` is for.
    const stops = invitePlan({
      ...WEB,
      role: { value: 'member' },
      projects: {
        names: ['storefront'],
        note: '1 more the service refused: warehouse',
      },
    });
    expect(stops[1]).toMatchObject({
      state: 'done',
      answer: 'storefront',
      detail: '1 more the service refused: warehouse',
    });
    // Without one, the stop keeps the flag's own description.
    expect(invitePlan({ ...WEB, role: { value: 'member' }, projects: { names: ['storefront'] } })[1].detail).toBe(
      'grant project access',
    );
  });

  test('§8 parity: the browser payload and --json carry the same array', () => {
    const input = {
      ...WEB,
      role: { value: 'member', flag: '--role member' },
      projects: { names: ['storefront'], flag: '--project storefront' },
    };
    const stops = invitePlan(input);
    const jsonSurface = JSON.parse(JSON.stringify({ stops }));

    const html = renderScreen('invite-teammate', {
      nonce: 'test-nonce',
      inviteeEmail: 'bob@example.com',
      orgName: 'mikes-market',
      callerEmail: 'mike@example.com',
      callerRole: 'owner',
      grantableRoles: [],
      defaultRole: 'member',
      projects: [],
      expiry: { presets: [], defaultTtl: '7d', serverCapDays: 30 },
      stops,
    } as never);

    // The payload is inlined into the page verbatim, so the array can be read
    // back out of the served HTML and compared.
    const match = html.match(/window\.__CAPY_DATA__ = (\{.*?\});/s);
    expect(match).not.toBeNull();
    const browserSurface = JSON.parse(match![1].replace(/\\u003c/g, '<'));

    expect(browserSurface.stops).toEqual(jsonSurface.stops);
    // And the markers survive the round trip — they are the part a rail needs
    // to explain itself, and the easiest thing to lose in a serialization.
    expect(browserSurface.stops[0].flag).toBe('--role member');
    expect(browserSurface.stops[1].answer).toBe('storefront');
  });
});

describe('grantedProjects', () => {
  test('a stop --project settled is not a stop the browser answered', () => {
    // `--project storefront --web` never serves the projects step, so the
    // browser's answer is empty. Reading that emptiness as "no projects" is
    // how such a run grants nothing and reports success.
    expect(grantedProjects('member', [], ['p1', 'p2'])).toEqual(['p1', 'p2']);
  });

  test('an answer given in the browser wins over nothing', () => {
    expect(grantedProjects('member', ['p3'], [])).toEqual(['p3']);
  });

  test('the browser outranks the flag once it has actually been asked', () => {
    // The only way both are populated is a run that served the step anyway;
    // the answer somebody just gave is the later word.
    expect(grantedProjects('project-admin', ['p3'], ['p1'])).toEqual(['p3']);
  });

  test('an org-wide role takes none of them, whatever a flag said', () => {
    // The terminal path achieves this by never entering its project block at
    // all — `capy invite bob --role admin --project storefront` grants org-wide
    // access and ignores the flag. Here it has to be said out loud.
    expect(grantedProjects('admin', ['p3'], ['p1'])).toEqual([]);
  });
});

describe('the TTL vocabulary', () => {
  test('parseTtl accepts exactly what --ttl documents', () => {
    expect(parseTtl('30m')).toBe(30 * 60_000);
    expect(parseTtl('24h')).toBe(24 * 3_600_000);
    expect(parseTtl('7d')).toBe(7 * 86_400_000);
    // "or a number of seconds", per the flag's own help.
    expect(parseTtl('90')).toBe(90_000);
    expect(parseTtl(' 7d ')).toBe(7 * 86_400_000);
  });

  test('parseTtl refuses rather than exiting, so a page can reject an answer', () => {
    // The command's own `--ttl` handler keeps the exit; a browser submit that
    // took the process down with it would leave the user staring at a dead tab.
    expect(parseTtl('soon')).toBeNull();
    expect(parseTtl('')).toBeNull();
    expect(parseTtl('7 days')).toBeNull();
    expect(parseTtl('-1d')).toBeNull();
  });

  test('formatTtl says an env override in the units the flag takes', () => {
    expect(formatTtl(7 * 86_400_000)).toBe('7d');
    expect(formatTtl(3_600_000)).toBe('1h');
    expect(formatTtl(90 * 60_000)).toBe('90m');
    expect(formatTtl(45_000)).toBe('45s');
  });

  test('an expiry reads forwards, never backwards', () => {
    // `formatRelativeTime` only knows "ago"; rendering an expiry through it is
    // how a screen tells somebody their fresh code lapsed just now.
    const now = Date.parse('2026-07-30T00:00:00Z');
    expect(formatRelativeFuture(now + 7 * 86_400_000, now)).toBe('in 7 days');
    expect(formatRelativeFuture(now + 86_400_000, now)).toBe('in 1 day');
    expect(formatRelativeFuture(now + 3_600_000, now)).toBe('in 1 hour');
    expect(formatRelativeFuture(now + 30 * 60_000, now)).toBe('in 30 minutes');
    expect(formatRelativeFuture(now + 5_000, now)).toBe('in under a minute');
    expect(formatRelativeFuture(now - 5_000, now)).toBe('in the past');
  });
});

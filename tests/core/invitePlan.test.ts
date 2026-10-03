/**
 * The route `capy invite` describes in `--json`, made checkable.
 *
 * The expiry stop gets the most attention here because it is the one station
 * with no terminal counterpart: `resolveNotAfter` reads four sources in order
 * and never asks, so the plan's job is to say which of the four decided.
 * Getting that wrong would put "you chose this" next to a lifetime an
 * environment variable chose.
 */
import { describe, test, expect } from 'bun:test';
import { invitePlan, roleNeedsProjects, parseTtl, formatTtl } from '../../src/core/invitePlan';

/** Nothing settled by argv. The expiry is always settled before the command starts. */
const TTY = { defaultTtl: '12h' };

describe('invitePlan', () => {
  test('an unanswered run stands on the first stop and declares all four', () => {
    const stops = invitePlan(TTY);
    expect(stops.map((s) => s.id)).toEqual(['role', 'projects', 'expiry', 'code']);
    expect(stops[0].state).toBe('current');
    expect(stops[1].state).toBe('upcoming');
    // The expiry is settled before the command starts, so it is never a question.
    expect(stops[2].state).toBe('done');
    expect(stops[3].state).toBe('upcoming');
  });

  test('the whole route is declared even when a stop will not be reached', () => {
    // A run that skips projects still declared four stations, which is what
    // makes "how many questions is this" answerable before the first one.
    expect(invitePlan(TTY).length).toBe(4);
    expect(invitePlan({ ...TTY, role: { value: 'admin', flag: '--role admin' } }).length).toBe(4);
  });

  test('--role settles the stop, marked with the flag that settled it', () => {
    const stops = invitePlan({ ...TTY, role: { value: 'admin', flag: '--role admin' } });
    expect(stops[0]).toMatchObject({ state: 'done', answer: 'admin', flag: '--role admin' });
  });

  test('an org-wide role skips the project stop rather than dropping it', () => {
    // `admin` reaches every project, so the run never visits that station —
    // and the rail says so up front instead of the stop silently vanishing.
    const stops = invitePlan({ ...TTY, role: { value: 'admin', flag: '--role admin' } });
    expect(stops[1].state).toBe('skipped');
    expect(stops[1].detail).toContain('every project');
    // The traveller moves past it to the next stop that is not settled: the code.
    expect(stops[3].state).toBe('current');
  });

  test('a scoped role keeps its project stop', () => {
    for (const role of ['member', 'project-admin']) {
      const stops = invitePlan({ ...TTY, role: { value: role, flag: `--role ${role}` } });
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
      ...TTY,
      role: { value: 'member', flag: 'existing membership' },
      projects: { names: ['storefront'], flag: 'existing membership' },
    });
    expect(stops[0]).toMatchObject({ state: 'done', flag: 'existing membership' });
    expect(stops[1]).toMatchObject({ state: 'done', answer: 'storefront', flag: 'existing membership' });
  });

  test('an answer the browser gave carries no flag', () => {
    // Nobody has to be told why they were not asked a question they just
    // answered — and claiming `--role` settled it would be a lie about a run.
    const stops = invitePlan({ ...TTY, role: { value: 'member' } });
    expect(stops[0]).toMatchObject({ state: 'done', answer: 'member' });
    expect(stops[0].flag).toBeUndefined();
  });

  test('a terminal run has its expiry settled before it starts', () => {
    // The whole reason this stop exists. `resolveNotAfter` never prompts, so
    // on a TTY the question is already answered — by the 7-day default here.
    const stops = invitePlan(TTY);
    expect(stops[2]).toMatchObject({ state: 'done', answer: '12h', flag: 'default' });
  });

  test('the environment variable that shortens an invite is named on the rail', () => {
    // CAPY_INVITE_TTL_SECONDS is honoured in silence today, so "why does this
    // invite last an hour" cannot be answered from the terminal at all.
    const stops = invitePlan({ ...TTY, envTtl: '1h', defaultTtl: '1h' });
    expect(stops[2]).toMatchObject({ state: 'done', answer: '1h', flag: 'CAPY_INVITE_TTL_SECONDS' });
  });

  test('--expires outranks --ttl, the way resolveNotAfter reads them', () => {
    const stops = invitePlan({
      ...TTY,
      expiry: { value: '2026-08-01T00:00:00Z', flag: '--expires 2026-08-01T00:00:00Z' },
    });
    expect(stops[2]).toMatchObject({ state: 'done', flag: '--expires 2026-08-01T00:00:00Z' });
  });

  test('every stop carries a detail, in the CLI\'s own words', () => {
    // These strings used to live in a lookup table inside the screen, keyed by
    // stop id, which meant the browser drew a route the CLI never described.
    for (const stop of invitePlan(TTY)) {
      expect(typeof stop.detail).toBe('string');
      expect(stop.detail!.length).toBeGreaterThan(0);
    }
    const stops = invitePlan(TTY);
    // Lifted verbatim from `--role` / `--project` / `--ttl`'s own help text.
    expect(stops[0].detail).toBe('invitee role: member | project-admin | admin');
    expect(stops[1].detail).toBe('grant project access');
    expect(stops[2].detail).toBe('invite lifetime, max 12h, e.g. 30m, 2h, 12h');
  });

  test('a stop only names what the run actually got, and says what it did not', () => {
    // The fan-out assigns one project at a time and can fail one at a time. A
    // stop is a claim about what this run DID, so a project the service refused
    // cannot appear in `answer` — and dropping it silently would hide the
    // failure rather than report it, which is what `note` is for.
    const stops = invitePlan({
      ...TTY,
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
    expect(invitePlan({ ...TTY, role: { value: 'member' }, projects: { names: ['storefront'] } })[1].detail).toBe(
      'grant project access',
    );
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

  test('parseTtl refuses rather than exiting', () => {
    // The command's own `--ttl` handler keeps the exit.
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
});

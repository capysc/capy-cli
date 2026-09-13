/**
 * A failure under `--web` ends on a page, and the page says the same thing the
 * terminal does.
 *
 * `displayErrorAndExit` printed ANSI and exited at eighteen call sites. Under
 * `--web` — agent-driven, so routinely no terminal anyone is reading — that
 * output went nowhere anyone would see, and a window already open was left
 * holding a page whose server the exit had just closed. The run's last fact,
 * the one that says what to do next, was the one that never surfaced.
 *
 * Two properties are worth pinning, and only one of them is obvious.
 *
 * The obvious one: each typed code produces its own layout. The other: the
 * builder decides on the CODE and never on the message. Both surfaces render
 * one failure, so a reword upstream must move both or neither — which is only
 * true while neither of them reads the sentence to pick a shape.
 */
import { describe, test, expect } from 'bun:test';
import { buildCommandErrorData } from '../../src/ui/commandErrorScreen';
import { renderError } from '../../src/ui/errorScreen';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('the error payload carries the code, not a description of it', () => {
  test('the code crosses verbatim, so an agent gets the same handle the CLI branched on', () => {
    const err = new CapyError('gone', ERROR_CODES.PROJECT_NOT_FOUND, { status: 404 });
    expect(buildCommandErrorData(err).code).toBe('PROJECT_NOT_FOUND');
  });

  test('a non-CapyError is UNKNOWN rather than guessed at', () => {
    const data = buildCommandErrorData(new Error('kaboom'));
    expect(data.code).toBe('UNKNOWN');
    expect(data.detail).toBe('kaboom');
  });

  test('the message never chooses the layout', () => {
    // The regression this exists for. `errorScreen` used to pick "Project not
    // found" by matching that sentence; if the builder did the same, the fix
    // would have moved the bug into the browser one layer down. Same code,
    // three unrelated sentences, one layout.
    const shapes = ['Project not found', 'No such project', ''].map((message) => {
      const d = buildCommandErrorData(
        new CapyError(message, ERROR_CODES.PROJECT_NOT_FOUND, { status: 404 }),
      );
      return { title: d.title, causes: d.causes?.length, remedies: d.remedies?.length };
    });
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  test('a revoked membership is read from the code, not from "no longer a member"', () => {
    const kicked = new CapyError('anything at all', ERROR_CODES.PERMISSION_DENIED, {
      status: 403,
      code: 'MEMBERSHIP_REVOKED',
    });
    expect(buildCommandErrorData(kicked).title).toBe('Access revoked');

    // A bare 403 is a denial, not a kick — the distinction that gates the
    // destructive local wipe, so the page must not blur it either.
    const denied = new CapyError('nope', ERROR_CODES.PERMISSION_DENIED, { status: 403 });
    expect(buildCommandErrorData(denied).title).toBe('Permission denied');
  });

  test('a wrapped decrypt failure is recognised through its cause', () => {
    // How it actually arrives: PERMISSION_DENIED on the outside with the real
    // code preserved underneath. Flattening `cause` would lose it.
    const wrapped = new CapyError('denied', ERROR_CODES.PERMISSION_DENIED, {
      variable: 'STRIPE_SECRET_KEY',
      cause: { code: ERROR_CODES.DECRYPT_KEY_MISMATCH },
    });
    const data = buildCommandErrorData(wrapped);
    expect(data.title).toBe('Cannot decrypt secrets');
    expect(data.context).toEqual([{ label: 'Variable', value: 'STRIPE_SECRET_KEY' }]);
  });
});

describe('the payload is fit to render', () => {
  const CODES = [
    ERROR_CODES.AUTH_FAILED,
    ERROR_CODES.PERMISSION_DENIED,
    ERROR_CODES.NETWORK_ERROR,
    ERROR_CODES.PROJECT_NOT_FOUND,
    ERROR_CODES.BRANCH_NOT_FOUND,
    ERROR_CODES.INVALID_FORMAT,
    ERROR_CODES.NO_KEEP_FILE,
    ERROR_CODES.QUOTA_EXCEEDED,
    ERROR_CODES.SERVICE_ERROR,
    ERROR_CODES.DECRYPT_KEY_MISMATCH,
    // The local-state refusals. These never reach the service, so they used to
    // be bare `console.error` + `process.exit(1)` at the top of a command —
    // right in a terminal, and nothing at all under `--web`.
    ERROR_CODES.NO_ACTIVE_BRANCH,
    ERROR_CODES.NO_MANAGED_KEYS,
    ERROR_CODES.NO_VARIABLES,
    ERROR_CODES.VARIABLE_NOT_FOUND,
    ERROR_CODES.NO_CONNECTORS,
    ERROR_CODES.DEV_LIVE_FIREWALL,
  ];

  test.each(CODES)('%s has a title and no empty prose fields', (code) => {
    const data = buildCommandErrorData(
      new CapyError('something happened', code, {
        status: 500,
        kind: 'project',
        limit: 3,
        variable: 'STRIPE_SECRET_KEY',
        branch: 'main',
        available: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
        variables: ['STRIPE_LIVE_KEY'],
        nothingLeft: false,
      }),
      { projectName: 'acme', projectId: 'prj_1', branch: 'main' },
    );
    expect(data.title.length).toBeGreaterThan(0);
    // An empty string renders as a blank callout or a bullet with nothing in
    // it — worse than the field being absent, which the screen skips.
    for (const s of [data.detail, ...(data.causes ?? []), ...(data.remedies ?? []).map((r) => r.text)]) {
      if (s !== undefined) expect(s.length).toBeGreaterThan(0);
    }
  });

  test('no ANSI reaches the browser', () => {
    // The CLI bolds its own messages on the way to a terminal, and those codes
    // render as literal `[1m` in a page. An earlier parcel shipped exactly
    // that through a `B()` helper.
    const data = buildCommandErrorData(
      new CapyError('\x1b[1mCapy\x1b[0m is unreachable', ERROR_CODES.SERVICE_ERROR, {
        status: 503,
      }),
      { projectName: '\x1b[1macme\x1b[0m' },
    );
    const rendered = JSON.stringify(data);
    expect(rendered).not.toContain('\x1b');
    expect(rendered).not.toContain('[1m');
  });

  test('the browser and the terminal agree on what happened', () => {
    // Not a string comparison — the layouts differ on purpose. What has to
    // match is the headline, because someone holding a screenshot next to a
    // transcript has to be able to see they describe one failure.
    for (const [code, headline] of [
      [ERROR_CODES.NETWORK_ERROR, 'Connection failed'],
      [ERROR_CODES.NO_KEEP_FILE, 'No keep.lock file found'],
      [ERROR_CODES.PROJECT_NOT_FOUND, 'Project not found'],
      [ERROR_CODES.INVALID_FORMAT, 'Invalid file format'],
      [ERROR_CODES.NO_ACTIVE_BRANCH, 'No active branch'],
      [ERROR_CODES.NO_MANAGED_KEYS, 'No managed keys to rotate on this branch'],
      [ERROR_CODES.NO_VARIABLES, 'No variables on this branch yet'],
      [ERROR_CODES.VARIABLE_NOT_FOUND, 'Variable not found'],
      [ERROR_CODES.NO_CONNECTORS, 'No connectors are registered'],
      [ERROR_CODES.DEV_LIVE_FIREWALL, 'Live mode is not allowed in capy-dev'],
    ] as const) {
      const err = new CapyError('detail', code, { status: 404 });
      expect(buildCommandErrorData(err).title).toBe(headline);
      expect(strip(renderError(err))).toContain(headline);
    }
  });
});

describe('the local-state refusals carry what the caller needs to correct itself', () => {
  test('a wrong variable name comes back with the names that would have worked', () => {
    // The whole difference between a page that ends the run and one an agent
    // can act on. `capy rotate NOPE --web` used to write "not in your
    // environment" to a stream nobody reads and exit 1, so the caller had no
    // surface at all — not the reason, and not the alternatives.
    const err = new CapyError('nope', ERROR_CODES.VARIABLE_NOT_FOUND, {
      variable: 'STRIPE_SECRET',
      branch: 'development',
      available: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
    });
    const data = buildCommandErrorData(err);
    expect(data.code).toBe('VARIABLE_NOT_FOUND');
    expect(data.detail).toBe('STRIPE_SECRET is not in your environment on branch development.');
    expect(data.context).toContainEqual({ label: 'Variable', value: 'STRIPE_SECRET' });
    expect(data.context).toContainEqual({ label: 'Branch', value: 'development' });
    expect(data.context).toContainEqual({
      label: 'Available',
      value: 'DATABASE_URL, STRIPE_SECRET_KEY',
    });
    // And the terminal says the same thing, including the list.
    const text = strip(renderError(err));
    expect(text).toContain('STRIPE_SECRET is not in your environment on branch development.');
    expect(text).toContain('Available: DATABASE_URL, STRIPE_SECRET_KEY');
  });

  test('a branch with nothing to offer omits the list rather than printing an empty one', () => {
    const err = new CapyError('nope', ERROR_CODES.VARIABLE_NOT_FOUND, {
      variable: 'X',
      branch: 'development',
      available: [],
    });
    expect(buildCommandErrorData(err).context).not.toContainEqual(
      expect.objectContaining({ label: 'Available' }),
    );
    expect(strip(renderError(err))).not.toContain('Available:');
  });

  test('the two live-mode refusals are told apart on the flag, not on the sentence', () => {
    // Same code, two facts: one key stopped a single rotation, or every
    // managed key was live and there is nothing left to do. Both arrive with
    // the same message text on purpose — if either surface read the sentence
    // to pick a shape, this is where it would show.
    const one = new CapyError('anything at all', ERROR_CODES.DEV_LIVE_FIREWALL, {
      variables: ['STRIPE_LIVE_KEY'],
      nothingLeft: false,
    });
    const all = new CapyError('anything at all', ERROR_CODES.DEV_LIVE_FIREWALL, {
      variables: ['STRIPE_LIVE_KEY', 'OTHER_LIVE_KEY'],
      nothingLeft: true,
    });

    expect(buildCommandErrorData(one).title).toBe('Live mode is not allowed in capy-dev');
    expect(buildCommandErrorData(all).title).toBe('Nothing to rotate');
    expect(strip(renderError(one))).toContain('STRIPE_LIVE_KEY is configured for live mode.');
    expect(strip(renderError(all))).toContain('All managed keys on this branch are live-mode.');

    // The live keys are named, so a `--all` run says WHICH ones it refused
    // rather than only how many survived.
    expect(buildCommandErrorData(all).context).toContainEqual({
      label: 'Live keys',
      value: 'STRIPE_LIVE_KEY, OTHER_LIVE_KEY',
    });
  });

  test('a branch-scoped refusal names the branch it is about', () => {
    for (const code of [ERROR_CODES.NO_MANAGED_KEYS, ERROR_CODES.NO_VARIABLES] as const) {
      const data = buildCommandErrorData(new CapyError('nope', code, { branch: 'development' }));
      expect(data.context).toContainEqual({ label: 'Branch', value: 'development' });
    }
  });
});

/**
 * The paid org gate has to reach the user with a way to pay.
 *
 * Creating an org used to be a hard one-per-account cap, so both renderers
 * special-cased `kind: 'organization'`: they said "each account can own one
 * organization", pointed the user at `capy invite`, and deliberately withheld
 * the upgrade link — an offer that could not be taken. CAP-550/CAP-592 turned
 * that cap into a Team-tier paywall, which inverted the requirement: the link
 * IS the way out now, and withholding it strands a user who is willing to pay.
 *
 * Both surfaces are asserted because they are separate code paths that used to
 * carry the same mistake independently.
 */
describe('QUOTA_EXCEEDED on organization is a paywall, not a hard cap', () => {
  const paidGate = () =>
    new CapyError('Creating an organization requires a Team plan.', ERROR_CODES.QUOTA_EXCEEDED, {
      status: 402,
      kind: 'organization',
      limit: 1,
      upgrade_url: 'https://admin.staging.capy.sc/billing',
    });

  test('the terminal render offers the upgrade URL the service sent', () => {
    const out = strip(renderError(paidGate()));
    expect(out).toContain('https://admin.staging.capy.sc/billing');
    // The retired tier name must not come back, and the old dead-end line
    // must not be the whole answer.
    expect(out).not.toContain('Capy Business');
    expect(out).not.toContain('Each Capy account can own one organization');
  });

  test('the page render carries the upgrade URL as a fact', () => {
    const data = buildCommandErrorData(paidGate());
    expect(data.context).toContainEqual({
      label: 'Upgrade',
      value: 'https://admin.staging.capy.sc/billing',
    });
    // Paying is offered first; being invited is the alternative, not the
    // only route out.
    expect(data.remedies?.[0].text).toMatch(/upgrade/i);
  });

  test('it uses the SERVICE message rather than inventing its own reason', () => {
    // The builder decides on the code, never the sentence — same property the
    // rest of this file pins. Vince approves the service strings; the CLI must
    // not paper over them with copy of its own.
    expect(strip(renderError(paidGate()))).toContain(
      'Creating an organization requires a Team plan.',
    );
    expect(buildCommandErrorData(paidGate()).detail).toBe(
      'Creating an organization requires a Team plan.',
    );
  });

  test('project and member refusals still surface the upgrade URL too', () => {
    for (const kind of ['project', 'member'] as const) {
      const err = new CapyError('nope', ERROR_CODES.QUOTA_EXCEEDED, {
        status: 402,
        kind,
        limit: 5,
        upgrade_url: 'https://admin.staging.capy.sc/billing',
      });
      expect(strip(renderError(err))).toContain('https://admin.staging.capy.sc/billing');
      expect(buildCommandErrorData(err).context).toContainEqual({
        label: 'Upgrade',
        value: 'https://admin.staging.capy.sc/billing',
      });
      expect(strip(renderError(err))).not.toContain('Capy Business');
    }
  });
});

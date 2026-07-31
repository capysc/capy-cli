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
  ];

  test.each(CODES)('%s has a title and no empty prose fields', (code) => {
    const data = buildCommandErrorData(
      new CapyError('something happened', code, { status: 500, kind: 'project', limit: 3 }),
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
    ] as const) {
      const err = new CapyError('detail', code, { status: 404 });
      expect(buildCommandErrorData(err).title).toBe(headline);
      expect(strip(renderError(err))).toContain(headline);
    }
  });
});

/**
 * One decision, made where the response is.
 *
 * `classifyResponse` replaces three separate re-derivations of the same fact,
 * each keyed on the service's prose:
 *
 *   - `errorScreen` picked its LAYOUT with `serverMsg.includes('Project not
 *     found')`, so rewording that sentence upstream would have dropped a user
 *     to the generic "Service error" panel and taken the recovery steps with it.
 *   - `getDecryptData` decided whether a 404 was fatal with
 *     `msg.includes('not found') && !msg.includes('No secrets')`.
 *   - `statusCommand` turned `err.message` into the `access_denied` badge that
 *     decides whether the report says `capy redeem` or `capy`.
 *
 * None of those would have failed a test when the wording changed. That is the
 * whole hazard: a string-keyed branch has no compile-time and no runtime signal
 * when its key moves. So this file pins the code the classifier returns, and
 * `noServerProseBranching` below pins that nothing goes back to reading the
 * sentence.
 */
import { describe, test, expect } from 'bun:test';
import { classifyResponse } from '../../src/service/serviceClient';
import { ERROR_CODES } from '../../src/types/index';

describe('classifyResponse — the server code wins', () => {
  test('a recognised `code` decides it, whatever the sentence says', () => {
    // The point of the whole change: prose becomes irrelevant once the server
    // sends a code. Here the message says one thing and the code says another.
    expect(
      classifyResponse(404, { code: 'PROJECT_NOT_FOUND', error: 'nope' }, 'nope'),
    ).toBe(ERROR_CODES.PROJECT_NOT_FOUND);
  });

  test('an UNRECOGNISED code is ignored rather than trusted', () => {
    // A server free to name any code could steer the CLI into a branch the CLI
    // never reasoned about. Unknown means SERVICE_ERROR, the safe default.
    expect(classifyResponse(500, { code: 'WHATEVER_I_LIKE' }, 'boom')).toBe(
      ERROR_CODES.SERVICE_ERROR,
    );
  });

  test('a non-string code cannot be smuggled through', () => {
    for (const code of [{}, true, 42, null, ['PROJECT_NOT_FOUND']]) {
      expect(classifyResponse(404, { code }, 'Project not found')).toBe(
        ERROR_CODES.PROJECT_NOT_FOUND, // falls to the 404 bridge, not to `code`
      );
    }
  });
});

describe('classifyResponse — the legacy bridge, quarantined to 404', () => {
  const cases: Array<[string, string]> = [
    ['Snapshot not found', ERROR_CODES.SNAPSHOT_NOT_FOUND],
    ['No secrets for this branch', ERROR_CODES.NO_SECRETS],
    ['Project not found', ERROR_CODES.PROJECT_NOT_FOUND],
    ['Branch "staging" not found', ERROR_CODES.BRANCH_NOT_FOUND],
  ];

  test.each(cases)('a 404 saying %p is %s', (message, code) => {
    expect(classifyResponse(404, {}, message)).toBe(code);
  });

  test('the same sentences on any other status are NOT reinterpreted', () => {
    // The bridge exists for old servers' 404 bodies only. A 500 whose message
    // happens to contain "Project not found" is a server fault, not a missing
    // project, and must not be dressed up as one.
    for (const [message] of cases) {
      expect(classifyResponse(500, {}, message)).toBe(ERROR_CODES.SERVICE_ERROR);
      expect(classifyResponse(400, {}, message)).toBe(ERROR_CODES.SERVICE_ERROR);
    }
  });

  test('"No secrets" is not a missing project — the first-run empty state', () => {
    // This ordering is load-bearing. `getDecryptData` propagates the not-found
    // family and swallows this one; getting it backwards makes an ordinary
    // first run look like a deleted project.
    expect(classifyResponse(404, {}, 'No secrets found for this branch')).toBe(
      ERROR_CODES.NO_SECRETS,
    );
  });

  test('an unrecognised 404 stays a service error', () => {
    expect(classifyResponse(404, {}, 'something else entirely')).toBe(
      ERROR_CODES.SERVICE_ERROR,
    );
  });
});

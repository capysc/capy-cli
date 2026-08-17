/**
 * BUG B (CLI side): a flow-service HTTP failure used to fall through
 * `renderError`'s generic "unexpected error" branch, showing only the bare
 * HTTP status (`flow request failed with status 403`) with no code — exactly
 * what made a 403 from the org-less-bearer bug read as an unrelated crash.
 * `FlowHttpError` must be routed through the same coded switch a `CapyError`
 * gets, never through the "no idea what this is" fallback.
 */
import { describe, test, expect } from 'bun:test';
import { renderError } from '../../src/ui/errorScreen';
import { FlowHttpError } from '../../src/flows/client';
import { ERROR_CODES } from '../../src/types/index';

describe('renderError: FlowHttpError', () => {
  test('a known code renders through the SAME switch a CapyError would, never the generic fallback', () => {
    const output = renderError(new FlowHttpError(403, ERROR_CODES.PERMISSION_DENIED));
    // The generic "unknown error" branch would have shown only the raw
    // FlowHttpError message ("flow request failed with status 403") — this
    // is PERMISSION_DENIED's own dedicated renderer instead.
    expect(output).toContain('Permission denied');
    expect(output).not.toContain('unexpected error');
    expect(output.toLowerCase()).not.toContain('flow request failed with status');
  });

  test('an unknown or missing code still surfaces a code (SERVICE_ERROR), never silence', () => {
    const noCode = renderError(new FlowHttpError(500, undefined));
    expect(noCode).toContain(ERROR_CODES.SERVICE_ERROR);
    expect(noCode).toContain('500');

    const badCode = renderError(new FlowHttpError(409, 'NOT_A_REAL_CODE'));
    expect(badCode).toContain(ERROR_CODES.SERVICE_ERROR);
    expect(badCode).toContain('409');
  });

  test('never falls into the bare "unexpected error" fallback for ANY FlowHttpError', () => {
    for (const err of [
      new FlowHttpError(403, ERROR_CODES.PERMISSION_DENIED),
      new FlowHttpError(500, ERROR_CODES.SERVICE_ERROR),
      new FlowHttpError(500, undefined),
      new FlowHttpError(409, 'GARBAGE'),
    ]) {
      expect(renderError(err)).not.toContain('An unexpected error occurred');
    }
  });
});

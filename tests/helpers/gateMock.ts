/**
 * A stand-in for bare `capy` as the first step of a command (src/sync/gate.ts), for the tests of a command's OWN
 * behaviour (its refusals, its prompts, its output), which must not reach for Keep.
 *
 * Use it in a file that runs isolated (`mock.module()` is process-wide; see tests/run-tests.sh), BEFORE the command is
 * imported:
 *
 *     import { stubbedGate } from '../helpers/gateMock';
 *     mock.module('../../src/sync/gate', () => stubbedGate());
 *
 * `gateFirst` and `ensureInSync` report the folder as in sync and record that they ran (`gateRan`), with what they were
 * given; everything else the module exports (`commitGated`, `answersByProtocol`, ...) is the real one. The gate itself is
 * tested in tests/sync/gate.test.ts; that every command calls it first is tested in tests/commands/gateFirst.test.ts.
 */
import { mock } from 'bun:test';
import * as realGate from '../../src/sync/gate';

export const gateRan = mock((_opts: unknown) => undefined);

export function stubbedGate(result: realGate.GateResult = 'in-sync') {
  return {
    ...realGate,
    gateFirst: async (opts: realGate.GateOptions = {}) => {
      gateRan(opts);
      if (result === 'stopped') realGate.stopWithNothingWritten();
    },
    ensureInSync: async (opts: realGate.GateOptions = {}) => {
      gateRan(opts);
      return result;
    },
  };
}

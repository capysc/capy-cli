import { describe, it, expect } from 'bun:test';
import { classifyLocalRow } from '../../src/ui/editScreen';

/**
 * Local-only edit rows must classify as committed-vs-working — never 'unknown'
 * (the remote-unavailable status), which is what regressed when local mode
 * reused the three-way remote comparison.
 */
describe('classifyLocalRow (local-only edit TUI)', () => {
  it('working matches committed → in sync / committed', () => {
    expect(classifyLocalRow('v', 'v')).toEqual({ status: 'in sync', updatedLabel: 'committed' });
  });

  it('working differs from committed → local / uncommitted', () => {
    expect(classifyLocalRow('new', 'old')).toEqual({ status: 'local', updatedLabel: 'uncommitted' });
  });

  it('new working value with no committed baseline → uncommitted', () => {
    expect(classifyLocalRow('new', undefined)).toEqual({ status: 'local', updatedLabel: 'uncommitted' });
  });

  it('committed but removed from working → uncommitted', () => {
    expect(classifyLocalRow(undefined, 'old')).toEqual({ status: 'local', updatedLabel: 'uncommitted' });
  });

  it('never returns the remote-mode "unknown" status', () => {
    for (const [w, c] of [['a', 'a'], ['a', 'b'], ['a', undefined], [undefined, 'b']] as const) {
      expect(classifyLocalRow(w, c).status).not.toBe('unknown');
    }
  });
});

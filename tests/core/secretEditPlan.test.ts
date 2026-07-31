/**
 * The routes `capy edit` and `capy decrypt` travel.
 *
 * The claim these tests exist to hold: the rail a person reads and the array a
 * headless caller parses are the SAME array. `secret-table` and
 * `secret-commit-review` are two halves of one journey and used to carry their
 * own lookup tables of station labels; they get them from `secretEditPlan` now,
 * so a station cannot be called two things.
 */
import { describe, test, expect } from 'bun:test';
import { secretEditPlan } from '../../src/core/secretEditPlan';
import { decryptPlan } from '../../src/core/decryptPlan';
import { renderScreen } from '../../src/ui/screens/serve';

const EDIT = {
  variableCount: 9,
  changeCount: 0,
  localMode: false,
  destination: 'mikes-market/staging',
  at: 'edit' as const,
};

describe('secretEditPlan', () => {
  test('draws every station up front, including the ones this run has not reached', () => {
    const stops = secretEditPlan(EDIT);
    expect(stops.map((s) => s.id)).toEqual(['edit', 'review', 'write', 'result']);
    expect(stops.map((s) => s.state)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
  });

  test('exactly one station is where the traveller is standing', () => {
    for (const at of ['edit', 'review', 'write', 'result'] as const) {
      const current = secretEditPlan({ ...EDIT, at }).filter((s) => s.state === 'current');
      expect(current).toHaveLength(1);
      expect(current[0].id).toBe(at);
    }
  });

  test('a finished stop reports what was decided, not what was on offer', () => {
    const stops = secretEditPlan({ ...EDIT, changeCount: 1, at: 'review' });
    expect(stops[0]).toEqual({ id: 'edit', label: 'Edit values', state: 'done', answer: '1 change' });
    // …and the count agrees with its own noun on both sides of 1.
    expect(secretEditPlan({ ...EDIT, changeCount: 4, at: 'review' })[0].answer).toBe('4 changes');
    expect(secretEditPlan({ ...EDIT, variableCount: 1 })[0].detail).toBe('1 variable');
  });

  test('the write stop names Keep only when there is a Keep to push to', () => {
    const server = secretEditPlan(EDIT)[2];
    expect(server).toMatchObject({
      label: 'Encrypt and push to Keep',
      detail: 'mikes-market/staging',
      detailMono: true,
    });

    // A local profile pushes nothing, and its detail is a sentence rather than
    // an identifier — so it must not be set in the machine face.
    const local = secretEditPlan({ ...EDIT, localMode: true })[2];
    expect(local).toMatchObject({ label: 'Commit locally', detail: 'to this machine only' });
    expect(local.detailMono).toBeUndefined();
  });

  test('a discarded run marks the write as skipped, never as done', () => {
    const stops = secretEditPlan({ ...EDIT, changeCount: 2, at: 'result', discarded: true });
    expect(stops[2].state).toBe('skipped');
    expect(stops[3].state).toBe('current');

    const committed = secretEditPlan({ ...EDIT, changeCount: 2, at: 'result' });
    expect(committed[2].state).toBe('done');
  });

  test('the result stop stops describing itself once you are standing on it', () => {
    expect(secretEditPlan(EDIT)[3].detail).toBe('what this run changed');
    expect(secretEditPlan({ ...EDIT, at: 'result' })[3].detail).toBeUndefined();
  });

  test('the array the screen renders is the array this returns', () => {
    const stops = secretEditPlan(EDIT);
    const html = renderScreen('secret-table', {
      nonce: 'n',
      projectName: 'mikes-market',
      branch: 'staging',
      mode: 'server',
      stops,
      rows: [],
    });
    expect(html).toContain('Encrypt and push to Keep');
    expect(html).toContain(JSON.stringify(stops).slice(1, 40));
  });
});

describe('decryptPlan', () => {
  const BASE = { wordCount: 24, outputFile: '.env.main.decrypted', usingSession: false };

  test('phrase, decrypt, write — declared before the first box opens', () => {
    const stops = decryptPlan(BASE);
    expect(stops.map((s) => s.id)).toEqual(['phrase', 'decrypt', 'write']);
    expect(stops[0]).toMatchObject({ state: 'current', detail: '24 words, typed here' });
    expect(stops[2].detail).toBe('.env.main.decrypted');
  });

  test('an open session skips the phrase stop instead of dropping it', () => {
    const stops = decryptPlan({ ...BASE, usingSession: true });
    expect(stops[0].state).toBe('skipped');
    expect(stops[1].state).toBe('current');
  });

  test('a run with no branch names no file rather than naming an empty one', () => {
    expect(decryptPlan({ ...BASE, outputFile: null })[2].detail).toBeUndefined();
  });

  test('the word count is the payload\'s, never assumed', () => {
    expect(decryptPlan({ ...BASE, wordCount: 12 })[0].detail).toBe('12 words, typed here');
  });

  test('a finished run leaves nothing current', () => {
    const stops = decryptPlan({ ...BASE, finished: true });
    expect(stops.some((s) => s.state === 'current')).toBe(false);
    expect(stops.map((s) => s.state)).toEqual(['done', 'done', 'done']);
  });
});

/**
 * The route `capy recover` declares before it opens anything.
 *
 * What is being pinned is that the whole route exists from the first render —
 * including the stop this run will skip and the one it cannot commit to yet.
 * The terminal announces none of it: you answer "which organization", and only
 * then does a destructive overwrite confirm appear, with nothing having warned
 * you it was coming. A rail that grew that stop on arrival would be the same
 * ambush with nicer typography.
 */
import { describe, test, expect } from 'bun:test';
import { recoverPlan } from '../../src/core/recoverPlan';

const BASE = { signedIn: true, userEmail: 'vince@capy.sc', wordCount: 24 };

const byId = (stops: ReturnType<typeof recoverPlan>, id: string) =>
  stops.find((s) => s.id === id)!;

describe('recoverPlan', () => {
  test('draws every stop from the first render, in order', () => {
    const stops = recoverPlan(BASE);
    expect(stops.map((s) => s.id)).toEqual([
      'auth',
      'organization',
      'overwrite',
      'phrase',
      'write',
    ]);
  });

  test('the sign-in is history by the time a screen exists', () => {
    // `recover` authenticates before it asks anything, so `auth` is done and
    // carries who it signed in as. Dotted track over history would say "over
    // to you" about something that is already finished.
    const auth = byId(recoverPlan(BASE), 'auth');
    expect(auth.state).toBe('done');
    expect(auth.answer).toBe('vince@capy.sc');
    expect(auth.manual).toBeUndefined();
  });

  test('an unfinished sign-in is the one stop drawn as manual', () => {
    const auth = byId(recoverPlan({ ...BASE, signedIn: false }), 'auth');
    expect(auth.state).toBe('current');
    expect(auth.manual).toBe(true);
    // …and nothing after it is where the traveller stands.
    expect(byId(recoverPlan({ ...BASE, signedIn: false }), 'organization').state).toBe('upcoming');
  });

  test('the overwrite gate is blank until the organization stop settles it', () => {
    // Whether this stop exists at all depends on the organization you pick, so
    // it cannot be a real station yet — and it must not be left out either.
    const overwrite = byId(recoverPlan(BASE), 'overwrite');
    expect(overwrite.state).toBe('upcoming');
    expect(overwrite.blank).toBe(true);
  });

  test('an organization with no key here strikes the gate out rather than dropping it', () => {
    const stops = recoverPlan({ ...BASE, orgName: 'Demos', hasKeyOnThisDevice: false });
    expect(byId(stops, 'overwrite').state).toBe('skipped');
    expect(byId(stops, 'overwrite').blank).toBeUndefined();
    // With nothing to destroy, the phrase is where the run stands.
    expect(byId(stops, 'phrase').state).toBe('current');
    expect(stops).toHaveLength(5);
  });

  test('an organization with a key here makes the gate the current stop', () => {
    const stops = recoverPlan({ ...BASE, orgName: 'Demos', hasKeyOnThisDevice: true });
    expect(byId(stops, 'organization').state).toBe('done');
    expect(byId(stops, 'organization').answer).toBe('Demos');
    expect(byId(stops, 'overwrite').state).toBe('current');
    // The phrase is not reachable until the gate is answered.
    expect(byId(stops, 'phrase').state).toBe('upcoming');
  });

  test('agreeing to the overwrite moves the run on to the phrase', () => {
    const stops = recoverPlan({
      ...BASE,
      orgName: 'Demos',
      hasKeyOnThisDevice: true,
      overwriteAgreed: true,
    });
    expect(byId(stops, 'overwrite').state).toBe('done');
    expect(byId(stops, 'overwrite').answer).toBe('replace it');
    expect(byId(stops, 'phrase').state).toBe('current');
  });

  test('the phrase stop counts the words the run expects, not a hardcoded 24', () => {
    expect(byId(recoverPlan({ ...BASE, wordCount: 12 }), 'phrase').detail).toBe('all 12 words');
    expect(byId(recoverPlan(BASE), 'phrase').detail).toBe('all 24 words');
  });

  test('a phrase nothing could check leaves the run standing at the write', () => {
    // The only state that reaches the write stop with a page still open: the
    // trial decryption could not run and the user is being asked to write
    // anyway. On every other run the phrase stop verifies and writes at once.
    const stops = recoverPlan({
      ...BASE,
      orgName: 'Demos',
      hasKeyOnThisDevice: false,
      phraseEntered: true,
    });
    expect(byId(stops, 'phrase').state).toBe('done');
    expect(byId(stops, 'write').state).toBe('current');
  });

  test('the write stop stops promising a verification that could not run', () => {
    // Standing at this stop means the trial decryption is the thing that DID
    // NOT happen. A rail still describing it as "verify it, then save it" is
    // describing a step that failed as though it were ahead of you.
    const stopped = byId(
      recoverPlan({ ...BASE, orgName: 'Demos', hasKeyOnThisDevice: false, phraseEntered: true }),
      'write',
    );
    expect(stopped.detail).toBe('nothing here could verify it, so saving it is a decision');

    // Everywhere else the stop is still ahead, and it still promises it.
    const ahead = byId(recoverPlan({ ...BASE, orgName: 'Demos', hasKeyOnThisDevice: false }), 'write');
    expect(ahead.detail).toContain('verify it against');
  });

  test('nothing on the rail is or describes phrase material', () => {
    const stops = recoverPlan({
      ...BASE,
      orgName: 'Demos',
      hasKeyOnThisDevice: true,
      overwriteAgreed: true,
      phraseEntered: true,
    });
    // The phrase stop never carries an answer: "what you typed" has no safe
    // summary, and a word count is already in the detail.
    expect(byId(stops, 'phrase').answer).toBeUndefined();
    expect(byId(stops, 'write').answer).toBeUndefined();
  });

  test('a whitespace-only organization name is not an answer', () => {
    const stops = recoverPlan({ ...BASE, orgName: '   ', hasKeyOnThisDevice: true });
    expect(byId(stops, 'organization').state).toBe('current');
  });
});

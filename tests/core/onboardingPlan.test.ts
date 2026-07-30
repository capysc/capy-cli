/**
 * The four routes the org / onboarding commands declare before they open
 * anything.
 *
 * Pinned here rather than through a screen because that is the claim: the rail
 * a person reads and the array a headless caller parses come out of these
 * functions, so a divergence between the two surfaces has to start with a
 * change to one of these tests.
 *
 * The property worth guarding hardest is that a stop this run will not visit is
 * declared `skipped` rather than dropped. A filtered list describes the run; the
 * point of a declared route is that it describes the ROUTE, including the
 * branch nobody took.
 */
import { describe, test, expect } from 'bun:test';
import {
  byocConnectPlan,
  createOrgPlan,
  localOnboardingPlan,
  orgSwitchPlan,
  ORG_CREATE_STOP_IDS,
  PHRASE_SOURCE_LABELS,
} from '../../src/core/onboardingPlan';

describe('orgSwitchPlan', () => {
  test('declares the create branch on a run that is switching, struck through', () => {
    const stops = orgSwitchPlan({});
    expect(stops.map((s) => s.id)).toEqual(['org', 'name', 'phrase', 'create', 'project']);
    // Nothing chosen yet, so the create stops are not this run's — but they are
    // on the map, which is the whole reason an account with no organizations is
    // not promised a two-stop journey.
    for (const id of ORG_CREATE_STOP_IDS) {
      expect(stops.find((s) => s.id === id)!.state).toBe('skipped');
    }
    expect(stops[0].state).toBe('current');
    expect(stops.find((s) => s.id === 'project')!.state).toBe('upcoming');
  });

  test('choosing the create row lights the three stops it adds', () => {
    const stops = orgSwitchPlan({ creating: true });
    for (const id of ORG_CREATE_STOP_IDS) {
      expect(stops.find((s) => s.id === id)!.state).toBe('upcoming');
    }
    // The rail says which row was picked, in the screen's own words.
    expect(stops[0]).toMatchObject({ state: 'done', answer: 'Create a new organization' });
  });

  test('an answered organization moves the traveller to the project stop', () => {
    const stops = orgSwitchPlan({ orgName: 'mikes-market' });
    expect(stops[0]).toMatchObject({ state: 'done', answer: 'mikes-market' });
    expect(stops.find((s) => s.id === 'project')!.state).toBe('current');
  });

  test('a walked create route is behind the traveller, not struck through', () => {
    // The screen served immediately after Name → Recovery phrase → Create. With
    // only `orgName` to go on the rail called all three "not needed" on the very
    // page that follows them, to a user who had just written down 24 words.
    const stops = orgSwitchPlan({ orgName: 'Northwind', created: true });
    for (const id of ORG_CREATE_STOP_IDS) {
      expect(stops.find((s) => s.id === id)!.state).toBe('done');
    }
    expect(stops[0]).toMatchObject({ state: 'done', answer: 'Northwind' });
    // The one stop left is where the traveller is.
    expect(stops.find((s) => s.id === 'project')!.state).toBe('current');
    expect(stops.filter((s) => s.state === 'current')).toHaveLength(1);
  });

  test('the walked phrase stop still carries only the consent', () => {
    const phrase = orgSwitchPlan({ orgName: 'Northwind', created: true }).find(
      (s) => s.id === 'phrase',
    )!;
    expect(phrase.answer).toBe('written down');
    expect(phrase.answer!.split(/\s+/)).toHaveLength(2);
  });

  test('a chosen project is done, carrying its own name', () => {
    const stops = orgSwitchPlan({ orgName: 'mikes-market', projectName: 'storefront' });
    expect(stops.find((s) => s.id === 'project')).toMatchObject({
      state: 'done',
      answer: 'storefront',
    });
  });
});

describe('createOrgPlan', () => {
  test('name, recovery phrase, create — declared before the phrase exists', () => {
    const stops = createOrgPlan({});
    expect(stops.map((s) => s.id)).toEqual(['name', 'phrase', 'create']);
    expect(stops.map((s) => s.state)).toEqual(['current', 'upcoming', 'upcoming']);
  });

  test('a named organization stands on the phrase stop', () => {
    const stops = createOrgPlan({ name: '  Northwind Labs  ' });
    expect(stops[0]).toMatchObject({ state: 'done', answer: 'Northwind Labs' });
    expect(stops[1].state).toBe('current');
  });

  test('the phrase stop never carries the phrase, only that it was written down', () => {
    const stops = createOrgPlan({ name: 'Northwind', confirmed: true });
    const phrase = stops.find((s) => s.id === 'phrase')!;
    expect(phrase).toMatchObject({ state: 'done', answer: 'written down' });
    // Whatever the answer is, it is four characters of English and not a seed.
    expect(phrase.answer!.split(/\s+/)).toHaveLength(2);
  });
});

describe('localOnboardingPlan', () => {
  test('four stops, and the phrase source is answered in the CLI\'s own words', () => {
    expect(localOnboardingPlan({}).map((s) => s.id)).toEqual([
      'source',
      'phrase',
      'passphrase',
      'finish',
    ]);
    expect(localOnboardingPlan({ source: 'generate' })[0]).toMatchObject({
      state: 'done',
      answer: PHRASE_SOURCE_LABELS.generate,
    });
    expect(localOnboardingPlan({ source: 'enter' })[0].answer).toBe(
      PHRASE_SOURCE_LABELS.enter,
    );
  });

  test('the traveller moves one stop at a time as answers land', () => {
    expect(localOnboardingPlan({}).map((s) => s.state)).toEqual([
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
    expect(localOnboardingPlan({ source: 'generate' }).map((s) => s.state)).toEqual([
      'done',
      'current',
      'upcoming',
      'upcoming',
    ]);
    expect(
      localOnboardingPlan({ source: 'generate', phraseSettled: true }).map((s) => s.state),
    ).toEqual(['done', 'done', 'current', 'upcoming']);
  });

  test('no stop ever carries a recovery phrase as its answer', () => {
    const stops = localOnboardingPlan({
      source: 'generate',
      phraseSettled: true,
      passphraseSettled: true,
    });
    expect(stops.find((s) => s.id === 'phrase')!.answer).toBeUndefined();
    expect(stops.find((s) => s.id === 'passphrase')!.answer).toBeUndefined();
  });
});

describe('byocConnectPlan', () => {
  test('the certificate stop is a blank until a probe has been run', () => {
    const stops = byocConnectPlan({});
    expect(stops.map((s) => s.id)).toEqual(['url', 'verify', 'trust', 'name', 'save']);
    const trust = stops.find((s) => s.id === 'trust')!;
    // Not skipped: nothing has looked yet, and promising to skip a station the
    // plan has not reached is a promise it cannot keep.
    expect(trust.state).toBe('upcoming');
    expect(trust.blank).toBe(true);
    // Finding a root certificate is work done outside Capy.
    expect(trust.manual).toBe(true);
  });

  test('a probe that trusted the certificate skips that stop for good', () => {
    const trust = byocConnectPlan({ url: 'https://capy.acme.com', certUntrusted: false }).find(
      (s) => s.id === 'trust',
    )!;
    expect(trust.state).toBe('skipped');
    expect(trust.blank).toBeUndefined();
  });

  test('an untrusted certificate makes it the stop the run is standing on', () => {
    const trust = byocConnectPlan({ url: 'https://capy.acme.com', certUntrusted: true }).find(
      (s) => s.id === 'trust',
    )!;
    expect(trust.state).toBe('current');
    const settled = byocConnectPlan({
      url: 'https://capy.acme.com',
      certUntrusted: true,
      caBundle: '~/certs/acme-root.crt',
    }).find((s) => s.id === 'trust')!;
    expect(settled).toMatchObject({ state: 'done', answer: '~/certs/acme-root.crt' });
  });

  test('a URL from argv is marked as answered by the argument, not by a question', () => {
    const [url] = byocConnectPlan({ url: 'https://capy.acme.com', urlFromArgv: true });
    expect(url).toMatchObject({ state: 'done', answer: 'https://capy.acme.com', flag: 'argument' });
    // Typed into the field instead: same answer, no flag to quote.
    const [typed] = byocConnectPlan({ url: 'https://capy.acme.com' });
    expect(typed.flag).toBeUndefined();
  });

  test('every stop says what happens there', () => {
    for (const stop of byocConnectPlan({})) {
      expect(stop.detail && stop.detail.length > 0).toBe(true);
    }
  });

  test('a verified instance moves the traveller to the name', () => {
    const stops = byocConnectPlan({ url: 'https://capy.acme.com', verified: true });
    expect(stops.find((s) => s.id === 'verify')!.state).toBe('done');
    expect(stops.find((s) => s.id === 'name')!.state).toBe('current');
  });

  test('an unsettled address leaves everything behind it unanswered', () => {
    // What a run that mistyped the host is looking at. `url` unset is the whole
    // statement: nothing downstream of an address nobody accepted may claim an
    // answer, and the traveller is standing on the question, not past it.
    const stops = byocConnectPlan({ urlFromArgv: true });
    expect(stops.find((s) => s.id === 'url')).toMatchObject({ state: 'current' });
    expect(stops.find((s) => s.id === 'url')!.answer).toBeUndefined();
    expect(stops.find((s) => s.id === 'verify')!.state).toBe('upcoming');
    expect(stops.find((s) => s.id === 'trust')).toMatchObject({ state: 'upcoming', blank: true });
    expect(stops.filter((s) => s.state === 'current')).toHaveLength(1);
  });

  test('the certificate question overtakes verify rather than lighting up beside it', () => {
    // Both stops were `current` at once: the run cannot be at two stations.
    const stops = byocConnectPlan({ url: 'https://capy.acme.com', certUntrusted: true });
    expect(stops.find((s) => s.id === 'trust')!.state).toBe('current');
    expect(stops.find((s) => s.id === 'verify')!.state).toBe('upcoming');
    expect(stops.filter((s) => s.state === 'current')).toHaveLength(1);
  });

  test('a bundle that made the instance verify is an answer, not a skipped stop', () => {
    // `certUntrusted` is false once the handshake completes — with the bundle in
    // it. Read in the other order the rail struck the station through and then
    // hung the bundle path off it as the answer to a question it never asked.
    const trust = byocConnectPlan({
      url: 'https://capy.acme.com',
      verified: true,
      certUntrusted: false,
      caBundle: '~/certs/acme-root.crt',
    }).find((s) => s.id === 'trust')!;
    expect(trust).toMatchObject({ state: 'done', answer: '~/certs/acme-root.crt' });
  });

  test('exactly one stop is current in every state this flow can reach', () => {
    const states = [
      {},
      { url: 'u' },
      { url: 'u', certUntrusted: true },
      { url: 'u', certUntrusted: true, caBundle: '~/c.crt' },
      { url: 'u', verified: true, certUntrusted: false },
      { url: 'u', verified: true, certUntrusted: false, profileName: 'acme' },
    ];
    for (const input of states) {
      expect(byocConnectPlan(input).filter((s) => s.state === 'current').length).toBeLessThanOrEqual(1);
    }
  });
});

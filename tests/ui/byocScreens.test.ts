/**
 * `capy byoc <url> --web`, served as the compiled `byoc-connect` screen.
 *
 * The terminal version is a `while (true)` around a probe and a re-prompt whose
 * only exit other than success is Ctrl-C. Three of these tests exist because of
 * that shape:
 *
 *   - every failure carries a CODE, so the flow decides on `tls_untrusted`
 *     rather than on the word "self-signed" in a sentence somebody may reword
 *   - a bundle path that could not be read keeps the run on the bundle
 *     question. The terminal throws you back to the URL prompt, which asks
 *     about the one thing that was not wrong.
 *   - saving over a profile that already exists needs the toggle. The CLI's own
 *     confirm defaults to no, and `saveAndActivateProfile` upserts — the old
 *     address is kept nowhere.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildByocConnectData,
  byocView,
  connectByocInBrowser,
} from '../../src/ui/byocScreens';
import type { ProbeOutcome } from '../../src/ui/screens/contract';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 300 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

/**
 * The payload a served screen renders from, read back out of the document.
 *
 * `renderScreen` inlines it as `window.__CAPY_DATA__`, so this is what the page
 * itself sees — asserting on the JSON substring instead means a passing test
 * that depends on key order.
 */
export function servedPayload(html: string, nonce: string): Record<string, unknown> {
  const start = html.indexOf(`{"nonce":"${nonce}"`);
  if (start < 0) throw new Error('no __CAPY_DATA__ payload in the served document');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (escaped) escaped = false;
    else if (c === '\\') escaped = true;
    else if (c === '"') inString = !inString;
    else if (!inString && c === '{') depth++;
    else if (!inString && c === '}' && --depth === 0) {
      return JSON.parse(html.slice(start, i + 1)) as Record<string, unknown>;
    }
  }
  throw new Error('unterminated __CAPY_DATA__ payload');
}

function driver(pageUrl: string) {
  const u = new URL(pageUrl);
  const base = `http://127.0.0.1:${u.port}`;
  const nonce = u.searchParams.get('n') ?? '';
  return {
    nonce,
    page: async (): Promise<string> => (await fetch(pageUrl)).text(),
    post: async (payload: Record<string, unknown>) =>
      (
        await fetch(`${base}/submit`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ nonce, payload }),
        })
      ).json() as Promise<Record<string, unknown>>,
  };
}

const submit = (answer: Record<string, unknown>) => ({ __action: 'submit', ...answer });

const OK = (url: string): Omit<ProbeOutcome, 'attempt'> => ({
  url,
  code: 'ok',
  reason: 'found (capy service detected)',
});

const REFUSED = (url: string): Omit<ProbeOutcome, 'attempt'> => ({
  url,
  code: 'connection_failed',
  reason: 'connection failed (ECONNREFUSED)',
  transportCode: 'ECONNREFUSED',
});

const UNTRUSTED = (url: string): Omit<ProbeOutcome, 'attempt'> => ({
  url,
  code: 'tls_untrusted',
  reason: 'self-signed or untrusted TLS certificate',
  cert: {
    subject: 'capy.acme.com',
    issuer: 'Acme Internal Root',
    expires: '2027-01-01',
    expired: false,
  },
});

const BASE = {
  defaultUrl: 'https://capy.internal',
  urlSource: 'builtin' as const,
  suggestName: (url: string) => (url.includes('acme') ? 'acme' : 'byoc'),
  existingProfiles: [],
  open: false,
};

describe('byocView', () => {
  test('a verified instance is the name question and nothing else', () => {
    expect(byocView({ verified: true })).toBe('name');
  });

  test('only an untrusted certificate opens the CA sub-flow', () => {
    expect(byocView({ probe: { ...UNTRUSTED('u'), attempt: 1 } })).toBe('ca-trust');
    // Every other failure is the same question again, which is the terminal's
    // behaviour and the right one: the address is what it doubts.
    expect(byocView({ probe: { ...REFUSED('u'), attempt: 1 } })).toBe('url');
  });

  test('declining the bundle drops back to the address, exactly as the terminal does', () => {
    const probe = { ...UNTRUSTED('u'), attempt: 1 };
    expect(byocView({ probe, declinedBundle: true })).toBe('url');
    expect(byocView({ probe, bundleRequested: true })).toBe('ca-path');
  });

  test('a bundle that could not be read keeps the question where it was', () => {
    expect(
      byocView({
        probe: { url: 'u', code: 'ca_unreadable', reason: 'cannot read CA bundle', attempt: 2 },
      }),
    ).toBe('ca-path');
  });
});

describe('buildByocConnectData', () => {
  test('opens on the address, with the whole route already drawn', () => {
    const d = buildByocConnectData(BASE, 'n');
    expect(d.step).toBe('url');
    expect(d.defaultUrl).toBe('https://capy.internal');
    expect(d.urlSource).toBe('builtin');
    expect(d.stops.map((s) => s.id)).toEqual(['url', 'verify', 'trust', 'name', 'save']);
    expect(d.probe).toBeUndefined();
  });

  test('a URL from argv says so on the rail', () => {
    const d = buildByocConnectData(
      { ...BASE, urlSource: 'argv', defaultUrl: 'https://capy.acme.com' },
      'n',
    );
    expect(d.urlSource).toBe('argv');
    expect(d.stops.find((s) => s.id === 'url')!.flag).toBeUndefined();
    // Once the address is settled, the rail names the argument that answered
    // it. Settled means a probe accepted it — an argument is a prefill for the
    // question, not a way around it.
    const answered = buildByocConnectData(
      {
        ...BASE,
        urlSource: 'argv',
        state: {
          url: 'https://capy.acme.com',
          urlFromArgv: true,
          verified: true,
          probe: { ...OK('https://capy.acme.com'), attempt: 1 },
        },
      },
      'n',
    );
    expect(answered.stops.find((s) => s.id === 'url')).toMatchObject({
      state: 'done',
      flag: 'argument',
    });
  });

  test('a failed probe does not settle the address, or anything behind it', () => {
    // THE RAIL DEFECT. `capy byoc https://nope.invalid --web`, host mistyped:
    // the page is asking for the address again while the rail beside it read
    // `Server URL https://nope.invalid` (done), `Verify ← you are here`, and
    // `Certificate not needed` — three false statements at once, the last of
    // them struck through on the strength of a probe that never completed a
    // handshake.
    const state = {
      url: 'https://nope.invalid',
      urlFromArgv: true,
      probe: { ...REFUSED('https://nope.invalid'), attempt: 1 },
    };
    const d = buildByocConnectData({ ...BASE, urlSource: 'argv', state }, 'n');

    expect(d.step).toBe('url');
    const stop = (id: string) => d.stops.find((s) => s.id === id)!;
    expect(stop('url').state).toBe('current');
    expect(stop('url').answer).toBeUndefined();
    expect(stop('verify').state).toBe('upcoming');
    expect(stop('trust')).toMatchObject({ state: 'upcoming', blank: true });
    expect(d.stops.filter((s) => s.state === 'current')).toHaveLength(1);
    // The failure itself still travels, and the field still holds what was
    // typed: the address is edited, not retyped.
    expect(d.probe!.code).toBe('connection_failed');
    expect(d.defaultUrl).toBe('https://nope.invalid');
  });

  test('only a completed handshake may strike the certificate stop through', () => {
    // The three failures that never reach a certificate at all.
    for (const code of ['connection_failed', 'http_status', 'not_capy'] as const) {
      const d = buildByocConnectData(
        {
          ...BASE,
          state: {
            url: 'https://capy.acme.com',
            probe: { url: 'https://capy.acme.com', code, reason: 'nope', attempt: 1 },
          },
        },
        'n',
      );
      expect(d.stops.find((s) => s.id === 'trust')!.state).not.toBe('skipped');
    }
    // A handshake that completed is the one thing that answers it.
    const ok = buildByocConnectData(
      {
        ...BASE,
        state: {
          url: 'https://capy.acme.com',
          verified: true,
          probe: { ...OK('https://capy.acme.com'), attempt: 1 },
        },
      },
      'n',
    );
    expect(ok.stops.find((s) => s.id === 'trust')!.state).toBe('skipped');
  });

  test('a bundle that worked is the certificate stop\'s answer', () => {
    const d = buildByocConnectData(
      {
        ...BASE,
        state: {
          url: 'https://capy.acme.com',
          verified: true,
          caBundle: '~/certs/root.crt',
          probe: { ...OK('https://capy.acme.com'), attempt: 2 },
        },
      },
      'n',
    );
    expect(d.stops.find((s) => s.id === 'trust')).toMatchObject({
      state: 'done',
      answer: '~/certs/root.crt',
    });
  });

  test('standing on the certificate question, the rail says so and only so', () => {
    const d = buildByocConnectData(
      {
        ...BASE,
        state: {
          url: 'https://capy.acme.com',
          probe: { ...UNTRUSTED('https://capy.acme.com'), attempt: 1 },
        },
      },
      'n',
    );
    expect(d.step).toBe('ca-trust');
    expect(d.stops.find((s) => s.id === 'url')).toMatchObject({
      state: 'done',
      answer: 'https://capy.acme.com',
    });
    expect(d.stops.find((s) => s.id === 'trust')!.state).toBe('current');
    expect(d.stops.filter((s) => s.state === 'current')).toHaveLength(1);
  });

  test('the failure travels as a code with its sentence beside it, never instead of it', () => {
    const d = buildByocConnectData(
      { ...BASE, state: { url: 'https://capy.internal', probe: { ...REFUSED('https://capy.internal'), attempt: 2 } } },
      'n',
    );
    expect(d.probe!.code).toBe('connection_failed');
    expect(d.probe!.transportCode).toBe('ECONNREFUSED');
    // The CLI's own line, quoted so a user searching their scrollback finds it.
    expect(d.probe!.reason).toBe('connection failed (ECONNREFUSED)');
    expect(d.probe!.attempt).toBe(2);
  });

  test('the certificate reaches the trust step, which is the point of the step', () => {
    const d = buildByocConnectData(
      {
        ...BASE,
        state: { url: 'https://capy.acme.com', probe: { ...UNTRUSTED('https://capy.acme.com'), attempt: 1 } },
      },
      'n',
    );
    expect(d.step).toBe('ca-trust');
    expect(d.probe!.cert).toMatchObject({ subject: 'capy.acme.com', issuer: 'Acme Internal Root' });
  });

  test('the suggested name only appears on the step that asks for one', () => {
    expect(buildByocConnectData(BASE, 'n').suggestedName).toBeUndefined();
    const d = buildByocConnectData(
      { ...BASE, state: { url: 'https://capy.acme.com', verified: true } },
      'n',
    );
    expect(d.step).toBe('name');
    expect(d.suggestedName).toBe('acme');
  });

  test('renders no secret material — a URL, a name and a path to a public cert', () => {
    const json = JSON.stringify(
      buildByocConnectData(
        { ...BASE, state: { url: 'https://capy.acme.com', verified: true, typedBundlePath: '~/certs/root.crt' } },
        'n',
      ),
    );
    expect(json).not.toContain('sk_');
    expect(json).not.toContain('BEGIN');
  });
});

describe('connectByocInBrowser', () => {
  test('the happy path: verify, name, save', async () => {
    let url = '';
    const probed: Array<[string, string | undefined]> = [];
    const done = connectByocInBrowser({
      ...BASE,
      urlSource: 'argv',
      defaultUrl: 'https://capy.acme.com',
      probe: async (u, ca) => {
        probed.push([u, ca]);
        return OK(u);
      },
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    expect(await d.post(submit({ step: 'url', url: 'https://capy.acme.com' }))).toEqual({
      next: true,
    });
    expect(probed).toEqual([['https://capy.acme.com', undefined]]);
    expect(await d.page()).toContain('"step":"name"');

    await d.post(submit({ step: 'name', name: 'acme', replace: false }));
    expect(await done).toEqual({
      url: 'https://capy.acme.com',
      caBundle: undefined,
      profileName: 'acme',
      replaced: false,
      cancelled: false,
    });
  });

  test('a failed probe asks again, and counts how far the run has wandered', async () => {
    // The terminal's loop has no count at all, so a user three URLs deep has no
    // idea how far they are from what they typed.
    let url = '';
    let calls = 0;
    const done = connectByocInBrowser({
      ...BASE,
      probe: async (u) => (++calls === 1 ? REFUSED(u) : OK(u)),
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ step: 'url', url: 'https://capy.internal' }));
    const retry = await d.page();
    expect(retry).toContain('"step":"url"');
    expect(retry).toContain('"attempt":1');
    expect(retry).toContain('"code":"connection_failed"');

    await d.post(submit({ step: 'url', url: 'https://capy.acme.com' }));
    expect(await d.page()).toContain('"attempt":2');
    await d.post(submit({ step: 'name', name: 'acme' }));
    expect((await done).url).toBe('https://capy.acme.com');
  });

  test('an untrusted certificate offers a bundle, and the bundle is verified before it is kept', async () => {
    let url = '';
    const done = connectByocInBrowser({
      ...BASE,
      probe: async (u, ca) => (ca ? OK(u) : UNTRUSTED(u)),
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ step: 'url', url: 'https://capy.acme.com' }));
    expect(await d.page()).toContain('"step":"ca-trust"');

    await d.post(submit({ step: 'ca-trust', trust: true }));
    expect(await d.page()).toContain('"step":"ca-path"');

    await d.post(submit({ step: 'ca-path', caBundle: ' ~/certs/root.crt ' }));
    expect(await d.page()).toContain('"step":"name"');

    await d.post(submit({ step: 'name', name: 'acme' }));
    expect(await done).toMatchObject({
      url: 'https://capy.acme.com',
      caBundle: '~/certs/root.crt',
      profileName: 'acme',
    });
  });

  test('declining the bundle goes back to the address and trusts nothing', async () => {
    let url = '';
    const done = connectByocInBrowser({
      ...BASE,
      probe: async (u) => (u.includes('acme') ? UNTRUSTED(u) : OK(u)),
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ step: 'url', url: 'https://capy.acme.com' }));
    await d.post(submit({ step: 'ca-trust', trust: false }));
    expect(await d.page()).toContain('"step":"url"');

    await d.post(submit({ step: 'url', url: 'https://capy.internal' }));
    await d.post(submit({ step: 'name', name: 'internal' }));
    expect(await done).toMatchObject({ url: 'https://capy.internal', caBundle: undefined });
  });

  test('a bundle that cannot be read keeps the run on the bundle question', async () => {
    let url = '';
    const done = connectByocInBrowser({
      ...BASE,
      probe: async (u, ca) => {
        if (!ca) return UNTRUSTED(u);
        if (ca.includes('typo')) {
          return { url: u, code: 'ca_unreadable', reason: 'cannot read CA bundle: ENOENT' };
        }
        return OK(u);
      },
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ step: 'url', url: 'https://capy.acme.com' }));
    await d.post(submit({ step: 'ca-trust', trust: true }));
    await d.post(submit({ step: 'ca-path', caBundle: '~/certs/typo.crt' }));

    const again = await d.page();
    expect(again).toContain('"step":"ca-path"');
    expect(again).toContain('"code":"ca_unreadable"');
    // The typo is prefilled so it is edited rather than retyped.
    expect(again).toContain('"caBundlePath":"~/certs/typo.crt"');

    await d.post(submit({ step: 'ca-path', caBundle: '~/certs/root.crt' }));
    await d.post(submit({ step: 'name', name: 'acme' }));
    expect((await done).caBundle).toBe('~/certs/root.crt');
  });

  test('a readable bundle that still does not chain returns to the address', async () => {
    // The path opened and the instance still would not verify, so a better path
    // is not the answer — the address or the instance is. The terminal reaches
    // the same conclusion by construction: its loop only offers the bundle
    // question while `!caBundle`, and falls through to `promptForUrl`. This flow
    // used to clear both flags and ask "trust it via a CA bundle?" all over
    // again, which is the one question the run had already answered twice.
    let url = '';
    const done = connectByocInBrowser({
      ...BASE,
      probe: async (u) => (u.includes('internal') ? OK(u) : UNTRUSTED(u)),
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ step: 'url', url: 'https://capy.acme.com' }));
    await d.post(submit({ step: 'ca-trust', trust: true }));
    await d.post(submit({ step: 'ca-path', caBundle: '~/certs/root.crt' }));

    const back = servedPayload(await d.page(), d.nonce);
    expect(back.step).toBe('url');
    // And the address it could not settle is not ticked off on the rail.
    const backStops = back.stops as Array<{ id: string; state: string }>;
    expect(backStops.find((s) => s.id === 'url')!.state).toBe('current');

    await d.post(submit({ step: 'url', url: 'https://capy.internal' }));
    await d.post(submit({ step: 'name', name: 'internal' }));
    expect(await done).toMatchObject({ url: 'https://capy.internal', caBundle: undefined });
  });

  test('a failed probe puts the rail back on the address with the page', async () => {
    // End to end over the loopback, because this is what `capy byoc <host>
    // --web` serves the moment the host is wrong: the whole route, all of it
    // still unanswered.
    let url = '';
    const done = connectByocInBrowser({
      ...BASE,
      urlSource: 'argv',
      defaultUrl: 'https://nope.invalid',
      timeoutMs: 4_000,
      probe: async (u) => REFUSED(u),
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ step: 'url', url: 'https://nope.invalid' }));

    const data = servedPayload(await d.page(), d.nonce);
    expect(data.step).toBe('url');
    expect((data.probe as { code: string }).code).toBe('connection_failed');
    const stops = data.stops as Array<{ id: string; state: string; answer?: string }>;
    // The three false statements, in the payload that produced them.
    expect(stops.find((s) => s.id === 'url')!.state).toBe('current');
    expect(stops.find((s) => s.id === 'verify')!.state).toBe('upcoming');
    expect(stops.find((s) => s.id === 'trust')!.state).toBe('upcoming');

    await d.post({ __action: 'cancel' });
    await done;
  });

  test('overwriting a profile that already exists has to be agreed to', async () => {
    let url = '';
    const done = connectByocInBrowser({
      ...BASE,
      existingProfiles: [{ name: 'acme', url: 'https://old.acme.com', active: true }],
      probe: async (u) => OK(u),
      onListen: (u) => (url = u),
    });

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ step: 'url', url: 'https://capy.acme.com' }));
    // The screen holds its button until the replace toggle is on, so this can
    // only arrive from something that is not the screen — and applying it would
    // discard an address kept nowhere else.
    expect((await d.post(submit({ step: 'name', name: 'acme' }))).error).toContain(
      'has to be agreed to',
    );

    await d.post(submit({ step: 'name', name: 'acme', replace: true }));
    expect(await done).toMatchObject({ profileName: 'acme', replaced: true });
  });

  test('a profile name the CLI would reject never reaches the config', async () => {
    let url = '';
    const done = connectByocInBrowser({
      ...BASE,
      timeoutMs: 4_000,
      probe: async (u) => OK(u),
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ step: 'url', url: 'https://capy.acme.com' }));
    expect((await d.post(submit({ step: 'name', name: '  ' }))).error).toBe('Name required');
    expect((await d.post(submit({ step: 'name', name: '-nope' }))).error).toContain(
      'letters, digits, hyphen, underscore',
    );
    await d.post({ __action: 'cancel' });
    await done;
  });

  test('a certificate answer that is not a boolean is refused', async () => {
    let url = '';
    const done = connectByocInBrowser({
      ...BASE,
      timeoutMs: 4_000,
      probe: async (u) => UNTRUSTED(u),
      onListen: (u) => (url = u),
    });
    void done.catch(() => undefined);

    const d = driver(await waitForUrl(() => url));
    await d.post(submit({ step: 'url', url: 'https://capy.acme.com' }));
    expect((await d.post(submit({ step: 'ca-trust', trust: 'yes' }))).error).toContain(
      'not an answer the certificate step can produce',
    );
    await d.post({ __action: 'cancel' });
    await done;
  });

  test('cancelling writes nothing', async () => {
    let url = '';
    const done = connectByocInBrowser({
      ...BASE,
      probe: async (u) => OK(u),
      onListen: (u) => (url = u),
    });
    const d = driver(await waitForUrl(() => url));
    await d.post({ __action: 'cancel' });
    expect(await done).toEqual({ url: '', profileName: '', replaced: false, cancelled: true });
  });
});

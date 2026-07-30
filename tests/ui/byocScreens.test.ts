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

function driver(pageUrl: string) {
  const u = new URL(pageUrl);
  const base = `http://127.0.0.1:${u.port}`;
  const nonce = u.searchParams.get('n') ?? '';
  return {
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
    // Once answered, the rail names the argument that answered it.
    const answered = buildByocConnectData(
      {
        ...BASE,
        urlSource: 'argv',
        state: { url: 'https://capy.acme.com', urlFromArgv: true },
      },
      'n',
    );
    expect(answered.stops.find((s) => s.id === 'url')!.flag).toBe('argument');
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

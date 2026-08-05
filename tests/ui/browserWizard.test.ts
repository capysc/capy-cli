import { describe, test, expect } from 'bun:test';
import { runBrowserWizard } from '../../src/ui/browserWizard';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 200 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

describe('runBrowserWizard loopback server', () => {
  test('serves the first screen, gates nonce/origin, advances through steps, and returns the result', async () => {
    let url = '';
    const seen: Array<{ step: number; payload: Record<string, unknown> }> = [];
    const done = runBrowserWizard(
      {
        title: 'Set up Capy',
        firstScreen: { html: '<form><input name="org" value="acme"><button type="submit">next</button></form>' },
        open: false,
        onListen: (u) => (url = u),
      },
      async (step, payload) => {
        seen.push({ step, payload });
        if (step === 0) return { screen: { html: '<form id="s2"><input name="project" value="web"><button type="submit">finish</button></form>' } };
        return { done: true, result: { org: seen[0].payload.org, project: payload.project } };
      },
    );

    const u0 = new URL(await waitForUrl(() => url));
    expect(`${u0.protocol}//${u0.host}${u0.pathname}`).toBe(`http://127.0.0.1:${u0.port}/`);
    const base = `http://127.0.0.1:${u0.port}`;
    const nonce = u0.searchParams.get('n') ?? '';

    // GET the page: 200, carries the nonce + title.
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(nonce);
    expect(html).toContain('Set up Capy');

    // GET with a wrong nonce → 403.
    expect((await fetch(`${base}/?n=wrong`)).status).toBe(403);

    // POST with a present-but-wrong Origin → 403 (DNS-rebind guard).
    const badOrigin = await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { ...headers, origin: 'http://evil.com' },
      body: JSON.stringify({ nonce, payload: { org: 'acme' } }),
    });
    expect(badOrigin.status).toBe(403);

    // POST with a wrong nonce → 403, nothing delivered.
    expect((await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce: 'wrong', payload: {} }) })).status).toBe(403);
    expect(seen.length).toBe(0);

    // Step 0 submit → 200, returns the next screen's HTML.
    const r0 = await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: { org: 'acme' } }) });
    expect(r0.status).toBe(200);
    const b0 = await r0.json();
    expect(b0.screen).toContain('name="project"');
    expect(b0.done).toBeUndefined();

    // Step 1 submit → 200 done.
    const r1 = await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: { project: 'web' } }) });
    expect(r1.status).toBe(200);
    expect((await r1.json()).done).toBe(true);

    const result = await done;
    expect(result).toEqual({ org: 'acme', project: 'web' });
    expect(seen.map((s) => s.step)).toEqual([0, 1]);
  });

  test('an inline error keeps the wizard open (no done, no result)', async () => {
    let url = '';
    let resolved = false;
    const done = runBrowserWizard(
      {
        title: 'T',
        firstScreen: { html: '<form><input name="x"><button type="submit">go</button></form>' },
        open: false,
        onListen: (u) => (url = u),
      },
      async (_step, payload) => {
        if (!payload.x) return { error: 'x is required' };
        return { done: true, result: payload };
      },
    );
    void done.then(() => (resolved = true));

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    // Missing field → inline error, 200, NOT done.
    const err = await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: {} }) });
    expect(err.status).toBe(200);
    expect((await err.json()).error).toBe('x is required');
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    // Now a valid submit finishes it.
    const ok = await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: { x: 'v' } }) });
    expect((await ok.json()).done).toBe(true);
    expect(await done).toEqual({ x: 'v' });
  });

  test('a side-route answer re-arms the question deadline', async () => {
    /*
     * `secret-table` asks for one value's plaintext with `{ __action:
     * 'reveal' }` — a question, not an answer — and the reducer replies with
     * `{ body }`, leaving the flow on the same step.
     *
     * Every POST disarms the per-question clock, because while the reducer is
     * working the browser owes us nothing. A branch that never re-arms it
     * therefore removes the deadline for the REST OF THE RUN: a `capy edit
     * --web` where one value was revealed could have its window closed and the
     * command would wait for a browser that is never coming back.
     *
     * So: reveal, then go silent, and the run must still end.
     */
    let url = '';
    let rejected: unknown = null;
    const done = runBrowserWizard(
      {
        title: 'Reveal then vanish',
        firstScreen: { html: '<form><button type="submit">go</button></form>' },
        open: false,
        timeoutMs: 400,
        onListen: (u) => (url = u),
      },
      async (_step, payload) =>
        payload.__action === 'reveal'
          ? { body: { value: 'sk_test_…' } }
          : { done: true, result: { finished: true } },
    );
    void done.catch((e) => (rejected = e));

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const revealed = await (
      await fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce, payload: { __action: 'reveal', key: 'STRIPE_KEY' } }),
      })
    ).json();
    // The side route really did answer, and did not advance the flow.
    expect(revealed.value).toBe('sk_test_…');
    expect(revealed.done).toBeUndefined();
    expect(revealed.screen).toBeUndefined();

    // Now say nothing. The same question is still on screen, so the clock the
    // reveal disarmed has to be running again.
    await new Promise((r) => setTimeout(r, 900));
    expect(
      rejected,
      'the run outlived its deadline after a reveal — the side route disarmed the clock and never re-armed it',
    ).not.toBeNull();
  });

  test('a screen may submit a structured payload, not just flat form fields', async () => {
    // The reason `window.capySubmit` exists. FormData flattens to string keys
    // and string values, so a step whose answer is a decision per variable —
    // the conflict resolver — or an array of name/value pairs — secret intake
    // — could only travel by encoding structure into field NAMES and having
    // the reducer parse it back out. This asserts the reducer receives the
    // shape the screen sent, nested and typed, over the same endpoint.
    let url = '';
    let received: Record<string, unknown> | undefined;
    const done = runBrowserWizard(
      {
        title: 'Resolve conflicts',
        firstScreen: { html: '<div id="resolver"></div>' },
        open: false,
        onListen: (u) => (url = u),
      },
      async (_step, payload) => {
        received = payload;
        return { done: true, result: payload };
      },
    );

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    const structured = {
      resolutions: [
        { key: 'STRIPE_KEY', take: 'remote' },
        { key: 'DATABASE_URL', take: 'local' },
      ],
      applyToAll: false,
      count: 2,
    };
    const res = await fetch(`${base}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: structured }),
    });
    expect((await res.json()).done).toBe(true);
    await done;

    // Arrays stay arrays, booleans stay booleans, numbers stay numbers — none
    // of which survives a FormData round trip.
    expect(received).toEqual(structured);
    expect(Array.isArray((received as { resolutions: unknown }).resolutions)).toBe(true);
    expect((received as { applyToAll: unknown }).applyToAll).toBe(false);
    expect((received as { count: unknown }).count).toBe(2);
  });

  test('the page exposes capySubmit and still serializes plain forms', async () => {
    // Both entry points must be present: the JSON path is additive, and every
    // hand-written screen on this branch is a form.
    let url = '';
    const done = runBrowserWizard(
      {
        title: 'Both paths',
        firstScreen: { html: '<form><button type="submit">go</button></form>' },
        open: false,
        onListen: (u) => (url = u),
      },
      async () => ({ done: true, result: {} }),
    );

    const html = await (await fetch(await waitForUrl(() => url))).text();
    expect(html).toContain('window.capySubmit');
    // The delegated form handler survives — it is what the existing screens use.
    expect(html).toContain('new FormData(form)');
    // One transport, not two: both paths reach the same POST, so the nonce and
    // the response contract cannot drift apart per screen technology.
    expect(html.match(/fetch\('\/submit'/g) ?? []).toHaveLength(1);

    const u = new URL(url);
    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce: u.searchParams.get('n'), payload: {} }),
    });
    await done;
  });

  test('a standalone step is served whole, and advancing is a reload', async () => {
    // The bridge to the compiled screens. Those are complete documents — their
    // own head, their own inlined styles and script — so they cannot be handed
    // back as a fragment for the current page to splice in. The CLI holds the
    // next one and the browser re-requests the page to get it.
    let url = '';
    const done = runBrowserWizard(
      {
        title: 'Compiled flow',
        firstScreen: { html: '<!DOCTYPE html><html><body>STEP ONE</body></html>', standalone: true },
        open: false,
        onListen: (u) => (url = u),
      },
      async (step) =>
        step === 0
          ? { screen: { html: '<!DOCTYPE html><html><body>STEP TWO</body></html>', standalone: true } }
          : { done: true, result: { finished: true } },
    );

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    // Served as itself: no wizard shell wrapped around it.
    const first = await (await fetch(url)).text();
    expect(first).toContain('STEP ONE');
    expect(first).not.toContain('id="screen"');
    expect(first).not.toContain('window.capySubmit');

    // Advancing does NOT push the markup down the open request — it says only
    // that another step exists.
    const advance = await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: {} }) });
    const body = await advance.json();
    expect(body.next).toBe(true);
    expect(body.screen).toBeUndefined();

    // The same URL now returns the NEXT step. This is what makes the reload in
    // the ui Wizard land somewhere new instead of redrawing the question that
    // was just answered.
    const second = await (await fetch(url)).text();
    expect(second).toContain('STEP TWO');
    expect(second).not.toContain('STEP ONE');

    const finish = await fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: {} }) });
    expect((await finish.json()).done).toBe(true);
    expect(await done).toEqual({ finished: true });
  });

  test('a shell step still swaps in place and is not affected by standalone', async () => {
    // The existing hand-written screens must keep advancing without a reload:
    // their markup IS pushed down the open request.
    let url = '';
    const done = runBrowserWizard(
      {
        title: 'Shell flow',
        firstScreen: { html: '<form><button type="submit">go</button></form>' },
        open: false,
        onListen: (u) => (url = u),
      },
      async (step) =>
        step === 0 ? { screen: { html: '<form id="s2"></form>' } } : { done: true, result: {} },
    );

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: {} }),
    });
    const body = await res.json();
    expect(body.screen).toContain('id="s2"');
    expect(body.next).toBeUndefined();

    await fetch(`http://127.0.0.1:${u.port}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: {} }) });
    await done;
  });

  test('the clock stops while the reducer works, and starts again with the next question', async () => {
    // The budget is per QUESTION, not per run. A flow that holds one window
    // across a whole first run spends most of its life in here — creating an
    // organization, showing 24 words — with nothing outstanding that a person
    // could answer, and killing the window for that is killing it for being
    // used.
    let url = '';
    let rejected: unknown = null;
    const done = runBrowserWizard(
      {
        title: 'Slow',
        firstScreen: { html: '<form><button type="submit">go</button></form>' },
        open: false,
        timeoutMs: 400,
        onListen: (u) => (url = u),
      },
      async (step) => {
        // Longer than the whole per-question budget, twice over.
        await new Promise((r) => setTimeout(r, 1_200));
        return step === 0 ? { screen: { html: '<form id="s2"></form>' } } : { done: true, result: { finished: true } };
      },
    );
    void done.catch((e) => (rejected = e));

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const post = () =>
      fetch(`http://127.0.0.1:${u.port}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: {} }) });

    expect((await (await post()).json()).screen).toContain('id="s2"');
    expect(rejected).toBeNull();
    expect(await post()).toBeDefined();
    expect(await done).toEqual({ finished: true });
  });

  test('a flow can END on a screen, and the wizard resolves once it is collected', async () => {
    // The third ending. `{ done: true }` says "this worked" in the only place
    // that can say it — the page, which draws its ending from the control the
    // user pressed — so a run that STOPPED has to hand over a document
    // instead: the reason, and no question on it.
    let url = '';
    let settled = false;
    const done = runBrowserWizard(
      {
        title: 'Stops',
        firstScreen: { html: '<form><button type="submit">go</button></form>', standalone: true },
        open: false,
        timeoutMs: 20_000,
        finalGraceMs: 20_000,
        onListen: (u) => (url = u),
      },
      async () => ({
        screen: { html: '<!DOCTYPE html><html><body>THE RUN STOPPED</body></html>', standalone: true, final: true },
        result: { cancelled: true },
      }),
    );
    void done.then(() => (settled = true));

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';
    const res = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: {} }),
    });
    // Told to reload — NOT told it is done, which is what draws the check.
    expect(await res.json()).toEqual({ next: true });
    // Not over until the page has actually been handed over: a socket that
    // closes the moment it is listening serves nobody.
    expect(settled).toBe(false);

    expect(await (await fetch(u.href)).text()).toContain('THE RUN STOPPED');
    expect(await done).toEqual({ cancelled: true });

    // And nothing more may be answered on it.
    const after = await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce, payload: {} }),
    }).catch(() => ({ status: 0 }));
    expect([0, 409]).toContain(after.status);
  });

  test('a final screen nobody comes back for still ends the run', async () => {
    // The window was already closed when the run died. The ending has nowhere
    // to be delivered, and the CLI still has to exit.
    let url = '';
    const started = Date.now();
    const done = runBrowserWizard(
      {
        title: 'Stops',
        firstScreen: { html: '<form><button type="submit">go</button></form>', standalone: true },
        open: false,
        timeoutMs: 20_000,
        finalGraceMs: 300,
        onListen: (u) => (url = u),
      },
      async () => ({
        screen: { html: '<!DOCTYPE html><html><body>THE RUN STOPPED</body></html>', standalone: true, final: true },
        result: { cancelled: true },
      }),
    );

    const u = new URL(await waitForUrl(() => url));
    await fetch(`http://127.0.0.1:${u.port}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nonce: u.searchParams.get('n') ?? '', payload: {} }),
    });

    expect(await done).toEqual({ cancelled: true });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('a wizard that finishes normally takes its SIGINT handler with it', async () => {
    // Every run registered one and removed none. One flow opens two wizards
    // per edited variable, so a normal editing session walked the listener
    // count up until node started warning about a leak — and every stale
    // handler still holds a closure over a server that is long gone.
    const before = process.listenerCount('SIGINT');

    for (let i = 0; i < 4; i++) {
      let url = '';
      const done = runBrowserWizard(
        { title: 'x', firstScreen: { html: '<form></form>' }, open: false, onListen: (u) => (url = u) },
        async () => ({ done: true, result: { i } }),
      );
      const u = new URL(await waitForUrl(() => url));
      await fetch(`http://127.0.0.1:${u.port}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce: u.searchParams.get('n'), payload: {} }),
      });
      await done;
    }

    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('closing the window, when a flow says that is a refusal', () => {
  const params = (onListen: (u: string) => void) => ({
    title: 'Close me',
    firstScreen: { html: '<!DOCTYPE html><html><body><h1>step</h1></body></html>', standalone: true },
    open: false,
    onListen,
    timeoutMs: 30_000,
    closeIsRefusal: { result: { action: 'cancel' }, graceMs: 200 },
  });

  /**
   * The beacon the served document actually sends: the nonce, and the
   * GENERATION of the document that is leaving. Nothing read off the page.
   */
  const beacon = (base: string, nonce: string, gen: number) =>
    fetch(`${base}/__closed`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: { gen } }) });

  const submit = (base: string, nonce: string) =>
    fetch(`${base}/submit`, { method: 'POST', headers, body: JSON.stringify({ nonce, payload: {} }) });

  test('the beacon is only in the document when the flow asked for one', async () => {
    let withUrl = '';
    let withoutUrl = '';
    const opted = runBrowserWizard(params((u) => (withUrl = u)), async () => ({ done: true, result: {} }));
    const plain = runBrowserWizard(
      { ...params((u) => (withoutUrl = u)), closeIsRefusal: undefined },
      async () => ({ done: true, result: {} }),
    );
    void opted.catch(() => undefined);
    void plain.catch(() => undefined);

    expect(await (await fetch(await waitForUrl(() => withUrl))).text()).toContain('/__closed');
    // Unchanged for every other flow: nothing is injected, and a closed window
    // stays what it was — a step nobody answered.
    expect(await (await fetch(await waitForUrl(() => withoutUrl))).text()).not.toContain('/__closed');

    for (const [url, p] of [[withUrl, opted], [withoutUrl, plain]] as const) {
      const u = new URL(url);
      await submit(`http://127.0.0.1:${u.port}`, u.searchParams.get('n') ?? '');
      await p;
    }
  });

  test('each served document is stamped with its own generation', async () => {
    // The stamp is what a beacon carries back, so it has to differ per serve —
    // two documents claiming to be the same one is the whole defect, restated.
    let url = '';
    const done = runBrowserWizard(params((u) => (url = u)), async () => ({ done: true, result: {} }));
    void done.catch(() => undefined);

    const first = await (await fetch(await waitForUrl(() => url))).text();
    const second = await (await fetch(url)).text();
    expect(first).toContain('gen:1');
    expect(second).toContain('gen:2');

    const u = new URL(url);
    await submit(`http://127.0.0.1:${u.port}`, u.searchParams.get('n') ?? '');
    await done;
  });

  test('it goes through the same guards as an answer', async () => {
    let url = '';
    const done = runBrowserWizard(params((u) => (url = u)), async () => ({ done: true, result: {} }));
    void done.catch(() => undefined);

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';
    // The document has to have gone out for its generation to be the current one.
    await fetch(url);

    // A refusal that ends a run is a request that has to prove where it came
    // from: same Origin pin and same constant-time nonce as `/submit`.
    expect(
      (await fetch(`${base}/__closed`, {
        method: 'POST',
        headers: { ...headers, origin: 'http://evil.com' },
        body: JSON.stringify({ nonce, payload: { gen: 1 } }),
      })).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/__closed`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nonce: 'wrong', payload: { gen: 1 } }),
      })).status,
    ).toBe(403);

    const ok = await beacon(base, nonce, 1);
    expect(ok.status).toBe(204);
    expect(await done).toEqual({ action: 'cancel' });
  });

  test('a beacon from a document that was already REPLACED is a reload, not a close', async () => {
    // THE REGRESSION THIS EXISTS FOR. A standalone step advances by reloading,
    // so `pagehide` fires on a perfectly healthy advance — and `sendBeacon` is
    // fire-and-forget, so it is processed AFTER the GET for the next document,
    // measured at about +4ms, every run. A flow that believed the beacon unless
    // something re-requested the page inside a grace therefore armed a
    // self-destruct on EVERY advance: the re-request had already happened, so
    // there was nothing left to cancel it, and the run ended ~1.2s later while
    // the person was still reading the step in front of them.
    //
    // The ordering below is that measured one, written down: re-serve first,
    // beacon for the OLD generation second. Nothing here waits on a race.
    let url = '';
    let settled: unknown = 'not settled';
    const done = runBrowserWizard(params((u) => (url = u)), async (step) =>
      step === 0
        ? { screen: { html: '<!DOCTYPE html><html><body><h1>step two</h1></body></html>', standalone: true } }
        : { done: true, result: { answered: true } },
    );
    void done.then((r) => (settled = r)).catch((e) => (settled = e));

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    // Generation 1 goes out, and is answered.
    expect(await (await fetch(url)).text()).toContain('gen:1');
    expect(await (await submit(base, nonce)).json()).toEqual({ next: true });

    // The advance: the browser reloads and receives generation 2 …
    expect(await (await fetch(url)).text()).toContain('step two');
    // … and only THEN does generation 1's `pagehide` beacon land.
    expect((await beacon(base, nonce, 1)).status).toBe(204);

    // Wait out several graces — the pause a person takes reading a new step.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(settled).toBe('not settled');

    // The step the person is looking at still answers, which is what the defect
    // took away: the CLI had already returned and the socket was gone.
    await submit(base, nonce);
    expect(await done).toEqual({ answered: true });
  });

  test('a page that comes straight back was reloading, not leaving', async () => {
    // The other ordering — beacon first, reload second. The generation is still
    // current when the beacon lands, so the grace is armed; the reload bumps it
    // and the timer finds itself stale when it fires.
    let url = '';
    let settled = false;
    const done = runBrowserWizard(params((u) => (url = u)), async () => ({ done: true, result: { answered: true } }));
    void done.then(() => (settled = true)).catch(() => undefined);

    const u = new URL(await waitForUrl(() => url));
    const base = `http://127.0.0.1:${u.port}`;
    const nonce = u.searchParams.get('n') ?? '';

    await fetch(url);
    await beacon(base, nonce, 1);
    // The reload lands well inside the 200ms grace.
    expect((await fetch(url)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);

    // …and the step it came back to still answers.
    await submit(base, nonce);
    expect(await done).toEqual({ answered: true });
  });

  test('a window that really closes still ends the run, promptly', async () => {
    // The property the beacon is FOR, kept: nothing comes back for the
    // generation that left, so it is a refusal and the run stops saying so.
    let url = '';
    const started = Date.now();
    const done = runBrowserWizard(params((u) => (url = u)), async () => ({ done: true, result: { answered: true } }));

    const u = new URL(await waitForUrl(() => url));
    await fetch(url);
    await beacon(`http://127.0.0.1:${u.port}`, u.searchParams.get('n') ?? '', 1);

    expect(await done).toEqual({ action: 'cancel' });
    // Not the 30s question deadline: an ending, not a timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

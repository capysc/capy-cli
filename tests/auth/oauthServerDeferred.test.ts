/**
 * OAuthServer deferred-completion mode (CAP-376 keep-screens fork), against
 * a REAL loopback server: the successful callback response is held open and
 * settled by completeDeferred; error callbacks are never deferred; default
 * (non-deferred) mode still answers the callback inline with the loopback
 * auth-success screen exactly as before.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { OAuthServer } from '../../src/auth/oauthServer';

const savedNoOpen = process.env.CAPY_WEB_NO_OPEN;

beforeAll(() => {
  // Never open a real browser from a test run.
  process.env.CAPY_WEB_NO_OPEN = '1';
});

afterAll(() => {
  if (savedNoOpen === undefined) delete process.env.CAPY_WEB_NO_OPEN;
  else process.env.CAPY_WEB_NO_OPEN = savedNoOpen;
});

let active: OAuthServer | null = null;
afterEach(() => {
  // Belt and braces: tear down whatever a failing test left listening.
  try {
    (active as any)?.cleanup?.();
  } catch {
    // already closed
  }
  active = null;
});

async function startedServer(opts: { deferCompletion?: boolean } = {}) {
  const server = new OAuthServer(opts);
  active = server;
  await server.bind();
  const flow = server.startAuthFlow('https://auth.example.test/authorize');
  // The URL the provider would redirect back to.
  const callbackBase = server.getRedirectUri().replace('localhost', '127.0.0.1');
  return { server, flow, callbackBase };
}

describe('deferred completion', () => {
  test('holds the successful callback open, resolves the flow early, then redirects on completeDeferred', async () => {
    const { server, flow, callbackBase } = await startedServer({ deferCompletion: true });

    const resP = fetch(`${callbackBase}?code=code-123&state=${server.getState()}`, {
      redirect: 'manual',
    });

    // The flow resolves as soon as the code arrives — before any response.
    const code = await flow;
    expect(code).toBe('code-123');

    const target = 'https://keep.capy.sc/flow/auth-success?c=conn-1';
    server.completeDeferred({ kind: 'redirect', url: target });

    const res = await resP;
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(target);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('success-screen fallback answers with the loopback auth-success screen', async () => {
    const { server, flow, callbackBase } = await startedServer({ deferCompletion: true });

    const resP = fetch(`${callbackBase}?code=code-456&state=${server.getState()}`);
    await flow;
    server.completeDeferred({ kind: 'success-screen' });

    const res = await resP;
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"autoCloseSeconds":3');
  });

  test('error-screen fallback answers with the loopback auth-error screen', async () => {
    const { server, flow, callbackBase } = await startedServer({ deferCompletion: true });

    const resP = fetch(`${callbackBase}?code=code-789&state=${server.getState()}`);
    await flow;
    server.completeDeferred({ kind: 'error-screen', message: 'exchange refused' });

    const res = await resP;
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('exchange refused');
  });

  test('error callbacks are never deferred: immediate error screen, flow rejects', async () => {
    // Driven through the handler with a captured response object: the
    // pre-existing error path closes the server immediately after writing,
    // which can cut a real socket before delivery under load — the claim
    // pinned here is "answered NOW, never held", not socket delivery.
    const { flow, server } = await startedServer({ deferCompletion: true });

    const writes: number[] = [];
    let body = '';
    const fakeRes = {
      writableEnded: false,
      writeHead(status: number) {
        writes.push(status);
        return this;
      },
      end(chunk?: string) {
        if (chunk) body += chunk;
        (this as { writableEnded: boolean }).writableEnded = true;
      },
    };
    (server as any).handleCallback(
      new URL(
        `http://127.0.0.1/callback?error=access_denied&error_description=denied&state=${server.getState()}`,
      ),
      fakeRes,
    );

    // Answered synchronously — never parked as a pending response.
    expect(writes).toEqual([400]);
    expect(body).toContain('denied');
    expect((server as any).pendingRes).toBeNull();

    await expect(flow).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  test('cleanup never leaves a held browser response hanging', async () => {
    const server = new OAuthServer({ deferCompletion: true });
    active = server;
    const writes: Array<{ status: number }> = [];
    const fakeRes = {
      writableEnded: false,
      writeHead(status: number) {
        writes.push({ status });
        return this;
      },
      end() {
        (this as any).writableEnded = true;
      },
    };
    (server as any).pendingRes = fakeRes;

    (server as any).cleanup();

    expect(writes).toEqual([{ status: 400 }]);
    expect((server as any).pendingRes).toBeNull();
  });
});

describe('default mode (flag off)', () => {
  test('answers the successful callback inline with the auth-success screen, exactly as before', async () => {
    const { server, flow, callbackBase } = await startedServer();

    const res = await fetch(`${callbackBase}?code=inline-1&state=${server.getState()}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"autoCloseSeconds":3');

    expect(await flow).toBe('inline-1');
  });
});

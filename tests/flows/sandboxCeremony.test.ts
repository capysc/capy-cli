/**
 * The in-process broker ceremony (CAP-451): strict envelope parsing, the
 * connection long-poll, and the request-fragment builder. `runSandboxCeremony`
 * itself (the orchestration, including org creation and device-key ceremonies)
 * is exercised indirectly through the driver/executors tests and through the
 * `orgCreationFromEnvelope` tests — this file is about the parts that are
 * pure functions or a single HTTP round trip.
 */
import { mock, describe, test, expect, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

// Guard rail: pin HOME to a throwaway tmpdir, same convention as
// tests/flows/observe.test.ts — hasAnyLocalKeyMaterial() reads
// getGlobalCapyDir() (via os.homedir()) lazily at call time.
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-sandbox-ceremony-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});
afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

import {
  parseSandboxSessionAnswer,
  pollSandboxConnection,
  buildCeremonyUrl,
  hasAnyLocalKeyMaterial,
  runSandboxCeremony,
  CEREMONY_CODES,
} from '../../src/flows/onboard/sandboxCeremony';
import { mintConnectionKeypair } from '../../src/service/brokerEnvelope';
import { sealEnvelopePageSide } from '../helpers/sealEnvelope';
import { FlowStep } from '../../src/flows/validate';
import { HANDOFF_EVENT_MARKER, type HandoffUrlEvent } from '../../src/ui/handoffEvent';
import { setOnboardJsonMode } from '../../src/ui/webMode';

function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    flow: 'sandbox-session',
    ok: true,
    user: { id: 'user_1', email: 'a@b.com' },
    refresh_token: 'rt-1',
    organizations: [],
    ...over,
  });
}

/**
 * A real (if unsigned) JWT with an `org_id` claim — CAP-451's fix requires
 * `applyFirstRun`'s final `authenticateSilent(orgId)` to genuinely succeed
 * (validateTokenOrg decodes the token and checks its `org_id` claim against
 * the org's `workos_org_id`), so a `sessions` fixture that wants the CACHED
 * branch to hit needs this rather than an opaque placeholder string.
 */
function fakeJwt(orgId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ org_id: orgId })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('parseSandboxSessionAnswer', () => {
  test('a minimal answer with no first_run parses to kind:none', () => {
    const result = parseSandboxSessionAnswer(envelope());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer.firstRun).toEqual({ kind: 'none' });
      expect(result.answer.refreshToken).toBe('rt-1');
      expect(result.answer.user.id).toBe('user_1');
    }
  });

  test('CHANGED EXPECTATION: create_org with no PRF pair is REFUSED — signup requires a door', () => {
    const result = parseSandboxSessionAnswer(
      envelope({ first_run: { kind: 'create_org', name: 'Acme', phrase: 'w'.repeat(1) } }),
    );
    expect(result.ok).toBe(false);
  });

  test('create_org with a complete PRF pair parses with defaults for missing backup flags', () => {
    const result = parseSandboxSessionAnswer(
      envelope({
        first_run: {
          kind: 'create_org',
          name: 'Acme',
          phrase: 'w',
          credential_id: 'cred-1',
          prf_output: 'prf-1',
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer.firstRun).toEqual({
        kind: 'create_org',
        name: 'Acme',
        phrase: 'w',
        credentialId: 'cred-1',
        prfOutput: 'prf-1',
        backupEligible: false,
        backupState: false,
      });
    }
  });

  test('HALF a PRF pair (credential_id with no prf_output) is refused, not partially trusted', () => {
    const result = parseSandboxSessionAnswer(
      envelope({ first_run: { kind: 'create_org', name: 'Acme', phrase: 'w', credential_id: 'cred-1' } }),
    );
    expect(result).toEqual({ ok: false, code: 'FLOW_ENVELOPE_INVALID' });
  });

  test('the other half of the pair alone is also refused', () => {
    const result = parseSandboxSessionAnswer(
      envelope({ first_run: { kind: 'create_org', name: 'Acme', phrase: 'w', prf_output: 'prf-1' } }),
    );
    expect(result).toEqual({ ok: false, code: 'FLOW_ENVELOPE_INVALID' });
  });

  test('an unknown first_run.kind is refused, never ignored', () => {
    const result = parseSandboxSessionAnswer(envelope({ first_run: { kind: 'do_something_else' } }));
    expect(result).toEqual({ ok: false, code: 'FLOW_ENVELOPE_INVALID' });
  });

  test('select_org requires org_id', () => {
    expect(parseSandboxSessionAnswer(envelope({ first_run: { kind: 'select_org' } }))).toEqual({
      ok: false,
      code: 'FLOW_ENVELOPE_INVALID',
    });
    const ok = parseSandboxSessionAnswer(envelope({ first_run: { kind: 'select_org', org_id: 'org_1' } }));
    expect(ok).toEqual({ ok: true, answer: expect.objectContaining({ firstRun: { kind: 'select_org', orgId: 'org_1' } }) });
  });

  test('unlock requires BOTH credential_id and prf_output', () => {
    expect(
      parseSandboxSessionAnswer(envelope({ first_run: { kind: 'unlock', credential_id: 'c' } })),
    ).toEqual({ ok: false, code: 'FLOW_ENVELOPE_INVALID' });
    const ok = parseSandboxSessionAnswer(
      envelope({ first_run: { kind: 'unlock', credential_id: 'c', prf_output: 'p' } }),
    );
    expect(ok).toEqual({
      ok: true,
      answer: expect.objectContaining({ firstRun: { kind: 'unlock', credentialId: 'c', prfOutput: 'p' } }),
    });
  });

  test('an explicit {ok:false, code:"declined"} maps to the ceremony_declined step code', () => {
    const result = parseSandboxSessionAnswer(
      JSON.stringify({ v: 1, flow: 'sandbox-session', ok: false, code: 'declined' }),
    );
    expect(result).toEqual({ ok: false, code: CEREMONY_CODES.DECLINED });
  });

  test('an ok:false with any OTHER code is refused, not silently mapped to declined', () => {
    const result = parseSandboxSessionAnswer(
      JSON.stringify({ v: 1, flow: 'sandbox-session', ok: false, code: 'something_else' }),
    );
    expect(result).toEqual({ ok: false, code: 'FLOW_ENVELOPE_INVALID' });
  });

  test('malformed JSON is refused', () => {
    expect(parseSandboxSessionAnswer('not json')).toEqual({ ok: false, code: 'FLOW_ENVELOPE_INVALID' });
  });

  test('the wrong flow/version tag is refused — a foreign envelope must never be read as this one', () => {
    expect(
      parseSandboxSessionAnswer(JSON.stringify({ v: 1, flow: 'device-key', ok: true, user: { id: 'u' }, refresh_token: 't' })),
    ).toEqual({ ok: false, code: 'FLOW_ENVELOPE_INVALID' });
    expect(
      parseSandboxSessionAnswer(JSON.stringify({ v: 2, flow: 'sandbox-session', ok: true, user: { id: 'u' }, refresh_token: 't' })),
    ).toEqual({ ok: false, code: 'FLOW_ENVELOPE_INVALID' });
  });

  test('missing refresh_token is refused', () => {
    const raw = JSON.parse(envelope());
    delete raw.refresh_token;
    expect(parseSandboxSessionAnswer(JSON.stringify(raw))).toEqual({ ok: false, code: 'FLOW_ENVELOPE_INVALID' });
  });

  test('a malformed sessions entry is refused', () => {
    const result = parseSandboxSessionAnswer(
      envelope({ sessions: { org_1: { access_token: 'tok' /* missing expires_at */ } } }),
    );
    expect(result).toEqual({ ok: false, code: 'FLOW_ENVELOPE_INVALID' });
  });

  test('a well-formed sessions entry is carried through', () => {
    const result = parseSandboxSessionAnswer(
      envelope({ sessions: { org_1: { access_token: 'tok', expires_at: 12345 } } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer.sessions).toEqual({ org_1: { access_token: 'tok', expires_at: 12345 } });
    }
  });
});

describe('hasAnyLocalKeyMaterial', () => {
  test('false against a clean home', () => {
    expect(hasAnyLocalKeyMaterial()).toBe(false);
  });
});

describe('buildCeremonyUrl', () => {
  const step = {
    contract_version: '1',
    flow_id: 'flow-1',
    flow_type: 'onboard',
    step_id: 's-1',
    kind: 'screen',
    resumed: false,
    screen: 'sandbox_session',
    url: 'https://keep.capy.sc/flow/sandbox-session?c=abc',
    params: { connection_id: 'abc', user_code: 'BCDF-GHJK' },
  } as unknown as FlowStep;

  test('appends a decodable #r= fragment carrying the first_run request, never touching the base URL', () => {
    const url = buildCeremonyUrl(step, 'my-machine');
    expect(url.startsWith('https://keep.capy.sc/flow/sandbox-session?c=abc#r=')).toBe(true);

    const b64 = url.split('#r=')[1];
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    expect(payload.v).toBe(1);
    expect(payload.flow).toBe('sandbox-session');
    expect(payload.first_run.machine_name).toBe('my-machine');
    expect(payload.first_run.no_local_key_material).toBe(true);
    expect(typeof payload.first_run.prf_salt).toBe('string');
    // 32 bytes, base64-encoded.
    expect(Buffer.from(payload.first_run.prf_salt, 'base64').length).toBe(32);
  });
});

describe('pollSandboxConnection', () => {
  test('opens a genuinely sealed answer end to end', async () => {
    const keypair = mintConnectionKeypair();
    const plaintext = envelope();
    const ciphertext = await sealEnvelopePageSide({
      plaintext,
      connectionId: 'conn-1',
      clientPubkeyB64: keypair.publicKeyB64,
    });

    const fetchImpl = mock(async () => new Response(
      JSON.stringify({ status: 'answered', ciphertext }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const result = await pollSandboxConnection({
      serviceUrl: 'https://api.test.invalid',
      connectionId: 'conn-1',
      flowSecret: 'flow-secret',
      keypair,
      fetchImpl,
    });

    expect(result).toEqual({ kind: 'answered', plaintext });
    // The flow secret authorizes the poll — the SAME secret, no second connection.
    const call = (fetchImpl as any).mock.calls[0];
    expect(call[0]).toContain('/connections/conn-1/result');
    expect(call[1].headers['X-Connection-Secret']).toBe('flow-secret');
  });

  test('a garbled ciphertext is a bad_envelope, not a thrown exception', async () => {
    const keypair = mintConnectionKeypair();
    const fetchImpl = mock(async () => new Response(
      JSON.stringify({ status: 'answered', ciphertext: Buffer.from('not an envelope').toString('base64') }),
      { status: 200 },
    )) as unknown as typeof fetch;

    const result = await pollSandboxConnection({
      serviceUrl: 'https://api.test.invalid',
      connectionId: 'conn-1',
      flowSecret: 'flow-secret',
      keypair,
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'bad_envelope' });
  });

  test('410 maps to expired, 409 maps to consumed', async () => {
    const keypair = mintConnectionKeypair();
    for (const [status, kind] of [[410, 'expired'], [409, 'consumed']] as const) {
      const fetchImpl = mock(async () => new Response('{}', { status })) as unknown as typeof fetch;
      const result = await pollSandboxConnection({
        serviceUrl: 'https://api.test.invalid',
        connectionId: 'conn-1',
        flowSecret: 'flow-secret',
        keypair,
        fetchImpl,
      });
      expect(result).toEqual({ kind });
    }
  });

  test('a network failure is reported, not thrown', async () => {
    const keypair = mintConnectionKeypair();
    const fetchImpl = mock(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const result = await pollSandboxConnection({
      serviceUrl: 'https://api.test.invalid',
      connectionId: 'conn-1',
      flowSecret: 'flow-secret',
      keypair,
      fetchImpl,
    });
    expect(result).toEqual({ kind: 'network' });
  });

  test('an already-elapsed deadline times out without ever polling', async () => {
    const keypair = mintConnectionKeypair();
    const fetchImpl = mock(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const result = await pollSandboxConnection({
      serviceUrl: 'https://api.test.invalid',
      connectionId: 'conn-1',
      flowSecret: 'flow-secret',
      keypair,
      fetchImpl,
      deadlineMs: -1,
    });
    expect(result).toEqual({ kind: 'timeout' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('runSandboxCeremony — applyFirstRun refuses an internally-inconsistent envelope', () => {
  const baseStep = {
    contract_version: '1',
    flow_id: 'flow-1',
    flow_type: 'onboard',
    step_id: 's-1',
    kind: 'screen',
    resumed: false,
    screen: 'sandbox_session',
    url: 'https://keep.capy.sc/flow/sandbox-session?c=conn-1',
    params: { connection_id: 'conn-1', user_code: 'BCDF-GHJK' },
  } as unknown as FlowStep;

  /** Seal `plaintext` as the page would, and serve it as the ONE poll answer. */
  async function runWithAnswer(plaintext: string) {
    const keypair = mintConnectionKeypair();
    const ciphertext = await sealEnvelopePageSide({
      plaintext,
      connectionId: 'conn-1',
      clientPubkeyB64: keypair.publicKeyB64,
    });
    const fetchImpl = mock(async () => new Response(
      JSON.stringify({ status: 'answered', ciphertext }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    return runSandboxCeremony({
      step: baseStep,
      keypair,
      flowSecret: 'flow-secret',
      serviceUrl: 'https://api.test.invalid',
      devMode: false,
      fetchImpl,
      targetDir: tempHome,
    });
  }

  test('select_org picking an org_id NOT in the envelope\'s own organizations list is refused', async () => {
    const outcome = await runWithAnswer(JSON.stringify({
      v: 1,
      flow: 'sandbox-session',
      ok: true,
      user: { id: 'user_1' },
      refresh_token: 'rt-1',
      organizations: [{ id: 'org_1', workos_org_id: 'w1', name: 'Org One' }],
      first_run: { kind: 'select_org', org_id: 'org_NOT_LISTED' },
    }));

    expect(outcome.result).toEqual({ outcome: 'failed', code: 'FLOW_ENVELOPE_INVALID' });
    expect(outcome.session).toBeUndefined();
  });

  test('select_org picking a listed org_id succeeds', async () => {
    const outcome = await runWithAnswer(JSON.stringify({
      v: 1,
      flow: 'sandbox-session',
      ok: true,
      user: { id: 'user_2' },
      refresh_token: 'rt-2',
      organizations: [{ id: 'org_1', workos_org_id: 'w1', name: 'Org One' }],
      sessions: { org_1: { access_token: fakeJwt('w1'), expires_at: Date.now() + 3600_000 } },
      first_run: { kind: 'select_org', org_id: 'org_1' },
    }));

    expect(outcome.result.outcome).toBe('ok');
    expect(outcome.result.result).toEqual({ org_id: 'org_1' });
  });

  test('unlock with ZERO organizations is refused rather than picking organizations[0]', async () => {
    const outcome = await runWithAnswer(JSON.stringify({
      v: 1,
      flow: 'sandbox-session',
      ok: true,
      user: { id: 'user_3' },
      refresh_token: 'rt-3',
      organizations: [],
      first_run: { kind: 'unlock', credential_id: 'cred-1', prf_output: 'prf-1' },
    }));

    expect(outcome.result).toEqual({ outcome: 'failed', code: 'FLOW_ENVELOPE_INVALID' });
  });

  test('unlock with MULTIPLE organizations is refused rather than picking organizations[0]', async () => {
    const outcome = await runWithAnswer(JSON.stringify({
      v: 1,
      flow: 'sandbox-session',
      ok: true,
      user: { id: 'user_4' },
      refresh_token: 'rt-4',
      organizations: [
        { id: 'org_1', workos_org_id: 'w1', name: 'Org One' },
        { id: 'org_2', workos_org_id: 'w2', name: 'Org Two' },
      ],
      first_run: { kind: 'unlock', credential_id: 'cred-1', prf_output: 'prf-1' },
    }));

    expect(outcome.result).toEqual({ outcome: 'failed', code: 'FLOW_ENVELOPE_INVALID' });
  });

  test('none with MULTIPLE organizations is refused rather than picking organizations[0]', async () => {
    const outcome = await runWithAnswer(JSON.stringify({
      v: 1,
      flow: 'sandbox-session',
      ok: true,
      user: { id: 'user_5' },
      refresh_token: 'rt-5',
      organizations: [
        { id: 'org_1', workos_org_id: 'w1', name: 'Org One' },
        { id: 'org_2', workos_org_id: 'w2', name: 'Org Two' },
      ],
      // No first_run — parses as {kind:'none'}.
    }));

    expect(outcome.result).toEqual({ outcome: 'failed', code: 'FLOW_ENVELOPE_INVALID' });
  });

  test('none with EXACTLY ONE organization still succeeds (unaffected by the new guard)', async () => {
    const outcome = await runWithAnswer(JSON.stringify({
      v: 1,
      flow: 'sandbox-session',
      ok: true,
      user: { id: 'user_6' },
      refresh_token: 'rt-6',
      organizations: [{ id: 'org_1', workos_org_id: 'w1', name: 'Org One' }],
      sessions: { org_1: { access_token: fakeJwt('w1'), expires_at: Date.now() + 3600_000 } },
    }));

    expect(outcome.result.outcome).toBe('ok');
    expect(outcome.result.result).toEqual({ org_id: 'org_1' });
  });
});

// ---------------------------------------------------------------------------
// Regression: applyFirstRun's `unlock` branch must pin the org (so
// serviceClient's token provider has something to hand out) BEFORE it makes
// any service call — not after. The bug this closes: `runUnlock` calls
// `deps.ops.listWrappers()` (the top-level, non-org-scoped op) as its very
// first step, and that op is NOT gated by `opsForOrg`'s own per-call
// `authenticateSilent`. A brand-new `AuthService` starts with `currentOrgId
// === null`, so `serviceClient`'s token provider (`authService.getValidToken
// ()`) returned null and the request went out with NO Authorization header
// at all — a 401 the old code's `catch { /* best-effort */ }` swallowed
// indistinguishably from a genuine ceremony failure, silently discarding the
// device-key unlock and leaving the org's key uninstalled (surfaced live as
// `blocked{key_not_on_device}` on a second machine that should have unlocked
// cleanly). NOT ISOLATED: globalThis.fetch swap only, restored in
// `afterEach`, no `mock.module()` — same convention as
// `tests/ui/keepInfoRelay.test.ts`.
// ---------------------------------------------------------------------------
describe('runSandboxCeremony — unlock pins the org before its first service call', () => {
  const SVC = 'https://api.test.invalid';
  const realFetch = globalThis.fetch;
  // header.payload.signature, unsigned — decodeJwtPayload only reads the
  // middle segment. No `org_id` claim, so getToken()'s org-match check is
  // trivially satisfied (see that method's `if (payload.org_id && ...)`).
  const FAKE_JWT = `h.${Buffer.from(JSON.stringify({ sub: 'user_unlock_1' })).toString('base64url')}.s`;
  let wrappersAuthHeader: string | null | undefined;
  let refreshCalledBeforeWrappers: boolean;
  let sawRefresh: boolean;

  beforeEach(() => {
    wrappersAuthHeader = undefined;
    refreshCalledBeforeWrappers = false;
    sawRefresh = false;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (!u.startsWith(SVC)) return realFetch(url, init);
      const path = u.slice(SVC.length);

      if (path.startsWith('/connections/conn-unlock-1/result')) {
        const ciphertext = (globalThis as any).__testUnlockCiphertext;
        return Response.json({ status: 'answered', ciphertext });
      }
      if (path === '/auth/refresh' && init?.method === 'POST') {
        sawRefresh = true;
        return Response.json({
          // getToken() decodes this and checks a `org_id` claim against the
          // org's workos_org_id — a shapeless string fails that decode and
          // is silently discarded as an invalid token, so this needs to be a
          // real (if unsigned) JWT with no `org_id` claim to validate against.
          access_token: FAKE_JWT,
          refresh_token: 'rt-rotated',
          expires_in: 3600,
        });
      }
      if (path.startsWith('/wrappers')) {
        wrappersAuthHeader = new Headers(init?.headers ?? {}).get('Authorization');
        refreshCalledBeforeWrappers = sawRefresh;
        return Response.json({ wrappers: [] });
      }
      throw new Error(`unexpected fetch in test: ${init?.method ?? 'GET'} ${path}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as any).__testUnlockCiphertext;
  });

  test('the org is pinned (Authorization header present) before listWrappers() runs', async () => {
    const keypair = mintConnectionKeypair();
    const step = {
      contract_version: '1',
      flow_id: 'flow-unlock-1',
      flow_type: 'onboard',
      step_id: 's-unlock-1',
      kind: 'screen',
      resumed: false,
      screen: 'sandbox_session',
      url: 'https://keep.capy.sc/flow/sandbox-session?c=conn-unlock-1',
      params: { connection_id: 'conn-unlock-1', user_code: 'BCDF-GHJK' },
    } as unknown as FlowStep;

    const plaintext = JSON.stringify({
      v: 1,
      flow: 'sandbox-session',
      ok: true,
      user: { id: 'user_unlock_1' },
      refresh_token: 'rt-unlock-1',
      // Deliberately NO `sessions` map — the org has no cached access token
      // yet, exactly like a fresh cross-device sign-in, forcing the org pin
      // through the real refresh path this regression is about.
      organizations: [{ id: 'org_1', workos_org_id: 'w1', name: 'Org One' }],
      first_run: { kind: 'unlock', credential_id: 'cred-1', prf_output: 'prf-1' },
    });
    (globalThis as any).__testUnlockCiphertext = await sealEnvelopePageSide({
      plaintext,
      connectionId: 'conn-unlock-1',
      clientPubkeyB64: keypair.publicKeyB64,
    });

    const outcome = await runSandboxCeremony({
      step,
      keypair,
      flowSecret: 'flow-secret',
      serviceUrl: SVC,
      devMode: false,
      targetDir: tempHome,
    });

    // No live door for this manufactured credential, so runUnlock itself
    // still fails (WRAPPER_NOT_FOUND) — that part is expected and fine, it
    // is caught as best-effort. What matters is that the listWrappers()
    // call it made along the way carried a real bearer, not none at all.
    expect(outcome.result.outcome).toBe('ok');
    expect(outcome.result.result).toEqual({ org_id: 'org_1' });
    expect(wrappersAuthHeader).toBe(`Bearer ${FAKE_JWT}`);
    expect(refreshCalledBeforeWrappers).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression (CAP-451, "403 mid-onboard"): applyFirstRun's final bearer
// settle used to report `{ok:true, token:undefined}` whenever
// authenticateSilent(orgId) failed after the org itself was resolved
// (create_org/select_org/unlock all share this tail) — e.g. a moment of
// WorkOS role-propagation lag right after an org is created, or any other
// transient 403/401 on the follow-up refresh. That false "ok" meant the
// driver carried on into write_keep_lock with no real bearer update, which
// then encrypted-and-pushed under a stale/absent one and 403'd — AFTER
// already rewriting .env. The fix: a failed settle is now a coded failure,
// never a silent ok with token:undefined.
// ---------------------------------------------------------------------------
describe('runSandboxCeremony — a failed final bearer settle is a coded failure, never a false ok', () => {
  const SVC = 'https://api.test.invalid';
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('select_org: authenticateSilent(orgId) 403ing on the follow-up refresh fails the step, never reports ok with no bearer', async () => {
    const keypair = mintConnectionKeypair();
    const step = {
      contract_version: '1',
      flow_id: 'flow-403-1',
      flow_type: 'onboard',
      step_id: 's-403-1',
      kind: 'screen',
      resumed: false,
      screen: 'sandbox_session',
      url: 'https://keep.capy.sc/flow/sandbox-session?c=conn-403-1',
      params: { connection_id: 'conn-403-1', user_code: 'BCDF-GHJK' },
    } as unknown as FlowStep;

    const plaintext = JSON.stringify({
      v: 1,
      flow: 'sandbox-session',
      ok: true,
      user: { id: 'user_403_1' },
      refresh_token: 'rt-403-1',
      // No `sessions` entry for org_1 — forces the real refresh path, the
      // one this regression is about, exactly like a just-created org whose
      // create-org response carried no access_token of its own.
      organizations: [{ id: 'org_1', workos_org_id: 'w1', name: 'Org One' }],
      first_run: { kind: 'select_org', org_id: 'org_1' },
    });
    const ciphertext = await sealEnvelopePageSide({
      plaintext,
      connectionId: 'conn-403-1',
      clientPubkeyB64: keypair.publicKeyB64,
    });

    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (!u.startsWith(SVC)) return realFetch(url, init);
      const path = u.slice(SVC.length);

      if (path.startsWith('/connections/conn-403-1/result')) {
        return Response.json({ status: 'answered', ciphertext });
      }
      if (path === '/auth/refresh' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ error: 'You do not have access to these secrets.', code: 'PERMISSION_DENIED' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch in test: ${init?.method ?? 'GET'} ${path}`);
    }) as typeof fetch;

    const outcome = await runSandboxCeremony({
      step,
      keypair,
      flowSecret: 'flow-secret',
      serviceUrl: SVC,
      devMode: false,
      targetDir: tempHome,
    });

    // The core assertion: a failed refresh is a FAILED step, never `ok`
    // with the caller left to discover the missing bearer downstream.
    expect(outcome.result.outcome).toBe('failed');
    expect(typeof outcome.result.code).toBe('string');
    // No session handed to the driver — nothing minted a working bearer.
    expect(outcome.session).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The `sandbox_session` step's `user_code` is the RFC-8628 anti-phishing
// binding a human is supposed to compare against the page
// (`shared/flows/steps.json`: "not a secret and MUST be shown to the
// human"). Under `--broker-ceremony` this ceremony is the ONLY place that
// code is available — it must ride on the `capy:handoff-url` event so a
// relaying caller (capy-mcp) can show it, and it must also print for the
// rare case of a human running `--broker-ceremony` directly at a terminal.
// ---------------------------------------------------------------------------
describe('runSandboxCeremony — surfaces the sandbox_session user_code', () => {
  const originalIsTTY = process.stdout.isTTY;

  const step = {
    contract_version: '1',
    flow_id: 'flow-code-1',
    flow_type: 'onboard',
    step_id: 's-code-1',
    kind: 'screen',
    resumed: false,
    screen: 'sandbox_session',
    url: 'https://keep.capy.sc/flow/sandbox-session?c=conn-code-1',
    params: { connection_id: 'conn-code-1', user_code: 'BCDF-GHJK' },
  } as unknown as FlowStep;

  /** Never answered within the test — every case here only inspects what happens BEFORE the poll settles. */
  function neverAnsweredFetch(): typeof fetch {
    return (async () => new Response(JSON.stringify({ status: 'pending' }), { status: 200 })) as unknown as typeof fetch;
  }

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
    setOnboardJsonMode(false);
  });

  test('the CAPY_EVENT_V1 line carries the step\'s user_code', async () => {
    process.stdout.isTTY = undefined as unknown as true; // spawned-process shape, same as handoffEvent's own tests
    const writes: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write);

    try {
      const outcome = runSandboxCeremony({
        step,
        keypair: mintConnectionKeypair(),
        flowSecret: 'flow-secret',
        serviceUrl: 'https://api.test.invalid',
        devMode: false,
        fetchImpl: neverAnsweredFetch(),
        deadlineMs: 1, // times out immediately — this test is only about the event emitted up front
        targetDir: tempHome,
      });
      await outcome;
    } finally {
      writeSpy.mockRestore();
    }

    const eventLine = writes.find((w) => w.startsWith(HANDOFF_EVENT_MARKER));
    expect(eventLine).toBeDefined();
    const parsed = JSON.parse(eventLine!.slice(HANDOFF_EVENT_MARKER.length).trimEnd()) as HandoffUrlEvent;
    expect(parsed.flow).toBe('onboard');
    expect(parsed.userCode).toBe('BCDF-GHJK');
  });

  test('prints the code at a real TTY when not in --json mode', async () => {
    process.stdout.isTTY = true;
    setOnboardJsonMode(false);
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation(((...args: unknown[]) => {
      logs.push(args.join(' '));
    }) as typeof console.log);

    try {
      await runSandboxCeremony({
        step,
        keypair: mintConnectionKeypair(),
        flowSecret: 'flow-secret',
        serviceUrl: 'https://api.test.invalid',
        devMode: false,
        fetchImpl: neverAnsweredFetch(),
        deadlineMs: 1,
        targetDir: tempHome,
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.some((l) => l.includes('BCDF-GHJK'))).toBe(true);
  });

  test('never prints the code in --json mode, even at a real TTY', async () => {
    process.stdout.isTTY = true;
    setOnboardJsonMode(true);
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation(((...args: unknown[]) => {
      logs.push(args.join(' '));
    }) as typeof console.log);

    try {
      await runSandboxCeremony({
        step,
        keypair: mintConnectionKeypair(),
        flowSecret: 'flow-secret',
        serviceUrl: 'https://api.test.invalid',
        devMode: false,
        fetchImpl: neverAnsweredFetch(),
        deadlineMs: 1,
        targetDir: tempHome,
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.some((l) => l.includes('BCDF-GHJK'))).toBe(false);
  });

  test('never prints the code when stdout is not a TTY (the ordinary --broker-ceremony caller)', async () => {
    process.stdout.isTTY = undefined as unknown as true;
    setOnboardJsonMode(false);
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation(((...args: unknown[]) => {
      logs.push(args.join(' '));
    }) as typeof console.log);

    try {
      await runSandboxCeremony({
        step,
        keypair: mintConnectionKeypair(),
        flowSecret: 'flow-secret',
        serviceUrl: 'https://api.test.invalid',
        devMode: false,
        fetchImpl: neverAnsweredFetch(),
        deadlineMs: 1,
        targetDir: tempHome,
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.some((l) => l.includes('BCDF-GHJK'))).toBe(false);
  });
});

/**
 * The in-process broker ceremony (CAP-451): strict envelope parsing, the
 * connection long-poll, and the request-fragment builder. `runSandboxCeremony`
 * itself (the orchestration, including org creation and device-key ceremonies)
 * is exercised indirectly through the driver/executors tests and through the
 * `orgCreationFromEnvelope` tests — this file is about the parts that are
 * pure functions or a single HTTP round trip.
 */
import { mock, describe, test, expect, afterAll } from 'bun:test';
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

  test('create_org with no PRF pair parses cleanly', () => {
    const result = parseSandboxSessionAnswer(
      envelope({ first_run: { kind: 'create_org', name: 'Acme', phrase: 'w'.repeat(1) } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer.firstRun).toEqual({ kind: 'create_org', name: 'Acme', phrase: 'w' });
    }
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
      sessions: { org_1: { access_token: 'tok', expires_at: Date.now() + 3600_000 } },
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
      sessions: { org_1: { access_token: 'tok', expires_at: Date.now() + 3600_000 } },
    }));

    expect(outcome.result.outcome).toBe('ok');
    expect(outcome.result.result).toEqual({ org_id: 'org_1' });
  });
});

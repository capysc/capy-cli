import { afterEach, describe, expect, jest, test } from 'bun:test';
import { ServiceClient } from '../../src/service/serviceClient';
import { CapyError, ERROR_CODES, type ServiceToken } from '../../src/types';

const SERVICE_ORIGIN = 'https://service.example.test';
const ORG_ID = 'org-123';
const CREDENTIAL_ID = 'credential_Abc-123';

const complete = () => ({
  key_state: 'minted',
  signup_complete: true,
  retryable: false,
  custody: {
    key_state: 'minted',
    ceremony_pending: false,
    has_live_wrapped_k_local: true,
  },
} as const);

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const token: ServiceToken = {
  access_token: 'access-token',
  expires_at: Date.now() + 60_000,
  organization_id: ORG_ID,
  user_id: 'user-123',
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ServiceClient.finalizeSignupCustody', () => {
  test('posts the credential-bound finalizer once and preserves authoritative readiness', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(complete()));
    const client = new ServiceClient(SERVICE_ORIGIN, false, async () => token);

    await expect(client.finalizeSignupCustody(ORG_ID, CREDENTIAL_ID)).resolves.toEqual(complete());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      `${SERVICE_ORIGIN}/orgs/${ORG_ID}/key-mint/finalize`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
        body: JSON.stringify({ wrapped_k_local_credential_id: CREDENTIAL_ID }),
      }),
    );
  });

  test('refuses invalid organization and credential identifiers before transport', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch');
    const client = new ServiceClient(SERVICE_ORIGIN);
    const invalid = [
      ['', CREDENTIAL_ID],
      [' org-123', CREDENTIAL_ID],
      [ORG_ID, ''],
      [ORG_ID, 'credential with spaces'],
      [ORG_ID, 'a'.repeat(1401)],
    ] as const;

    const errors = await Promise.all(invalid.map(([orgId, credentialId]) =>
      client.finalizeSignupCustody(orgId, credentialId).then(() => null, (error: unknown) => error)));

    expect(errors.every((error) => error instanceof CapyError && error.code === ERROR_CODES.INVALID_FORMAT)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('preserves a valid incomplete readiness verdict without promoting it', async () => {
    const incomplete = [
      {
        key_state: 'minted',
        signup_complete: false,
        retryable: true,
        custody: {
          key_state: 'minted',
          ceremony_pending: false,
          has_live_wrapped_k_local: false,
        },
      },
      {
        key_state: 'minted',
        signup_complete: false,
        retryable: true,
        custody: {
          key_state: 'minted',
          ceremony_pending: true,
          has_live_wrapped_k_local: true,
        },
      },
    ] as const;
    const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(incomplete[fetcher.mock.calls.length - 1]));
    const client = new ServiceClient(SERVICE_ORIGIN);

    const results = await Promise.all(incomplete.map(() =>
      client.finalizeSignupCustody(ORG_ID, CREDENTIAL_ID)));

    expect(results).toEqual(incomplete);
    expect(results.every((result) => result.signup_complete === false)).toBe(true);
  });

  test('accepts the exact idempotent already-minted response', async () => {
    const already = { ...complete(), already: true as const };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(already));
    const client = new ServiceClient(SERVICE_ORIGIN);

    await expect(client.finalizeSignupCustody(ORG_ID, CREDENTIAL_ID)).resolves.toEqual(already);
  });

  test('fails closed on incomplete, contradictory, or widened success bodies', async () => {
    const malformed = [
      { key_state: 'minted', signup_complete: true, retryable: false },
      { ...complete(), key_state: 'minting' },
      { ...complete(), already: false },
      { ...complete(), unexpected: true },
      { ...complete(), custody: { ...complete().custody, key_state: 'unknown' } },
      { ...complete(), custody: { ...complete().custody, unexpected: true } },
      { ...complete(), custody: { ...complete().custody, ceremony_pending: true } },
      { ...complete(), custody: { ...complete().custody, has_live_wrapped_k_local: false } },
      { ...complete(), retryable: true },
      { ...complete(), signup_complete: false, retryable: true },
      {
        ...complete(),
        signup_complete: false,
        retryable: false,
        custody: { ...complete().custody, has_live_wrapped_k_local: false },
      },
    ] as const;
    const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(malformed[fetcher.mock.calls.length - 1]));
    const client = new ServiceClient(SERVICE_ORIGIN);

    const errors = await Promise.all(malformed.map(() =>
      client.finalizeSignupCustody(ORG_ID, CREDENTIAL_ID).then(() => null, (error: unknown) => error)));

    expect(errors.every((error) => error instanceof CapyError && error.code === ERROR_CODES.SERVICE_ERROR)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(malformed.length);
  });

  test('preserves server coded refusal and never falls back to the no-body finalizer', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      code: 'WRAPPER_INVARIANT_VIOLATION',
      error: 'The signup device key is not available.',
    }, 409));
    const client = new ServiceClient(SERVICE_ORIGIN);

    const error = await client.finalizeSignupCustody(ORG_ID, CREDENTIAL_ID)
      .then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(CapyError);
    expect((error as CapyError).code).toBe(ERROR_CODES.WRAPPER_INVARIANT_VIOLATION);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({
      wrapped_k_local_credential_id: CREDENTIAL_ID,
    }));
  });
});

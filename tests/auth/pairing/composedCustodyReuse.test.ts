import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

const flowId = '10000000-0000-4000-8000-000000000001';
const connectionId = '10000000-0000-4000-8000-000000000002';
const userId = 'user_fixture';
const orgId = 'org-fixture';
const token = `fixture.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
const input = { flowId, serviceOrigin: 'https://service.example', userId, identityAccessToken: token } as const;
const inspect = mock(async (): Promise<{ kind: 'verified'; orgId: string } | { kind: 'missing' } | { kind: 'invalid' }> => ({ kind: 'verified', orgId }));
const create = mock(async () => ({ connectionId }));
const cancel = mock(async () => undefined);
const awaitAnswer = mock(async () => ({ kind: 'timeout' as const }));
mock.module('../../../src/auth/pairing/existingFilesystemCustody', () => ({ inspectExistingFilesystemCustody: inspect }));
mock.module('../../../src/service/brokerClient', () => ({ BrokerClient: class {
  readonly createConnection = create;
  readonly cancel = cancel;
  readonly awaitAnswer = awaitAnswer;
} }));
const fetchSpy = spyOn(globalThis, 'fetch');
const { continueComposedCustody } = await import('../../../src/auth/pairing/composedCustody');

beforeEach(() => {
  inspect.mockReset().mockResolvedValue({ kind: 'verified', orgId });
  create.mockClear(); cancel.mockClear(); awaitAnswer.mockClear();
  fetchSpy.mockReset().mockImplementation(async (value) => {
    const url = String(value);
    if (url.endsWith(`/flows/authentication/${flowId}`)) return Response.json({ flow_id: flowId, user_id: userId, initialization_run_id: null });
    if (url.endsWith('/custody') || url.endsWith('/custody/ack')) return Response.json({});
    throw new Error('Unexpected request');
  });
});
afterAll(() => fetchSpy.mockRestore());

describe('composed custody with existing keys', () => {
  test('verified existing keys acknowledge the same authenticated flow without a browser key transfer', async () => {
    expect(await continueComposedCustody(input)).toEqual({ kind: 'complete', flowId, orgId });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(awaitAnswer).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toContain(`${input.serviceOrigin}/flows/authentication/${flowId}/custody/ack`);
    expect(cancel).toHaveBeenCalledWith(connectionId);
  });
  test('invalid existing keys never create a relay or acknowledge custody', async () => {
    inspect.mockResolvedValue({ kind: 'invalid' });
    expect(await continueComposedCustody(input)).toEqual({ kind: 'indeterminate', code: 'CUSTODY_FILESYSTEM_UNVERIFIED' });
    expect(create).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  test('changed custody after relay binding is rejected before acknowledgement', async () => {
    inspect.mockResolvedValueOnce({ kind: 'verified', orgId }).mockResolvedValueOnce({ kind: 'invalid' });
    expect(await continueComposedCustody(input)).toEqual({ kind: 'indeterminate', code: 'CUSTODY_FILESYSTEM_UNVERIFIED' });
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/custody/ack'))).toBe(false);
    expect(cancel).toHaveBeenCalledWith(connectionId);
  });
  test('a machine without keys retains the existing browser-delivery path', async () => {
    inspect.mockResolvedValue({ kind: 'missing' });
    expect(await continueComposedCustody(input)).toEqual({ kind: 'retryable', code: 'DELIVERY_TIMEOUT' });
    expect(awaitAnswer).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/custody/ack'))).toBe(false);
  });
  test('repository-bound onboarding keeps its existing custody protocol', async () => {
    fetchSpy.mockImplementation(async (value) => String(value).endsWith(`/flows/authentication/${flowId}`)
      ? Response.json({ flow_id: flowId, user_id: userId, initialization_run_id: 'init-run-fixture' })
      : Response.json({}));
    expect(await continueComposedCustody(input)).toEqual({ kind: 'retryable', code: 'DELIVERY_TIMEOUT' });
    expect(inspect).not.toHaveBeenCalled();
    expect(awaitAnswer).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/custody/ack'))).toBe(false);
  });
});

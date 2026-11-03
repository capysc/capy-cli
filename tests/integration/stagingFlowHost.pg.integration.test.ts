import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createHash, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mintPageKeypairPageSide, openRequestEnvelopePageSide, sealEnvelopePageSide } from '../helpers/sealEnvelope';

const serviceRoot = process.env.CAPY_FLOW_HOST_TEST_SERVICE_ROOT;
const database = process.env.DATABASE_URL;
const configured = !!serviceRoot && !!database;
const state = mkdtempSync(join(tmpdir(), 'capy-synthetic-flow-host-'));
const repository = join(state, 'repository');
mkdirSync(repository, { mode: 0o700 });
const owner = `synthetic-host-${randomUUID()}`;
const organization = randomUUID();
const session = randomUUID();
const root = Buffer.alloc(32, 7);
const fingerprint = `sha256:${createHash('sha256').update(repository).digest('hex')}`;
const origin = mock(() => 'http://127.0.0.1:1');
const token = mock(() => ({ access_token: '', user_id: owner, organization_id: organization }));
mock.module('../../src/auth/authService', () => ({ AuthService: class {
  authenticateSilent = async () => ({ success: true, user_id: owner, organization_id: organization });
  getValidToken = async () => token();
}, silentAuthFailureMessage: () => 'Synthetic authentication unavailable' }));
mock.module('../../src/config/profileConfig', () => ({ resolveActiveUrl: () => origin() }));
mock.module('../../src/config/globalConfig', () => ({ readLocalRoot: () => root, getGlobalCapyDir: () => state }));
mock.module('../../src/config/keepOrigin', () => ({ resolveKeepOrigin: () => 'https://synthetic-keep.invalid' }));
mock.module('../../src/core/projectManager', () => ({ ProjectManager: class {
  detectProjectState = async () => ({ initialized: false, userId: owner });
} }));
mock.module('../../src/auth/initRunIdentity', () => ({ resolveInitRunIdentity: () => ({ runtimeId: randomUUID(), repositoryFingerprint: fingerprint, repositoryRoot: repository, machineName: 'Synthetic host' }) }));
mock.module('../../src/auth/pairing/existingFilesystemCustody', () => ({ inspectExistingFilesystemCustody: async () => ({ kind: 'verified', orgId: organization }) }));
import { runWithFlowInteraction } from '../../src/ui/flowInteraction';
import { currentInteraction, emitInteractionGoal } from '../../src/ui/interaction';
import { runFlowAgentCommand } from '../../src/commands/flowAgentCommand';
import { flowAgentPlanHash } from '../../src/ui/flowAgentBridge';
import { findFlowRecoveryBootstraps } from '../../src/ui/flowRecoveryStore';

afterAll(() => { rmSync(state, { recursive: true, force: true }); });

for (const scenario of ['complete', 'cancelled'] as const) test.skipIf(!configured)(scenario === 'complete'
  ? 'an active host carries one request through encrypted browser approval, single application and verified completion'
  : 'browser/runtime cancellation reaches the initiating host before any application', async () => {
  const target = new URL(database!);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.startsWith('/flow_')) throw new Error('An isolated local synthetic flow database is required.');
  const [{ default: express }, jose, auth, authentication, conversations, dbModule, drizzle] = await Promise.all([
    import(`${serviceRoot}/service/node_modules/express/index.js`),
    import(`${serviceRoot}/service/node_modules/jose/dist/browser/index.js`),
    import(`${serviceRoot}/service/src/middleware/auth.ts`),
    import(`${serviceRoot}/service/src/routes/authenticationFlows.ts`),
    import(`${serviceRoot}/service/src/routes/conversations.ts`),
    import(`${serviceRoot}/service/src/db/index.ts`),
    import(`${serviceRoot}/service/node_modules/drizzle-orm/index.js`),
  ]);
  const signing = await jose.generateKeyPair('EdDSA');
  const bearer = await new jose.SignJWT({ sid: session }).setSubject(owner).setProtectedHeader({ alg: 'EdDSA' }).setIssuedAt().setExpirationTime('5m').sign(signing.privateKey);
  expect((await jose.jwtVerify(bearer, signing.publicKey)).payload.sub).toBe(owner);
  token.mockReturnValue({ access_token: bearer, user_id: owner, organization_id: organization });
  const db = dbModule.getDb();
  await db.insert(dbModule.schema.organizations).values({ id: organization, name: organization, nameLower: organization, workosOrgId: `org_${organization}` });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const authenticate = auth.createUserAuthMiddleware({ jwksResolver: async () => signing.publicKey });
  app.use('/flows/authentication', authentication.createAuthenticationFlowsRouter(authenticate, { serviceOrigin: () => origin(), membership: async (user: string) => ({ active: user === owner }) }));
  app.use('/flows', conversations.createConversationsRouter(authenticate, async (user: string, org: string) => user === owner && org === organization));
  const server = await new Promise<import('node:http').Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  origin.mockReturnValue(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`);
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${origin()}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    if (!response.ok) throw new Error(`Synthetic route refused ${response.status}: ${data.code}`);
    return data;
  };
  const hostEvents = new PassThrough();
  const hostLines = createInterface({ input: hostEvents, crlfDelay: Infinity });
  const hostIterator = hostLines[Symbol.asyncIterator]();
  const stdout = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { hostEvents.write(chunk); return true; }) as typeof process.stdout.write);
  const hostEvent = async (type?: string): Promise<Readonly<Record<string, any>>> => {
    const next = await hostIterator.next();
    if (next.done) throw new Error('Synthetic host event reader stopped early');
    const event = JSON.parse(next.value);
    return type === undefined || event.type === type ? event : hostEvent(type);
  };
  const operation = mock(async () => {
    const approved = await currentInteraction()!.prompt<boolean>({ view: { text: 'Synthetic repository approval', input: { kind: 'confirm', default: false } },
      decide: data => typeof data.value === 'boolean' ? { value: data.value } : { error: 'Choose yes or no.' } });
    if (!approved) throw new Error('Synthetic fixture declined');
    await emitInteractionGoal({ flow: 'init-wizard', goal: 'repository_onboarded', status: 'succeeded' });
  });
  const running = runWithFlowInteraction(operation, true, { command: 'capy', continuationTool: 'capy_onboard_continue', expectedUserId: owner, organizationId: organization })
    .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  const agentInput = new PassThrough();
  const agentOutput = new PassThrough();
  const agentLines = createInterface({ input: agentOutput, crlfDelay: Infinity });
  const agentResponses = agentLines[Symbol.asyncIterator]();
  try {
    const preflight = await fetch(`${origin()}/flows/${randomUUID()}/messages`, { headers: { Authorization: `Bearer ${bearer}` } });
    expect(preflight.status).toBe(404);
    const handoff = await Promise.race([hostEvent(), running.then(result => {
      if (!result.ok) throw result.error;
      throw new Error('Synthetic flow completed before its handoff');
    })]);
    const flowId = handoff.flow_id as string;
    expect(handoff.instructions.join(' ')).toContain('Do not wait for another user chat message.');
    const page = await mintPageKeypairPageSide();
    await request(`/flows/${flowId}/attach`, { page_pubkey: page.pagePubkeyB64 });
    const nextPrompt = async (after: number): Promise<Readonly<{ message: any; cursor: number }>> => {
      const history = await request(`/flows/${flowId}/messages?after=${after}&wait_ms=1000`);
      const prompt = history.messages.find((message: any) => message.direction === 'cli_to_browser' && message.type === 'prompt');
      return prompt ? { message: prompt, cursor: prompt.sequence } : nextPrompt(history.cursor);
    };
    const answer = async (message: any): Promise<void> => {
      const id = randomUUID();
      const plaintext = JSON.stringify({ v: 1, flow_id: flowId, id, correlation_id: message.correlation_id, type: 'answer', data: { value: true } });
      const history = await request(`/flows/${flowId}/messages?wait_ms=0`);
      const envelope = await sealEnvelopePageSide({ plaintext, connectionId: `${flowId}:${id}`, clientPubkeyB64: history.client_pubkey });
      await request(`/flows/${flowId}/messages`, { v: 1, id, correlation_id: message.correlation_id, direction: 'browser_to_cli', type: 'answer', envelope });
    };
    const first = await nextPrompt(0);
    const initialHistory = await request(`/flows/${flowId}/messages?wait_ms=0`);
    const opened = JSON.parse(await openRequestEnvelopePageSide({ ciphertextB64: first.message.envelope, connectionId: `${flowId}:${first.message.id}`,
      clientPubkeyB64: initialHistory.client_pubkey, pagePrivateKey: page.privateKey }));
    expect(opened.data.question.text).toBe('Synthetic repository approval');
    if (scenario === 'cancelled') {
      const saved = findFlowRecoveryBootstraps(root, { origin: origin(), owner_id: owner, organization_id: organization, repo_fingerprint: fingerprint })
        .find(item => item.binding.flow_id === flowId)!;
      const payload = conversations.conversationProofPayload('abandon', flowId, 'abandon', {});
      await request(`/flows/${flowId}/abandon`, { proof: sign('sha256', payload, saved.keys.privateKey).toString('base64') });
      const cancelled = await running;
      expect(cancelled.ok).toBe(false);
      if (!cancelled.ok) expect(cancelled.error.code).toBe('FLOW_CANCELLED');
      expect((await request(`/flows/${flowId}/messages?wait_ms=0`)).state).toBe('cancelled');
      return;
    }
    await answer(first.message);
    const continuation = await nextPrompt(first.cursor);
    await answer(continuation.message);
    const dispatched = await hostEvent('agent_handoff');
    expect(dispatched.flow_id).toBe(flowId);
    expect(dispatched.attachment.protocol).toBe('capy.flow.agent.v1');
    const attached = runFlowAgentCommand(agentInput, agentOutput, { flowId, devMode: true });
    const send = (body: Readonly<Record<string, unknown>>): void => { agentInput.write(`${JSON.stringify(body)}\n`); };
    const response = async () => JSON.parse((await agentResponses.next()).value!);
    send({ id: 'synthetic-status', action: 'status' });
    expect((await response()).state).toBe('awaiting_approval');
    const proposed = { plan_id: randomUUID(), summary: 'Write an isolated synthetic result',
      files: [{ path: 'result.txt', change: 'Create the synthetic result', reason: 'Verify actual application' }], checks: ['Read back result.txt'] };
    const plan = { ...proposed, plan_hash: flowAgentPlanHash({ ...proposed, plan_hash: '' }) };
    send({ id: 'synthetic-plan', action: 'plan', plan });
    const approval = await nextPrompt(continuation.cursor);
    await answer(approval.message);
    expect((await response()).decision).toBe('yes');
    const begin = { id: 'synthetic-apply', action: 'begin_apply', plan_id: plan.plan_id, plan_hash: plan.plan_hash };
    send(begin);
    const granted = await response();
    expect(granted.authorization).toBe('granted');
    send(begin);
    expect(await response()).toEqual(granted);
    writeFileSync(join(repository, 'result.txt'), 'synthetic verified result', { flag: 'wx', mode: 0o600 });
    expect(readFileSync(join(repository, 'result.txt'), 'utf8')).toBe('synthetic verified result');
    send({ id: 'synthetic-complete', action: 'complete', plan_id: plan.plan_id, plan_hash: plan.plan_hash,
      application_id: granted.application_id, result: { summary: 'Synthetic repository application verified', checks: ['Read back result.txt: passed'] } });
    expect((await response()).outcome).toBe('succeeded');
    agentInput.end();
    expect(await attached).toBe(0);
    expect(await running).toEqual({ ok: true });
    expect(operation).toHaveBeenCalledTimes(1);
    const final = await request(`/flows/${flowId}/messages?wait_ms=0`);
    expect(final.state).toBe('done');
    const stored = await db.select().from(dbModule.schema.flowMessages).where(drizzle.eq(dbModule.schema.flowMessages.flowId, flowId));
    expect(JSON.stringify(stored)).not.toContain('Synthetic repository application verified');
  } finally {
    agentInput.end();
    for (const saved of findFlowRecoveryBootstraps(root, { origin: origin(), owner_id: owner, organization_id: organization, repo_fingerprint: fingerprint })) {
      const payload = conversations.conversationProofPayload('abandon', saved.binding.flow_id, 'abandon', {});
      await request(`/flows/${saved.binding.flow_id}/abandon`, { proof: sign('sha256', payload, saved.keys.privateKey).toString('base64') }).catch(() => undefined);
    }
    await running;
    stdout.mockRestore(); hostLines.close(); hostEvents.end(); agentLines.close(); agentOutput.end();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.delete(dbModule.schema.flows).where(drizzle.eq(dbModule.schema.flows.userId, owner));
    await db.delete(dbModule.schema.organizations).where(drizzle.eq(dbModule.schema.organizations.id, organization));
    await dbModule.resetDb();
  }
}, 20000);

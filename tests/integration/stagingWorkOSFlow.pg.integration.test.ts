import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createHash, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as shared from '../../src/commands/connectors/shared';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mintPageKeypairPageSide, openRequestEnvelopePageSide, sealEnvelopePageSide } from '../helpers/sealEnvelope';

const nativeExists = fs.existsSync;
const nativeRead = fs.readFileSync;
const keepRoot = process.env.CAPY_FLOW_KEEP_TEST_ROOT;
const serviceRoot = process.env.CAPY_FLOW_HOST_TEST_SERVICE_ROOT;
const database = process.env.DATABASE_URL;
const configured = !!serviceRoot && !!database;
const state = mkdtempSync(join(tmpdir(), 'capy-synthetic-flow-host-'));
const repository = join(state, 'repository');
const connector = { provider: 'workos', source: 'api', mode: 'sandbox', account_id: 'env_fixture', created_at: 1, fingerprint: 'fixture' };
const keep = { version: '3.0', org_id: 'fixture-org', project_id: 'fixture-project', project_name: 'fixture',
  variables: { KEY: [{branch:'development',resource_id:'fixture-resource',value_hash:'fixture-hash',connector}] } };
const writes = mock(async (_ctx: unknown, _name: string, value: string) => { writeFileSync(join(repository,'synthetic-result'), value, {mode:0o600}); });
const login = mock(async (interaction: import('../../src/ui/interaction').Interaction) => {
  await interaction.progress({status:'start',text:'Synthetic provider handoff',provider_auth:{id:randomUUID(),provider:'WorkOS',state:'pending',
    authorization_url:'https://synthetic-provider.invalid/device',verification_code:'AAAA-BBBB',expires_at:null}});
  const approved = await interaction.prompt({view:{text:'Synthetic replacement login code',input:{kind:'confirm',default:false}},decide:payload => ({value:payload.value === true})});
  if (!approved) throw new Error('Synthetic login declined');
});
mock.module('../../src/commands/connectors/workosFlowLogin', () => ({runWorkOSFlowLogin:login}));
mock.module('fs', () => ({...fs, existsSync:(path: fs.PathLike) => String(path).endsWith('/.workos/credentials.json') || nativeExists(path),
  readFileSync:(...args: Parameters<typeof fs.readFileSync>) => String(args[0]).endsWith('/.workos/credentials.json')
    ? JSON.stringify({accessToken:'synthetic-provider-token',expiresAt:Date.now()+3600000}) : nativeRead(...args)}));
mock.module('child_process', () => ({...cp, execSync:(command: string) => {if (command === 'workos --version') return Buffer.from('0.22.0'); throw new Error('No host credential processes allowed');},spawnSync:() => {throw new Error('No provider processes allowed');}}));
mock.module('../../src/sync/gate', () => ({gateFirst:async () => 'in-sync'}));
mock.module('../../src/commands/connectors/shared', () => ({...shared,resolveContext:async () => ({keep,branch:'development',
  localPlaintext:{KEY:'synthetic-old-key',WORKOS_CLIENT_ID:'client_01JD4FCFQ5M1XGAV5E4CG8BT8A'}}),writeAndSync:writes}));
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
  detectProjectState = async () => ({ initialized: true, userId: owner });
  readKeepFile = () => keep;
  deriveActiveBranch = () => 'development';
} }));
mock.module('../../src/auth/initRunIdentity', () => ({ resolveInitRunIdentity: () => ({ runtimeId: randomUUID(), repositoryFingerprint: fingerprint, repositoryRoot: repository, machineName: 'Synthetic host' }) }));
mock.module('../../src/auth/pairing/existingFilesystemCustody', () => ({ inspectExistingFilesystemCustody: async () => ({ kind: 'verified', orgId: organization }) }));
import { RotateCommand } from '../../src/commands/rotateCommand';
import { runWithFlowInteraction } from '../../src/ui/flowInteraction';
import { currentInteraction, emitInteractionGoal } from '../../src/ui/interaction';
import { runFlowAgentCommand } from '../../src/commands/flowAgentCommand';
import { flowAgentPlanHash } from '../../src/ui/flowAgentBridge';
import { findFlowRecoveryBootstraps } from '../../src/ui/flowRecoveryStore';

afterAll(() => { rmSync(state, { recursive: true, force: true }); });

for (const scenario of ['success', 'reauth', 'uncertain', 'changed-target', 'cancelled'] as const) test.skipIf(!configured)(`synthetic WorkOS ${scenario} crosses the encrypted browser/runtime boundary`, async () => {
  const target = new URL(database!);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.startsWith('/flow_')) throw new Error('An isolated local synthetic flow database is required.');
  const browserFixture = keepRoot ? await (async () => {
    const directory = join(state, `browser-${scenario}`);
    const bundle = await Bun.build({ entrypoints:[`${keepRoot}/tests/fixtures/conversationHarness.tsx`],outdir:directory,target:'browser',
      define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},
      plugins:[{name:'keep-fixture-alias',setup(builder){builder.onResolve({filter:/^@\//},args=>({path:Bun.resolveSync(args.path.replace('@/','./src/'),keepRoot)}));}}] });
    if (!bundle.success) throw new Error('Keep fixture bundle failed');
    const {chromium} = await import(`${keepRoot}/node_modules/playwright/index.mjs`);
    return {directory,browser:await chromium.launch({headless:true})};
  })() : null;
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
  login.mockClear(); writes.mockClear();
  const calls = mock((_name: string) => undefined);
  const nativeFetch = globalThis.fetch;
  const providerFetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    if (String(input) !== 'https://api.workos.com/graphql') {
      if (!String(input).startsWith(origin())) throw new Error('Only isolated fixture services are allowed');
      return nativeFetch(input, options);
    }
    const request = JSON.parse(String(options!.body));
    calls(request.operationName);
    const clientId = 'client_01JD4FCFQ5M1XGAV5E4CG8BT8A';
    const data = {
      teamProjectsV2:{currentTeam:{projectsV2:[{name:'Fixture',environments:[{id:scenario === 'changed-target' && login.mock.calls.length > 0 ? 'env_changed' : 'env_fixture',name:'Fixture',sandbox:true,clientId}]}]}},
      keys:{keys:{data:[{id:'key_old',name:'Old',createdAt:'2026-08-01T00:00:00Z',displayValue:'synthetic-old-key',applicationId:'app_fixture',expiredAt:null}]}},
      createKey:{createKey:{__typename:'KeyCreated',key:{key:{id:'key_new'},value:'synthetic-new-key'}}},
      expireKey:{expireKey:{__typename:'KeyExpired'}},
    } as const;
    if (request.operationName === 'createKey' && scenario === 'uncertain') throw new Error('Synthetic connection lost after request');
    if (request.operationName === 'createKey' && ['reauth','changed-target'].includes(scenario) && login.mock.calls.length === 0) return new Response('Synthetic forbidden',{status:403});
    if (!(request.operationName in data)) throw new Error('Unexpected provider operation');
    return Response.json({data:data[request.operationName as keyof typeof data]});
  });
  process.stderr.write(`fixture ${scenario}: starting runtime\n`);
  const running = runWithFlowInteraction(async () => {
    const names = await new RotateCommand(true).execute('KEY', {noPush:true,allowedProviders:['workos']});
    await emitInteractionGoal({flow:'rotate',goal:'credentials_rotated',status:'succeeded',result:{variables:names}});
  }, true, {command:'rotate',continuationTool:'capy_rotate_continue',expectedUserId:owner,organizationId:organization})
    .then(() => ({ok:true as const}), error => ({ok:false as const,error}));
  try {
    const handoff = await Promise.race([hostEvent(),running.then(result => { if (!result.ok) throw result.error; throw new Error('Flow ended before handoff'); })]);
    process.stderr.write(`fixture ${scenario}: handoff received\n`);
    const flowId = handoff.flow_id as string;
    const page = browserFixture ? null : await mintPageKeypairPageSide();
    if (page) await request(`/flows/${flowId}/attach`, {page_pubkey:page.pagePubkeyB64});
    const browserPage = browserFixture ? await browserFixture.browser.newPage({viewport:{width:480,height:640}}) : null;
    if (browserPage && browserFixture) {
      browserPage.setDefaultTimeout(7000);
      await browserPage.route('http://localhost/**',async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><div id="root"></div><link rel="stylesheet" href="/bundle.css"><script src="/bundle.js"></script>'});
        if (url.pathname === '/bundle.js' || url.pathname === '/bundle.css') return route.fulfill({contentType:url.pathname.endsWith('js')?'text/javascript':'text/css',
          body:await Bun.file(`${browserFixture.directory}/conversationHarness.${url.pathname.endsWith('js')?'js':'css'}`).text()});
        if (url.pathname.startsWith(`/api/flow/conversation/${flowId}/`)) {
          const response = await fetch(`${origin()}${url.pathname.replace('/api/flow/conversation/','/flows/')}${url.search}`,{
            method:route.request().method(),headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},
            ...(route.request().method()==='POST'?{body:route.request().postData()}:{}),signal:AbortSignal.timeout(35000)});
          return route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
        }
        return route.fulfill({status:404,body:''});
      });
      await browserPage.goto(`http://localhost/?host&flow=${flowId}`);
      await browserPage.getByRole('button',{name:'Yes',exact:true}).last().waitFor();
    }
    const prompts = mock((_text: string) => undefined);
    const consume = async (after: number): Promise<void> => {
      const history = await request(`/flows/${flowId}/messages?after=${after}&wait_ms=1000`);
      for (const message of history.messages) {
        if (message.direction !== 'cli_to_browser') continue;
        if (message.type !== 'prompt') continue;
        if (page) {
          const opened = JSON.parse(await openRequestEnvelopePageSide({ciphertextB64:message.envelope,connectionId:`${flowId}:${message.id}`,clientPubkeyB64:history.client_pubkey,pagePrivateKey:page.privateKey}));
          prompts(opened.data.question.text);
        }
        if (scenario === 'cancelled') {
          const saved = findFlowRecoveryBootstraps(root,{origin:origin(),owner_id:owner,organization_id:organization,repo_fingerprint:fingerprint}).find(item => item.binding.flow_id === flowId)!;
          const payload = conversations.conversationProofPayload('abandon',flowId,'abandon',{});
          await request(`/flows/${flowId}/abandon`,{proof:sign('sha256',payload,saved.keys.privateKey).toString('base64')});
          return;
        }
        if (browserPage) {
          const sent = browserPage.waitForResponse(response => response.request().method()==='POST' && new URL(response.url()).pathname.endsWith('/messages'));
          await browserPage.getByRole('button',{name:'Yes',exact:true}).last().click();
          await sent;
          continue;
        }
        const id = randomUUID();
        const plaintext = JSON.stringify({v:1,flow_id:flowId,id,correlation_id:message.correlation_id,type:'answer',data:{value:true}});
        const envelope = await sealEnvelopePageSide({plaintext,connectionId:`${flowId}:${id}`,clientPubkeyB64:history.client_pubkey});
        await request(`/flows/${flowId}/messages`,{v:1,id,correlation_id:message.correlation_id,direction:'browser_to_cli',type:'answer',envelope});
      }
      if (history.state === 'active') return consume(history.cursor);
    };
    process.stderr.write(`fixture ${scenario}: browser attached\n`);
    await consume(0);
    const result = await running;
    if (scenario === 'success' || scenario === 'reauth') {
      expect(result).toEqual({ok:true});
      expect(writes).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(repository,'synthetic-result'),'utf8')).toBe('synthetic-new-key');
      expect(calls.mock.calls.filter(([name]) => name === 'expireKey')).toHaveLength(1);
    } else {
      expect(result.ok).toBe(false);
      expect(writes).not.toHaveBeenCalled();
      expect(calls.mock.calls.some(([name]) => name === 'expireKey')).toBe(false);
      if (!result.ok && scenario === 'changed-target') expect(result.error.code).toBe('ROTATE_WORKOS_TARGET_CHANGED');
      if (!result.ok && scenario === 'cancelled') expect(result.error.code).toBe('FLOW_CANCELLED');
      if (scenario === 'uncertain') {
        if (!result.ok) expect(result.error.code).toBe('ROTATE_WORKOS_CREATE_UNCERTAIN');
        expect(calls.mock.calls.filter(([name]) => name === 'createKey')).toHaveLength(1);
      }
    }
    expect(login.mock.calls.length).toBe(['reauth','changed-target'].includes(scenario) ? 1 : 0);
    if (scenario === 'reauth' && !browserPage) expect(prompts.mock.calls.map(([text]) => text)).toContain('Synthetic replacement login code');
    if (browserPage) {
      if (scenario === 'cancelled') await browserPage.getByText('This flow was cancelled.',{exact:false}).waitFor();
      else await browserPage.getByText('This session has concluded. Close this window and return to your agent to resume.',{exact:true}).waitFor();
      if (scenario === 'reauth') expect(await browserPage.locator('body').innerText()).toContain('Synthetic replacement login code');
      expect(await browserPage.getByRole('button',{name:'Yes',exact:true}).count()).toBe(0);
      const screenshot = process.env.CAPY_FLOW_SCREENSHOT_DIR;
      if (screenshot) {mkdirSync(screenshot,{recursive:true});await browserPage.screenshot({path:join(screenshot,`workos-${scenario}.png`)});}
    }
    const status = await request(`/flows/${flowId}/conversation-status?wait_ms=0`);
    expect(status.command).toBe('rotate');
    expect(status.outcome).toBe(scenario === 'success' || scenario === 'reauth' ? 'succeeded' : scenario === 'cancelled' ? null : 'failed');
    const stored = await db.select().from(dbModule.schema.flowMessages).where(drizzle.eq(dbModule.schema.flowMessages.flowId,flowId));
    expect(JSON.stringify(stored)).not.toContain('synthetic-new-key');
  } finally {
    for (const saved of findFlowRecoveryBootstraps(root,{origin:origin(),owner_id:owner,organization_id:organization,repo_fingerprint:fingerprint})) {
      const payload = conversations.conversationProofPayload('abandon',saved.binding.flow_id,'abandon',{});
      await request(`/flows/${saved.binding.flow_id}/abandon`,{proof:sign('sha256',payload,saved.keys.privateKey).toString('base64')}).catch(() => undefined);
    }
    await running;
    if (browserFixture) await browserFixture.browser.close();
    providerFetch.mockRestore(); stdout.mockRestore(); hostLines.close(); hostEvents.end();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await db.delete(dbModule.schema.flows).where(drizzle.eq(dbModule.schema.flows.userId,owner));
    await db.delete(dbModule.schema.organizations).where(drizzle.eq(dbModule.schema.organizations.id,organization));
    await dbModule.resetDb();
  }
},20000);

// Explicit synthetic provider preload. It never changes Capy authentication.
import { mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const failure = code => new (class extends Error { get code() { return code; } })(code);
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const read = fs.readFileSync;
const exists = fs.existsSync;
const execute = childProcess.execSync;
const spawn = childProcess.spawn;
const spawnSync = childProcess.spawnSync;
const marker = JSON.parse(read(join(process.cwd(),'.capy-workos-validation.json'),'utf8'));
const keep = JSON.parse(read(join(process.cwd(),'keep.lock'),'utf8'));
if (marker.purpose !== 'capy-staging-workos-validation-v1' || !String(keep.project_name).startsWith('capy-flow-validation-')) throw failure('SYNTHETIC_WORKOS_PROJECT_REQUIRED');
const values = parse(read(join(process.cwd(),'.env'),'utf8'));
const clientId = 'client_01JD4FCFQ5M1XGAV5E4CG8BT8A';
const oldValue = 'capy-synthetic-workos-key-initial';
const newValue = 'capy-synthetic-workos-key-replacement';
if (Object.keys(values).some(name => !['WORKOS_API_KEY','WORKOS_CLIENT_ID'].includes(name))
  || values.WORKOS_CLIENT_ID !== clientId || ![oldValue,newValue].includes(values.WORKOS_API_KEY)) throw failure('SYNTHETIC_WORKOS_VALUES_REQUIRED');
const scenario = process.env.CAPY_SYNTHETIC_WORKOS_SCENARIO ?? 'success';
if (!['success','reauth','replacement-code','permission-denied','changed-target','ambiguous-create'].includes(scenario)) throw failure('SYNTHETIC_WORKOS_SCENARIO_INVALID');
const { ExitPromptError } = require(join(root,'dist/ui/interaction.js'));
const login = mock(async interaction => {
  interaction.signal?.throwIfAborted();
  const id = randomUUID();
  const progress = async (state, code) => interaction.progress({status:state === 'failed' ? 'failure' : state === 'authorized' ? 'success' : 'start',
    text:'Synthetic WorkOS authentication; no provider website or account is used.',provider_auth:{id,provider:'WorkOS (synthetic)',state,
      authorization_url:null,verification_code:code,expires_at:new Date(Date.now()+60000).toISOString()}});
  const ask = async text => interaction.prompt({view:{text,input:{kind:'confirm',default:false}},decide:payload => typeof payload.value === 'boolean'
    ? {value:payload.value} : {error:'Choose yes or no.'}});
  await progress('pending','AAAA-BBBB');
  if (scenario === 'replacement-code') {
    await progress('failed','AAAA-BBBB');
    if (!await ask('Synthetic WorkOS code expired. Request a replacement code?')) throw new ExitPromptError('Synthetic provider login cancelled.');
    await progress('pending','CCCC-DDDD');
  }
  if (!await ask('Approve synthetic WorkOS authentication? No real WorkOS account will be accessed.')) throw new ExitPromptError('Synthetic provider login cancelled.');
  await progress('authorized',null);
});
mock.module(join(root,'dist/commands/connectors/workosFlowLogin.js'), () => ({runWorkOSFlowLogin:login}));
const commonFs = require('node:fs');
spyOn(commonFs,'existsSync').mockImplementation(path => String(path).endsWith('/.workos/credentials.json') || exists(path));
spyOn(commonFs,'readFileSync').mockImplementation((path,...args) => String(path).endsWith('/.workos/credentials.json')
  ? JSON.stringify({accessToken:'synthetic-provider-token',expiresAt:Date.now()+3600000}) : read(path,...args));
const commonProcesses = require('node:child_process');
spyOn(commonProcesses,'execSync').mockImplementation((command,...args) => /^workos\s/.test(String(command))
  ? command === 'workos --version' ? Buffer.from('0.22.0-synthetic') : (() => {throw failure('SYNTHETIC_WORKOS_PROCESS_REFUSED');})()
  : execute(command,...args));
spyOn(commonProcesses,'spawn').mockImplementation((command,...args) => command === 'workos'
  ? (() => {throw failure('SYNTHETIC_WORKOS_PROCESS_REFUSED');})() : spawn(command,...args));
spyOn(commonProcesses,'spawnSync').mockImplementation((command,...args) => command === 'workos'
  ? (() => {throw failure('SYNTHETIC_WORKOS_PROCESS_REFUSED');})() : spawnSync(command,...args));
const nativeFetch = globalThis.fetch;
spyOn(globalThis,'fetch').mockImplementation(async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.href !== 'https://api.workos.com/graphql') {
    if (url.origin !== 'https://staging-api.capy.sc') throw failure('SYNTHETIC_WORKOS_NETWORK_REFUSED');
    return nativeFetch(input,options);
  }
  if (options?.method !== 'POST') throw failure('SYNTHETIC_WORKOS_REQUEST_INVALID');
  const request = JSON.parse(String(options.body));
  const environment = new Headers(options.headers).get('x-url-environment-id');
  if (request.operationName !== 'teamProjectsV2' && environment !== 'env_fixture') throw failure('SYNTHETIC_WORKOS_TARGET_INVALID');
  if (request.operationName === 'createKey' && scenario === 'ambiguous-create') throw new Error('Synthetic response lost after create; do not replay.');
  if (request.operationName === 'createKey' && ['reauth','replacement-code','permission-denied','changed-target'].includes(scenario)
    && (login.mock.calls.length === 0 || scenario === 'permission-denied')) return new Response('Synthetic permission denial',{status:403});
  const responses = {
    teamProjectsV2:{currentTeam:{projectsV2:[{name:'Synthetic WorkOS',environments:[{id:scenario === 'changed-target' && login.mock.calls.length > 0 ? 'env_changed' : 'env_fixture',name:'Synthetic environment',sandbox:true,clientId}]}]}},
    keys:{keys:{data:[{id:'key_fixture_old',name:'Synthetic old key',createdAt:'2026-08-01T00:00:00Z',displayValue:parse(read(join(process.cwd(),'.env'),'utf8')).WORKOS_API_KEY,applicationId:'app_fixture',expiredAt:null}]}},
    createKey:{createKey:{__typename:'KeyCreated',key:{key:{id:'key_fixture_new'},value:newValue}}},
    expireKey:{expireKey:{__typename:'KeyExpired'}},
  };
  if (!(request.operationName in responses)) throw failure('SYNTHETIC_WORKOS_OPERATION_REFUSED');
  if (request.operationName === 'createKey' && request.variables?.input?.applicationId !== 'app_fixture') throw failure('SYNTHETIC_WORKOS_TARGET_INVALID');
  if (request.operationName === 'expireKey' && request.variables?.input?.keyId !== 'key_fixture_old') throw failure('SYNTHETIC_WORKOS_TARGET_INVALID');
  return Response.json({data:responses[request.operationName]});
});

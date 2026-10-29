import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

// A fresh process isolates fake filesystem/process/network modules. Every
// provider operation runs against these fixtures; no host credential store or
// provider endpoint can be reached, including on an unexpected code path.
const run = (scenario: 'success' | 'expiry-fails' | 'client-id' | 'ambiguous' | 'reauth' | 'decline' | 'persistent' | 'http-401' | 'http-403' | 'changed-target' | 'changed-app' | 'network-failure' | 'decline-reapproval' | 'lookup-403' | 'partial-create') => {
  const source = `
    import { mock, spyOn } from 'bun:test';
    import * as fs from 'node:fs';
    import * as cp from 'node:child_process';
    const scenario = ${JSON.stringify(scenario)};
    const login = mock(async (_interaction, options) => {call('provider-login', options);});
    mock.module('./src/commands/connectors/workosFlowLogin.ts', () => ({runWorkOSFlowLogin:login}));
    const credentials = JSON.stringify({accessToken:'fixture-token',expiresAt:Date.now()+3600000});
    mock.module('fs', () => ({...fs, existsSync:()=>true, readFileSync:(path)=> {
      if (String(path).endsWith('/.workos/credentials.json')) return credentials;
      throw new Error('Unexpected filesystem read');
    }}));
    mock.module('child_process', () => ({...cp, execSync:()=>{throw new Error('No process allowed');}, spawnSync:()=>{throw new Error('No process allowed');}}));
    const { workosConnector } = await import('./src/commands/connectors/workos.ts');
    const { runWithInteraction } = await import('./src/ui/interaction.ts');
    const call = mock((name, input)=>undefined);
    const output = mock(event=>undefined);
    const clientId = 'client_01JD4FCFQ5M1XGAV5E4CG8BT8A';
    const previous = {provider:'workos',source:scenario==='client-id'?'client-id':'api',mode:'sandbox',account_id:'env_fixture',created_at:1};
    const key = {id:'key_old',name:'Old',createdAt:'2026-08-01T00:00:00Z',displayValue:scenario==='ambiguous'?null:'fixture-old-secret',applicationId:'app_fixture',expiredAt:null};
    const responses = {
      teamProjectsV2:{currentTeam:{projectsV2:[{name:'Fixture',environments:[{id:'env_fixture',name:'Fixture',sandbox:true,clientId}]}]}},
      keys:{keys:{data:[key,...(scenario==='ambiguous'?[{...key,id:'key_other',applicationId:'app_other'}]:[])]}},
      createKey:{createKey:{__typename:'KeyCreated',key:{key:{id:'key_new'},value:'fixture-new-secret'}}},
      expireKey:{expireKey:{__typename:scenario==='expiry-fails'?'KeyNotFound':'KeyExpired'}},
    };
    spyOn(globalThis,'fetch').mockImplementation(async (url, options)=> {
      if (url !== 'https://api.workos.com/graphql') throw new Error('Unexpected network request');
      const request = JSON.parse(options.body);
      const environmentHeader = options.headers['x-url-environment-id'];
      if (request.operationName === 'teamProjectsV2' ? environmentHeader !== undefined : environmentHeader !== 'env_fixture') {
        throw new Error('WorkOS environment context is missing or incorrect');
      }
      call(request.operationName,request.variables);
      if (scenario === 'lookup-403' && request.operationName === 'keys' && login.mock.calls.length === 0) {
        return Response.json({errors:[{message:'Forbidden',extensions:{code:'FORBIDDEN'}}]});
      }
      if (request.operationName === 'teamProjectsV2' && scenario === 'changed-target' && login.mock.calls.length > 0) {
        return Response.json({data:{currentTeam:{projectsV2:[{environments:[{id:'env_changed',clientId,sandbox:true}]}]}}});
      }
      if (request.operationName === 'keys' && scenario === 'changed-app' && login.mock.calls.length > 0) {
        return Response.json({data:{keys:{data:[{...key,applicationId:'app_changed'}]}}});
      }
      if (request.operationName === 'createKey' && scenario === 'partial-create') return Response.json({data:responses.createKey,errors:[{message:'Partial failure',extensions:{code:'FORBIDDEN'}}]});
      if (request.operationName === 'createKey' && scenario === 'network-failure') throw new Error('Network connection lost');
      if (request.operationName === 'createKey' && (['reauth','decline','persistent','http-401','http-403','changed-target','changed-app','decline-reapproval'].includes(scenario)) && (login.mock.calls.length === 0 || scenario === 'persistent')) {
        if (scenario === 'http-401' || scenario === 'http-403') return new Response('Not JSON', {status:scenario === 'http-401'?401:403});
        return Response.json({errors:[{message:'Forbidden',extensions:{code:'INTERNAL_SERVER_ERROR',exception:{status:403}}}]});
      }
      if (!(request.operationName in responses)) throw new Error('Unexpected operation');
      return Response.json({data:responses[request.operationName]});
    });
    const interaction = {output,progress:output,goal:output,prompt:async question=> {
      const view = question.view;
      call('prompt',view);
      // Rotation now asks a mandatory confirm question before mutating
      // anything (commit 5150bb1, "authorize WorkOS rotation within Keep").
      // A confirm question carries no choices; approve it so the scenario
      // can reach create/expire. A list question (application/environment
      // pickers) keeps picking the app_other candidate when present.
      const choices = view.input.choices;
      const value = choices ? (choices.find(choice=>choice.label.includes('app_other')) ?? choices[0]).value : !(scenario === 'decline' && view.text.startsWith('WorkOS refused')) && !(scenario === 'decline-reapproval' && login.mock.calls.length > 0);
      const answer = question.decide({value});
      if ('error' in answer) throw new Error(answer.error);
      return answer.value;
    }};
    const before = Date.now();
    const result = await runWithInteraction(interaction,async ()=>{
      try { const result=await workosConnector.rotate({localPlaintext:{KEY:'fixture-old-secret',WORKOS_CLIENT_ID:clientId},branch:'development'},'KEY',previous,{nonTty:true});
        return {ok:true,mode:result.entry.mode,valueMatches:result.value==='fixture-new-secret'};
      } catch(error) {return {ok:false,code:error.code,message:error.message};}
    });
    const calls=call.mock.calls;
    const expiry=calls.find(([name])=>name==='expireKey')?.[1]?.input;
    console.log(JSON.stringify({result,names:calls.map(([name])=>name),create:calls.find(([name])=>name==='createKey')?.[1]?.input,
      expiry:expiry?{id:expiry.keyId,delay:Date.parse(expiry.expiredAt)-before}:null,
      leaked:JSON.stringify(output.mock.calls).includes('fixture-new-secret')||JSON.stringify(output.mock.calls).includes('fixture-old-secret'),
      logins:login.mock.calls.length,loginOptions:login.mock.calls[0]?.[1],prompts:calls.filter(([name])=>name==='prompt').map(([,view])=>view.text),outputs:output.mock.calls.map(([event])=>event.text).filter(Boolean)}));
  `;
  const result = Bun.spawnSync([process.execPath, '--eval', source], { cwd: join(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
};

describe('real WorkOS connector through Interaction with isolated fake I/O', () => {
  test('creates replacement then schedules one-hour overlap without revealing keys', () => {
    const result = run('success');
    // The mandatory pre-mutation confirm (commit 5150bb1) inserts a 'prompt'
    // call between the key lookup and the mutation.
    expect(result.names).toEqual(['teamProjectsV2', 'keys', 'prompt', 'createKey', 'expireKey']);
    expect(result.result).toEqual({ok:true,mode:'sandbox',valueMatches:true});
    expect(result.expiry.id).toBe('key_old'); expect(result.expiry.delay).toBeGreaterThanOrEqual(3600000);
    expect(result.expiry.delay).toBeLessThan(3605000); expect(result.leaked).toBe(false);
  });
  test('failed expiry still returns new key and mandatory manual-revoke warning', () => {
    const result = run('expiry-fails');
    expect(result.result.ok).toBe(true); expect(result.outputs.join(' ')).toContain('Revoke it in the WorkOS dashboard');
    expect(result.leaked).toBe(false);
  });
  test('client ID fails fatally before credential reads/network/mutation', () => {
    const result = run('client-id');
    expect(result.names).toEqual([]); expect(result.result.code).toBe('COMMAND_EXIT_1');
  });
  test('ambiguous application uses the common typed question and selected application', () => {
    const result = run('ambiguous');
    // Application-choice prompt, then the mandatory pre-mutation confirm
    // (commit 5150bb1) — two 'prompt' calls before createKey.
    expect(result.names).toEqual(['teamProjectsV2', 'keys', 'prompt', 'prompt', 'createKey']);
    expect(result.create.applicationId).toBe('app_other'); expect(result.result.ok).toBe(true);
  });
});


describe('WorkOS authentication recovery stays inside the rotation', () => {
  test('rejected create offers provider login, verifies target, reapproves, then rotates', () => {
    const result = run('reauth');
    expect(result.names).toEqual(['teamProjectsV2','keys','prompt','createKey','prompt','provider-login','teamProjectsV2','keys','prompt','createKey','expireKey']);
    expect(result.loginOptions).toEqual({force:true});
    expect(result.result.ok).toBe(true);
    expect(result.prompts.filter((text: string) => text.startsWith('Rotate'))).toHaveLength(2);
    expect(result.leaked).toBe(false);
  });
  test('declining provider login stops before any key expiry', () => {
    const result = run('decline');
    expect(result.result.ok).toBe(false);
    expect(result.logins).toBe(0);
    expect(result.expiry).toBeNull();
    expect(result.names.filter((name: string) => name === 'createKey')).toHaveLength(1);
  });
  test('a fresh session still denied stops after one login without an auth loop', () => {
    const result = run('persistent');
    expect(result.result.code).toBe('ROTATE_WORKOS_PERMISSION_DENIED');
    expect(result.result.message).toContain('createKey');
    expect(result.result.message).not.toContain('cannot see this environment');
    expect(result.logins).toBe(1);
    expect(result.expiry).toBeNull();
    expect(result.names.filter((name: string) => name === 'createKey')).toHaveLength(2);
  });
  test.each(['http-401','http-403'] as const)('%s with a non-JSON body also recovers', scenario => {
    const result = run(scenario);
    expect(result.result.ok).toBe(true);
    expect(result.logins).toBe(1);
  });
  test.each(['changed-target','changed-app'] as const)('%s cannot silently redirect the retry', scenario => {
    const result = run(scenario);
    expect(result.result.code).toBe('ROTATE_WORKOS_TARGET_CHANGED');
    expect(result.names.filter((name: string) => name === 'createKey')).toHaveLength(1);
    expect(result.expiry).toBeNull();
  });
  test('a network failure cannot replay a potentially successful creation', () => {
    const result = run('network-failure');
    expect(result.result.ok).toBe(false);
    expect(result.logins).toBe(0);
    expect(result.names.filter((name: string) => name === 'createKey')).toHaveLength(1);
    expect(result.expiry).toBeNull();
  });
  test('declining the renewed rotation approval does not retry create', () => {
    const result = run('decline-reapproval');
    expect(result.result.ok).toBe(false);
    expect(result.logins).toBe(1);
    expect(result.names.filter((name: string) => name === 'createKey')).toHaveLength(1);
    expect(result.expiry).toBeNull();
  });
  test('a FORBIDDEN key lookup can reauthenticate before the first mutation', () => {
    const result = run('lookup-403');
    expect(result.result.ok).toBe(true);
    expect(result.logins).toBe(1);
    expect(result.names.filter((name: string) => name === 'createKey')).toHaveLength(1);
  });
});

test('partial create results cannot replay a potentially successful creation', () => {
  const result = run('partial-create');
  expect(result.result.code).toBe('ROTATE_WORKOS_CREATE_UNCERTAIN');
  expect(result.logins).toBe(0);
  expect(result.names.filter((name: string) => name === 'createKey')).toHaveLength(1);
  expect(result.expiry).toBeNull();
});

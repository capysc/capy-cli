import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

// A fresh process isolates fake filesystem/process/network modules. Every
// provider operation runs against these fixtures; no host credential store or
// provider endpoint can be reached, including on an unexpected code path.
const run = (scenario: 'success' | 'expiry-fails' | 'client-id' | 'ambiguous') => {
  const source = `
    import { mock } from 'bun:test';
    import * as fs from 'node:fs';
    import * as cp from 'node:child_process';
    const scenario = ${JSON.stringify(scenario)};
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
    Reflect.set(globalThis,'fetch',async (url, options)=> {
      if (url !== 'https://api.workos.com/graphql') throw new Error('Unexpected network request');
      const request = JSON.parse(options.body);
      call(request.operationName,request.variables);
      if (!(request.operationName in responses)) throw new Error('Unexpected operation');
      return Response.json({data:responses[request.operationName]});
    });
    const interaction = {output,progress:output,goal:output,prompt:async question=> {
      const view = question.view;
      call('prompt',view);
      const selected = view.input.choices.find(choice=>choice.label.includes('app_other')) ?? view.input.choices[0];
      const answer = question.decide({value:selected.value});
      if ('error' in answer) throw new Error(answer.error);
      return answer.value;
    }};
    const before = Date.now();
    const result = await runWithInteraction(interaction,async ()=>{
      try { const result=await workosConnector.rotate({localPlaintext:{KEY:'fixture-old-secret',WORKOS_CLIENT_ID:clientId},branch:'development'},'KEY',previous,{nonTty:true});
        return {ok:true,mode:result.entry.mode,valueMatches:result.value==='fixture-new-secret'};
      } catch(error) {return {ok:false,code:error.code};}
    });
    const calls=call.mock.calls;
    const expiry=calls.find(([name])=>name==='expireKey')?.[1]?.input;
    console.log(JSON.stringify({result,names:calls.map(([name])=>name),create:calls.find(([name])=>name==='createKey')?.[1]?.input,
      expiry:expiry?{id:expiry.keyId,delay:Date.parse(expiry.expiredAt)-before}:null,
      leaked:JSON.stringify(output.mock.calls).includes('fixture-new-secret')||JSON.stringify(output.mock.calls).includes('fixture-old-secret'),
      outputs:output.mock.calls.map(([event])=>event.text).filter(Boolean)}));
  `;
  const result = Bun.spawnSync([process.execPath, '--eval', source], { cwd: join(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout));
};

describe('real WorkOS connector through Interaction with isolated fake I/O', () => {
  test('creates replacement then schedules one-hour overlap without revealing keys', () => {
    const result = run('success');
    expect(result.names).toEqual(['teamProjectsV2', 'keys', 'createKey', 'expireKey']);
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
    expect(result.names).toEqual([]); expect(result.result).toEqual({ok:false,code:'COMMAND_EXIT_1'});
  });
  test('ambiguous application uses the common typed question and selected application', () => {
    const result = run('ambiguous');
    expect(result.names).toEqual(['teamProjectsV2', 'keys', 'prompt', 'createKey']);
    expect(result.create.applicationId).toBe('app_other'); expect(result.result.ok).toBe(true);
  });
});

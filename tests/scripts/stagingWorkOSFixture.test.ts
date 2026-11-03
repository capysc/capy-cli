import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const repository = resolve(import.meta.dir,'../..');
const run = (scenario: string, permitted = true) => {
  const cwd = mkdtempSync(join(tmpdir(),'capy-workos-manual-fixture-'));
  try {
    writeFileSync(join(cwd,'.capy-workos-validation.json'),JSON.stringify({purpose:'capy-staging-workos-validation-v1'}));
    writeFileSync(join(cwd,'keep.lock'),JSON.stringify({project_name:permitted ? 'capy-flow-validation-fixture' : 'unrelated-project'}));
    writeFileSync(join(cwd,'.env'),'WORKOS_API_KEY=capy-synthetic-workos-key-initial\nWORKOS_CLIENT_ID=client_01JD4FCFQ5M1XGAV5E4CG8BT8A\n');
    const source = `
      import {mock} from 'bun:test';
      const {workosConnector} = await import(${JSON.stringify(join(repository,'dist/commands/connectors/workos.js'))});
      const {runWithInteraction} = await import(${JSON.stringify(join(repository,'dist/ui/interaction.js'))});
      const prompt = mock(async question => {const result=question.decide({value:true});if ('error' in result) throw new Error(result.error);return result.value;});
      const progress = mock(async () => undefined);
      const result = await runWithInteraction({prompt,progress,output:async () => undefined,goal:async () => undefined},async () => {
        try {const replacement=await workosConnector.rotate({localPlaintext:{KEY:'capy-synthetic-workos-key-initial',WORKOS_CLIENT_ID:'client_01JD4FCFQ5M1XGAV5E4CG8BT8A'},branch:'development'},'KEY',
          {provider:'workos',source:'api',mode:'sandbox',account_id:'env_fixture',created_at:1},{nonTty:true});return {ok:true,valueMatches:replacement.value==='capy-synthetic-workos-key-replacement'};}
        catch(error){return {ok:false,code:error.code};}
      });
      const blocked = await fetch('https://api.capy.sc/health').then(() => false,error => error.code==='SYNTHETIC_WORKOS_NETWORK_REFUSED');
      console.log(JSON.stringify({result,blocked,prompts:prompt.mock.calls.map(([question]) => question.view.text),providerNames:progress.mock.calls.map(([event]) => event.provider_auth?.provider)}));
    `;
    const result = Bun.spawnSync([process.execPath,'--preload',join(repository,'scripts/validation/workos-fixture.mjs'),'--eval',source],{
      cwd,stdout:'pipe',stderr:'pipe',env:{...process.env,CAPY_SYNTHETIC_WORKOS_SCENARIO:scenario},timeout:10000,
    });
    return {exitCode:result.exitCode,stdout:new TextDecoder().decode(result.stdout),stderr:new TextDecoder().decode(result.stderr)};
  } finally {rmSync(cwd,{recursive:true,force:true});}
};

for (const scenario of ['success','reauth','replacement-code'] as const) test(`manual provider fixture supports ${scenario} without a real WorkOS account`, () => {
  const result = run(scenario);
  expect(result.exitCode).toBe(0);
  const data = JSON.parse(result.stdout);
  expect(data.result).toEqual({ok:true,valueMatches:true});
  expect(data.blocked).toBe(true);
  if (scenario === 'replacement-code') expect(data.prompts).toContain('Synthetic WorkOS code expired. Request a replacement code?');
  expect(data.providerNames.every((name: string) => name === 'WorkOS (synthetic)')).toBe(true);
});

for (const scenario of ['permission-denied','changed-target','ambiguous-create'] as const) test(`manual provider fixture preserves ${scenario} refusal`, () => {
  const result = run(scenario);
  expect(result.exitCode).toBe(0);
  const data = JSON.parse(result.stdout);
  expect(data.result.ok).toBe(false);
  if (scenario === 'permission-denied') expect(data.result.code).toBe('ROTATE_WORKOS_PERMISSION_DENIED');
  if (scenario === 'changed-target') expect(data.result.code).toBe('ROTATE_WORKOS_TARGET_CHANGED');
  if (scenario === 'ambiguous-create') expect(data.result.code).toBe('ROTATE_WORKOS_CREATE_UNCERTAIN');
  expect(data.blocked).toBe(true);
});

test('the synthetic preload refuses an unrelated project before accessing a provider', () => {
  const result = run('success',false);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('SYNTHETIC_WORKOS_PROJECT_REQUIRED');
  expect(result.stdout).toBe('');
});

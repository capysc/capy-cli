import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

const run = (development: boolean, args: readonly string[]) => {
  const entry = development ? 'index-dev' : 'index';
  const script = `
    import {mock} from 'bun:test';
    mock.module('./src/commands/capyCommand.ts',()=>({CapyCommand:class{execute(){throw new Error('Wrong command route');}}}));
    mock.module('./src/core/localGate.ts',()=>({assertNotLocalOnly:()=>undefined}));
    mock.module('./src/commands/rotateReadiness.ts',()=>({inspectLocalRotateReadiness:async options=>({event:'readiness',options,ready:true,checks:[]})}));
    mock.module('./src/commands/rotateFlow.ts',()=>({runRotateFlow:async (variable,options,devMode)=>console.log(JSON.stringify({event:'flow',variable,options,devMode}))}));
    mock.module('./src/commands/rotateCommand.ts',()=>({RotateCommand:class{constructor(devMode){return {execute(variable,options){console.log(JSON.stringify({event:'ordinary',variable,options,devMode}));}};}}}));
    Reflect.set(process,'argv',[process.execPath,'capy',...${JSON.stringify(args)}]);
    await import('./src/${entry}.ts');
  `;
  const result = Bun.spawnSync([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  const lines = new TextDecoder().decode(result.stdout).trim().split('\n');
  return JSON.parse(lines.find(line => line.startsWith('{"event":')) ?? '{}');
};

describe('real production/dev argv dispatch with fake command boundaries', () => {
  for (const devMode of [false, true]) {
    test(`readiness preserves expected identity after the subcommand (dev=${devMode})`, () => {
      const result = run(devMode, ['rotate', 'KEY', '--provider', 'workos', '--expected-user-id', 'user_fixture', '--no-push', '--check-readiness']);
      expect(result.event).toBe('readiness');
      expect(result.options).toMatchObject({expectedUserId:'user_fixture',noPush:true,devMode});
    });
    test(`Flow honors parent identity, variable and deployment intent (dev=${devMode})`, () => {
      const result = run(devMode, ['--flow', '--expected-user-id', 'user_fixture', 'rotate', 'KEY', '--provider', 'workos', '--deploy-kind', 'cf-worker']);
      expect(result).toMatchObject({event:'flow',variable:'KEY',devMode,options:{expectedUserId:'user_fixture',provider:'workos',deployKind:'cf-worker',skipPrompts:false}});
    });
    test(`ordinary terminal route remains ordinary (dev=${devMode})`, () => {
      const result = run(devMode, ['rotate', 'KEY', '--no-push']);
      expect(result).toMatchObject({event:'ordinary',variable:'KEY',devMode,options:{noPush:true,web:false}});
    });
  }
});

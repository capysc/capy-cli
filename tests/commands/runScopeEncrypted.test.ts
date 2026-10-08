import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCipheriv, createHash, randomBytes } from 'crypto';

const projectKey = 'dummy-project-key';
const resolveKey = mock(async () => projectKey);
const authenticate = mock(async () => ({success:true,user_id:'test-user'}));
const spawn = mock((_command: string, _args: readonly string[], _options: Readonly<{env:Readonly<Record<string,string|undefined>>}>) => ({
  on: (event: string, cb: (...args: unknown[]) => void) => { if (event === 'close') queueMicrotask(() => cb(0)); },
  kill: () => {},
}));
mock.module('child_process', () => ({ spawn, ChildProcess: class {} }));
mock.module('../../src/auth/authService', () => ({AuthService: class { authenticateSilent = authenticate; getValidToken = async () => 'fake'; }}));
mock.module('../../src/service/serviceClient', () => ({ServiceClient: class { setTokenProvider = () => {}; }}));
mock.module('../../src/crypto/keyResolver', () => ({resolveProjectKey:resolveKey}));
mock.module('../../src/config/profileConfig', () => ({isLocalOnly:()=>false,resolveActiveUrl:()=>'http://127.0.0.1'}));
mock.module('../../src/core/repoLinkReporter', () => ({reportRepoLink:async()=>undefined}));
const {runCommand} = await import('../../src/commands/runCommand');
const errors = spyOn(console,'error').mockImplementation(()=>{});
const parent = process.cwd();
const dir = mkdtempSync(join(tmpdir(),'capy-run-encrypted-scope-'));
const options = {org:'o',project:'p',branch:'local',only:'NEEDED'} as const;
function encrypted(value: string): string {
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(projectKey).digest(),iv);
  const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return `capy:abcde:${Buffer.concat([iv,ciphertext,cipher.getAuthTag()]).toString('base64')}`;
}
beforeEach(()=>{
  process.chdir(dir);
  spawn.mockClear(); resolveKey.mockClear(); authenticate.mockClear(); errors.mockClear();
  mkdirSync(join(dir,'.capy'),{recursive:true});
  writeFileSync(join(dir,'.capy','branch'),'local');
  writeFileSync(join(dir,'keep.lock'),JSON.stringify({org_id:'o',project_id:'p',variables:{}}));
  writeFileSync(join(dir,'.env'),`NEEDED=${encrypted('synthetic-selected-value')}\nUNRELATED=capy:abcde:broken\n`);
});
afterAll(()=>{process.chdir(parent);mock.restore();rmSync(dir,{recursive:true,force:true});});
test('only selected ciphertext is decrypted and injected',async()=>{
  expect(await runCommand(['dummy'],false,options)).toBe(0);
  expect(spawn.mock.calls[0][2].env.NEEDED).toBe('synthetic-selected-value');
  expect(spawn.mock.calls[0][2].env.UNRELATED).toBeUndefined();
  expect(resolveKey).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls.flat().join(' ')).not.toContain('synthetic-selected-value');
});
test('unscoped run fails before authentication, key resolution or spawn',async()=>{
  expect(await runCommand(['dummy'],false,{nonTty:true})).toBe(1);
  expect(authenticate).not.toHaveBeenCalled();expect(resolveKey).not.toHaveBeenCalled();expect(spawn).not.toHaveBeenCalled();
});
test('context mismatch fails before authentication, key resolution or spawn',async()=>{
  expect(await runCommand(['dummy'],false,{...options,org:'wrong'})).toBe(1);
  expect(authenticate).not.toHaveBeenCalled();expect(resolveKey).not.toHaveBeenCalled();expect(spawn).not.toHaveBeenCalled();
});

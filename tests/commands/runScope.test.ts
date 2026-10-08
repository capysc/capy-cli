import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { requiresExplicitRunScope, validateRunScope } from '../../src/core/runScope';

const scope = ['--org', 'org-fixture', '--project', 'project-fixture', '--branch', 'local', '--only', 'NEEDED'];
const cli = resolve(import.meta.dir, '../../dist/index.js');
const child = ['--', 'node', '-e', 'console.log(JSON.stringify({needed:process.env.NEEDED,unrelated:process.env.UNRELATED,aws:process.env.AWS_SECRET_ACCESS_KEY}))'];
function run(args: readonly string[], settings: Readonly<{ envFile?: string; lock?: boolean; branch?: string; dev?: boolean; env?: Readonly<Record<string, string>> }> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'capy-scope-'));
  try {
    writeFileSync(join(dir, '.env'), settings.envFile ?? 'NEEDED=dummy\nUNRELATED=must-not-inherit\nAWS_SECRET_ACCESS_KEY=must-not-inherit\n');
    if (settings.lock !== false) writeFileSync(join(dir, 'keep.lock'), JSON.stringify({version:'3.0',org_id:'org-fixture',project_id:'project-fixture',project_name:'fixture',variables:{}}));
    mkdirSync(join(dir, '.capy'));
    writeFileSync(join(dir, '.capy', 'branch'), settings.branch ?? 'local');
    return spawnSync('node', [settings.dev ? cli.replace('index.js', 'index-dev.js') : cli, 'run', ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, CAPY_NO_REPO_LINK: '1', ...settings.env },
      encoding: 'utf8', timeout: 10000,
    });
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

describe('local run scope', () => {
  test('the reported unscoped administration pattern refuses before running the child', () => {
    const result = run(['--', 'env', 'AWS_PROFILE=personal-vpn-terraform', ...child.slice(1)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RUN_SCOPE_REQUIRED');
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('must-not-inherit');
  });
  test('plaintext allowlist excludes unrelated .env values and inherited copies', () => {
    const result = run([...scope, ...child], {env:{UNRELATED:'ambient-copy',AWS_SECRET_ACCESS_KEY:'ambient-copy'}});
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({needed:'dummy'});
    expect(result.stderr).toContain('variables=NEEDED');
    expect(result.stderr).not.toContain('dummy');
  });
  test('unselected encrypted variables do not trigger authentication or decryption', () => {
    const result = run([...scope, ...child], {envFile:'NEEDED=dummy\nUNRELATED=capy:abcde:not-valid-ciphertext\n'});
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({needed:'dummy'});
  });
  test.each(['org','project','branch'])('wrong %s refuses before decrypt or spawn', field => {
    const args = scope.map((value,index) => scope[index-1] === `--${field}` ? 'wrong' : value);
    const result = run([...args, ...child], {envFile:'NEEDED=capy:abcde:not-valid-ciphertext\n'});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RUN_CONTEXT_MISMATCH');
    expect(result.stdout).toBe('');
  });
  test('missing lock refuses even for plaintext variables', () => {
    const result = run([...scope, ...child], {lock:false});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RUN_CONTEXT_MISMATCH');
  });
  test('conflicting .env project metadata refuses', () => {
    const result = run([...scope, ...child], {envFile:'# capy:project_id=other\nNEEDED=dummy\n'});
    expect(result.stderr).toContain('RUN_CONTEXT_MISMATCH');
    expect(result.status).toBe(1);
  });
  test.each(['*','MISSING','NEEDED,'])('invalid selector %s refuses', only => {
    const result = run([...scope.slice(0,-1), only, ...child]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RUN_SCOPE_INVALID');
  });
  test('dev entrypoint enforces the same guard and accepts explicit scope', () => {
    expect(run(child, {dev:true}).stderr).toContain('RUN_SCOPE_REQUIRED');
    const result = run([...scope,...child], {dev:true});
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({needed:'dummy'});
  });
  test('flags after -- belong to the child and cannot authorize injection', () => {
    const result = run([...child, ...scope]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RUN_SCOPE_REQUIRED');
  });
  test('partial scope cannot silently select all variables', () => {
    expect(run(['--only','NEEDED',...child]).stderr).toContain('RUN_SCOPE_REQUIRED');
  });
  test('empty local environment still forwards a command without scope', () => {
    expect(run(child,{envFile:''}).status).toBe(0);
  });
  test('recognized agents require scope even with a PTY; ordinary terminals retain compatibility', () => {
    for (const name of ['CODEX_THREAD_ID','CODEX_CI','CLAUDECODE','CURSOR_AGENT']) expect(requiresExplicitRunScope(true,{[name]:'1'})).toBe(true);
    expect(requiresExplicitRunScope(true,{})).toBe(false);
    expect(requiresExplicitRunScope(true,{},true)).toBe(true);
    expect(requiresExplicitRunScope(false,{})).toBe(true);
  });
  test('complete scope returns distinct explicit names', () => {
    expect(validateRunScope({org:'o',project:'p',branch:'b',only:'ONE, TWO,ONE'})).toEqual(['ONE','TWO']);
  });
});

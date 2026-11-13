/**
 * What the protected-branch gate must leave alone, proven against the built CLI:
 *
 *  - deployed mode (a runtime blob pair in the environment) never asks which branch it is on
 *    and never needs `--protected`, even in a folder that says it is on a protected branch;
 *  - `capy edit` on a protected branch is unaffected;
 *  - the gate is reachable from `capy run` and `capy export` only.
 *
 * Needs `bun run build` first, like the other tests that spawn `dist/`.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { spawn } from 'child_process';
import { hkdfSync, randomBytes } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildSecretsBlob,
  deployInnerWrap,
  encryptEnvBlob,
  generateDeployId,
  generateDerivationToken,
} from '../../src/crypto/deployCrypto';

const CLI = join(__dirname, '../../dist/index.js');
const SRC = join(__dirname, '../../src');

interface Cli {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function capy(args: ReadonlyArray<string>, opts: { cwd: string; serviceUrl: string; env?: Record<string, string> }): Promise<Cli> {
  const home = mkdtempSync(join(tmpdir(), 'capy-gate-home-'));
  mkdirSync(join(home, '.capy'), { recursive: true });
  writeFileSync(
    join(home, '.capy', 'config.json'),
    JSON.stringify({ default: 'test', profiles: { test: { url: opts.serviceUrl } } }),
  );
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, CAPY_NO_AUTOCOMMIT: '1', ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout.on('data', (d: Buffer) => void out.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => void err.push(d.toString()));
    const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('close', (code: number | null) => {
      clearTimeout(killer);
      rmSync(home, { recursive: true, force: true });
      resolve({ stdout: out.join(''), stderr: err.join(''), exitCode: code ?? 1 });
    });
    child.stdin.end();
  });
}

function deployedFixture(envVars: Record<string, string>) {
  const projectId = 'proj_1';
  const pk = randomBytes(32);
  const deployId = generateDeployId();
  const innerBlob = deployInnerWrap(pk, generateDerivationToken(), projectId);
  const encryptedVars = encryptEnvBlob(envVars, pk, innerBlob, projectId, deployId);
  const secretsBlob = buildSecretsBlob(deployId, innerBlob, encryptedVars);
  const salt = projectId + deployId.toString('hex');
  const serviceKeyHex = Buffer.from(
    hkdfSync('sha256', Buffer.from(innerBlob, 'base64'), salt, 'capy:deploy:service-key', 32),
  ).toString('hex');
  return { projectKey: pk.toString('hex'), secretsBlob, serviceKeyHex };
}

/** A fake service that records every request and would call `prod` protected if anyone asked. */
async function startService(serviceKeyHex: string) {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && /^\/deploy\/[0-9a-f]+\/decrypt$/.test(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service_key: serviceKeyHex }));
    } else if (req.method === 'GET' && /\/branches$/.test(req.url ?? '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ branches: [{ id: 'b1', name: 'prod', project_id: 'proj_1', is_protected: true }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
  return { url: `http://127.0.0.1:${addr.port}`, seen, close: () => server.close() };
}

const KEEP = JSON.stringify({ version: '1', org_id: 'org_1', project_id: 'proj_1', project_name: 'p', variables: {} });

/** A project folder that says it is on branch `prod`. */
function protectedFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'capy-gate-folder-'));
  writeFileSync(join(dir, 'keep.lock'), KEEP);
  writeFileSync(join(dir, '.env'), '# capy:branch=prod\nSECRET=capy:abcde:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
  mkdirSync(join(dir, '.capy'), { recursive: true });
  writeFileSync(join(dir, '.capy', 'branch'), 'prod');
  return dir;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
});

describe('deployed mode: no branch lookup, no flag', () => {
  const cases = [
    { name: 'SECRETS_BLOB + PROJECT_KEY', names: { blob: 'SECRETS_BLOB', key: 'PROJECT_KEY' } },
    { name: '_SECRETS_BLOB + _PROJECT_KEY', names: { blob: '_SECRETS_BLOB', key: '_PROJECT_KEY' } },
  ] as const;

  for (const c of cases) {
    test(`${c.name}: runs in a folder on a protected branch, the server is never asked about branches`, async () => {
      const fx = deployedFixture({ API_KEY: 'sk-deployed' });
      const service = await startService(fx.serviceKeyHex);
      const dir = protectedFolder();
      cleanups.push(service.close, () => rmSync(dir, { recursive: true, force: true }));

      const r = await capy(['run', '--', 'node', '-e', 'console.log(process.env.API_KEY)'], {
        cwd: dir,
        serviceUrl: service.url,
        env: { [c.names.blob]: fx.secretsBlob, [c.names.key]: fx.projectKey },
      });

      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('sk-deployed');
      expect(r.stderr).not.toContain('PROTECTED_');
      expect(service.seen.some((line) => /\/branches/.test(line))).toBe(false);
      expect(service.seen).toHaveLength(1); // only the deploy-key fetch it always made
    });
  }
});

describe('the --protected flag on the built CLI', () => {
  test('is listed by `capy help --json` with the two codes', async () => {
    const service = await startService('00'.repeat(32));
    const dir = protectedFolder();
    cleanups.push(service.close, () => rmSync(dir, { recursive: true, force: true }));
    const r = await capy(['help', '--json'], { cwd: dir, serviceUrl: service.url });
    const doc = JSON.parse(r.stdout);
    const run = doc.commands.find((c: { path: string }) => c.path === 'run');
    expect(run.options.map((o: { long: string }) => o.long)).toEqual(['--protected']);
    expect(doc.errorCodes).toContain('PROTECTED_BRANCH_NEEDS_FLAG');
    expect(doc.errorCodes).toContain('PROTECTED_STATUS_UNREADABLE');
  });

  test('is read before `--`; after `--` it belongs to the child', async () => {
    const service = await startService('00'.repeat(32));
    const dir = mkdtempSync(join(tmpdir(), 'capy-gate-folder-'));
    writeFileSync(join(dir, '.env'), 'PLAIN=1\n');
    cleanups.push(service.close, () => rmSync(dir, { recursive: true, force: true }));
    const show = 'console.log(JSON.stringify(process.argv.slice(1)))';
    const before = await capy(['run', '--protected', '--', 'node', '-e', show], { cwd: dir, serviceUrl: service.url });
    const after = await capy(['run', '--', 'node', '-e', show, '--', '--protected'], { cwd: dir, serviceUrl: service.url });
    expect(before.exitCode).toBe(0);
    expect(JSON.parse(before.stdout)).toEqual([]);
    expect(JSON.parse(after.stdout)).toEqual(['--protected']);
  });
});

describe('capy edit on a protected branch', () => {
  test('is unaffected: it answers as it always did, and never asks the server about branches', async () => {
    const service = await startService('00'.repeat(32));
    const dir = protectedFolder();
    cleanups.push(service.close, () => rmSync(dir, { recursive: true, force: true }));

    // No name and nothing on a terminal: edit refuses before any auth or network call.
    const r = await capy(['edit', '--json'], { cwd: dir, serviceUrl: service.url });

    const all = r.stdout + r.stderr;
    expect(all).toContain('EDIT_NEEDS_TTY');
    expect(all).not.toContain('PROTECTED_');
    expect(service.seen).toEqual([]);
  });

  test('the edit and secrets-write code has no path to the gate', () => {
    const sources = sourceFilesUnder(SRC);
    const reachGate = sources
      .filter((f) => /protectedBranchGate|PROTECTED_BRANCH_NEEDS_FLAG|PROTECTED_STATUS_UNREADABLE|allowProtected/.test(readFileSync(f, 'utf-8')))
      .map((f) => f.slice(SRC.length + 1))
      .sort();
    const allowed = new Set([
      'commands/exportCommand.ts',
      'commands/runCommand.ts',
      'core/protectedBranchGate.ts',
      'index-dev.ts',
      'index.ts',
      'types/index.ts',
    ]);
    expect(reachGate.filter((f) => !allowed.has(f))).toEqual([]);
    const editLike = reachGate.filter((f) => /edit|secrets|add|push|checkout/i.test(f));
    expect(editLike).toEqual([]);
  });
});

function sourceFilesUnder(dir: string): ReadonlyArray<string> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFilesUnder(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

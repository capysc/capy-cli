import { mock, describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

// Mock homedir to a temp dir BEFORE importing anything that reads os.homedir().
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-localflow-home-'));
mock.module('os', () => {
  const actual = require('os');
  // `default` too: modules loaded later (bare capy, which every `capy push` runs first, loads inquirer) import `os` by default.
  return { ...actual, default: { ...actual, homedir: () => tempHome }, homedir: () => tempHome };
});

// Network tripwire: any fetch in local-only mode is a leak.
let fetchCalled = false;
const realFetch = global.fetch;
global.fetch = ((..._args: any[]) => {
  fetchCalled = true;
  throw new Error('LEAK: network call in local-only mode');
}) as any;

const realCwd = process.cwd();
let projectDir: string;

beforeAll(async () => {
  const gc = await import('../../src/config/globalConfig');
  const kr = await import('../../src/crypto/keyResolver');
  const km = await import('../../src/crypto/keyManager');
  const { saveAndActivateProfile } = await import('../../src/config/profileConfig');

  // Local-only profile + unlocked passphrase session.
  saveAndActivateProfile('local', { url: 'local://', localOnly: true });
  const M = km.seedPhraseToMasterKey(km.generateSeedPhrase());
  kr.saveLocalKey(M, 'test-passphrase');
  gc.saveLocalSession(M.toString('hex'));

  // A project dir with a local keep.lock + a plaintext .env.
  projectDir = mkdtempSync(join(require('os').tmpdir(), 'capy-localflow-proj-'));
  mkdirSync(join(projectDir, '.capy'), { recursive: true });
  writeFileSync(join(projectDir, '.capy', 'branch'), 'development');
  writeFileSync(
    join(projectDir, 'keep.lock'),
    JSON.stringify({
      version: '3.0',
      org_id: gc.LOCAL_ORG_ID,
      project_id: 'proj-localflow',
      project_name: 'localflow',
      variables: {},
    }),
  );
  writeFileSync(join(projectDir, '.env'), 'MY_SECRET=hello-offline\n');
  process.chdir(projectDir);
});

afterAll(() => {
  process.chdir(realCwd);
  global.fetch = realFetch;
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('local-only end-to-end (offline, no leakage)', () => {
  it('capy push commits locally with zero network calls (off a terminal bare capy reports the new variable first; --resolve local commits it)', async () => {
    const { PushCommand } = await import('../../src/commands/pushCommand');
    // stdin is not a terminal here, so nobody can answer bare capy's menu: the difference comes back as a row.
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const first = await new PushCommand()
      .execute()
      .then(() => 'returned')
      .catch((e: Error) => e.message);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0] ?? '{}')) as { code?: string; conflict_id?: string; conflicts?: Array<{ name: string; type: string; remote: string | null }> };
    log.mockRestore();
    err.mockRestore();
    expect(first).toBe('__exit_3__');
    expect(payload.code).toBe('SECRETS_CONFLICT');
    expect(payload.conflicts).toMatchObject([{ name: 'MY_SECRET', type: 'new', remote: null }]);
    expect(fetchCalled).toBe(false);

    const quiet = spyOn(console, 'log').mockImplementation(() => {});
    const quietErr = spyOn(console, 'error').mockImplementation(() => {});
    await new PushCommand().execute({ conflictFlags: { resolve: ['MY_SECRET=local'], conflict: payload.conflict_id } });
    quiet.mockRestore();
    quietErr.mockRestore();
    exit.mockRestore();

    expect(fetchCalled).toBe(false);

    // Keep cache written under the synthetic local org.
    const gc = await import('../../src/config/globalConfig');
    const keepDir = join(gc.getGlobalCapyDir(), 'keep', gc.LOCAL_ORG_ID, 'proj-localflow');
    expect(existsSync(keepDir)).toBe(true);
    expect(readdirSync(keepDir).length).toBeGreaterThan(0);
  });

  it('the committed secret decrypts offline with the local key', async () => {
    const { resolveLocalProjectKey } = await import('../../src/core/localUnlock');
    const { FileManager } = await import('../../src/files/fileManager');
    const fm = new FileManager();

    // After push the keep.lock holds the variable; the encrypted blob is in
    // the keep cache. Resolve the key offline and decrypt the cached value.
    const key = await resolveLocalProjectKey('proj-localflow');

    const gc = await import('../../src/config/globalConfig');
    const { SyncEngine } = await import('../../src/sync/syncEngine');
    const pm = new (await import('../../src/core/projectManager')).ProjectManager();
    const keep = pm.readKeepFile();
    const hash = SyncEngine.computeKeepHash(keep!, 'development');
    const blob = gc.readSecretsLocal(gc.LOCAL_ORG_ID, 'proj-localflow', hash);
    expect(blob?.env_file).toBeTruthy();

    const encrypted = fm.parseEnvContent(blob!.env_file);
    const decrypted = fm.decryptValue(encrypted['MY_SECRET'], key);
    expect(decrypted).toBe('hello-offline');
    expect(fetchCalled).toBe(false);
  });
});

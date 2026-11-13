/**
 * First LOCAL-ONLY project setup (bare `capy` in a folder with no project, local-only profile): what the TRACKED
 * `keep.lock` holds afterwards, in the working tree and as staged in git.
 *
 * `initializeProjectLocal` writes identity with no pins, then runs `syncProject`, which pins the `.env` but (shared by
 * every command) leaves an existing tracked file alone. So the setup path itself must carry the pins into the tracked
 * file and stage it, or the file the user commits has zero pins.
 *
 * Real everything, in a temp home and a temp git repository; a network tripwire proves nothing leaves the machine.
 * Off a terminal the sync's differences are answered with `--resolve`, so the first run reports the rows and the
 * second run answers them (the same shape as localOnlyFlow.test.ts).
 *
 * Isolated: `mock.module()` is process-wide (tests/run-tests.sh).
 */
import { mock, describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, spyOn } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A temp home BEFORE anything that reads os.homedir() is imported.
const tempHome = mkdtempSync(join(tmpdir(), 'capy-localsetup-home-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, default: { ...actual, homedir: () => tempHome }, homedir: () => tempHome };
});

const fetchCalls = mock(() => undefined);
const realFetch = global.fetch;
global.fetch = ((..._args: unknown[]) => {
  fetchCalls();
  throw new Error('LEAK: network call in local-only mode');
}) as never;

const ORIGIN = process.cwd();
const dirs = mock((_: string) => undefined);

beforeAll(async () => {
  const globalConfig = await import('../../src/config/globalConfig');
  const keyResolver = await import('../../src/crypto/keyResolver');
  const keyManager = await import('../../src/crypto/keyManager');
  const { saveAndActivateProfile } = await import('../../src/config/profileConfig');

  saveAndActivateProfile('local', { url: 'local://', localOnly: true });
  const masterKey = keyManager.seedPhraseToMasterKey(keyManager.generateSeedPhrase());
  keyResolver.saveLocalKey(masterKey, 'test-passphrase');
  globalConfig.saveLocalSession(masterKey.toString('hex'));
});

beforeEach(() => {
  // A throwaway git repository: setup stages keep.lock with `git add` in the working directory.
  const dir = mkdtempSync(join(tmpdir(), 'capy-localsetup-proj-'));
  dirs(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(ORIGIN);
  dirs.mock.calls.forEach(([dir]) => rmSync(dir, { recursive: true, force: true }));
  dirs.mockClear();
});
afterAll(() => {
  global.fetch = realFetch;
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

type SetupOptions = { protocol?: boolean; conflictFlags?: { resolve?: string[]; conflict?: string } };
type KeepLike = { project_id: string; org_id: string; variables: Record<string, Array<{ branch?: string; resource_id: string; value_hash: string }>> };

async function setupLocal(options: SetupOptions): Promise<void> {
  const { CapyCommand } = await import('../../src/commands/capyCommand');
  const quiet = spyOn(console, 'log').mockImplementation(() => {});
  const quietErr = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await (new CapyCommand(options, false) as unknown as { initializeProjectLocal: () => Promise<void> }).initializeProjectLocal();
  } finally {
    quiet.mockRestore();
    quietErr.mockRestore();
  }
}

const trackedPath = (): string => join(process.cwd(), 'keep.lock');
const readKeep = (text: string): KeepLike => JSON.parse(text) as KeepLike;
const stagedText = (): string => execFileSync('git', ['show', ':keep.lock'], { cwd: process.cwd(), encoding: 'utf-8' });

/** The first run off a terminal reports the rows with a conflict_id; the id is returned and the project is reset. */
async function conflictIdFromFirstRun(): Promise<string> {
  const refusal = await setupLocal({ protocol: true }).then(
    () => undefined,
    (e: { details?: { conflict_id?: string } }) => e,
  );
  const id = refusal?.details?.conflict_id;
  expect(typeof id).toBe('string');
  rmSync(trackedPath(), { force: true });
  rmSync(join(process.cwd(), '.capy'), { recursive: true, force: true });
  return id as string;
}

describe('first local-only setup with a .env', () => {
  test('the tracked keep.lock and the staged copy both pin the variables', async () => {
    writeFileSync(join(process.cwd(), '.env'), 'API_KEY=value-one\nDB_URL=value-two\n', 'utf-8');
    const conflict = await conflictIdFromFirstRun();

    await setupLocal({
      protocol: true,
      conflictFlags: { resolve: ['API_KEY=local', 'DB_URL=local'], conflict },
    });

    const tracked = readKeep(readFileSync(trackedPath(), 'utf-8'));
    expect(Object.keys(tracked.variables).sort()).toEqual(['API_KEY', 'DB_URL']);
    expect(tracked.variables.API_KEY[0].branch).toBe('development');
    expect(tracked.variables.DB_URL[0].branch).toBe('development');

    // Same as the working copy, and the STAGED copy is the same file: a bare `git commit` commits the pins.
    expect(readFileSync(trackedPath(), 'utf-8')).toBe(readFileSync(join(process.cwd(), '.capy', 'keep.lock'), 'utf-8'));
    expect(stagedText()).toBe(readFileSync(trackedPath(), 'utf-8'));
    expect(Object.keys(readKeep(stagedText()).variables).sort()).toEqual(['API_KEY', 'DB_URL']);
    expect(fetchCalls).not.toHaveBeenCalled();
  });
});

describe('first local-only setup that pins nothing', () => {
  test('no .env: the tracked keep.lock holds identity and zero pins', async () => {
    await setupLocal({ protocol: true });

    expect(existsSync(trackedPath())).toBe(true);
    const tracked = readKeep(readFileSync(trackedPath(), 'utf-8'));
    expect(tracked.variables).toEqual({});
    expect(tracked.org_id.length).toBeGreaterThan(0);
    expect(fetchCalls).not.toHaveBeenCalled();
  });

  test('the first run that stopped on the reported rows leaves the tracked file as the first write made it', async () => {
    writeFileSync(join(process.cwd(), '.env'), 'API_KEY=value-one\n', 'utf-8');

    const refusal = await setupLocal({ protocol: true }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(refusal).toBeDefined();
    expect(readKeep(readFileSync(trackedPath(), 'utf-8')).variables).toEqual({});
  });
});

/**
 * `capy run -- docker compose …` when forwarding cannot be applied: exactly one
 * line on stderr, nothing on stdout, and the command still runs unchanged with
 * the same exit code. Classes that stay silent: not a compose command, and a
 * compose command where no service reads the Capy .env. Child processes and the
 * key resolution are faked; the encryption, .env parsing and compose planning
 * are real.
 */
import { mock, spyOn, describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KEY = 'ab'.repeat(32);

// The fakes keep no state of their own: the compose file in the project dir
// holds what `docker compose config` should answer, and the fake spawn writes
// the argv it was given to `spawned.json` in that dir.
const actualProfileConfig = { ...(await import('../../src/config/profileConfig')) };

mock.module('child_process', () => ({
  spawn: (cmd: string, args: string[], _opts: unknown) => {
    writeFileSync(join(process.cwd(), 'spawned.json'), JSON.stringify([cmd, ...args]));
    const child = {
      stdio: [],
      on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
        if (event === 'close') queueMicrotask(() => cb(3, null));
        return child;
      },
      kill: () => {},
    };
    return child;
  },
  spawnSync: () => JSON.parse(readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf-8')),
  ChildProcess: class {},
}));

mock.module('../../src/config/profileConfig', () => ({ ...actualProfileConfig, isLocalOnly: () => true }));

mock.module('../../src/core/localUnlock', () => ({
  resolveLocalProjectKey: async () => KEY,
}));

afterAll(() => mock.restore());

const { runCommand } = await import('../../src/commands/runCommand');
const { Encryptor } = await import('../../src/crypto/encryptor');

type Outcome = {
  readonly code: number;
  readonly stderr: readonly string[];
  readonly stdout: readonly string[];
  /** The argv the command was started with, when it was started. */
  readonly spawned: readonly string[] | undefined;
};

type ComposeConfigAnswer = { readonly status: number; readonly stdout: string };

/** Runs `args` in a project whose .env holds one encrypted value; `config` is what `docker compose config` answers. */
async function runIn(args: string[], config: ComposeConfigAnswer): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), 'capy-run-compose-warning-'));
  const cwd = process.cwd();
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    writeFileSync(join(dir, '.env'), `DB_PASSWORD=capy:res-1:${Encryptor.encrypt('hunter2', KEY)}\n`);
    writeFileSync(join(dir, 'keep.lock'), JSON.stringify({ org_id: 'org-1', project_id: 'proj-1' }));
    writeFileSync(join(dir, 'docker-compose.yml'), JSON.stringify(config));
    process.chdir(dir);
    const code = await runCommand(args);
    const spawnedFile = join(dir, 'spawned.json');
    return {
      code,
      stderr: err.mock.calls.map((c) => String(c[0])),
      stdout: [...log.mock.calls.map((c) => String(c[0])), ...out.mock.calls.map((c) => String(c[0]))],
      spawned: existsSync(spawnedFile) ? JSON.parse(readFileSync(spawnedFile, 'utf-8')) : undefined,
    };
  } finally {
    process.chdir(cwd);
    err.mockRestore();
    log.mockRestore();
    out.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}

const WARNING = 'capy run: Docker Compose forwarding was not applied; the command runs unchanged.';
const COMPOSE_UP = ['docker', 'compose', 'up'];
const readsCapyEnv = { status: 0, stdout: JSON.stringify({ services: { app: { env_file: ['.env'] } } }) };
const readsNothing = { status: 0, stdout: JSON.stringify({ services: { app: {} } }) };
const configFailed = { status: 1, stdout: '' };

describe('capy run, compose forwarding gaps', () => {
  test('(a) not a compose command: silent, runs as given', async () => {
    const r = await runIn(['node', '-e', '0'], configFailed);
    expect(r.stderr).not.toContain(WARNING);
    expect(r.spawned).toEqual(['node', '-e', '0']);
    expect(r.code).toBe(3);
  });

  test('(b) compose, but no service reads the Capy .env: silent, runs unchanged', async () => {
    const r = await runIn(COMPOSE_UP, readsNothing);
    expect(r.stderr).not.toContain(WARNING);
    expect(r.spawned).toEqual(COMPOSE_UP);
    expect(r.code).toBe(3);
  });

  test('(c) compose, setup cannot be determined (config fails): exactly one warning on stderr, nothing on stdout, same command, same exit code', async () => {
    const r = await runIn(COMPOSE_UP, configFailed);
    expect(r.stderr.filter((l) => l === WARNING)).toHaveLength(1);
    expect(r.stdout).toEqual([]);
    expect(r.spawned).toEqual(COMPOSE_UP);
    expect(r.code).toBe(3);
  });

  test('(c) compose with --project-directory: exactly one warning, runs unchanged', async () => {
    const argv = ['docker', 'compose', '--project-directory', 'api', 'up'];
    const r = await runIn(argv, readsCapyEnv);
    expect(r.stderr.filter((l) => l === WARNING)).toHaveLength(1);
    expect(r.spawned).toEqual(argv);
  });

  test('success: forwarded, no warning', async () => {
    const r = await runIn(COMPOSE_UP, readsCapyEnv);
    expect(r.stderr).not.toContain(WARNING);
    expect(r.spawned).toContain('/dev/fd/3');
  });
});

/**
 * `capy run -- docker compose …`: containers don't inherit compose's
 * environment, so `env_file: .env` hands them ciphertext. planComposeForward
 * adds a names-only override so compose forwards the decrypted values.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import {
  parseComposeArgs,
  resolveComposeFiles,
  buildOverride,
  planComposeForward,
  type ComposeDeps,
} from '../../src/commands/composeForward';

const CWD = '/app';
const ENV = '/app/.env';

function deps(over: Partial<ComposeDeps> = {}): ComposeDeps {
  return {
    cwd: CWD,
    env: {},
    platform: 'darwin',
    exists: (p) => p === '/app/docker-compose.yml',
    readEnvFiles: () => ({ app: ['/app/.env'], queue: ['.env'], db: [], web: ['/app/web.env'] }),
    ...over,
  };
}

describe('parseComposeArgs', () => {
  test('splits docker compose argv into head, globals and the subcommand', () => {
    expect(parseComposeArgs(['docker', 'compose', '-f', 'a.yml', '-p', 'x', 'run', '--rm', 'app', 'php'])).toEqual({
      head: ['docker', 'compose'],
      globals: ['-f', 'a.yml', '-p', 'x'],
      rest: ['run', '--rm', 'app', 'php'],
    });
  });

  test('handles the standalone docker-compose binary and --flag=value', () => {
    expect(parseComposeArgs(['docker-compose', '--file=a.yml', 'up'])).toEqual({
      head: ['docker-compose'],
      globals: ['--file=a.yml'],
      rest: ['up'],
    });
  });

  test('ignores anything that is not compose', () => {
    expect(parseComposeArgs(['docker', 'run', 'alpine'])).toBeUndefined();
    expect(parseComposeArgs(['php', 'artisan', 'serve'])).toBeUndefined();
  });
});

describe('resolveComposeFiles', () => {
  test('explicit -f flags win', () => {
    expect(resolveComposeFiles(['-f', 'a.yml', '--file=b.yml'], CWD, {})).toEqual(['a.yml', 'b.yml']);
  });

  test('COMPOSE_FILE is used when no -f is given', () => {
    expect(resolveComposeFiles([], CWD, { COMPOSE_FILE: 'a.yml:b.yml', COMPOSE_PATH_SEPARATOR: ':' })).toEqual(['a.yml', 'b.yml']);
  });

  test('defaults keep the override file compose would have loaded', () => {
    const exists = (p: string) => p === '/app/compose.yaml' || p === '/app/compose.override.yaml';
    expect(resolveComposeFiles([], CWD, {}, exists)).toEqual(['compose.yaml', 'compose.override.yaml']);
  });

  test('gives up rather than guess', () => {
    expect(resolveComposeFiles([], CWD, {}, () => false)).toBeUndefined();
    expect(resolveComposeFiles(['--project-directory', 'api'], CWD, {}, () => true)).toBeUndefined();
  });
});

describe('buildOverride', () => {
  test('lists names only, and only for services reading the Capy .env', () => {
    const body = buildOverride({ app: ['/app/.env'], queue: ['.env'], db: [] }, ENV, ['DB_PASSWORD', 'APP_KEY'], CWD);
    expect(JSON.parse(body as string)).toEqual({
      services: {
        app: { environment: ['APP_KEY', 'DB_PASSWORD'] },
        queue: { environment: ['APP_KEY', 'DB_PASSWORD'] },
      },
    });
  });

  test('nothing to do when no service reads the .env', () => {
    expect(buildOverride({ db: [] }, ENV, ['X'], CWD)).toBeUndefined();
  });
});

describe('planComposeForward', () => {
  test('POSIX: names the default file, appends the override on fd 3, never writes a value', () => {
    const plan = planComposeForward(['docker', 'compose', 'up', '-d'], ENV, ['DB_PASSWORD'], deps());
    expect(plan?.args).toEqual(['docker', 'compose', '-f', 'docker-compose.yml', '-f', '/dev/fd/3', 'up', '-d']);
    expect(JSON.parse(plan?.pipe as string).services.app.environment).toEqual(['DB_PASSWORD']);
    expect(plan?.pipe).not.toContain('supersecret');
  });

  test("keeps the user's own -f flags and puts the override last", () => {
    const plan = planComposeForward(['docker', 'compose', '-f', 'interp.yml', 'run', 'app'], ENV, ['K'], deps());
    expect(plan?.args).toEqual(['docker', 'compose', '-f', 'interp.yml', '-f', '/dev/fd/3', 'run', 'app']);
  });

  test('Windows: writes a names-only temp file and cleans it up', () => {
    const plan = planComposeForward(['docker', 'compose', 'up'], ENV, ['K'], deps({ platform: 'win32' }));
    const file = plan?.args[plan.args.indexOf('up') - 1] as string;
    expect(plan?.pipe).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf-8')).services.app.environment).toEqual(['K']);
    plan?.cleanup();
    expect(existsSync(file)).toBe(false);
  });

  test('leaves argv alone when compose config cannot be read', () => {
    expect(planComposeForward(['docker', 'compose', 'up'], ENV, ['K'], deps({ readEnvFiles: () => undefined }))).toBeUndefined();
  });
});

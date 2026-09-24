/**
 * Public parser/refusal contract. These subprocess cases use no saved
 * identity or reachable service, and must leave the fixture repository
 * untouched when a reviewed push cannot authenticate or validate its input.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entrypoint = resolve(import.meta.dir, '../../src/index.ts');

function isolatedInvocation(args: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'capy-push-json-refusal-'));
  const repository = join(root, 'repository');
  // Never the developer's real HOME/~/.capy* — a throwaway home is what
  // actually isolates this run. The prod entrypoint (index.ts) deliberately
  // strips CAPY_GLOBAL_DIR_NAME / CAPY_API_URL / CAPY_KEEP_ORIGIN from its own
  // environment and resolves its target from ~/.capy/config.json instead (see
  // src/config/prodPins.ts), so passing them here would do nothing but trip
  // its stderr notice — and every case below fails at the (non-interactive,
  // sessionless) authentication step, before the service-origin check that
  // would otherwise want a matching profile.
  const fakeHome = join(root, 'home');
  mkdirSync(repository);
  mkdirSync(fakeHome, { recursive: true });
  const globalState = join(fakeHome, '.capy');
  mkdirSync(globalState, { recursive: true });
  const sentinel = join(repository, 'existing.txt');
  writeFileSync(sentinel, 'Preserve this existing repository file.\n', { flag: 'wx' });
  const outcome = spawnSync(process.execPath, [entrypoint, 'push', ...args], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 15_000,
    // Do not inherit credentials, profile selection, debug flags or a real API.
    env: {
      PATH: process.env.PATH,
      HOME: fakeHome,
      CAPY_WEB_NO_OPEN: '1',
      NO_COLOR: '1',
    },
  });
  return { outcome, repository, globalState, sentinel } as const;
}

test('push help advertises the same JSON review interface used by an agent', () => {
  const { outcome } = isolatedInvocation(['--help']);
  expect(outcome.status).toBe(0);
  for (const flag of ['--json', '--plan', '--confirm', '--non-tty', '--expected-user-id', '--service-origin']) {
    expect(outcome.stdout).toContain(flag);
  }
});

test('a fresh unauthenticated JSON push exits with one structured refusal and preserves repository files', () => {
  const { outcome, repository, globalState, sentinel } = isolatedInvocation([
    '--json', '--plan', '--non-tty', '--expected-user-id', 'user_offlinefixture',
    '--service-origin', 'http://127.0.0.1:9',
  ]);
  expect(outcome.error).toBeUndefined();
  expect(outcome.signal).toBeNull();
  expect(outcome.status).toBe(1);
  const result = JSON.parse(outcome.stdout.trim());
  expect(result).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
  expect(outcome.stdout.trim().split('\n')).toHaveLength(1);
  expect(outcome.stdout).not.toContain('https://');
  expect(outcome.stderr).not.toContain('Authenticating');
  expect(readdirSync(repository)).toEqual(['existing.txt']);
  expect(readFileSync(sentinel, 'utf8')).toBe('Preserve this existing repository file.\n');
  // Empty state directories are harmless; no session, key or config file may be created.
  expect(readdirSync(globalState, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())).toEqual([]);
});

for (const [name, args] of [
  ['missing account binding', ['--json', '--plan', '--service-origin', 'http://127.0.0.1:9']],
  ['missing environment binding', ['--json', '--plan', '--expected-user-id', 'user_offlinefixture']],
  ['simultaneous planning and applying', ['--json', '--plan', '--confirm', `hmac-sha256:${'a'.repeat(64)}`,
    '--expected-user-id', 'user_offlinefixture', '--service-origin', 'http://127.0.0.1:9']],
] as const) {
  test(`push refuses ${name} through its actual argument parser`, () => {
    const { outcome, repository, globalState } = isolatedInvocation(args);
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe(1);
    expect(JSON.parse(outcome.stdout.trim())).toEqual({ ok: false, code: 'PUSH_REVIEW_ARGUMENT_INVALID' });
    expect(readdirSync(repository)).toEqual(['existing.txt']);
    expect(readdirSync(globalState)).toEqual([]);
  });
}

test('a supplied environment cannot redirect a reviewed push away from the active CLI service', () => {
  const { outcome, repository, globalState } = isolatedInvocation([
    '--json', '--plan', '--expected-user-id', 'user_offlinefixture',
    '--service-origin', 'https://unrelated.example.invalid',
  ]);
  expect(outcome.status).toBe(1);
  expect(JSON.parse(outcome.stdout.trim())).toEqual({ ok: false, code: 'AUTH_FAILED' });
  expect(readdirSync(repository)).toEqual(['existing.txt']);
  // With both an expected user and a service origin present, this run reaches
  // real (silent, non-interactive) authentication before the origin check —
  // and the fenced-refresh recovery added in 6a9b0c0 ("fix(auth): recover
  // from an indeterminate refresh by signing in again") takes the session
  // lock for that check unconditionally, which creates the (empty) auth/
  // directory as a side effect even when there is no session to find. Empty
  // state directories are harmless, as the sibling assertion above already
  // documents; only a written session, key or config file would matter.
  expect(readdirSync(globalState, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())).toEqual([]);
});

test('review flags cannot fall through to the ordinary interactive push path', () => {
  const { outcome, repository, globalState } = isolatedInvocation(['--plan']);
  expect(outcome.status).toBe(1);
  expect(JSON.parse(outcome.stdout.trim())).toEqual({ ok: false, code: 'PUSH_JSON_REQUIRED' });
  expect(readdirSync(repository)).toEqual(['existing.txt']);
  expect(readdirSync(globalState)).toEqual([]);
});

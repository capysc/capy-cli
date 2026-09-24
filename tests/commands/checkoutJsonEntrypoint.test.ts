import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

for (const entrypoint of ['index.ts', 'index-dev.ts'] as const) {
  const entry = resolve(import.meta.dir, '../../src', entrypoint);
  function invoke(args: readonly string[]) {
    const cwd = mkdtempSync(join(tmpdir(), 'capy-checkout-entry-'));
    // A fresh HOME per call is what actually isolates each run — CAPY_GLOBAL_DIR_NAME
    // is on top of that, and only the dev entrypoint honours it (see prodPins.ts: the
    // prod entrypoint deliberately strips CAPY_GLOBAL_DIR_NAME / CAPY_API_URL /
    // CAPY_KEEP_ORIGIN and prints a stderr notice when it finds them). None of these
    // tests reach a network call or read the global dir before returning, so prod
    // simply doesn't need them — passing them would only trip the notice.
    const configRoot = mkdtempSync(join(tmpdir(), 'capy-checkout-home-'));
    const devOnlyEnv = entrypoint === 'index-dev.ts'
      ? { CAPY_GLOBAL_DIR_NAME: '.capy-checkout-fixture', CAPY_API_URL: 'http://127.0.0.1:9', CAPY_KEEP_ORIGIN: 'http://127.0.0.1:9' }
      : {};
    const result = spawnSync(process.execPath, [entry, 'checkout', 'preview', ...args], {
      cwd, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: configRoot, ...devOnlyEnv, NO_COLOR: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(readdirSync(cwd)).toEqual([]);
    expect(result.stderr).toBe('');
    return { status: result.status, body: JSON.parse(result.stdout) };
  }

  test(`${entrypoint}: non-TTY missing target returns one JSON refusal without auth`, () => {
    const result = invoke(['--non-tty', '--json']);
    expect(result.status).toBe(1);
    expect(result.body.code).toBe('CHECKOUT_TARGET_REQUIRED');
  });
  test(`${entrypoint}: expected account alone cannot fall back to interactive checkout`, () => {
    expect(invoke(['--expected-user-id', 'fixture-user']).body.code).toBe('CHECKOUT_TARGET_REQUIRED');
  });
  test.each(['--expected-user-id', '--expected-org-id', '--expected-project-id', '--expected-branch-id'])(`${entrypoint}: empty %s never falls back to interactive checkout`, (flag) => {
    const result = invoke([flag, '']);
    expect(result.status).toBe(1);
    expect(result.body.code).toBe('CHECKOUT_TARGET_REQUIRED');
  });
  test(`${entrypoint}: complete hosted target still requires a real keep.lock`, () => {
    const result = invoke(['--json', '--non-tty', '--expected-user-id', 'fixture-user', '--expected-org-id', 'fixture-org', '--expected-project-id', 'fixture-project', '--expected-branch-id', 'fixture-branch']);
    expect(result.status).toBe(1);
    expect(result.body.code).toBe('NO_KEEP_FILE');
  });
  test(`${entrypoint}: JSON alone does not start an interactive ceremony`, () => {
    expect(invoke(['--json']).body.code).toBe('NO_KEEP_FILE');
  });
  test(`${entrypoint}: force refresh cannot sneak through the non-TTY route`, () => {
    expect(invoke(['--json', '--non-tty', '--refresh']).body.code).toBe('CHECKOUT_OPTIONS_UNSUPPORTED');
  });
  test(`${entrypoint}: JSON create remains a plan, not a branch mutation`, () => {
    const result = invoke(['--json', '--create', '--no-protected']);
    expect(result.status).toBe(0);
    expect(Array.isArray(result.body.stops)).toBe(true);
  });
}

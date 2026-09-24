import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const AUTHENTICATION_FLOW_ID = '22222222-2222-4222-8222-222222222222';
const EXPECTED_USER_ID = 'user_entrypointfixture';
const SERVICE_ORIGIN = 'http://127.0.0.1:9';

function invoke(
  entrypoint: 'index.ts' | 'index-dev.ts',
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
) {
  // Never the developer's real HOME/~/.capy* — a throwaway home isolates every
  // run regardless of which entrypoint it drives.
  const fakeHome = mkdtempSync(join(tmpdir(), 'capy-expected-user-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'capy-expected-user-project-'));
  // Prod ignores CAPY_API_URL (see prodPins.ts) and resolves its target from
  // ~/.capy/config.json instead. A BYOC-style profile pointed at
  // SERVICE_ORIGIN is how a prod run ever reaches the same origin the test
  // passes via --service-origin, so tests that must get past the "does this
  // origin match the active service" guard and into the real executor need
  // it laid out where prod actually reads it. Harmless for the dev entrypoint,
  // which resolves CAPY_API_URL first and never consults this file.
  const capyDir = join(fakeHome, '.capy');
  mkdirSync(capyDir, { recursive: true });
  writeFileSync(join(capyDir, 'config.json'), JSON.stringify({
    default: 'fixture', profiles: { fixture: { url: SERVICE_ORIGIN } },
  }));
  try {
    // The prod entrypoint (index.ts) deliberately strips CAPY_GLOBAL_DIR_NAME /
    // CAPY_API_URL / CAPY_KEEP_ORIGIN from its environment and prints a stderr
    // notice when it finds them (see src/config/prodPins.ts) — so only hand
    // them to the dev entrypoint, which still honours them. Prod's isolation
    // comes from the throwaway HOME above; it never reads these regardless.
    const devOnlyEnv = entrypoint === 'index-dev.ts'
      ? { CAPY_GLOBAL_DIR_NAME: '.capy-dev-fixture', CAPY_API_URL: SERVICE_ORIGIN, CAPY_KEEP_ORIGIN: 'http://127.0.0.1:8' }
      : {};
    const result = spawnSync(process.execPath, [resolve(import.meta.dir, '../../src', entrypoint), ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        HOME: fakeHome,
        ...devOnlyEnv,
        CAPY_WEB_NO_OPEN: '1',
        NO_COLOR: '1',
        ...extraEnv,
      },
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr } as const;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

function parseSingleJson(stdout: string): Readonly<Record<string, unknown>> {
  return JSON.parse(stdout) as Readonly<Record<string, unknown>>;
}

for (const entrypoint of ['index.ts', 'index-dev.ts'] as const) {
  describe(`${entrypoint} repeated expected-user-id option`, () => {
    const pairArguments = [
      'pair', '--json', '--flow-id', 'invalid-flow-id',
      '--authentication-flow-id', AUTHENTICATION_FLOW_ID,
      '--expected-user-id', EXPECTED_USER_ID,
      '--service-origin', SERVICE_ORIGIN,
      '--runtime-only',
    ] as const;

    test('delivers the post-subcommand identity to readiness validation', () => {
      const result = invoke(entrypoint, pairArguments);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(parseSingleJson(result.stdout)).toEqual({
        ok: false,
        flow_id: 'invalid-flow-id',
        code: 'READINESS_ARGUMENT_INVALID',
      });
    });

    test('preserves a late global web flag while delivering the child identity', () => {
      const result = invoke(entrypoint, [...pairArguments, '--web']);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(parseSingleJson(result.stdout)).toEqual({
        ok: false,
        flow_id: 'invalid-flow-id',
        code: 'READINESS_ARGUMENT_INVALID',
      });
    });

    test.each([
      ['setup', 'SETUP_ARGUMENT_INVALID'],
      ['add', 'INTAKE_ARGUMENT_INVALID'],
    ] as const)('refuses flow %s without an identity before its executor', (subcommand, code) => {
      const result = invoke(entrypoint, [
        'flow', subcommand, AUTHENTICATION_FLOW_ID,
        '--service-origin', SERVICE_ORIGIN,
        '--json',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(parseSingleJson(result.stdout)).toEqual({
        ok: false,
        flow_id: AUTHENTICATION_FLOW_ID,
        code,
      });
    });

    test.each([
      ['setup', 'SETUP_EXECUTOR_FAILED'],
      ['add', 'INTAKE_EXECUTOR_FAILED'],
    ] as const)('delivers a post-subcommand identity to flow %s', (subcommand, code) => {
      // The owned empty cwd fails the repository-root preflight before session or network access.
      const result = invoke(entrypoint, [
        'flow', subcommand, AUTHENTICATION_FLOW_ID,
        '--expected-user-id', EXPECTED_USER_ID,
        '--service-origin', SERVICE_ORIGIN,
        '--json',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(parseSingleJson(result.stdout)).toEqual(expect.objectContaining({
        ok: false,
        flow_id: AUTHENTICATION_FLOW_ID,
        code,
        message: expect.any(String),
      }));
    });

    test('keeps expected-user-id after the run delimiter in child arguments', () => {
      const result = invoke(
        entrypoint,
        ['run', '--', 'echo', '--expected-user-id', 'child-value'],
        { _CAPY_DEPLOY_KEY: 'fixture-half-pair' },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('ambiguous deploy credentials');
    });
  });
}

/**
 * The staging launcher must never send a pairing or transport link to the
 * production Keep origin. The probe replaces the compiled entrypoint before
 * it loads, so it exercises only the wrapper and cannot authenticate.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const WRAPPER = join(__dirname, '../../bin/capy-staging');
const STAGING_KEEP_ORIGIN = 'https://staging-keep.capy.sc';
const PROBE = `
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = (request, parent, isMain) => request.endsWith('dist/index-dev.js')
  ? (process.stdout.write(JSON.stringify({ keepOrigin: process.env.CAPY_KEEP_ORIGIN })), {})
  : originalLoad(request, parent, isMain);
require(process.argv[1]);
`;

function runWrapper(environment: NodeJS.ProcessEnv): { readonly keepOrigin?: string; readonly code: number; readonly stderr: string } {
  const result = spawnSync('node', ['-e', PROBE, WRAPPER], { encoding: 'utf-8', env: environment });
  return {
    keepOrigin: result.stdout ? JSON.parse(result.stdout).keepOrigin : undefined,
    code: result.status ?? 1,
    stderr: result.stderr ?? '',
  };
}

const environmentWithoutKeepOrigin = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'CAPY_KEEP_ORIGIN'),
);

describe('capy-staging launcher', () => {
  test('defaults Keep links to staging without loading authentication', () => {
    const result = runWrapper(environmentWithoutKeepOrigin);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.keepOrigin).toBe(STAGING_KEEP_ORIGIN);
  });

  test('preserves an explicit Keep origin override', () => {
    const result = runWrapper({ ...environmentWithoutKeepOrigin, CAPY_KEEP_ORIGIN: 'https://keep.example.invalid' });
    expect(result.code).toBe(0);
    expect(result.keepOrigin).toBe('https://keep.example.invalid');
  });
});

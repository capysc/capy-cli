import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertStagingFlowTargets } from '../../src/ui/stagingFlow';

test('staging flow targets allow only staging or isolated local fixtures', () => {
  expect(() => assertStagingFlowTargets('https://staging-api.capy.sc', 'https://staging-keep.capy.sc')).not.toThrow();
  expect(() => assertStagingFlowTargets('http://127.0.0.1:4000', 'http://localhost:4001')).not.toThrow();
  for (const [service, keep] of [['https://api.capy.sc', 'https://staging-keep.capy.sc'],
    ['https://staging-api.capy.sc', 'https://keep.capy.sc'], ['https://staging-api.capy.sc/path', 'https://staging-keep.capy.sc'],
    ['https://user:credential@staging-api.capy.sc', 'https://staging-keep.capy.sc']]) {
    expect(() => assertStagingFlowTargets(service, keep)).toThrow('STAGING_FLOW_TARGET_INVALID');
  }
});

test('production entry cannot execute either staging flow operation', () => {
  for (const args of [['onboard', '--json'], ['flow', '--id', '55555555-5555-4555-8555-555555555555', '--json']]) {
    const result = spawnSync(process.execPath.endsWith('bun') ? 'node' : process.execPath, [resolve('bin/capy'), ...args], { encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, code: 'STAGING_BINARY_REQUIRED' });
  }
});

test('the staging wrapper rejects production origins before loading a command', () => {
  const result = spawnSync('node', [resolve('bin/capy-staging'), '--help'], {
    env: { ...process.env, CAPY_API_URL: 'https://api.capy.sc' }, encoding: 'utf8', timeout: 5000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('STAGING_FLOW_TARGET_INVALID');
  expect(result.stdout).toBe('');
});

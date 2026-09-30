import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const entrypoint of ['index.ts', 'index-dev.ts']) {
  test(`${entrypoint} passes audit --json through the shared root flag`, () => {
    const home = mkdtempSync(join(tmpdir(), 'capy-audit-entry-'));
    try {
      const result = spawnSync(process.execPath, [resolve(import.meta.dir, '../../src', entrypoint), 'audit', '--json', '--org', 'org_fixture'], {
        cwd: home, encoding: 'utf8', timeout: 10_000,
        env: { PATH: process.env.PATH, HOME: home, CAPY_WEB_NO_OPEN: '1' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).not.toContain('Use --json');
      expect(output).toMatch(/session|sign in/i);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

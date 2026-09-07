import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

for (const entrypoint of ['index.ts', 'index-dev.ts'] as const) {
  test(`${entrypoint} exposes the typed authentication command`, () => {
    const result = spawnSync(process.execPath, [
      resolve(import.meta.dir, '../..', 'src', entrypoint),
      'flow', 'authenticate', '--help',
    ], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('authenticate [options] <id>');
    expect(result.stdout).toContain('--expected-user-id <id>');
    expect(result.stdout).toContain('--service-origin <origin>');
    expect(result.stdout).toContain('--json');
  });
}

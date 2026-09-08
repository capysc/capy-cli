import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

for (const entrypoint of ['index.ts', 'index-dev.ts'] as const) {
  test(`${entrypoint} exposes unified instrumented pairing and retires the public auth subcommand`, () => {
    const result = spawnSync(process.execPath, [
      resolve(import.meta.dir, '../..', 'src', entrypoint),
      'pair', '--help',
    ], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pair [options]');
    expect(result.stdout).toContain('--flow-id <id>');
    expect(result.stdout).toContain('--authentication-flow-id <id>');
    expect(result.stdout).toContain('--expected-user-id <id>');
    expect(result.stdout).toContain('--service-origin <origin>');
    expect(result.stdout).toContain('--json');
  });
}

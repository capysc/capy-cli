import { expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test('injected paid auto-commit reporter preserves commit and leaves structured stdout clean', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'capy-reporter-'));
  const git = (args: readonly string[]) => execFileSync('git', [...args], { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['init', '-q', '-b', 'fixture']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@example.test']);
    writeFileSync(join(fixture, 'keep.lock'), '{}\n');
    const modulePath = join(import.meta.dir, '../../src/git/autoCommitKeep.ts');
    const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e',
      `import {autoCommitKeep} from ${JSON.stringify(modulePath)}; const result=autoCommitKeep('development', process.cwd(), (_message, warning)=>console.error(warning?'warning':'status')); if(!result.committed)process.exit(2);`],
    { cwd: fixture, env: { ...process.env, CAPY_NO_AUTOCOMMIT: '0' }, stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe('');
    expect(child.stderr.toString().trim()).toBe('status');
    expect(git(['log', '-1', '--format=%s']).trim()).toBe('chore(capy): pin development secrets');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

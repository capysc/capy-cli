/**
 * The `capy connect vercel` flags, through the real CLI program:
 *   - `--create-token` and `--token-expires-days` are gone — an unknown option
 *     gets the CLI's normal refusal (exit 1), and neither is in `--help`;
 *   - `--targets` exists, with its approved help line.
 *
 * Spawns `src/index.ts` with an empty HOME, so nothing on this machine is read.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts');

const capy = (args: readonly string[]) => {
  const home = mkdtempSync(join(tmpdir(), 'capy-flags-home-'));
  try {
    const r = spawnSync(process.execPath, ['run', ENTRY, ...args], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH ?? '', HOME: home },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

describe('capy connect vercel — flags', () => {
  test.each([['--create-token'], ['--token-expires-days']])('%s is an unknown option: the normal refusal, exit 1', (flag) => {
    const r = capy(['connect', 'vercel', flag, ...(flag === '--create-token' ? [] : ['3'])]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(flag);
    expect(r.stdout).toBe('');
  });

  test('--help lists --targets with its help line, and neither removed flag', () => {
    const r = capy(['connect', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--targets');
    // the help wraps lines to the terminal width: compare with whitespace collapsed
    expect(r.stdout.replace(/\s+/g, ' ')).toContain('--targets Also write a Vercel deploy target for each imported environment');
    expect(r.stdout).not.toContain('--create-token');
    expect(r.stdout).not.toContain('--token-expires-days');
  });
});

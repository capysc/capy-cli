/**
 * The committed `docs/cli-reference.md` must be exactly what
 * `bun run docs:cli` (scripts/gen-cli-reference.mjs) would generate right
 * now, from the real built CLI. Needs `bun run build` first, same as the
 * other tests that spawn `dist/`.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { renderCliReferenceMarkdown } from '../../src/core/cliReferenceMarkdown';

const CLI_ROOT = join(__dirname, '../..');
const PROD_CLI = join(CLI_ROOT, 'dist/index.js');
const COMMITTED = join(CLI_ROOT, 'docs/cli-reference.md');

describe('docs/cli-reference.md', () => {
  test('matches what regenerating from the built CLI right now would produce', () => {
    const help = spawnSync('node', [PROD_CLI, 'help', '--json'], { encoding: 'utf-8' });
    expect(help.status).toBe(0);
    const doc = JSON.parse(help.stdout);
    const regenerated = renderCliReferenceMarkdown(doc);
    const committed = readFileSync(COMMITTED, 'utf-8');

    expect(
      committed,
      'docs/cli-reference.md is stale — run `bun run docs:cli` to regenerate and commit the result.',
    ).toBe(regenerated);
  });
});

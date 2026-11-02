/**
 * Spec test 10: a repo that already carries the OLD agents block is brought up to
 * the new one by `capy agents` (action "updated", every byte outside the markers
 * identical); a second run changes nothing ("unchanged"). Also: the first-run
 * prompt's `hasCurrentBlock` check sees the old block as not current, so the
 * update is offered once. Driven through the BUILT cli; needs `bun run build`.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AGENTS_BLOCK, hasCurrentBlock } from '../../src/core/agentsBlockPlan';

const PROD_CLI = join(__dirname, '../../dist/index.js');

/** The block exactly as 0.9.7-before-this-change wrote it. */
const OLD_BLOCK = [
  '<!-- capy:agents:begin -->',
  '## Secrets (Capy)',
  "This repo's secrets are managed by Capy.",
  '- Run `capy help --json` for every command, its options, and its error codes.',
  '- Always pass `--json` and branch on the `code` field, never on message text.',
  '- Never print, log, or commit secret values.',
  '<!-- capy:agents:end -->',
].join('\n');

const BEFORE = '# My project\n\nSome docs written by a person.\n\n';
const AFTER = '\n\n## Other notes\n\nMore text, with trailing spaces   \nand no final newline';

function runAgents(cwd: string, home: string): { action: string; code: number | null } {
  const r = spawnSync('node', [PROD_CLI, 'agents', '--yes', '--json'], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CAPY_WEB_NO_OPEN: '1' },
  });
  const payload = JSON.parse(r.stdout) as { files: { path: string; action: string }[] };
  return { action: payload.files[0].action, code: r.status };
}

describe('capy agents with the old block already in the repo', () => {
  test('the old block is not current (so the first-run prompt offers the update); the new one is', () => {
    expect(hasCurrentBlock(`${BEFORE}${OLD_BLOCK}${AFTER}`)).toBe(false);
    expect(hasCurrentBlock(`${BEFORE}${AGENTS_BLOCK}${AFTER}`)).toBe(true);
  });

  test('first run: updated, bytes outside the markers identical; second run: unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'capy-agents-upgrade-'));
    const home = mkdtempSync(join(tmpdir(), 'capy-agents-home-'));
    try {
      writeFileSync(join(root, 'AGENTS.md'), `${BEFORE}${OLD_BLOCK}${AFTER}`);

      const first = runAgents(root, home);
      expect(first).toEqual({ action: 'updated', code: 0 });
      const upgraded = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
      expect(upgraded).toBe(`${BEFORE}${AGENTS_BLOCK}${AFTER}`);
      expect(upgraded.startsWith(BEFORE)).toBe(true);
      expect(upgraded.endsWith(AFTER)).toBe(true);
      expect(upgraded).toContain('`<cmd> | capy edit NAME --json`');

      const second = runAgents(root, home);
      expect(second).toEqual({ action: 'unchanged', code: 0 });
      expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(upgraded);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

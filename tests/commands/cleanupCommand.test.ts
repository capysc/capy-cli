import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const TEST_DIR = join(tmpdir(), `capy-cleanup-test-${process.pid}`);
const MARKER = '# --- capy auto-sync (do not remove) ---';
const END_MARKER = '# --- end capy ---';

const CAPY_BLOCK = [
  MARKER,
  'if [ "$3" = "1" ] && [ ! -d "$(git rev-parse --git-dir)/rebase-merge" ] && [ ! -d "$(git rev-parse --git-dir)/rebase-apply" ]; then',
  '  command -v capy >/dev/null 2>&1 && capy status',
  'fi',
  END_MARKER,
].join('\n');

function makeGitRepo(): string {
  mkdirSync(TEST_DIR, { recursive: true });
  execSync('git init', { cwd: TEST_DIR, stdio: 'pipe' });
  const hooksDir = join(TEST_DIR, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  return hooksDir;
}

/**
 * Runs the cleanup logic against a given hooks directory.
 * This mirrors the actual cleanup command in index.ts but takes
 * the hooksDir directly (the real command resolves it via git rev-parse).
 */
function runCleanup(hooksDir: string): string {
  const hookNames = ['post-checkout', 'post-merge', 'pre-push'];
  let removed = false;
  const messages: string[] = [];

  for (const hookName of hookNames) {
    const hookPath = join(hooksDir, hookName);
    if (!existsSync(hookPath)) continue;

    const content = readFileSync(hookPath, 'utf-8');
    if (!content.includes(MARKER)) continue;

    const escMarker = MARKER.replace(/[()]/g, '\\$&');
    const escEnd = END_MARKER.replace(/[()]/g, '\\$&');
    const re = new RegExp(`${escMarker}[\\s\\S]*?${escEnd}\\n?`);
    const updated = content.replace(re, '').trim();

    if (!updated || /^#!.*sh$/.test(updated)) {
      rmSync(hookPath);
    } else {
      writeFileSync(hookPath, updated + '\n', 'utf-8');
      const { chmodSync } = require('fs');
      chmodSync(hookPath, 0o755);
    }
    removed = true;
    messages.push(`Removed capy hook from ${hookName}`);
  }

  if (removed) {
    messages.push('Capy git hooks removed.');
  } else {
    messages.push('No capy hooks found.');
  }
  return messages.join('\n');
}

describe('capy cleanup', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('removes capy-only hook file entirely', () => {
    const hooksDir = makeGitRepo();
    writeFileSync(join(hooksDir, 'post-checkout'), `#!/bin/sh\n${CAPY_BLOCK}\n`);

    const output = runCleanup(hooksDir);

    expect(existsSync(join(hooksDir, 'post-checkout'))).toBe(false);
    expect(output).toContain('Removed capy hook from post-checkout');
    expect(output).toContain('Capy git hooks removed.');
  });

  test('preserves non-capy hooks in same file', () => {
    const hooksDir = makeGitRepo();
    const otherHook = '#!/bin/sh\necho "my custom hook"';
    writeFileSync(join(hooksDir, 'post-merge'), `${otherHook}\n${CAPY_BLOCK}\n`);

    runCleanup(hooksDir);

    expect(existsSync(join(hooksDir, 'post-merge'))).toBe(true);
    const content = readFileSync(join(hooksDir, 'post-merge'), 'utf-8');
    expect(content).toContain('echo "my custom hook"');
    expect(content).not.toContain(MARKER);
  });

  test('reports no hooks found when none exist', () => {
    const hooksDir = makeGitRepo();
    const output = runCleanup(hooksDir);
    expect(output).toContain('No capy hooks found.');
  });

  test('skips hook files without capy markers', () => {
    const hooksDir = makeGitRepo();
    writeFileSync(join(hooksDir, 'post-checkout'), '#!/bin/sh\necho "unrelated"');

    const output = runCleanup(hooksDir);

    expect(existsSync(join(hooksDir, 'post-checkout'))).toBe(true);
    expect(output).toContain('No capy hooks found.');
  });

  test('cleans up all three hook types', () => {
    const hooksDir = makeGitRepo();
    for (const name of ['post-checkout', 'post-merge', 'pre-push']) {
      writeFileSync(join(hooksDir, name), `#!/bin/sh\n${CAPY_BLOCK}\n`);
    }

    const output = runCleanup(hooksDir);

    for (const name of ['post-checkout', 'post-merge', 'pre-push']) {
      expect(existsSync(join(hooksDir, name))).toBe(false);
    }
    expect(output).toContain('Capy git hooks removed.');
  });
});

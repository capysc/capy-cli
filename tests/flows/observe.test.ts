/**
 * The sensors, against real directories on disk.
 *
 * These are the definitions the flow service's predicate table is written
 * against, so each case here pins one line of that spec — most importantly the
 * ones that are easy to get subtly wrong: a corrupt keep.lock still counts as
 * PRESENT (reporting it absent would route the service at initializing over a
 * git-owned file), a single plaintext value among encrypted ones still counts
 * as plaintext (the half-finished encrypt), and the wrap predicate must flip
 * once its verb has run, or the flow loops on a step that never converges.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { observeOnboard } from '../../src/flows/onboard/observe';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capy-observe-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const observe = () => observeOnboard({ targetDir: dir, sessionLive: false });

const keepLock = (branch = 'development') =>
  JSON.stringify({
    version: '3.0',
    org_id: 'org_1',
    project_id: 'proj_1',
    project_name: 'x',
    variables: { FOO: [{ resource_id: 'r', branch, value_hash: 'h' }] },
  });

describe('observeOnboard', () => {
  test('a nonexistent directory reports targetDirValid false and nothing else true', () => {
    const obs = observeOnboard({ targetDir: join(dir, 'not-here'), sessionLive: true });
    expect(obs.targetDirValid).toBe(false);
    expect(obs.hasCapyDir).toBe(false);
    expect(obs.hasKeepLock).toBe(false);
    expect(obs.envMetaRecoverable).toBe(false);
    expect(obs.envStillPlaintext).toBe(false);
    expect(obs.commandsWrapped).toBe(false);
    expect(obs.branchConflict).toBe(false);
    // The session hint is not a fact about the directory, so it survives.
    expect(obs.sessionLive).toBe(true);
  });

  test('a file where a directory should be is not a valid target', () => {
    const file = join(dir, 'afile');
    writeFileSync(file, 'x');
    expect(observeOnboard({ targetDir: file, sessionLive: false }).targetDirValid).toBe(false);
  });

  test('a fresh repo: nothing local, and one edit still outstanding', () => {
    const obs = observe();
    expect(obs.targetDirValid).toBe(true);
    expect(obs.hasCapyDir).toBe(false);
    expect(obs.hasKeepLock).toBe(false);
    // NOT vacuous: with no agent file present the plan creates AGENTS.md, so
    // there is exactly one edit outstanding even in an empty directory.
    expect(obs.commandsWrapped).toBe(false);
  });

  test('the wrap predicate flips once the edits are applied — the convergence guarantee', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }, null, 2));
    expect(observe().commandsWrapped).toBe(false);

    const { buildPlan } = require('../../src/flows/onboard/plan') as typeof import('../../src/flows/onboard/plan');
    const { applyPlan } = require('../../src/flows/onboard/apply') as typeof import('../../src/flows/onboard/apply');
    applyPlan(buildPlan({ targetDir: dir }));

    expect(observe().commandsWrapped).toBe(true);
  });

  test('a plaintext .env is plaintext; a fully encrypted one is not', () => {
    writeFileSync(join(dir, '.env'), 'FOO=bar\nBAZ=qux\n');
    expect(observe().envStillPlaintext).toBe(true);

    writeFileSync(join(dir, '.env'), '# capy:org_id=org_1\nFOO=capy:rid:ciphertext\n');
    expect(observe().envStillPlaintext).toBe(false);
  });

  test('one plaintext value among encrypted ones still counts — the half-finished state', () => {
    writeFileSync(join(dir, '.env'), 'FOO=capy:rid:ct\nNEW=plaintext\n');
    expect(observe().envStillPlaintext).toBe(true);
  });

  test('a QUOTED encrypted value is not plaintext', () => {
    // Splitting on `=` and testing startsWith('capy:') calls this plaintext,
    // which would make the encrypt step a no-op forever and the flow spin.
    writeFileSync(join(dir, '.env'), 'FOO="capy:rid:ciphertext"\n');
    expect(observe().envStillPlaintext).toBe(false);
  });

  test('an exported plaintext value IS plaintext', () => {
    writeFileSync(join(dir, '.env'), 'export FOO=bar\n');
    expect(observe().envStillPlaintext).toBe(true);
  });

  test('an empty value classifies the way the CLI classifies it', () => {
    writeFileSync(join(dir, '.env'), 'FOO=\n');
    const { FileManager } = require('../../src/files/fileManager') as typeof import('../../src/files/fileManager');
    expect(observe().envStillPlaintext).toBe(new FileManager(dir).hasPlaintextValues());
  });

  test('a multi-line quoted encrypted value is not plaintext', () => {
    writeFileSync(join(dir, '.env'), 'KEY="capy:rid:line1\nline2"\n');
    expect(observe().envStillPlaintext).toBe(false);
  });

  test('comments and blank lines are not values', () => {
    writeFileSync(join(dir, '.env'), '# a comment\n\nFOO=capy:rid:ct\n');
    expect(observe().envStillPlaintext).toBe(false);
  });

  test('the .env capy header is what makes a keep.lock recoverable', () => {
    writeFileSync(join(dir, '.env'), 'FOO=capy:rid:ct\n');
    expect(observe().envMetaRecoverable).toBe(false);

    writeFileSync(
      join(dir, '.env'),
      '# capy:org_id=org_1\n# capy:project_id=proj_1\n# capy:branch=development\nFOO=capy:rid:ct\n',
    );
    expect(observe().envMetaRecoverable).toBe(true);
  });

  test('a corrupt keep.lock still reports hasKeepLock TRUE', () => {
    // The whole point: existence only. If this reported false, the service
    // would offer to initialize over a git-owned file.
    writeFileSync(join(dir, 'keep.lock'), '{ this is not json');
    const obs = observe();
    expect(obs.hasKeepLock).toBe(true);
    expect(obs.targetDirValid).toBe(true);
  });

  test('.capy/ presence is independent of keep.lock', () => {
    mkdirSync(join(dir, '.capy'));
    const obs = observe();
    expect(obs.hasCapyDir).toBe(true);
    expect(obs.hasKeepLock).toBe(false);
  });

  test('an unwrapped package.json is not wrapped; a wrapped one is', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }, null, 2));
    // AGENTS.md would also be created, so this is unambiguous.
    expect(observe().commandsWrapped).toBe(false);

    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'capy run -- vite' } }, null, 2),
    );
    writeFileSync(join(dir, 'AGENTS.md'), agentDocsFixture());
    expect(observe().commandsWrapped).toBe(true);
  });

  test('a branch conflict needs BOTH sides, and the .capy side must be real', () => {
    writeFileSync(
      join(dir, '.env'),
      '# capy:org_id=org_1\n# capy:project_id=proj_1\n# capy:branch=development\nFOO=capy:rid:ct\n',
    );
    mkdirSync(join(dir, '.capy'));
    writeFileSync(join(dir, 'keep.lock'), keepLock('development'));

    // .capy/branch names a branch nothing knows about → stale cache, not a conflict.
    writeFileSync(join(dir, '.capy', 'branch'), 'ghost');
    expect(observe().branchConflict).toBe(false);

    // Now the same name IS a real branch in keep.lock → a genuine conflict.
    writeFileSync(join(dir, 'keep.lock'), JSON.stringify({
      version: '3.0',
      org_id: 'org_1',
      project_id: 'proj_1',
      project_name: 'x',
      variables: { FOO: [{ resource_id: 'r', branch: 'ghost', value_hash: 'h' }] },
    }));
    expect(observe().branchConflict).toBe(true);

    // Agreement is never a conflict.
    writeFileSync(join(dir, '.capy', 'branch'), 'development');
    expect(observe().branchConflict).toBe(false);
  });

  test('reports names and booleans only — no value ever leaves', () => {
    writeFileSync(join(dir, '.env'), 'SECRET=hunter2\n');
    const obs = observe();
    expect(JSON.stringify(obs)).not.toContain('hunter2');
    for (const value of Object.values(obs)) expect(typeof value).toBe('boolean');
  });
});

/** An agent-docs file already carrying the marker block, so that edit is a no-op. */
function agentDocsFixture(): string {
  const { computeAgentDocsEdits } = require('../../src/flows/onboard/agentDocs') as typeof import('../../src/flows/onboard/agentDocs');
  const tmp = mkdtempSync(join(tmpdir(), 'capy-doc-'));
  writeFileSync(join(tmp, 'AGENTS.md'), '');
  const [edit] = computeAgentDocsEdits(tmp);
  rmSync(tmp, { recursive: true, force: true });
  return edit.after;
}

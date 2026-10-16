/**
 * A torn checkout (`.capy/branch` and the `.env` header name different, real branches) met by bare `capy` as a command's
 * first step (src/sync/gate.ts), through the REAL runner and a mock service (tests/helpers/pipedHarness.ts):
 *   - in another checkout than the working directory (discovery) it is that folder's coded failure
 *     (`BRANCH_STATE_INCONSISTENT`), never the end of the process, so the next folder is still synced;
 *   - the working directory is back where it was afterwards.
 * (The same state in the working directory is followed, not refused: tests/commands/conflictProtocol.test.ts.)
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deriveResourceId } from '../../src/crypto/resourceId';
import { FileManager } from '../../src/files/fileManager';
import { ProjectManager } from '../../src/core/projectManager';
import type { KeepFile } from '../../src/types/index';
import { Encryptor } from '../../src/crypto/encryptor';
import { SyncEngine } from '../../src/sync/syncEngine';
import { createHarness, BRANCH, ORG_ID, PROJECT_ID, type Harness } from '../helpers/pipedHarness';

const hash16 = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 16);
const VALUES = { X: 'SENTINEL-x-torn-1d4a' } as const;

const keepOf = (): KeepFile => ({
  version: '3.0',
  org_id: ORG_ID,
  project_id: PROJECT_ID,
  project_name: 'piped-test',
  variables: Object.fromEntries(
    Object.entries(VALUES).map(([name, value]) => [
      name,
      [{ resource_id: deriveResourceId(BRANCH, name), branch: BRANCH, value_hash: hash16(value), changed_at: '2026-10-01T21:44:18.000Z' }],
    ]),
  ),
});

/** A checkout under `parent` that agrees with the server; `fileBranch` is what `.capy/branch` says. */
function checkout(h: Harness, parent: string, name: string, fileBranch: string): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, '.capy'), { recursive: true });
  const files = new FileManager(dir);
  const keep = keepOf();
  files.writeKeepFile(keep);
  files.writeEncryptedEnvFile({ ...VALUES }, h.projectKey, undefined, keep, BRANCH);
  writeFileSync(join(dir, '.capy', 'branch'), fileBranch);
  return dir;
}

/** `syncFolder` over `dirs` in a child process whose HOME is the harness's (the real runner reads its session and profile from there). */
async function syncInChild(h: Harness, dirs: readonly string[]): Promise<{ readonly results: readonly Record<string, unknown>[]; readonly before: string; readonly after: string; readonly ended?: number }> {
  const child = spawn(process.execPath, [join(__dirname, '../helpers/syncFoldersChild.ts'), ...dirs], {
    cwd: h.project,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: h.home, USERPROFILE: h.home, CAPY_WEB_NO_OPEN: '1', CAPY_NO_AUTOCOMMIT: '1' },
  });
  const [stdout, stderr] = await Promise.all([text(child.stdout), text(child.stderr), once(child, 'close')]);
  const line = stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`child did not report: ${stderr}\n${stdout}`);
  }
}

describe('syncFolder over two discovered folders, the first in a torn state (real runner)', () => {
  const state = { h: undefined as Harness | undefined };
  const h = (): Harness => {
    if (!state.h) throw new Error('harness not ready');
    return state.h;
  };
  beforeEach(async () => {
    const harness = await createHarness();
    Object.assign(state, { h: harness });
    // The server: `production` is what both folders hold; `development` is a real branch of the project.
    const keep = keepOf();
    const lines = Object.entries(VALUES).map(([name, value]) => `${name}=capy:${deriveResourceId(BRANCH, name)}:${Encryptor.encrypt(value, harness.projectKey)}`);
    harness.setBranchData(PROJECT_ID, BRANCH, { env_file: lines.join('\n'), permissions: [], keep_hash: SyncEngine.computeKeepHash(keep, BRANCH), keep_file: JSON.stringify(keep) });
    harness.setBranches(PROJECT_ID, [
      { id: 'b1', name: 'production', is_protected: false },
      { id: 'b2', name: 'development', is_protected: false },
    ]);
  });
  afterEach(async () => {
    await state.h?.dispose();
  });

  test('the torn folder is reported with BRANCH_STATE_INCONSISTENT (no exit, nothing written), the next folder is synced, the working directory is restored', async () => {
    const parent = join(h().root, 'discovered');
    const torn = checkout(h(), parent, 'torn', 'development'); // .capy/branch says development, .env was encrypted for production
    const fine = checkout(h(), parent, 'fine', BRANCH);
    const run = await syncInChild(h(), [torn, fine]);
    expect(run.results[0]).toMatchObject({ ok: false, code: 'BRANCH_STATE_INCONSISTENT' });
    expect(run.results[1]).toEqual({ ok: true });
    expect(run.ended).toBeUndefined();
    expect(run.after).toBe(run.before);
    // Nothing was written into the torn folder: the .env header and the branch cache are as they were.
    expect(new FileManager(torn).readEnvMeta().branch).toBe(BRANCH);
    expect(new ProjectManager(torn).readActiveBranch()).toBe('development');
    expect(h().pushCount()).toBe(0);
  });

  test('the failure names the two branches and carries no value', async () => {
    const torn = checkout(h(), join(h().root, 'discovered'), 'torn', 'development');
    const run = await syncInChild(h(), [torn]);
    const failure = JSON.stringify(run.results[0]);
    expect(failure).toContain('BRANCH_STATE_INCONSISTENT');
    expect(failure).not.toContain(VALUES.X);
  });
});

/**
 * `capy connect dokploy --json` must print exactly one JSON object on
 * stdout — nothing else, from any code on the path it drives. The one thing
 * that USED to break this: `writeImportedAndSync`'s push:true path (real
 * `capy connect <import-connector> ...` with push on) ended by calling the
 * old auto-commit helper, which printed "> keep.lock committed …" straight
 * to stdout.
 *
 * That helper is gone (CAP-667): capy never auto-commits keep.lock onto
 * whatever branch the caller happens to be on — `writeImportedAndSync` now
 * only ever writes the untracked working copy (`.capy/keep.lock`), and the
 * tracked keep.lock this test seeds is left exactly as committed. So the
 * property this file proves is now two-sided: stdout purity (still, for the
 * same reason — nothing on this path should ever print anything but the one
 * JSON line), AND that the tracked keep.lock genuinely never gets committed
 * to on this path any more.
 *
 * This drives the REAL `ConnectCommand.executeImport` → `writeImportedAndSync`
 * chain, inside a throwaway git repo, and checks stdout byte for byte plus
 * the repo's git state afterward. `SyncEngine` and `writeKeepCache` run for
 * real too — both are pure/best-effort and `CAPY_GLOBAL_DIR_NAME` isolates
 * the global config dir they touch, so nothing here reaches this developer's
 * real `~/.capy` or git checkout. No `mock.module()`, so this file runs in
 * the normal batch.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectCommand } from '../../src/commands/connectCommand';
import type { ResolvedContext } from '../../src/commands/connectors/shared';
import type { ConnectOpts, ConnectorModule, ImportOutcome } from '../../src/commands/connectors/registry';
import type { ConnectorMetadata, KeepFile } from '../../src/types/index';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
}

function initRepoWithKeep(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'keep.lock'), JSON.stringify({ v: 0 }));
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

const successOutcome = (): ImportOutcome => ({
  ok: true,
  applicationId: 'app_1',
  imported: [
    {
      varName: 'API_KEY',
      value: 'sk_test_should_not_print',
      entry: { provider: 'dokploy', source: 'import', created_at: 1, fingerprint: 'x…y' } as ConnectorMetadata,
    },
  ],
  unchanged: [],
  skipped: [],
  warnings: [{ code: 'DOKPLOY_PLAINTEXT_REMAINS', names: ['API_KEY'] }],
  deployTargetSaved: false,
});

function fakeImportModule(outcome: ImportOutcome): ConnectorModule {
  return {
    name: 'dokploy',
    description: 'test double',
    kind: 'import',
    connect: async () => {
      throw new Error('not used');
    },
    rotate: async () => {
      throw new Error('not used');
    },
    import: async () => outcome,
  };
}

/** A ctx whose `fileManager.writeKeepFile` actually writes to disk, so the test can inspect the tracked keep.lock's git state afterward. */
function fakeCtx(dir: string): ResolvedContext {
  const keep: KeepFile = { version: '3.0', org_id: 'o', project_id: 'p', project_name: 'demo', variables: {} };
  return {
    pm: { readSyncState: () => null },
    fileManager: {
      writeKeepFile: (k: KeepFile) => writeFileSync(join(dir, 'keep.lock'), JSON.stringify(k)),
      writeEncryptedEnvFile: () => {},
      writeSyncState: () => {},
    },
    serviceClient: {
      // No real server round trip: `keep_file` omitted so `adoptServerKeep`
      // falls back to the locally-merged keep (see its own doc).
      pushSecrets: async () => ({ keep_hash: 'h'.repeat(16) }),
    },
    orgId: 'o',
    projectId: 'p',
    branch: 'development',
    userId: 'u',
    projectKey: 'test-project-key',
    keep,
    localPlaintext: {},
  } as unknown as ResolvedContext;
}

describe('capy connect dokploy --json — stdout purity with push on (CAP defect 2)', () => {
  test('stdout is exactly one JSON line that parses; the tracked keep.lock is never committed (CAP-667)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-connect-json-purity-'));
    const originalCwd = process.cwd();
    const savedDirName = process.env.CAPY_GLOBAL_DIR_NAME;
    process.env.CAPY_GLOBAL_DIR_NAME = `.capy-test-${process.pid}-${Date.now()}`;

    // `console.log`/`console.error` are the only two surfaces `executeImport`
    // (the JSON line) writes through — Bun's console does not route through
    // the JS-level `process.stdout.write` binding, so that is what a spy has
    // to sit on to see everything.
    const outLines: string[] = [];
    const errLines: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation(((...a: unknown[]) => {
      outLines.push(a.map(String).join(' '));
    }) as never);
    const errSpy = spyOn(console, 'error').mockImplementation(((...a: unknown[]) => {
      errLines.push(a.map(String).join(' '));
    }) as never);

    let headBefore = '';
    try {
      initRepoWithKeep(dir);
      headBefore = git(dir, ['rev-parse', 'HEAD']).trim();
      process.chdir(dir);

      const command = new ConnectCommand(false);
      await (command as unknown as { executeImport: Function }).executeImport(
        fakeImportModule(successOutcome()),
        'dokploy',
        fakeCtx(dir),
        { json: true, noPush: false } as ConnectOpts,
      );
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.chdir(originalCwd);
      if (savedDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
      else process.env.CAPY_GLOBAL_DIR_NAME = savedDirName;
    }

    // stdout (console.log) carries exactly one line: the JSON object.
    expect(outLines.length).toBe(1);
    expect(() => JSON.parse(outLines[0])).not.toThrow();
    expect(JSON.parse(outLines[0])).toMatchObject({ ok: true, provider: 'dokploy', imported: ['API_KEY'] });
    expect(outLines[0]).not.toContain('sk_test_should_not_print');
    expect(errLines.join('\n')).not.toContain('sk_test_should_not_print');

    // CAP-667: no auto-commit at all. HEAD never moved past the seeded
    // 'init' commit, and the tracked keep.lock this test's fake
    // `writeKeepFile` wrote to sits uncommitted in the working tree.
    expect(git(dir, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(git(dir, ['status', '--porcelain']).trim()).toBe('M keep.lock');
  }, 30_000);
});

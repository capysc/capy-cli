// CAP-549 — `capy checkout` assumed keep.lock only ever changes through capy.
// When keep.lock is updated by something else (a `git pull` is the normal
// GitOps case), the pre-switch guards misfired: check A ("uncommitted
// changes") diffed .env against pins that had just moved out from under it,
// and check B ("unpushed changes") compared the same stale/moved hash. Both
// remedies ("commit", "push") would have pushed the user's STALE local
// values over the newer keep.
//
// This file is deliberately an integration-style test, NOT the pure-mock
// style used by branchKeepFile.test.ts: `ProjectManager`, `FileManager`, and
// `SyncEngine` are the REAL classes (rooted at a throwaway temp directory),
// so the properties asserted below — a real AES round-trip decrypt, the real
// `# capy:branch=` header, the real sha256 keep-hash — are exercised through
// the actual production code paths, not re-derived by the test. Only the
// network/auth layer (AuthService, ServiceClient) and key derivation
// (crypto/keyResolver) are mocked, since those would otherwise need a live
// service.
//
// Uses mock.module() — must run isolated (tests/run-tests.sh ISOLATED_FILES).

import { mock, spyOn, beforeEach, afterEach, afterAll, describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Module mocks — must come before imports of mocked modules. `core/projectManager`,
// `files/fileManager`, and `sync/syncEngine` are deliberately NOT mocked here.
// ---------------------------------------------------------------------------
mock.module('../../src/auth/authService', () => ({
  AuthService: mock(() => ({})),
}));
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: mock(() => ({})),
}));
mock.module('../../src/crypto/keyResolver', () => ({
  resolveProjectKey: mock(async () => ENCRYPTION_KEY),
  wrapAndSaveMasterKey: mock(async () => undefined),
  hasOrgKey: mock(() => true),
}));
mock.module('../../src/config/globalConfig', () => ({
  writeKeepCache: mock(() => undefined),
  fetchSecretsWithCache: mock(async () => null),
  isRecoveryActive: mock(() => false),
}));
mock.module('inquirer', () => ({
  default: {
    prompt: mock(() => Promise.resolve({})),
    Separator: class Separator { constructor() {} },
  },
}));
mock.module('../../src/ui/spinner', () => ({
  default: (_text: string) => ({
    start: () => ({
      fail: mock(() => undefined),
      succeed: mock(() => undefined),
      stop: mock(() => undefined),
      text: '',
    }),
  }),
}));
mock.module('../../src/ui/errorScreen', () => ({
  displayErrorAndExit: mock((err: any) => {
    const msg = err?.message || String(err);
    throw new Error(`displayErrorAndExit: ${msg}`);
  }),
}));

afterAll(() => { mock.restore(); });

// ---------------------------------------------------------------------------
// Imports (after mocks). ProjectManager/FileManager/SyncEngine are the REAL
// classes — nothing above mocks their specifiers.
// ---------------------------------------------------------------------------
import { CheckoutCommand } from '../../src/commands/checkoutCommand';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { ProjectManager } from '../../src/core/projectManager';
import { FileManager } from '../../src/files/fileManager';
import { SyncEngine } from '../../src/sync/syncEngine';
import { getSyncKeepHash } from '../../src/types/index';
import type { KeepFile } from '../../src/types/index';

const MockAuthService = AuthService as any;
const MockServiceClient = ServiceClient as any;

// Fixed so the REAL FileManager's AES round-trip is deterministic across the
// "write as if from the server" and "read back through the command" halves
// of each test.
const ENCRYPTION_KEY = 'cap549-test-project-key';

const hashValue = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A keep.lock fixture: { branch: { VAR: plaintext } } → v3 KeepFile. */
function makeKeep(perBranch: Record<string, Record<string, string>>): KeepFile {
  const variables: KeepFile['variables'] = {};
  for (const [branch, entries] of Object.entries(perBranch)) {
    for (const [name, value] of Object.entries(entries)) {
      const existing = variables[name] ?? [];
      variables[name] = [
        ...existing,
        { resource_id: `${branch}:${name.toLowerCase()}`, branch, value_hash: hashValue(value) },
      ];
    }
  }
  return {
    version: '3.0',
    org_id: 'org-123',
    project_id: 'proj-123',
    project_name: 'cap549-test',
    variables,
  };
}

/**
 * Real ciphertext for `vars`, as `ServiceClient.getDecryptData`'s `env_content`
 * would return it — encrypted with the REAL `FileManager`/`Encryptor` (via a
 * throwaway scratch file, since `writeEncryptedEnvFile` only writes to disk),
 * header lines stripped (the server response is bare `KEY=value` pairs).
 */
function serverEnvContent(fileManager: FileManager, tempDir: string, vars: Record<string, string>, branch: string): string {
  const scratchPath = join(tempDir, `.env.__scratch-${branch}__`);
  fileManager.writeEncryptedEnvFile(vars, ENCRYPTION_KEY, scratchPath, null, branch);
  const raw = readFileSync(scratchPath, 'utf-8');
  unlinkSync(scratchPath);
  return raw.split('\n').filter(l => l.length > 0 && !l.startsWith('# capy:')).join('\n');
}

function makeServiceClient(opts: {
  branches: Array<{ name: string; is_protected: boolean }>;
  envContentByBranch: Record<string, string>;
  keepForSplice: KeepFile;
}) {
  return {
    setTokenProvider: mock(() => undefined),
    listBranches: mock(() => Promise.resolve(opts.branches)),
    getDecryptData: mock((_projectId: string, branch: string) => Promise.resolve({
      env_content: opts.envContentByBranch[branch] ?? '',
      keep_hash: 'unused-by-this-path',
      keep_file: JSON.stringify(opts.keepForSplice),
    })),
    coDecrypt: mock(() => Promise.resolve({ plaintext: '' })),
    wrapOuterLayer: mock(() => Promise.resolve({ ciphertext: '' })),
  };
}

/**
 * Real `ProjectManager`/`FileManager` rooted at `tempDir` — build these (and
 * write fixtures through them) BEFORE constructing `CheckoutCommand`, since
 * `CheckoutCommand`'s own `serviceClient` mock implementation must already be
 * set when its constructor runs (it captures `ServiceClient`'s mock return
 * value once, at `new ServiceClient()` time).
 */
function makeRealManagers(tempDir: string): { projectManager: ProjectManager; fileManager: FileManager } {
  return { projectManager: new ProjectManager(tempDir), fileManager: new FileManager(tempDir) };
}

/**
 * A `CheckoutCommand` whose internal `projectManager`/`fileManager` are the
 * REAL instances above, swapped in after construction. The constructor
 * hardcodes `new ProjectManager()` / `new FileManager()` (no project-root
 * injection point), which default to `process.cwd()` — so this is the only
 * way to point a real, unmocked instance at a scratch directory without
 * touching the process's actual working directory. Call this only AFTER
 * `MockServiceClient.mockImplementation(...)` is set for this test.
 */
function makeCheckoutCommand(projectManager: ProjectManager, fileManager: FileManager): CheckoutCommand {
  const cmd = new CheckoutCommand();
  (cmd as any).projectManager = projectManager;
  (cmd as any).fileManager = fileManager;
  return cmd;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let tempDir: string;
let exitSpy: any;
let errSpy: any;
let logSpy: any;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cap549-checkout-'));

  // Non-throwing, matching branchKeepFile.test.ts: checkoutCommand.ts never
  // `return`s right after `process.exit(1)` (it relies on the real process
  // actually halting), so a throwing mock would need every guard branch
  // wrapped in try/catch. The existing suite already established that a
  // silent fall-through is harmless here — later code re-runs against the
  // same fixtures and produces no additional matching console output.
  exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  errSpy = spyOn(console, 'error').mockImplementation(() => {});
  logSpy = spyOn(console, 'log').mockImplementation(() => {});

  MockAuthService.mockImplementation(() => ({
    setSessionUserId: mock(() => undefined),
    authenticateSilent: mock(() => Promise.resolve({ success: true, organization_id: 'org-123', user_id: 'user-456' })),
    authenticate: mock(() => Promise.resolve({ success: true, organization_id: 'org-123', user_id: 'user-456' })),
    getValidToken: mock(() => Promise.resolve('token-123')),
  }));
});

afterEach(() => {
  exitSpy.mockRestore();
  errSpy.mockRestore();
  logSpy.mockRestore();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('capy checkout — CAP-549 external keep move + --refresh', () => {
  test('external keep move, no --refresh: blocked with the accurate message, not the misleading ones', async () => {
    const keep = makeKeep({
      development: { API_KEY: 'dev-key-v1' },
      staging: { API_KEY: 'staging-key-v1' },
    });
    const { projectManager, fileManager } = makeRealManagers(tempDir);

    fileManager.writeKeepFile(keep);
    projectManager.writeActiveBranch('development');
    // .env is clean relative to keep.lock (its decrypted value hashes to
    // exactly what's pinned) — a genuine local edit is NOT what trips this.
    fileManager.writeEncryptedEnvFile({ API_KEY: 'dev-key-v1' }, ENCRYPTION_KEY, undefined, keep, 'development');
    // sync-state remembers a hash that predates keep.lock's current content —
    // simulating keep.lock having been rewritten by `git pull`, not by capy.
    fileManager.writeSyncState({
      last_sync: new Date(0).toISOString(),
      synced_variables: ['API_KEY'],
      keep_hash: { development: '0'.repeat(64) },
    });

    MockServiceClient.mockImplementation(() => makeServiceClient({
      branches: [{ name: 'development', is_protected: false }, { name: 'staging', is_protected: false }],
      envContentByBranch: { staging: serverEnvContent(fileManager, tempDir, { API_KEY: 'staging-key-v1' }, 'staging') },
      keepForSplice: keep,
    }));

    const cmd = makeCheckoutCommand(projectManager, fileManager);
    await cmd.execute('staging');

    const stderr = errSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    expect(stderr).toContain('changed outside capy');
    expect(stderr).not.toContain('capy push');
    // The reordering means check A's message must not ALSO fire for the same
    // root cause — this scenario gets exactly one accurate diagnosis.
    expect(stderr).not.toContain('uncommitted changes');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('external keep move + --refresh: succeeds, .env rebuilt to the current keep for the TARGET branch, sync-state hash updated', async () => {
    const keep = makeKeep({
      development: { API_KEY: 'dev-key-v1' },
      staging: { API_KEY: 'staging-key-v1' },
    });
    const { projectManager, fileManager } = makeRealManagers(tempDir);

    fileManager.writeKeepFile(keep);
    projectManager.writeActiveBranch('development');
    fileManager.writeEncryptedEnvFile({ API_KEY: 'dev-key-v1' }, ENCRYPTION_KEY, undefined, keep, 'development');
    fileManager.writeSyncState({
      last_sync: new Date(0).toISOString(),
      synced_variables: ['API_KEY'],
      keep_hash: { development: '0'.repeat(64) }, // same "moved externally" precondition as above
    });

    MockServiceClient.mockImplementation(() => makeServiceClient({
      branches: [{ name: 'development', is_protected: false }, { name: 'staging', is_protected: false }],
      envContentByBranch: {
        staging: serverEnvContent(fileManager, tempDir, { API_KEY: 'staging-key-v2-fresh' }, 'staging'),
      },
      keepForSplice: keep,
    }));

    const cmd = makeCheckoutCommand(projectManager, fileManager);
    await cmd.execute('staging', { refresh: true });

    expect(exitSpy).not.toHaveBeenCalled();

    // Real `# capy:branch=` header — CAP-215's torn-state guard depends on
    // this always matching the branch .env was actually written for.
    expect(fileManager.readEnvMeta().branch).toBe('staging');

    // PROPERTY, not shape: the on-disk .env genuinely decrypts (real AES-GCM,
    // same helper `syncAndWriteBranch` used to write it) back to the target
    // branch's current plaintext — not merely "some file changed".
    const decrypted = fileManager.readEncryptedEnvFile(ENCRYPTION_KEY);
    expect(decrypted.API_KEY).toBe('staging-key-v2-fresh');

    // sync-state's keep_hash for the target branch now matches the current
    // keep.lock — checkout never wrote this before --refresh existed.
    const syncStateAfter = projectManager.readSyncState();
    const keepAfter = projectManager.readKeepFile()!;
    expect(getSyncKeepHash(syncStateAfter, 'staging')).toBe(SyncEngine.computeKeepHash(keepAfter, 'staging'));

    expect(projectManager.readActiveBranch()).toBe('staging');
  });

  test('keep unmoved + genuine local .env edit, no --refresh: existing "uncommitted changes" message, unchanged', async () => {
    const keep = makeKeep({
      development: { API_KEY: 'dev-key-v1' },
      staging: { API_KEY: 'staging-key-v1' },
    });
    const { projectManager, fileManager } = makeRealManagers(tempDir);

    fileManager.writeKeepFile(keep);
    projectManager.writeActiveBranch('development');
    // A REAL uncommitted edit: decrypts to something that does not hash-match
    // keep.lock's pin for development/API_KEY.
    fileManager.writeEncryptedEnvFile({ API_KEY: 'EDITED-locally-not-pushed' }, ENCRYPTION_KEY, undefined, keep, 'development');
    // sync-state hash MATCHES the current keep — keep.lock has not moved.
    fileManager.writeSyncState({
      last_sync: new Date().toISOString(),
      synced_variables: ['API_KEY'],
      keep_hash: { development: SyncEngine.computeKeepHash(keep, 'development') },
    });

    MockServiceClient.mockImplementation(() => makeServiceClient({
      branches: [{ name: 'development', is_protected: false }, { name: 'staging', is_protected: false }],
      envContentByBranch: { staging: serverEnvContent(fileManager, tempDir, { API_KEY: 'staging-key-v1' }, 'staging') },
      keepForSplice: keep,
    }));

    const cmd = makeCheckoutCommand(projectManager, fileManager);
    await cmd.execute('staging');

    const stderr = errSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    // Pinned verbatim (existing behavior — CAP-549 must not change this message).
    expect(stderr).toContain('You have uncommitted changes on "development" (API_KEY).');
    expect(stderr).not.toContain('changed outside capy');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('same-branch `capy checkout <active> --refresh`: succeeds, .env and sync-state refreshed in place, local edit discarded', async () => {
    const keep = makeKeep({
      development: { API_KEY: 'dev-key-v1' },
    });
    const { projectManager, fileManager } = makeRealManagers(tempDir);

    fileManager.writeKeepFile(keep);
    projectManager.writeActiveBranch('development');
    // A real local edit that would trip check A without --refresh.
    fileManager.writeEncryptedEnvFile({ API_KEY: 'LOCAL-EDIT-not-pushed' }, ENCRYPTION_KEY, undefined, keep, 'development');
    // Unmoved keep — this is the item-5 "explicit discard consent" case, not
    // the external-move case.
    fileManager.writeSyncState({
      last_sync: new Date(0).toISOString(),
      synced_variables: ['API_KEY'],
      keep_hash: { development: SyncEngine.computeKeepHash(keep, 'development') },
    });

    MockServiceClient.mockImplementation(() => makeServiceClient({
      branches: [{ name: 'development', is_protected: false }],
      envContentByBranch: {
        development: serverEnvContent(fileManager, tempDir, { API_KEY: 'dev-key-v1-refreshed-from-server' }, 'development'),
      },
      keepForSplice: keep,
    }));

    const cmd = makeCheckoutCommand(projectManager, fileManager);
    await cmd.execute('development', { refresh: true });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(fileManager.readEnvMeta().branch).toBe('development');

    const decrypted = fileManager.readEncryptedEnvFile(ENCRYPTION_KEY);
    // The local edit is gone — --refresh's whole point is to discard it.
    expect(decrypted.API_KEY).toBe('dev-key-v1-refreshed-from-server');

    const syncStateAfter = projectManager.readSyncState();
    const keepAfter = projectManager.readKeepFile()!;
    expect(getSyncKeepHash(syncStateAfter, 'development')).toBe(SyncEngine.computeKeepHash(keepAfter, 'development'));
  });
});

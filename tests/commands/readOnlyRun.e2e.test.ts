import { mock, spyOn, describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// CAP-303 regression — Daniel's incident, from Machine B's side, against the
// REAL filesystem stack (ProjectManager, FileManager, SyncEngine, real
// keep.lock bytes on disk). Only the network boundary (auth, service, key
// resolution) is mocked.
//
// The incident: `capy` on development fetched latest; the server's keep_file
// was main-flavored (last pusher never had dev entries); the client
// "self-heal" overwrote keep.lock with it before any user action — even a
// plain run + quit rewrote the file and nuked the dev pins.
// ---------------------------------------------------------------------------

const promptCalls: any[] = [];

mock.module('../../src/auth/authService', () => ({
  AuthService: mock(() => ({
    setSessionUserId: mock(() => undefined),
    authenticateSilent: mock(() => Promise.resolve({
      success: true,
      organization_id: 'org-1',
      organization_name: 'Test Org',
      user_id: 'user-b',
      user_email: 'b@example.com',
      _auth_method: 'cached',
    })),
    authenticate: mock(() => Promise.resolve({ success: true, organization_id: 'org-1', user_id: 'user-b' })),
    getToken: mock(() => ({
      access_token: 't',
      refresh_token: 'r',
      expires_at: Date.now() + 3600000,
      organization_id: 'org-1',
      user_id: 'user-b',
    })),
  })),
}));

// The server's latest keep is main-flavored: the last pusher's keep.lock
// never had development entries. Assigned per-test below.
let serverKeepFile: string | undefined;

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: mock(() => ({
    setTokenProvider: mock(() => undefined),
    getDecryptData: mock(() => Promise.resolve({
      env_content: '',
      decrypt_key: '',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      keep_hash: 'a'.repeat(64),
      latest_keep_hash: 'a'.repeat(64),
      keep_file: serverKeepFile,
    })),
    getSecrets: mock(() => Promise.resolve(null)),
    coDecrypt: mock(() => Promise.resolve({ plaintext: '' })),
    wrapOuterLayer: mock(() => Promise.resolve({ ciphertext: '' })),
    listBranches: mock(() => Promise.resolve([])),
  })),
}));

mock.module('../../src/crypto/keyResolver', () => {
  const actual = require('../../src/crypto/keyResolver');
  return {
    ...actual,
    resolveProjectKey: mock(async () => 'test-project-key'),
  };
});

mock.module('../../src/config/globalConfig', () => {
  const actual = require('../../src/config/globalConfig');
  return {
    ...actual,
    writeKeepCache: mock(() => undefined),
    fetchSecretsWithCache: mock(async () => null),
    readSecretsLocal: mock(() => null),
  };
});

mock.module('../../src/config/profileConfig', () => {
  const actual = require('../../src/config/profileConfig');
  return { ...actual, isLocalOnly: () => false };
});

mock.module('inquirer', () => ({
  default: {
    prompt: mock((questions: any) => {
      promptCalls.push(questions);
      return Promise.resolve({ action: 'skip' });
    }),
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

afterAll(() => { mock.restore(); });

import { CapyCommand } from '../../src/commands/capyCommand';
import { FileManager, serializeKeep } from '../../src/files/fileManager';
import { ProjectManager } from '../../src/core/projectManager';
import type { KeepFile } from '../../src/types/index';

const LOCAL_KEEP: KeepFile = {
  version: '3.0',
  org_id: 'org-1',
  project_id: 'proj-1',
  project_name: 'demo',
  variables: {
    API_KEY: [{ resource_id: 'r-dev-api', branch: 'development', value_hash: 'h-dev-api' }],
    DB_URL: [{ resource_id: 'r-dev-db', branch: 'development', value_hash: 'h-dev-db' }],
  },
};

const MAIN_FLAVORED_SERVER_KEEP = {
  version: '3.0',
  org_id: 'org-1',
  project_id: 'proj-1',
  project_name: 'demo',
  variables: {
    API_KEY: [{ resource_id: 'r-main-api', branch: 'main', value_hash: 'h-main-api' }],
  },
};

const projectState = {
  initialized: true,
  hasKeepFile: true,
  hasEnvFile: false,
  projectName: 'demo',
  organizationId: 'org-1',
  projectId: 'proj-1',
  activeBranch: 'development',
  userId: 'user-b',
};

describe('CAP-303: read-only run cannot rewrite keep.lock (e2e, real FS)', () => {
  let dir: string;
  let origCwd: string;
  let logSpy: any;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capy-readonly-'));
    origCwd = process.cwd();
    process.chdir(dir);
    promptCalls.length = 0;
    serverKeepFile = JSON.stringify(MAIN_FLAVORED_SERVER_KEEP);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(origCwd);
    logSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  test('run + quit on development leaves keep.lock byte-identical despite a main-flavored server keep', async () => {
    // Machine B's real on-disk state: committed keep.lock with dev pins.
    new FileManager(dir).writeKeepFile(LOCAL_KEEP);
    new ProjectManager(dir).writeActiveBranch('development');
    const bytesBefore = readFileSync(join(dir, 'keep.lock'), 'utf-8');

    const cmd = new CapyCommand();
    await (cmd as any).syncProject({ ...projectState });

    // The run genuinely reached the interactive menu (not an early bail)...
    const sawMenu = promptCalls.some((q: any) => (Array.isArray(q) ? q[0] : q)?.name === 'action');
    expect(sawMenu).toBe(true);

    // ...and quitting left the file untouched. Pre-fix, these bytes were the
    // serialized main-flavored server keep and the dev pins were gone.
    const bytesAfter = readFileSync(join(dir, 'keep.lock'), 'utf-8');
    expect(bytesAfter).toBe(bytesBefore);

    const keepNow = JSON.parse(bytesAfter);
    expect(keepNow.variables.API_KEY[0].branch).toBe('development');
    expect(keepNow.variables.DB_URL).toBeDefined();
    expect(JSON.stringify(keepNow.variables)).not.toContain('r-main-api');
  });

  test('bootstrap: a MISSING keep.lock is reconstructed from the server keep', async () => {
    new ProjectManager(dir).writeActiveBranch('development');
    expect(existsSync(join(dir, 'keep.lock'))).toBe(false);

    const cmd = new CapyCommand();
    await (cmd as any).syncProject({ ...projectState, hasKeepFile: false });

    // Reconstruction is the one legitimate write: the file now exists and is
    // exactly the canonical serialization of the server's keep.
    expect(existsSync(join(dir, 'keep.lock'))).toBe(true);
    const written = readFileSync(join(dir, 'keep.lock'), 'utf-8');
    expect(written).toBe(serializeKeep(MAIN_FLAVORED_SERVER_KEEP as KeepFile));
  });
});

/**
 * Conflict/overwrite UX polish on top of single-user lock-less mode:
 *
 *  1. `conflictContextLines` — connector metadata + relative "last written"
 *     time rendered ABOVE the existing overwrite/CAS confirm questions,
 *     additively (the question text itself is unchanged — see
 *     `addCommand.test.ts`'s `overwriteNotice` test, which still passes).
 *  2. `editCommand`'s save path and `pushCommand` now offer the same TTY
 *     inquirer confirm `addCommand` already used for a same-key CAS
 *     conflict, instead of refusing unconditionally.
 *  3. `maybeWarnPersonalEnv` — a one-line, non-blocking heads-up on the
 *     FIRST lock-less write in a directory that git recognizes as a team
 *     project (a repo with a remote) but whose `.env` has no capy identity
 *     header yet.
 *
 * Same harness convention as `locklessContext.test.ts`: AuthService,
 * ServiceClient and keyResolver.resolveProjectKey are mocked (no network/
 * crypto in a unit test); ProjectManager, FileManager, SyncEngine and the
 * real AES-GCM Encryptor are the real thing against real temp directories.
 * `inquirer` and `ui/editScreen.ts` are mocked too, since this file exercises
 * the interactive confirm paths directly.
 */
import { mock, describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const TEMP_HOME = mkdtempSync(join(require('os').tmpdir(), 'capy-conflictux-home-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => TEMP_HOME };
});

const PROJECT_KEY = 'c'.repeat(64);

type AuthResult = { success: boolean; user_id?: string; organization_id?: string; error?: string };

let authResultQueue: AuthResult[] = [];
mock.module(join(import.meta.dir, '../../../src/auth/authService.ts'), () => ({
  AuthService: class {
    constructor(_apiUrl?: string, _devMode?: boolean, _sessionUserId?: string) {}
    async authenticateSilent(_orgId?: string): Promise<AuthResult> {
      return authResultQueue.length ? authResultQueue.shift()! : { success: false };
    }
    async authenticate(_orgId?: string): Promise<AuthResult> {
      return authResultQueue.length ? authResultQueue.shift()! : { success: false };
    }
    setSessionUserId(_userId: string) {}
    async getValidToken() {
      return { access_token: 'tok', expires_at: Date.now() + 999999, organization_id: 'org-x', user_id: 'user-x' };
    }
  },
}));

type Project = { id: string; name: string; organization_id: string };

let listProjectsResult: Project[] = [];
let getDecryptDataResult: any = { env_content: '', decrypt_key: '', expires_at: new Date().toISOString() };
type PushImpl = (
  projectId: string,
  keepFile: string,
  envBlob: string,
  branch: string,
  baseKeepHash?: string,
) => Promise<{ keep_hash: string; keep_file?: string }>;
let pushSecretsQueue: PushImpl[] = [];
const serviceCalls: any[] = [];
mock.module(join(import.meta.dir, '../../../src/service/serviceClient.ts'), () => ({
  ServiceClient: class {
    constructor(_apiUrl?: string, _devMode?: boolean) {}
    setTokenProvider() {}
    async listProjects(): Promise<Project[]> {
      serviceCalls.push(['listProjects']);
      return listProjectsResult;
    }
    async getDecryptData(projectId: string, branch?: string) {
      serviceCalls.push(['getDecryptData', projectId, branch]);
      return getDecryptDataResult;
    }
    async getSecrets(_projectId: string, _keepHash: string) {
      return null;
    }
    async pushSecrets(projectId: string, keepFile: string, envBlob: string, branch: string, baseKeepHash?: string) {
      serviceCalls.push(['pushSecrets', projectId, branch, baseKeepHash]);
      const next = pushSecretsQueue.shift();
      if (next) return next(projectId, keepFile, envBlob, branch, baseKeepHash);
      return { keep_hash: 'a'.repeat(64) };
    }
    async coDecrypt() {
      return { plaintext: '' };
    }
    async wrapOuterLayer() {
      return { ciphertext: '' };
    }
  },
}));

mock.module(join(import.meta.dir, '../../../src/crypto/keyResolver.ts'), () => ({
  resolveProjectKey: mock(async () => PROJECT_KEY),
}));

// `inquirer.prompt` fake: records every question asked (so tests can assert
// on the exact message text) and answers by the question's `name`, falling
// back to its `default` when the test hasn't set one.
let promptCalls: any[] = [];
let promptAnswers: Record<string, any> = {};
mock.module('inquirer', () => ({
  default: {
    prompt: mock(async (questions: any) => {
      const arr = Array.isArray(questions) ? questions : [questions];
      const out: Record<string, any> = {};
      for (const q of arr) {
        promptCalls.push(q);
        out[q.name] = q.name in promptAnswers ? promptAnswers[q.name] : q.default;
      }
      return out;
    }),
  },
}));

// The edit screen's TUI reads a real TTY; replaced with a fake that hands the
// built `state` to the test and drives `editContext.saveLocalEdits` the way a
// person pressing save would. `suspendForPrompt` is a trivial passthrough —
// there's no real terminal to suspend in a test, only the confirm callback's
// own logic is under test here.
import * as realEditScreen from '../../../src/ui/editScreen';
let editScreenRunCalls: Array<{ state: any }> = [];
let editSaveEdits: Record<string, string> = {};
mock.module(join(import.meta.dir, '../../../src/ui/editScreen.ts'), () => ({
  ...realEditScreen,
  EditScreen: class {
    async run(state: any, ctx: any) {
      editScreenRunCalls.push({ state });
      await ctx.saveLocalEdits(editSaveEdits);
    }
    async suspendForPrompt(fn: () => Promise<any>) {
      return fn();
    }
  },
}));

afterAll(() => {
  mock.restore();
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

import {
  resolveContext,
  writeAndSync,
  conflictContextLines,
  describeConnector,
  conflictOverwriteQuestion,
  maybeWarnPersonalEnv,
  keepEntryFor,
} from '../../../src/commands/connectors/shared';
import { CapyError, ERROR_CODES, KeepFile, ConnectorMetadata } from '../../../src/types/index';
import { deriveResourceId } from '../../../src/crypto/resourceId';
import { Encryptor } from '../../../src/crypto/encryptor';
import { FileManager } from '../../../src/files/fileManager';

/** A real `KEY=capy:resourceId:ciphertext` .env line, decryptable with PROJECT_KEY. */
function cipherLine(branch: string, key: string, value: string): string {
  return `${key}=capy:${deriveResourceId(branch, key)}:${Encryptor.encrypt(value, PROJECT_KEY)}`;
}

const TEST_DIR = join(tmpdir(), `capy-conflictux-ctx-${process.pid}`);
const ORIGINAL_CWD = process.cwd();

function resetState(): void {
  authResultQueue = [];
  listProjectsResult = [];
  getDecryptDataResult = { env_content: '', decrypt_key: '', expires_at: new Date().toISOString() };
  pushSecretsQueue = [];
  serviceCalls.length = 0;
  promptCalls = [];
  promptAnswers = {};
  editScreenRunCalls = [];
  editSaveEdits = {};
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.chdir(TEST_DIR);
  resetState();
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeEnvHeader(): void {
  writeFileSync(join(TEST_DIR, '.env'), '# capy:org_id=org-header\n# capy:project_id=proj-header\n\n');
}

async function withTTY<T>(fn: () => Promise<T>): Promise<T> {
  // The edit-surface gate (editSurfaceIsSafe) requires BOTH stdin and stdout
  // to be a TTY before the full-screen editor may render — fake both.
  const savedIn = process.stdin.isTTY;
  const savedOut = process.stdout.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: savedIn, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: savedOut, configurable: true });
  }
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = ((...args: any[]) => {
    lines.push(args.map(String).join(' '));
  }) as any;
  return {
    lines,
    restore: () => {
      console.log = realLog;
    },
  };
}

function captureErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const realErr = console.error;
  console.error = ((...args: any[]) => {
    lines.push(args.map(String).join(' '));
  }) as any;
  return {
    lines,
    restore: () => {
      console.error = realErr;
    },
  };
}

const CONNECTOR: ConnectorMetadata = {
  provider: 'stripe',
  source: 'connect',
  mode: 'test',
  created_at: 1_700_000_000,
  fingerprint: 'sk_…abc',
};

describe('conflictContextLines / describeConnector / conflictOverwriteQuestion', () => {
  test('describeConnector: provider + mode when mode is set', () => {
    expect(describeConnector(CONNECTOR)).toBe('stripe (test)');
  });

  test('describeConnector: provider alone with no mode', () => {
    expect(describeConnector({ ...CONNECTOR, mode: undefined })).toBe('stripe');
  });

  test('conflictOverwriteQuestion matches addCommand\'s existing sentence byte for byte', () => {
    expect(conflictOverwriteQuestion(['A', 'B'])).toBe(
      'A, B changed on the server while you were editing. Overwrite?',
    );
  });

  test('renders one line per var with connector + relative last-written time', () => {
    const now = new Date();
    const changedAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'd',
      variables: {
        STRIPE_KEY: [{ resource_id: 'r1', branch: 'development', value_hash: 'h1', connector: CONNECTOR, changed_at: changedAt }],
        PLAIN_VAR: [{ resource_id: 'r2', branch: 'development', value_hash: 'h2' }],
      },
    };

    const lines = conflictContextLines(keep, ['STRIPE_KEY', 'PLAIN_VAR', 'MISSING'], 'development');

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('STRIPE_KEY');
    expect(lines[0]).toContain('stripe (test)');
    expect(lines[0]).toContain('last written');
    expect(lines[0]).toContain('minutes ago');
  });

  test('a var with no connector and no changed_at produces no line', () => {
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'd',
      variables: { PLAIN: [{ resource_id: 'r', branch: 'development', value_hash: 'h' }] },
    };
    expect(conflictContextLines(keep, ['PLAIN'], 'development')).toEqual([]);
  });

  test('keepEntryFor exposes the raw entry the context lines are built from', () => {
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'o',
      project_id: 'p',
      project_name: 'd',
      variables: { A: [{ resource_id: 'r', branch: 'development', value_hash: 'h', connector: CONNECTOR }] },
    };
    expect(keepEntryFor(keep, 'A', 'development')?.connector?.provider).toBe('stripe');
    expect(keepEntryFor(keep, 'A', 'main')).toBeUndefined();
  });
});

describe('addCommand — enriched overwrite/conflict gates', () => {
  test('local "already exists" gate: context lines print above the confirm; decline aborts without a second push', async () => {
    writeEnvHeader();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-header' }];
    const changedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const serverKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-header',
      project_id: 'proj-header',
      project_name: 'default',
      variables: {
        STRIPE_KEY: [
          {
            resource_id: deriveResourceId('development', 'STRIPE_KEY'),
            branch: 'development',
            value_hash: 'h1',
            connector: CONNECTOR,
            changed_at: changedAt,
          },
        ],
      },
    };
    getDecryptDataResult = {
      env_content: cipherLine('development', 'STRIPE_KEY', 'existing-value'),
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_hash: 'server-base-hash',
      keep_file: JSON.stringify(serverKeep),
    };

    promptAnswers = { ok: false };
    const { lines: logs, restore } = captureLogs();
    try {
      const { AddCommand } = await import('../../../src/commands/addCommand');
      await new AddCommand(true).execute(['STRIPE_KEY'], {});
    } finally {
      restore();
    }

    // Context line printed above the (unchanged) confirm question.
    expect(logs.some((l) => l.includes('STRIPE_KEY') && l.includes('stripe (test)') && l.includes('last written'))).toBe(
      true,
    );
    expect(promptCalls.some((q) => q.message === 'STRIPE_KEY already exist(s). Overwrite?')).toBe(true);
    // Declined — no push attempted.
    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(0);
    expect(logs.some((l) => l.includes('Aborted.'))).toBe(true);
  });

  test('CAS gate: same-key server conflict shows context lines from the server\'s copy; decline refuses coded', async () => {
    writeEnvHeader();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-header' }];
    const changedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const serverKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-header',
      project_id: 'proj-header',
      project_name: 'default',
      variables: {
        NEW_VAR: [
          {
            resource_id: 'r-someone-else',
            branch: 'development',
            value_hash: 'h-someone-else',
            connector: CONNECTOR,
            changed_at: changedAt,
          },
        ],
      },
    };
    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(serverKeep),
        });
      },
    ];
    promptAnswers = { value: 'super-secret-value', ok: false };

    const { lines: logs, restore } = captureLogs();
    let thrown: any;
    try {
      const { AddCommand } = await import('../../../src/commands/addCommand');
      await new AddCommand(true).execute(['NEW_VAR'], {});
    } catch (err) {
      thrown = err;
    } finally {
      restore();
    }

    expect(thrown).toBeInstanceOf(CapyError);
    expect(thrown.code).toBe(ERROR_CODES.STALE_KEEP_HASH);
    expect(logs.some((l) => l.includes('NEW_VAR') && l.includes('stripe (test)') && l.includes('last written'))).toBe(
      true,
    );
    expect(promptCalls.some((q) => q.message === 'NEW_VAR changed on the server while you were editing. Overwrite?')).toBe(
      true,
    );
    // Only one push attempted — refused before a retry.
    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(1);
  });

  test('CAS gate: accepting the confirm lets the retried push land', async () => {
    writeEnvHeader();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-header' }];
    const serverKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-header',
      project_id: 'proj-header',
      project_name: 'default',
      variables: {
        NEW_VAR: [{ resource_id: 'r-someone-else', branch: 'development', value_hash: 'h-someone-else' }],
      },
    };
    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(serverKeep),
        });
      },
      async (_projectId, keepFileJson) => ({ keep_hash: 'final-hash', keep_file: keepFileJson }),
    ];
    promptAnswers = { value: 'super-secret-value', ok: true };

    const { lines: logs, restore } = captureLogs();
    try {
      const { AddCommand } = await import('../../../src/commands/addCommand');
      await new AddCommand(true).execute(['NEW_VAR'], {});
    } finally {
      restore();
    }

    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(2);
    expect(logs.some((l) => l.includes('Saved 1 variable'))).toBe(true);
  });
});

describe('editCommand — same-key CAS conflict now offers the addCommand-style confirm', () => {
  test('decline refuses coded; the confirm carries the server-side context lines', async () => {
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: 'org-1' }];
    const baseServerKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'default',
      variables: {
        A: [{ resource_id: deriveResourceId('development', 'A'), branch: 'development', value_hash: 'hA' }],
      },
    };
    getDecryptDataResult = {
      env_content: cipherLine('development', 'A', 'value-a'),
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_hash: 'server-base-hash',
      keep_file: JSON.stringify(baseServerKeep),
    };

    const changedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const conflictServerKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'default',
      variables: {
        A: [
          {
            resource_id: 'r-someone-else',
            branch: 'development',
            value_hash: 'h-someone-else',
            connector: CONNECTOR,
            changed_at: changedAt,
          },
        ],
      },
    };
    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(conflictServerKeep),
        });
      },
    ];
    editSaveEdits = { A: 'my-new-value' };
    promptAnswers = { ok: false };

    const { lines: logs, restore } = captureLogs();
    let thrown: any;
    await withTTY(async () => {
      try {
        const { EditCommand } = await import('../../../src/commands/editCommand');
        await new EditCommand(undefined, true).execute({});
      } catch (err) {
        thrown = err;
      } finally {
        restore();
      }
    });

    expect(thrown).toBeInstanceOf(CapyError);
    expect(thrown.code).toBe(ERROR_CODES.STALE_KEEP_HASH);
    expect(promptCalls.some((q) => q.message === 'A changed on the server while you were editing. Overwrite?')).toBe(
      true,
    );
    expect(logs.some((l) => l.includes('A') && l.includes('stripe (test)'))).toBe(true);
    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(1);
  });

  test('accept lets the retried push land', async () => {
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: 'org-1' }];
    const baseServerKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'default',
      variables: {
        A: [{ resource_id: deriveResourceId('development', 'A'), branch: 'development', value_hash: 'hA' }],
      },
    };
    getDecryptDataResult = {
      env_content: cipherLine('development', 'A', 'value-a'),
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_hash: 'server-base-hash',
      keep_file: JSON.stringify(baseServerKeep),
    };
    const conflictServerKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'default',
      variables: {
        A: [{ resource_id: 'r-someone-else', branch: 'development', value_hash: 'h-someone-else' }],
      },
    };
    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(conflictServerKeep),
        });
      },
      async (_projectId, keepFileJson) => ({ keep_hash: 'final-hash', keep_file: keepFileJson }),
    ];
    editSaveEdits = { A: 'my-new-value' };
    promptAnswers = { ok: true };

    await withTTY(async () => {
      const { EditCommand } = await import('../../../src/commands/editCommand');
      await new EditCommand(undefined, true).execute({});
    });

    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(2);
  });

  test('not a TTY: refuses the same-key conflict without prompting', async () => {
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: 'org-1' }];
    const baseServerKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'default',
      variables: {
        A: [{ resource_id: deriveResourceId('development', 'A'), branch: 'development', value_hash: 'hA' }],
      },
    };
    getDecryptDataResult = {
      env_content: cipherLine('development', 'A', 'value-a'),
      decrypt_key: '',
      expires_at: new Date().toISOString(),
      keep_hash: 'server-base-hash',
      keep_file: JSON.stringify(baseServerKeep),
    };
    const conflictServerKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'default',
      variables: { A: [{ resource_id: 'r-someone-else', branch: 'development', value_hash: 'h-someone-else' }] },
    };
    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(conflictServerKeep),
        });
      },
    ];
    editSaveEdits = { A: 'my-new-value' };

    const saved = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    let thrown: any;
    try {
      const { EditCommand } = await import('../../../src/commands/editCommand');
      await new EditCommand(undefined, true).execute({});
    } catch (err) {
      thrown = err;
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
    }

    // Since the edit-surface gate landed (editSurfaceIsSafe), a non-TTY
    // non-web `capy edit` never reaches saveLocalEdits at all — the gate
    // refuses up front, so no prompt and no push can ever happen. The
    // web-surface refusal (confirmOverwrite omitted -> coded STALE_KEEP_HASH
    // from pushKeepWithRetry) stays covered by the retry-loop tests.
    expect(thrown).toBeInstanceOf(CapyError);
    expect(thrown.code).toBe('EDIT_SCREEN_UNSAFE_SURFACE');
    expect(promptCalls.length).toBe(0);
    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(0);
  });
});

describe('pushCommand — same-key CAS conflict now offers the addCommand-style confirm', () => {
  function setUpLockFullProject(): void {
    mkdirSync(join(TEST_DIR, '.capy'), { recursive: true });
    writeFileSync(join(TEST_DIR, '.capy', 'branch'), 'development');
    writeFileSync(
      join(TEST_DIR, '.capy', 'sync-state'),
      JSON.stringify({
        last_sync: new Date().toISOString(),
        synced_variables: ['NEW_VAR'],
        user_id: 'user-1',
        keep_hash: { development: 'base-hash-1' },
      }),
    );
    const keep: KeepFile = {
      version: '3.0',
      org_id: 'org-push',
      project_id: 'proj-push',
      project_name: 'pushproj',
      variables: {},
    };
    writeFileSync(join(TEST_DIR, 'keep.lock'), JSON.stringify(keep));
    writeFileSync(join(TEST_DIR, '.env'), 'NEW_VAR=plaintext-value\n');
  }

  // PushCommand.execute() wraps _execute() in a try/catch that routes any
  // thrown error to `displayErrorAndExit`, which ends in `process.exit(1)` —
  // there is no rethrow to catch from the caller. Same stub pattern
  // `decryptCommand.test.ts` uses for its own exit-on-refusal assertions:
  // replace `process.exit` with one that records the code and throws a
  // marker instead of actually tearing down the test process.
  function stubProcessExit(): { exitCode: () => number | undefined; restore: () => void } {
    const orig = process.exit;
    let code: number | undefined;
    // @ts-expect-error — stub for test
    process.exit = (c?: number) => {
      code = c;
      throw new Error('__STUBBED_EXIT__');
    };
    return {
      exitCode: () => code,
      restore: () => {
        process.exit = orig;
      },
    };
  }

  test('TTY: decline refuses coded, with context lines shown above the confirm', async () => {
    setUpLockFullProject();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-push' }];
    const changedAt = new Date(Date.now() - 30 * 1000).toISOString(); // just now
    const serverKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-push',
      project_id: 'proj-push',
      project_name: 'pushproj',
      variables: {
        NEW_VAR: [
          {
            resource_id: 'r-someone-else',
            branch: 'development',
            value_hash: 'h-someone-else',
            connector: CONNECTOR,
            changed_at: changedAt,
          },
        ],
      },
    };
    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(serverKeep),
        });
      },
    ];
    promptAnswers = { ok: false };

    const { lines: logs, restore: restoreLogs } = captureLogs();
    const { exitCode, restore: restoreExit } = stubProcessExit();
    await withTTY(async () => {
      try {
        const { PushCommand } = await import('../../../src/commands/pushCommand');
        await new PushCommand(true).execute();
      } catch (err: any) {
        if (err?.message !== '__STUBBED_EXIT__') throw err;
      } finally {
        restoreLogs();
        restoreExit();
      }
    });

    expect(exitCode()).toBe(1);
    // Refused before a retry — exactly one push attempt.
    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(1);
    expect(promptCalls.some((q) => q.message === 'NEW_VAR changed on the server while you were editing. Overwrite?')).toBe(
      true,
    );
    expect(logs.some((l) => l.includes('NEW_VAR') && l.includes('stripe (test)'))).toBe(true);
  });

  test('TTY: accepting the confirm lets the retried push land', async () => {
    setUpLockFullProject();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-push' }];
    const serverKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-push',
      project_id: 'proj-push',
      project_name: 'pushproj',
      variables: { NEW_VAR: [{ resource_id: 'r-someone-else', branch: 'development', value_hash: 'h-someone-else' }] },
    };
    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(serverKeep),
        });
      },
      async (_projectId, keepFileJson) => ({ keep_hash: 'final-hash', keep_file: keepFileJson }),
    ];
    promptAnswers = { ok: true };

    await withTTY(async () => {
      const { PushCommand } = await import('../../../src/commands/pushCommand');
      await new PushCommand(true).execute();
    });

    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(2);
    expect(promptCalls.some((q) => q.message === 'NEW_VAR changed on the server while you were editing. Overwrite?')).toBe(
      true,
    );
  });

  test('non-TTY: refuses without prompting at all', async () => {
    setUpLockFullProject();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-push' }];
    const serverKeep: KeepFile = {
      version: '3.0',
      org_id: 'org-push',
      project_id: 'proj-push',
      project_name: 'pushproj',
      variables: { NEW_VAR: [{ resource_id: 'r-someone-else', branch: 'development', value_hash: 'h-someone-else' }] },
    };
    pushSecretsQueue = [
      async () => {
        throw new CapyError('stale', ERROR_CODES.STALE_KEEP_HASH, {
          status: 409,
          keep_hash: 'server-hash-1',
          keep_file: JSON.stringify(serverKeep),
        });
      },
    ];

    const saved = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const { exitCode, restore: restoreExit } = stubProcessExit();
    try {
      const { PushCommand } = await import('../../../src/commands/pushCommand');
      await new PushCommand(true).execute();
    } catch (err: any) {
      if (err?.message !== '__STUBBED_EXIT__') throw err;
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: saved, configurable: true });
      restoreExit();
    }

    expect(exitCode()).toBe(1);
    expect(promptCalls.length).toBe(0);
    expect(serviceCalls.filter((c) => c[0] === 'pushSecrets').length).toBe(1);
  });
});

describe('maybeWarnPersonalEnv — soft, non-blocking personal-env-in-a-team-project note', () => {
  function gitInit(withRemote: boolean): void {
    execFileSync('git', ['init', '-q'], { cwd: TEST_DIR });
    if (withRemote) {
      execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/team/repo.git'], { cwd: TEST_DIR });
    }
  }

  test('fires once for a lock-less write whose identity came from the server, in a repo with a remote', async () => {
    gitInit(true);
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: 'org-1' }];

    const ctx = await resolveContext({ devMode: true });
    expect(ctx.identitySource).toBe('server');

    const { lines: errs, restore } = captureErrors();
    try {
      maybeWarnPersonalEnv(ctx, TEST_DIR);
      maybeWarnPersonalEnv(ctx, TEST_DIR); // same ctx again — deduped, not a second line
    } finally {
      restore();
    }

    expect(errs).toEqual(['Heads up: this saves to your personal env, not a team project.']);
  });

  test('stays silent when the .env identity header already exists (not the first write)', async () => {
    gitInit(true);
    writeEnvHeader();
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-header' }];

    const ctx = await resolveContext({ devMode: true });
    expect(ctx.identitySource).toBe('header');

    const { lines: errs, restore } = captureErrors();
    try {
      maybeWarnPersonalEnv(ctx, TEST_DIR);
    } finally {
      restore();
    }
    expect(errs).toEqual([]);
  });

  test('stays silent in a git repo with no remote configured', async () => {
    gitInit(false);
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: 'org-1' }];

    const ctx = await resolveContext({ devMode: true });
    const { lines: errs, restore } = captureErrors();
    try {
      maybeWarnPersonalEnv(ctx, TEST_DIR);
    } finally {
      restore();
    }
    expect(errs).toEqual([]);
  });

  test('stays silent outside a git repo entirely', async () => {
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: 'org-1' }];

    const ctx = await resolveContext({ devMode: true });
    const { lines: errs, restore } = captureErrors();
    try {
      maybeWarnPersonalEnv(ctx, TEST_DIR);
    } finally {
      restore();
    }
    expect(errs).toEqual([]);
  });

  test('stays silent for lock-full contexts (keep.lock present) regardless of git state', () => {
    gitInit(true);
    const fauxLockFullCtx = { lockless: false, identitySource: undefined } as any;
    const { lines: errs, restore } = captureErrors();
    try {
      maybeWarnPersonalEnv(fauxLockFullCtx, TEST_DIR);
    } finally {
      restore();
    }
    expect(errs).toEqual([]);
  });

  test('writeAndSync wires the warning in automatically on a real lock-less write', async () => {
    gitInit(true);
    authResultQueue = [{ success: true, user_id: 'user-1', organization_id: 'org-1' }];
    listProjectsResult = [{ id: 'proj-1', name: 'default', organization_id: 'org-1' }];
    pushSecretsQueue = [async () => ({ keep_hash: 'h'.repeat(64) })];

    const ctx = await resolveContext({ devMode: true });
    const { lines: errs, restore } = captureErrors();
    try {
      await writeAndSync(ctx, 'NEW_VAR', 'value', { push: true });
    } finally {
      restore();
    }

    expect(errs).toEqual(['Heads up: this saves to your personal env, not a team project.']);
    // The write itself left the identity header behind — the on-disk proof
    // that the next command in this directory would see identitySource
    // 'header' and stay silent.
    expect(existsSync(join(TEST_DIR, '.env'))).toBe(true);
  });
});

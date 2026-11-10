/**
 * `capy org` inside a git repo: a repo belongs to one organization, the `org_id` in its TRACKED keep.lock.
 *
 * Switching to a different organization (an existing one, or a new one) from inside that folder is refused at the
 * pick: no re-auth, no organization created, nothing written in the folder. Real `FileManager` and files in a temp
 * directory; the prompts, auth, the service and the key store are faked.
 *
 * Isolated: `mock.module()` is process-wide (tests/run-tests.sh).
 */
import { describe, test, expect, mock, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realKeyResolver from '../../src/crypto/keyResolver';
import * as realGate from '../../src/sync/gate';
import * as realOrgCreation from '../../src/commands/orgCreation';

const answers = mock((_name: string): unknown => undefined);
const createOrganization = mock(async () => ({ id: 'org_new', name: 'Brand New' }));

mock.module('../../src/crypto/keyResolver', () => ({
  ...realKeyResolver,
  hasOrgKey: () => true,
}));
mock.module('../../src/sync/gate', () => ({
  ...realGate,
  gateFirst: async () => undefined,
}));
mock.module('../../src/commands/orgCreation', () => ({
  ...realOrgCreation,
  createNewOrganization: createOrganization,
}));
mock.module('inquirer', () => ({
  default: {
    prompt: async (questions: unknown) => {
      const name = Array.isArray(questions) ? questions[0]?.name : (questions as { name?: string })?.name;
      return { [name as string]: answers(name as string) };
    },
    Separator: class Separator {},
  },
}));

import { OrgCommand } from '../../src/commands/orgCommand';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { ERROR_CODES } from '../../src/types/index';

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

const ORIGIN = process.cwd();
const dirs = mock((_: string) => undefined);

const ORG_A = { id: 'org_repo_A', name: 'Alpha Co' };
const ORG_B = { id: 'org_other_B', name: 'Beta Co' };

const keepFor = (orgId: string): string =>
  JSON.stringify({ version: '3.0', org_id: orgId, project_id: `proj-${orgId}`, project_name: 'demo', variables: {} }, null, 2) + '\n';

/** A folder with a tracked keep.lock for `repoOrgId` (or none), a working copy and a sync-state. */
function folder(repoOrgId: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'capy-org-guard-'));
  dirs(dir);
  mkdirSync(join(dir, '.capy'), { recursive: true });
  writeFileSync(join(dir, '.capy', 'sync-state'), JSON.stringify({ last_sync: 'x', synced_variables: [], user_id: 'user-1', org_id: repoOrgId ?? 'none' }) + '\n');
  if (repoOrgId !== undefined) {
    writeFileSync(join(dir, 'keep.lock'), keepFor(repoOrgId));
    writeFileSync(join(dir, '.capy', 'keep.lock'), keepFor(repoOrgId).replace('demo', 'demo-working-copy'));
  }
  process.chdir(dir);
  return dir;
}

const filesUnder = (dir: string): readonly string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .toSorted();

/** Every file under `dir` with its bytes, so "nothing changed" is one equality. */
const snapshot = (dir: string): Readonly<Record<string, string>> =>
  Object.fromEntries(filesUnder(dir).map((p) => [p, readFileSync(p).toString('base64')]));

/** Fakes auth, the service and the prompts; `picks` is the organization the person chooses. */
function fakes(picks: string) {
  answers.mockImplementation((name) => (name === 'orgId' ? picks : name === 'projectId' ? 'proj-in-B' : undefined));
  const signedIn = {
    success: true,
    user_id: 'user-1',
    user_email: 'dev@example.com',
    organization_id: ORG_A.id,
    organizations: [ORG_A, ORG_B],
    _refresh_token: 'refresh-token',
    _auth_method: 'cached',
  };
  return {
    silent: spyOn(AuthService.prototype, 'authenticateSilent').mockResolvedValue(signedIn as never),
    interactive: spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(signedIn as never),
    refresh: spyOn(AuthService.prototype, 'refreshWithCredentials').mockResolvedValue({ success: true } as never),
    listProjects: spyOn(ServiceClient.prototype, 'listProjects').mockResolvedValue([
      { id: 'proj-in-B', name: 'beta-project', organization_id: ORG_B.id },
    ] as never),
    initializeProject: spyOn(ServiceClient.prototype, 'initializeProject').mockResolvedValue({} as never),
    network: spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test')),
  };
}

/** Runs `capy org` with `process.exit` trapped and the terminal captured. */
async function runOrg(): Promise<{ exit: number | undefined; stderr: string; stdout: string }> {
  const exit = spyOn(process, 'exit').mockImplementation(((c?: number) => {
    throw new ExitSignal(c);
  }) as never);
  const out = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const read = () => ({ stderr: err.mock.calls.flat().join('\n'), stdout: out.mock.calls.flat().join('\n') });
  try {
    await new OrgCommand().execute({ nonTty: true });
    return { exit: undefined, ...read() };
  } catch (thrown) {
    if (!(thrown instanceof ExitSignal)) throw thrown;
    return { exit: thrown.code, ...read() };
  } finally {
    exit.mockRestore();
    out.mockRestore();
    err.mockRestore();
  }
}

afterEach(() => {
  mock.restore();
  createOrganization.mockClear();
  process.chdir(ORIGIN);
  dirs.mock.calls.forEach(([dir]) => rmSync(dir, { recursive: true, force: true }));
  dirs.mockClear();
});

describe('switching to a different organization inside a repo', () => {
  test('an existing organization: refuses with REPO_ORG_MISMATCH, exit 1, naming the repo organization', async () => {
    folder(ORG_A.id);
    fakes(ORG_B.id);
    const result = await runOrg();

    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(ERROR_CODES.REPO_ORG_MISMATCH);
    expect(result.stderr).toContain(ORG_A.name);
  });

  test('an existing organization: no re-auth, no project listing, and the folder is byte-identical', async () => {
    const dir = folder(ORG_A.id);
    const f = fakes(ORG_B.id);
    const before = snapshot(dir);
    await runOrg();

    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.listProjects).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
    expect(Object.keys(before).filter((p) => p.endsWith('keep.lock')).length).toBe(2);
  });

  test('a NEW organization: refused before it is created, nothing re-authed, folder byte-identical', async () => {
    const dir = folder(ORG_A.id);
    const f = fakes('__create_new__');
    const before = snapshot(dir);
    const result = await runOrg();

    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(ERROR_CODES.REPO_ORG_MISMATCH);
    expect(createOrganization).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.initializeProject).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('switching where nothing contradicts it', () => {
  test('the SAME organization as the repo: unchanged ("Already on"), nothing re-authed, folder byte-identical', async () => {
    const dir = folder(ORG_A.id);
    const f = fakes(ORG_A.id);
    const before = snapshot(dir);
    const result = await runOrg();

    expect(result.exit).toBeUndefined();
    expect(result.stdout).toContain(ORG_A.name);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });

  test('no keep.lock: switching to another organization proceeds as before (re-auth, project picked)', async () => {
    const dir = folder(undefined);
    const f = fakes(ORG_B.id);
    const result = await runOrg();

    expect(result.exit).toBeUndefined();
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.listProjects).toHaveBeenCalledTimes(1);
    expect(result.stdout).toContain(ORG_B.name);
    expect(existsSync(join(dir, 'keep.lock'))).toBe(false);
  });
});

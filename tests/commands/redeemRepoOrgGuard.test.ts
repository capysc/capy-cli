/**
 * `capy redeem` inside a git repo: a repo belongs to one organization, the `org_id` in its TRACKED keep.lock.
 *
 * Redeeming an invite for a different organization is refused before anything else happens: no sign-in, no service
 * call, no key save, no file write. Real `FileManager` and files in a temp directory; auth, the service and the key
 * store are faked.
 *
 * Isolated: `mock.module()` is process-wide (tests/run-tests.sh).
 */
import { describe, test, expect, mock, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realKeyResolver from '../../src/crypto/keyResolver';

mock.module('../../src/crypto/keyResolver', () => ({
  ...realKeyResolver,
  hasOrgKey: () => true,
}));

import { RedeemCommand } from '../../src/commands/redeemCommand';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { buildRedeemCode } from '../../src/crypto/inviteCrypto';
import { ERROR_CODES } from '../../src/types/index';

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

const ORIGIN = process.cwd();
const dirs = mock((_: string) => undefined);

const REPO_ORG = 'org_repo_A';
const INVITED_ORG = 'org_invited_B';

const redeemCodeFor = (orgId: string): string =>
  buildRedeemCode(Buffer.alloc(32, 7), Buffer.from('outer').toString('base64'), orgId, Date.now() + 3_600_000);

const keepFor = (orgId: string): string =>
  JSON.stringify({ version: '3.0', org_id: orgId, project_id: `proj-${orgId}`, project_name: 'demo', variables: {} }, null, 2) + '\n';

/** A folder with a tracked keep.lock for `repoOrgId` (or none), a working copy and a sync-state naming that org. */
function folder(repoOrgId: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'capy-redeem-guard-'));
  dirs(dir);
  mkdirSync(join(dir, '.capy'), { recursive: true });
  writeFileSync(join(dir, '.capy', 'sync-state'), JSON.stringify({ last_sync: 'x', synced_variables: [], user_id: 'u-old', org_id: repoOrgId ?? 'none' }) + '\n');
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

const signedIn = (orgId: string) => ({
  success: true,
  user_id: 'user-1',
  user_email: 'dev@example.com',
  organization_id: orgId,
  organizations: [{ id: orgId, name: 'Invited Inc' }],
  _auth_method: 'cached',
});

/** Fakes every auth and service edge; returns the spies so a test can count calls. */
function fakes() {
  return {
    silent: spyOn(AuthService.prototype, 'authenticateSilent').mockResolvedValue(signedIn(INVITED_ORG) as never),
    interactive: spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(signedIn(INVITED_ORG) as never),
    coDecrypt: spyOn(ServiceClient.prototype, 'coDecrypt').mockResolvedValue({ plaintext: 'inner' } as never),
    network: spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test')),
  };
}

/** Runs the redeem with `process.exit` trapped and the terminal captured. */
async function redeem(code: string): Promise<{ exit: number | undefined; stderr: string; stdout: string }> {
  const exit = spyOn(process, 'exit').mockImplementation(((c?: number) => {
    throw new ExitSignal(c);
  }) as never);
  const out = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await new RedeemCommand().execute(code);
    return { exit: undefined, stderr: err.mock.calls.flat().join('\n'), stdout: out.mock.calls.flat().join('\n') };
  } catch (thrown) {
    if (!(thrown instanceof ExitSignal)) throw thrown;
    return { exit: thrown.code, stderr: err.mock.calls.flat().join('\n'), stdout: out.mock.calls.flat().join('\n') };
  } finally {
    exit.mockRestore();
    out.mockRestore();
    err.mockRestore();
  }
}

afterEach(() => {
  mock.restore();
  process.chdir(ORIGIN);
  dirs.mock.calls.forEach(([dir]) => rmSync(dir, { recursive: true, force: true }));
  dirs.mockClear();
});

describe('redeeming another organization into a repo', () => {
  test('refuses with REPO_ORG_MISMATCH, exit 1, and the sentence on stderr', async () => {
    folder(REPO_ORG);
    fakes();
    const result = await redeem(redeemCodeFor(INVITED_ORG));

    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(ERROR_CODES.REPO_ORG_MISMATCH);
    expect(result.stderr).toContain(REPO_ORG);
    expect(result.stderr).toContain(INVITED_ORG);
    expect(result.stdout).toBe('');
  });

  test('makes no sign-in and no service call at all', async () => {
    folder(REPO_ORG);
    const f = fakes();
    await redeem(redeemCodeFor(INVITED_ORG));

    expect(f.silent).not.toHaveBeenCalled();
    expect(f.interactive).not.toHaveBeenCalled();
    expect(f.coDecrypt).not.toHaveBeenCalled();
    expect(f.network).not.toHaveBeenCalled();
  });

  test('leaves keep.lock, .capy/keep.lock and .capy/sync-state byte-identical, and adds no file', async () => {
    const dir = folder(REPO_ORG);
    fakes();
    const before = snapshot(dir);
    await redeem(redeemCodeFor(INVITED_ORG));

    expect(snapshot(dir)).toEqual(before);
    expect(Object.keys(before).some((p) => p.endsWith('sync-state'))).toBe(true);
    expect(Object.keys(before).filter((p) => p.endsWith('keep.lock')).length).toBe(2);
  });
});

describe('redeeming where nothing contradicts it', () => {
  test('a tracked keep.lock of the SAME organization: proceeds as before, keep.lock untouched, sync-state points at the org', async () => {
    const dir = folder(INVITED_ORG);
    const f = fakes();
    const keepBefore = readFileSync(join(dir, 'keep.lock'), 'utf-8');
    const workingBefore = readFileSync(join(dir, '.capy', 'keep.lock'), 'utf-8');
    const result = await redeem(redeemCodeFor(INVITED_ORG));

    expect(result.exit).toBeUndefined();
    expect(f.silent).toHaveBeenCalled();
    expect(f.coDecrypt).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, 'keep.lock'), 'utf-8')).toBe(keepBefore);
    expect(readFileSync(join(dir, '.capy', 'keep.lock'), 'utf-8')).toBe(workingBefore);
    expect(JSON.parse(readFileSync(join(dir, '.capy', 'sync-state'), 'utf-8')).org_id).toBe(INVITED_ORG);
  });

  test('no keep.lock: proceeds as before, writes the sync-state, creates no keep.lock', async () => {
    const dir = folder(undefined);
    const f = fakes();
    const result = await redeem(redeemCodeFor(INVITED_ORG));

    expect(result.exit).toBeUndefined();
    expect(f.coDecrypt).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, 'keep.lock'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, '.capy', 'sync-state'), 'utf-8')).org_id).toBe(INVITED_ORG);
  });

  test('an unparseable keep.lock is still removed, as before', async () => {
    const dir = folder(undefined);
    writeFileSync(join(dir, 'keep.lock'), '{ not json');
    fakes();
    const result = await redeem(redeemCodeFor(INVITED_ORG));

    expect(result.exit).toBeUndefined();
    expect(existsSync(join(dir, 'keep.lock'))).toBe(false);
  });
});

/** Parses, but names no organization: not a repo's identity. */
const NO_ORG_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['null', 'null'],
  ['an array', '[]'],
  ['a number', '5'],
  ['a string', '"keep"'],
  ['an object with no org_id', '{"version":"3.0","project_id":"p","project_name":"demo","variables":{}}'],
  ['an empty org_id', '{"version":"3.0","org_id":"","project_id":"p","project_name":"demo","variables":{}}'],
  ['a non-string org_id', '{"version":"3.0","org_id":5,"project_id":"p","project_name":"demo","variables":{}}'],
];

describe.each(NO_ORG_SHAPES)('a keep.lock that is %s', (_name, content) => {
  test('is neither a refusal nor kept: both copies removed with the existing line, and the redeem proceeds', async () => {
    const dir = folder(undefined);
    writeFileSync(join(dir, 'keep.lock'), content);
    writeFileSync(join(dir, '.capy', 'keep.lock'), content);
    const f = fakes();
    const result = await redeem(redeemCodeFor(INVITED_ORG));

    expect(result.exit).toBeUndefined();
    expect(result.stderr).not.toContain(ERROR_CODES.REPO_ORG_MISMATCH);
    expect(result.stdout).toContain('Removed invalid keep.lock');
    expect(existsSync(join(dir, 'keep.lock'))).toBe(false);
    expect(existsSync(join(dir, '.capy', 'keep.lock'))).toBe(false);
    expect(f.coDecrypt).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(dir, '.capy', 'sync-state'), 'utf-8')).org_id).toBe(INVITED_ORG);
  });
});

describe('a keep.lock with a valid org_id that differs from the invite', () => {
  test('still refuses up front and deletes nothing (the working copy included)', async () => {
    const dir = folder(REPO_ORG);
    fakes();
    const before = snapshot(dir);
    const result = await redeem(redeemCodeFor(INVITED_ORG));

    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(ERROR_CODES.REPO_ORG_MISMATCH);
    expect(result.stdout).not.toContain('Removed');
    expect(snapshot(dir)).toEqual(before);
  });
});

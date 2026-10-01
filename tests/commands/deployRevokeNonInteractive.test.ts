/**
 * `capy deploy revoke <deployId>` (CAP-659 Phase 2 / CAP-520) —
 * `DeployRevokeCommand`'s non-interactive confirm gate and `--dry-run`
 * preview, driven directly against the class with a mocked
 * `AuthService`/`ServiceClient` (same shape as `deployRevokeWiring.test.ts`,
 * which mocks the same two modules for the sibling `deployRemove()` path).
 *
 * `mock.module()` is process-wide — this file runs isolated
 * (tests/run-tests.sh).
 */
import { describe, test, expect, afterEach, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(tmpdir(), `capy-deploy-revoke-noninteractive-${process.pid}-${Date.now()}`);
const ORIGINAL_CWD = process.cwd();

mock.module('../../src/auth/authService', () => ({
  AuthService: class {
    async authenticateSilent() {
      return { success: true, user_id: 'user_1' };
    }
    async getValidToken() {
      return 'fake-session-token';
    }
  },
}));

const revokeDeployTokenMock = mock(async (_id: string) => ({}));
const listDeployTokensMock = mock(async () => ({
  tokens: [
    {
      deploy_id: 'dep_abc123',
      label: null,
      created_by: 'user_1',
      created_at: '2026-01-01T00:00:00.000Z',
      revoked_at: null,
    },
  ],
}));
// `DeployRevokeCommand.execute()` wraps its whole body in a try/catch that
// hands any thrown error to `displayErrorAndExit`, which calls
// `process.exit(1)` itself — fine in production (`process.exit` never
// returns), but it would swallow the ExitSignal our MOCKED `process.exit`
// throws below and re-exit with 1, masking the real refusal code. Mocked to
// re-throw unchanged so the original exit code survives to `capture()`.
mock.module('../../src/ui/errorScreen', () => ({
  displayErrorAndExit: async (err: unknown) => {
    throw err;
  },
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: class {
    setTokenProvider() {}
    async listDeployTokens(...args: unknown[]) {
      return listDeployTokensMock(...(args as []));
    }
    async revokeDeployToken(id: string) {
      return revokeDeployTokenMock(id);
    }
  },
}));

import { DeployRevokeCommand } from '../../src/commands/deployTokenCommand';

/** Sentinel thrown by the mocked `process.exit`, carrying the exit code. */
class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('process.exit called');
  }
}

async function capture(fn: () => Promise<void>): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  let stdout = '';
  let stderr = '';
  const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout += args.map(String).join(' ') + '\n';
  });
  const errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr += args.map(String).join(' ') + '\n';
  });
  try {
    await fn();
    return { stdout, stderr };
  } catch (err) {
    if (err instanceof ExitSignal) return { exitCode: err.code, stdout, stderr };
    throw err;
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

function writeKeep(): void {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(
    join(ROOT, 'keep.lock'),
    JSON.stringify({ version: '3.0', org_id: 'org-test', project_id: 'proj-test', project_name: 'test', variables: {} }),
  );
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  rmSync(ROOT, { recursive: true, force: true });
  revokeDeployTokenMock.mockClear();
  listDeployTokensMock.mockClear();
});

describe('DeployRevokeCommand — non-interactive confirm gate (CAP-659/CAP-520)', () => {
  test('no --yes, no TTY, not dry-run: refuses with DEPLOY_CONFIRM_NEEDS_TTY, exit 3 — never revokes', async () => {
    writeKeep();
    process.chdir(ROOT);

    const cmd = new DeployRevokeCommand(undefined, false, {});
    const r = await capture(() => cmd.execute('dep_abc'));

    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('DEPLOY_CONFIRM_NEEDS_TTY');
    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
  });

  test('--json without --yes: a coded JSON refusal on stdout, never prose, never revokes', async () => {
    writeKeep();
    process.chdir(ROOT);

    const cmd = new DeployRevokeCommand(undefined, false, { json: true });
    const r = await capture(() => cmd.execute('dep_abc'));

    expect(r.exitCode).toBe(3);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed).toEqual({ ok: false, code: 'DEPLOY_CONFIRM_NEEDS_TTY', error: expect.any(String) });
    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
  });

  test('--yes: skips the confirm, revokes the resolved full id', async () => {
    writeKeep();
    process.chdir(ROOT);

    const cmd = new DeployRevokeCommand(undefined, false, { yes: true });
    const r = await capture(() => cmd.execute('dep_abc'));

    expect(r.exitCode).toBeUndefined();
    expect(revokeDeployTokenMock).toHaveBeenCalledTimes(1);
    expect(revokeDeployTokenMock.mock.calls[0][0]).toBe('dep_abc123');
  });

  test('an ambiguous prefix refuses (not resolved to whichever row sorts first), never revokes — now shared with the terminal path, not just --web', async () => {
    writeKeep();
    process.chdir(ROOT);
    listDeployTokensMock.mockImplementationOnce(async () => ({
      tokens: [
        { deploy_id: 'dep_abc111', label: null, created_by: 'u', created_at: '2026-01-01T00:00:00.000Z', revoked_at: null },
        { deploy_id: 'dep_abc222', label: null, created_by: 'u', created_at: '2026-01-01T00:00:00.000Z', revoked_at: null },
      ],
    }));

    const cmd = new DeployRevokeCommand(undefined, false, { yes: true });
    const r = await capture(() => cmd.execute('dep_abc'));

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('2 deploy tokens start with');
    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
  });

  test('--dry-run: previews (reversible: false), changes nothing, never prompts even with --yes absent', async () => {
    writeKeep();
    process.chdir(ROOT);

    const cmd = new DeployRevokeCommand(undefined, false, { dryRun: true, json: true });
    const r = await capture(() => cmd.execute('dep_abc'));

    expect(revokeDeployTokenMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed).toEqual({
      ok: true,
      dry_run: true,
      command: 'deploy revoke',
      changes: [{ where: 'capy_service', action: 'revoke deploy token', target: 'dep_abc123', reversible: false }],
      unanswered: [],
    });
  });
});

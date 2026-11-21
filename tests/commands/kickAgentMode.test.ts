/**
 * `capy kick <email>` answerable by an agent: `--json`, `--non-tty` or no terminal means nobody is asked.
 *
 * The real `KickCommand` and `resolveOrgContext`; sign-in and the service are spies on the real classes, so the
 * assertions are about which service calls were made. No `mock.module()`.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuthService } from '../../src/auth/authService';
import { ServiceClient } from '../../src/service/serviceClient';
import { KickCommand } from '../../src/commands/kickCommand';

const ORIGIN = process.cwd();
const ORG = { id: 'org-1', name: 'Acme' };
const OTHER_ORG = { id: 'org-2', name: 'Other' };
const QUESTION = 'Remove alice@acme.com from this organization? They will lose access to all secrets.';

const MEMBERS = [
  { membershipId: 'mem-owner-1', userId: 'u-1', email: 'owner@acme.com', role: 'owner', status: 'active', createdAt: '2025-01-01T00:00:00Z', projects: [] },
  { membershipId: 'mem-obrien-3', userId: 'u-3', email: "o'brien@acme.com", role: 'member', status: 'active', createdAt: '2025-03-01T00:00:00Z', projects: [] },
  { membershipId: 'mem-alice-2', userId: 'u-2', email: 'Alice@Acme.com', role: 'member', status: 'active', createdAt: '2025-02-01T00:00:00Z', projects: [] },
];

// One parent directory for the whole file; each test works in a fresh folder inside it, and the parent goes at the end.
const PARENT = mkdtempSync(join(tmpdir(), 'capy-kick-'));
beforeEach(() => {
  process.chdir(mkdtempSync(join(PARENT, 'case-')));
});
afterEach(() => {
  mock.restore();
  process.chdir(ORIGIN);
});
afterAll(() => {
  rmSync(PARENT, { recursive: true, force: true });
});

interface World {
  readonly orgs?: ReadonlyArray<{ id: string; name: string }>;
  readonly signedIn?: boolean;
  readonly listFails?: Error;
  readonly kickFails?: Error;
}

function fakeWorld(world: World = {}) {
  const { orgs = [ORG], signedIn = true, listFails, kickFails } = world;
  const session = signedIn
    ? ({ success: true, user_id: 'user-1', user_email: 'dev@example.com', organization_id: orgs[0].id, organizations: orgs } as never)
    : ({ success: false, error: 'No valid session available', error_code: 'no_session' } as never);
  const authenticateSilent = spyOn(AuthService.prototype, 'authenticateSilent').mockResolvedValue(session);
  const authenticate = spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(session);
  const listMemberDetails = spyOn(ServiceClient.prototype, 'listMemberDetails').mockImplementation(async () => {
    if (listFails !== undefined) throw listFails;
    return { members: MEMBERS } as never;
  });
  const kickMember = spyOn(ServiceClient.prototype, 'kickMember').mockImplementation(async () => {
    if (kickFails !== undefined) throw kickFails;
  });
  return { authenticateSilent, authenticate, listMemberDetails, kickMember };
}

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

interface Captured {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: Record<string, any> | undefined;
}

async function kick(email: string, options?: { yes?: boolean; json?: boolean; nonTty?: boolean }): Promise<Captured> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const thrown: unknown = await new KickCommand().execute(email, options).then(() => null, (err: unknown) => err);
  const stdout = logSpy.mock.calls.map((args) => args.map(String).join('\n')).join('\n');
  const stderr = errSpy.mock.calls.map((args) => args.map(String).join('\n')).join('\n');
  const exitCode = exitSpy.mock.calls.length > 0 ? (exitSpy.mock.calls[exitSpy.mock.calls.length - 1][0] as number | undefined) : undefined;
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  if (thrown !== null && !(thrown instanceof ExitSignal)) throw thrown;
  return { exitCode, stdout, stderr, json: stdout.trim().startsWith('{') ? JSON.parse(stdout) : undefined };
}

describe('capy kick without --yes in agent mode', () => {
  test('--json: removes nothing, exits 3 with the confirm and the terminal question word for word', async () => {
    const calls = fakeWorld();
    const out = await kick('alice@acme.com', { json: true });

    expect(out.exitCode).toBe(3);
    expect(out.json).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(out.json!.elicitation).toEqual({
      kind: 'confirm',
      question: QUESTION,
      details: { org: ORG, member: { email: 'Alice@Acme.com' } },
      display: '|  |  |\n| --- | --- |\n| Org | Acme |\n| Member | Alice@Acme.com |',
      answer: { yes: 'capy kick alice@acme.com --yes --json' },
    });
    expect(calls.kickMember).not.toHaveBeenCalled();
    expect(calls.authenticate).not.toHaveBeenCalled();
  });

  test('--non-tty is the same, and so is no terminal at all (stdin that is not a TTY)', async () => {
    const calls = fakeWorld();
    const nonTty = await kick('alice@acme.com', { nonTty: true });
    const piped = await kick('alice@acme.com', {});
    expect(nonTty.exitCode).toBe(3);
    expect(piped.exitCode).toBe(3);
    expect(piped.json).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(calls.kickMember).not.toHaveBeenCalled();
  });

  test('an email with characters a shell would read is quoted in the answer command', async () => {
    fakeWorld();
    const out = await kick("o'brien@acme.com", { json: true });
    expect(out.exitCode).toBe(3);
    expect(out.json!.elicitation.answer.yes).toBe(`capy kick 'o'\\''brien@acme.com' --yes --json`);
    expect(out.json!.elicitation.question).toBe("Remove o'brien@acme.com from this organization? They will lose access to all secrets.");
  });

  test('under another binary (CAPY_BIN_NAME) the answer command starts with that binary', async () => {
    fakeWorld();
    const env = spyOn(process, 'env', 'get' as never).mockReturnValue({ ...process.env, CAPY_BIN_NAME: 'capy-staging' } as never);
    const out = await kick('alice@acme.com', { json: true }).finally(() => env.mockRestore());
    expect(out.exitCode).toBe(3);
    expect(out.json!.elicitation.answer.yes).toBe('capy-staging kick alice@acme.com --yes --json');
  });

  test('an email that matches no member is MEMBER_NOT_FOUND (exit 1) and nothing is asked or removed', async () => {
    const calls = fakeWorld();
    const out = await kick('nobody@acme.com', { json: true });
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'MEMBER_NOT_FOUND' });
    expect(out.json!.elicitation).toBeUndefined();
    expect(calls.kickMember).not.toHaveBeenCalled();
  });
});

describe('capy kick --yes in agent mode', () => {
  test('removes the member once, by membership id, and answers {ok:true} with the email and the org', async () => {
    const calls = fakeWorld();
    const out = await kick('alice@acme.com', { yes: true, json: true });

    expect(out.exitCode).toBeUndefined();
    expect(calls.kickMember).toHaveBeenCalledTimes(1);
    expect(calls.kickMember).toHaveBeenCalledWith('org-1', 'mem-alice-2');
    expect(out.json).toEqual({ ok: true, removed: true, email: 'Alice@Acme.com', org: ORG });
    // JSON only on stdout; nothing of the human screen.
    expect(out.stdout).not.toContain('\x1b[');
    expect(out.stderr).toBe('');
  });

  test('--yes with no terminal and no --json answers in JSON too', async () => {
    const calls = fakeWorld();
    const out = await kick('alice@acme.com', { yes: true });
    expect(out.json).toMatchObject({ ok: true, removed: true });
    expect(calls.kickMember).toHaveBeenCalledTimes(1);
  });
});

describe('capy kick failures in agent mode are coded JSON', () => {
  test('a failed removal keeps the service error code', async () => {
    const { CapyError, ERROR_CODES } = await import('../../src/types/index');
    fakeWorld({ kickFails: new CapyError('Not allowed', ERROR_CODES.PERMISSION_DENIED) });
    const out = await kick('alice@acme.com', { yes: true, json: true });
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });

  test('an error with no code is SERVICE_ERROR, never a stack', async () => {
    fakeWorld({ listFails: new Error('socket hang up') });
    const out = await kick('alice@acme.com', { json: true });
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'SERVICE_ERROR' });
    expect(out.stderr).toBe('');
  });

  test('no session: AUTH_FAILED, with no browser', async () => {
    const calls = fakeWorld({ signedIn: false });
    const out = await kick('alice@acme.com', { yes: true, json: true });
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
    expect(calls.authenticate).not.toHaveBeenCalled();
    expect(calls.kickMember).not.toHaveBeenCalled();
  });

  test('several organizations and none chosen: ORG_SELECTION_REQUIRED (exit 3), no prompt', async () => {
    const calls = fakeWorld({ orgs: [ORG, OTHER_ORG] });
    const out = await kick('alice@acme.com', { yes: true, json: true });
    expect(out.exitCode).toBe(3);
    expect(out.json).toMatchObject({ ok: false, code: 'ORG_SELECTION_REQUIRED', orgs: [ORG, OTHER_ORG] });
    expect(calls.kickMember).not.toHaveBeenCalled();
  });
});

describe('capy kick in a terminal', () => {
  const setTTY = (value: boolean) => Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  afterEach(() => setTTY(false));

  test('--yes skips the question and prints the usual human lines', async () => {
    setTTY(true);
    const calls = fakeWorld();
    const out = await kick('alice@acme.com', { yes: true });
    expect(calls.kickMember).toHaveBeenCalledWith('org-1', 'mem-alice-2');
    expect(out.json).toBeUndefined();
    expect(out.stdout).toContain('alice@acme.com');
    expect(out.stdout).toContain('has been removed from the organization.');
  });

  test('no member is the old sentence on stderr and exit 1', async () => {
    setTTY(true);
    fakeWorld();
    const out = await kick('nobody@acme.com', {});
    expect(out.exitCode).toBe(1);
    // (With `process.exit` faked to throw, the original code's own catch adds a second line; a real exit never gets there.)
    expect(out.stderr).toContain('No member found matching "nobody@acme.com".');
    expect(out.stdout).toBe('');
  });
});

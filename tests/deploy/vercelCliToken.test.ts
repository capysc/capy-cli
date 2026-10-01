/**
 * Creating the Vercel token from the Vercel CLI's sign-in (`mintTeamToken`).
 *
 * A stub `vercel` program on PATH records every call's argv and answers from
 * canned JSON / exit codes, so the REAL runner (execFile, PATH search, stdout
 * capture) is what runs. The property under test: the token the stub hands
 * back is exactly what reaches `save`, and appears nowhere else — not in any
 * recorded argv, not in a report, not in a refusal.
 */
import { describe, test, expect, mock } from 'bun:test';
import { mintTeamToken, parseExpiryDays, scopesAreExactlyTeam, type MintRequest } from '../../src/deploy/vercelCliToken';
import { ERROR_CODES } from '../../src/types/index';
import { FAKE_BEARER, createdJson, teamsJson, withStubVercel } from '../helpers/stubVercelCli';

const ACME = { id: 'team_acme', slug: 'acme' };
const OTHER = { id: 'team_other', slug: 'other' };

const OK_FILES = { 'teams.json': teamsJson([ACME]), 'create.json': createdJson() } as const;

/** A save target that records what it was given in a `mock` (never in an array of the test's own). */
function savingTarget() {
  const save = mock(async (_value: string) => {});
  return { save, prepare: async () => ({ ok: true as const, save, replacedExisting: false }) };
}

function request(over: Partial<MintRequest> = {}): MintRequest {
  return { pickTeam: null, prepare: savingTarget().prepare, askSignOut: null, ...over };
}

const verbs = (calls: readonly (readonly string[])[]): readonly string[] => calls.map((c) => (c[0] === 'api' ? `api ${c[1].split('?')[0]}` : c.slice(0, 2).join(' ')));

describe('mintTeamToken — happy path', () => {
  test('saves exactly the stub bearer; the value is in no argv and no report', async () => {
    await withStubVercel(OK_FILES, async (stub) => {
      const target = savingTarget();
      const out = await mintTeamToken({ env: stub.env }, request({ prepare: target.prepare }));
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(target.save.mock.calls).toEqual([[FAKE_BEARER]]);
      expect(out.bearer).toBe(FAKE_BEARER);
      // never on a command line, never in the report
      expect(stub.rawLog()).not.toContain(FAKE_BEARER);
      expect(JSON.stringify(out.report)).not.toContain(FAKE_BEARER);
      expect(out.report).toMatchObject({ name: 'capy-acme-import', id: 'tok_new_1', team: ACME, secretName: '_CONNECTOR_VERCEL_TOKEN', replacedExisting: false });
      expect(verbs(stub.calls())).toEqual(['whoami', 'api /v2/teams', 'api /v3/user/tokens']);
    });
  });

  test('the create call is `api /v3/user/tokens -X POST -f name=… --scope <slug>`, with no expiry by default', async () => {
    await withStubVercel(OK_FILES, async (stub) => {
      await mintTeamToken({ env: stub.env }, request());
      const create = stub.calls().find((c) => c[1] === '/v3/user/tokens');
      expect(create).toEqual(['api', '/v3/user/tokens', '-X', 'POST', '-f', 'name=capy-acme-import', '--scope', 'acme']);
    });
  });

  test('--token-expires-days becomes expiresAt in milliseconds', async () => {
    await withStubVercel(OK_FILES, async (stub) => {
      const out = await mintTeamToken({ env: stub.env, now: () => 1_000_000 }, request({ expiresDays: 2 }));
      const create = stub.calls().find((c) => c[1] === '/v3/user/tokens');
      expect(create).toContain('-F');
      expect(create).toContain(`expiresAt=${1_000_000 + 2 * 86_400_000}`);
      expect(out.ok && out.report.expiresAt).toBe(new Date(1_000_000 + 2 * 86_400_000).toISOString());
    });
  });

  test('replacedExisting is reported from the store step', async () => {
    await withStubVercel(OK_FILES, async (stub) => {
      const out = await mintTeamToken({ env: stub.env }, request({ prepare: async () => ({ ok: true, save: async () => {}, replacedExisting: true }) }));
      expect(out.ok && out.report.replacedExisting).toBe(true);
    });
  });
});

describe('mintTeamToken — which team', () => {
  const several = { 'teams.json': teamsJson([ACME, OTHER]), 'create.json': createdJson() };

  test('--team <slug> and --team <id> both pick that team', async () => {
    await withStubVercel(several, async (stub) => {
      const bySlug = await mintTeamToken({ env: stub.env }, request({ team: 'acme' }));
      expect(bySlug.ok && bySlug.report.team).toEqual(ACME);
      const byId = await mintTeamToken({ env: stub.env }, request({ team: 'team_acme' }));
      expect(byId.ok && byId.report.team).toEqual(ACME);
    });
  });

  test('several teams and nobody to ask: VERCEL_TEAM_REQUIRED, nothing created, nothing saved', async () => {
    await withStubVercel(several, async (stub) => {
      const target = savingTarget();
      const out = await mintTeamToken({ env: stub.env }, request({ prepare: target.prepare }));
      expect(out).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TEAM_REQUIRED });
      expect(target.save.mock.calls.length).toBe(0);
      expect(stub.calls().some((c) => c[1] === '/v3/user/tokens')).toBe(false);
    });
  });

  test('several teams and a pick: the picked one', async () => {
    await withStubVercel({ 'teams.json': teamsJson([ACME, OTHER]), 'create.json': createdJson({ scopes: [{ type: 'team', teamId: 'team_other' }] }) }, async (stub) => {
      const out = await mintTeamToken({ env: stub.env }, request({ pickTeam: async () => 'team_other' }));
      expect(out.ok && out.report.team).toEqual(OTHER);
    });
  });

  test('an unknown --team: VERCEL_TEAM_NOT_FOUND; no teams at all: VERCEL_TEAM_REQUIRED', async () => {
    await withStubVercel(OK_FILES, async (stub) => {
      expect(await mintTeamToken({ env: stub.env }, request({ team: 'nope' }))).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TEAM_NOT_FOUND });
    });
    await withStubVercel({ 'teams.json': teamsJson([]), 'create.json': createdJson() }, async (stub) => {
      expect(await mintTeamToken({ env: stub.env }, request({}))).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TEAM_REQUIRED });
    });
  });
});

describe('mintTeamToken — the Vercel CLI', () => {
  test('binary missing: VERCEL_CLI_MISSING with an install link; nothing ran', async () => {
    const out = await mintTeamToken({ env: { PATH: '/nonexistent-dir-for-test' } }, request());
    expect(out).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_CLI_MISSING });
    expect(out.ok === false && out.link?.url).toBe('https://vercel.com/docs/cli');
  });

  test('not signed in (whoami exits non-zero): VERCEL_CLI_NOT_SIGNED_IN; no team list, no create', async () => {
    await withStubVercel({ ...OK_FILES, 'whoami.exit': '1' }, async (stub) => {
      const out = await mintTeamToken({ env: stub.env }, request());
      expect(out).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_CLI_NOT_SIGNED_IN });
      expect(verbs(stub.calls())).toEqual(['whoami']);
    });
  });

  test('VERCEL_TOKEN in the caller environment is not passed to the CLI (the sign-in is the only identity)', async () => {
    await withStubVercel(OK_FILES, async (stub) => {
      const out = await mintTeamToken({ env: { ...stub.env, VERCEL_TOKEN: 'vcp_ENV_TOKEN_SENTINEL' } }, request());
      expect(out.ok).toBe(true);
      expect(stub.tokenEnvSeen().length).toBeGreaterThan(0);
      expect(stub.tokenEnvSeen().every((l) => l === '[]')).toBe(true);
    });
  });

  test('the CLI refusing to create (non-zero exit): VERCEL_TOKEN_CREATE_FAILED with the token page', async () => {
    await withStubVercel({ ...OK_FILES, 'create.exit': '1' }, async (stub) => {
      const target = savingTarget();
      const out = await mintTeamToken({ env: stub.env }, request({ prepare: target.prepare }));
      expect(out).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_CREATE_FAILED });
      expect(out.ok === false && out.link?.url).toBe('https://vercel.com/account/settings/tokens');
      expect(target.save.mock.calls.length).toBe(0);
    });
  });
});

describe('mintTeamToken — the new token must be scoped to exactly the chosen team', () => {
  const bad: ReadonlyArray<[string, readonly unknown[]]> = [
    ['a user scope', [{ type: 'user' }]],
    ['another team', [{ type: 'team', teamId: 'team_other' }]],
    ['extra scopes', [{ type: 'team', teamId: 'team_acme' }, { type: 'team', teamId: 'team_other' }]],
    ['no scopes', []],
  ];

  for (const [label, scopes] of bad) {
    test(`${label}: the token is deleted at once and VERCEL_TOKEN_SCOPE_UNEXPECTED is returned; nothing saved`, async () => {
      await withStubVercel({ 'teams.json': teamsJson([ACME]), 'create.json': createdJson({ scopes }) }, async (stub) => {
        const target = savingTarget();
        const out = await mintTeamToken({ env: stub.env }, request({ prepare: target.prepare }));
        expect(out).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_SCOPE_UNEXPECTED });
        expect(target.save.mock.calls.length).toBe(0);
        expect(stub.calls().filter((c) => c[0] === 'tokens')).toEqual([['tokens', 'rm', 'tok_new_1']]);
        expect(JSON.stringify(out)).not.toContain(FAKE_BEARER);
      });
    });
  }

  test('scope check and delete both fail: VERCEL_TOKEN_CLEANUP_FAILED names the id, never the value', async () => {
    await withStubVercel({ 'teams.json': teamsJson([ACME]), 'create.json': createdJson({ scopes: [{ type: 'user' }] }), 'rm.exit': '1' }, async (stub) => {
      const out = await mintTeamToken({ env: stub.env }, request());
      expect(out).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_CLEANUP_FAILED, tokenId: 'tok_new_1' });
      expect(JSON.stringify(out)).toContain('tok_new_1');
      expect(JSON.stringify(out)).not.toContain(FAKE_BEARER);
    });
  });

  test('scopesAreExactlyTeam: exactly one team scope for that team and nothing else', () => {
    expect(scopesAreExactlyTeam([{ type: 'team', teamId: 'team_acme' }], 'team_acme')).toBe(true);
    expect(scopesAreExactlyTeam([{ type: 'user' }], 'team_acme')).toBe(false);
    expect(scopesAreExactlyTeam([], 'team_acme')).toBe(false);
  });
});

describe('mintTeamToken — saving', () => {
  test('save fails: the token is deleted and the STORE\'s code is returned', async () => {
    await withStubVercel(OK_FILES, async (stub) => {
      const failing = request({
        prepare: async () => ({
          ok: true,
          save: async () => {
            throw Object.assign(new Error('boom'), { code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY });
          },
          replacedExisting: false,
        }),
      });
      const out = await mintTeamToken({ env: stub.env }, failing);
      expect(out).toMatchObject({ ok: false, code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY });
      expect(stub.calls().filter((c) => c[0] === 'tokens')).toEqual([['tokens', 'rm', 'tok_new_1']]);
      expect(JSON.stringify(out)).not.toContain(FAKE_BEARER);
      expect(JSON.stringify(out)).not.toContain('boom');
    });
  });

  test('save fails and delete fails too: VERCEL_TOKEN_CLEANUP_FAILED with the id', async () => {
    await withStubVercel({ ...OK_FILES, 'rm.exit': '1' }, async (stub) => {
      const failing = request({ prepare: async () => ({ ok: true, save: async () => Promise.reject(new Error('x')), replacedExisting: false }) });
      expect(await mintTeamToken({ env: stub.env }, failing)).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_CLEANUP_FAILED, tokenId: 'tok_new_1' });
    });
  });

  test('the store step refusing (not an admin) happens BEFORE any token is created', async () => {
    await withStubVercel(OK_FILES, async (stub) => {
      const out = await mintTeamToken(
        { env: stub.env },
        request({ prepare: async () => ({ ok: false, code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY, message: 'no' }) }),
      );
      expect(out).toMatchObject({ ok: false, code: ERROR_CODES.SYSTEM_STORE_ADMIN_ONLY });
      expect(stub.calls().some((c) => c[1] === '/v3/user/tokens')).toBe(false);
    });
  });
});

describe('mintTeamToken — signing the Vercel CLI out', () => {
  test('interactive, yes: runs `vercel logout`', async () => {
    await withStubVercel(OK_FILES, async (stub) => {
      const ask = mock(async (_m: string, _d: boolean) => true);
      const out = await mintTeamToken({ env: stub.env }, request({ askSignOut: ask }));
      expect(ask.mock.calls[0][1]).toBe(true); // default yes
      expect(stub.calls().some((c) => c[0] === 'logout')).toBe(true);
      expect(out.ok && out.report.cliSignOut).toBe('done');
      expect(out.ok && out.report.next).toBeUndefined();
    });
  });

  test('interactive, no: does not log out, and reports the next step', async () => {
    await withStubVercel(OK_FILES, async (stub) => {
      const out = await mintTeamToken({ env: stub.env }, request({ askSignOut: async () => false }));
      expect(stub.calls().some((c) => c[0] === 'logout')).toBe(false);
      expect(out.ok && out.report.cliSignOut).toBe('declined');
      expect(out.ok && out.report.next).toBe('vercel logout');
    });
  });

  test('non-interactive: never logs out, only reports the next step', async () => {
    await withStubVercel(OK_FILES, async (stub) => {
      const out = await mintTeamToken({ env: stub.env }, request({ askSignOut: null }));
      expect(stub.calls().some((c) => c[0] === 'logout')).toBe(false);
      expect(out.ok && out.report.cliSignOut).toBe('not_offered');
      expect(out.ok && out.report.next).toBe('vercel logout');
    });
  });
});

describe('parseExpiryDays', () => {
  test('absent is fine; whole days 1..3650 are fine; anything else is VERCEL_TOKEN_EXPIRY_INVALID', () => {
    expect(parseExpiryDays(undefined)).toEqual({ ok: true, days: undefined });
    expect(parseExpiryDays('30')).toEqual({ ok: true, days: 30 });
    for (const bad of ['0', '-1', '1.5', 'abc', '', '99999']) {
      expect(parseExpiryDays(bad)).toMatchObject({ ok: false, code: ERROR_CODES.VERCEL_TOKEN_EXPIRY_INVALID });
    }
  });
});

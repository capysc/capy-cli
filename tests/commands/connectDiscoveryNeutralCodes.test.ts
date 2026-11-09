/**
 * The steps `capy connect <provider> --discover` shares (commands/connectors/discoverySteps.ts) report their refusals
 * with the codes of the provider that runs them.
 *
 * A Vercel run reports the neutral `CONNECTOR_*` codes and never a code or a string that names Dokploy. A Dokploy run
 * reports exactly the `DOKPLOY_*` codes it always has. The same steps run under both tables here, and each table is
 * compared with the full list of what it must say.
 *
 * No `mock.module()`: this file runs in the normal batch.
 */
import { describe, test, expect, mock } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONNECTOR_DISCOVERY_CODES, DOKPLOY_DISCOVERY_CODES, type DiscoveryCodes } from '../../src/commands/connectors/discoveryCodes';
import { buildRealDiscoverySequenceDeps } from '../../src/commands/connectors/discoverySteps';
import { createVercelConnector } from '../../src/commands/connectors/vercel';
import { reportVercelDiscovery } from '../../src/commands/connectors/vercelDiscovery';
import { defaultDiscoveryProjectName, findCandidateReposResult, type DiscoveryContext, type DiscoveryPlanEnv } from '../../src/commands/connectors/dokployDiscovery';
import type { ConnectOpts, ImportOutcome } from '../../src/commands/connectors/registry';
import { FileManager } from '../../src/files/fileManager';
import { wrapAndSaveMasterKey } from '../../src/crypto/keyResolver';
import { commitDiscoveryChanges } from '../../src/git/discoveryCommit';
import { CapyError, ERROR_CODES, type KeepFile } from '../../src/types/index';
import type { VercelFetchLike } from '../../src/deploy/vercelApi';
import { fakeVercelFetch, project, type FakeVercelData, type RawEnv } from '../helpers/fakeVercel';
import { captureConsole, git, initRepo, withExitCodeRestored, withIsolatedGlobalDir, withTempDir } from '../helpers/testSandbox';

const ORG = 'org_codes';
const USER = 'user_codes';
const PROJECT = 'proj_codes';

const mentionsDokploy = (text: string): boolean => /dokploy/i.test(text);
const stringValues = (table: DiscoveryCodes): readonly string[] => Object.values(table).filter((v): v is string => typeof v === 'string');

// ── the tables ──────────────────────────────────────────────────────────────

describe('the code tables', () => {
  test('the neutral table names no provider, and every code in it is in ERROR_CODES', () => {
    const codes = stringValues(CONNECTOR_DISCOVERY_CODES);
    expect(codes).toHaveLength(18);
    expect(codes.filter(mentionsDokploy)).toEqual([]);
    codes.forEach((code) => expect(Object.values(ERROR_CODES)).toContain(code));
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('Dokploy\'s table is exactly the strings its discovery has always reported', () => {
    expect(DOKPLOY_DISCOVERY_CODES).toEqual({
      keepsServiceCode: false,
      pushFailed: 'DOKPLOY_PUSH_FAILED',
      folderNotInitialized: 'DOKPLOY_FOLDER_NOT_INITIALIZED',
      projectLookupFailed: 'DOKPLOY_PROJECT_LOOKUP_FAILED',
      projectNameExists: 'DOKPLOY_PROJECT_NAME_EXISTS',
      projectNotFound: 'DOKPLOY_PROJECT_NOT_FOUND',
      initFailed: 'DOKPLOY_INIT_FAILED',
      projectNameTooLong: 'DOKPLOY_PROJECT_NAME_TOO_LONG',
      keyResolutionFailed: 'DOKPLOY_KEY_RESOLUTION_FAILED',
      folderDirty: 'DOKPLOY_FOLDER_DIRTY',
      branchProtected: 'DOKPLOY_BRANCH_PROTECTED',
      keepMissing: 'DOKPLOY_KEEP_MISSING',
      checkoutFailed: 'DOKPLOY_CHECKOUT_FAILED',
      remoteUnreadable: 'DOKPLOY_REMOTE_UNREADABLE',
      commitWouldMix: 'DOKPLOY_COMMIT_WOULD_MIX',
      commitBranchInvalid: 'DOKPLOY_COMMIT_BRANCH_INVALID',
      commitBranchExists: 'DOKPLOY_COMMIT_BRANCH_EXISTS',
      gitIdentityMissing: 'DOKPLOY_GIT_IDENTITY_MISSING',
      commitFailed: 'DOKPLOY_COMMIT_FAILED',
    });
  });

  test('Vercel\'s discovery modules do not import the Dokploy connector', () => {
    const importLines = (file: string): readonly string[] =>
      readFileSync(join(__dirname, '../../src/commands/connectors', file), 'utf-8')
        .split('\n')
        .filter((l) => /^\s*(import|\}\s*from)\b/.test(l) && /from\s+'/.test(l));
    ['vercel.ts', 'vercelDiscovery.ts'].forEach((file) => {
      expect(importLines(file).filter((l) => /from\s+'\.\/dokploy'/.test(l))).toEqual([]);
    });
  });
});

// ── the shared steps under each table ───────────────────────────────────────

const planEnv = { environmentName: 'preview', serviceId: 'prj_x', serviceName: 'x', serviceKind: 'vercel' } as unknown as DiscoveryPlanEnv;

type ServiceOverrides = Partial<Record<'getDecryptData' | 'listProjects' | 'pushSecrets' | 'coDecrypt', unknown>>;

interface StepWorld {
  readonly root: string;
  readonly ensure: (opts: { interactive: boolean; yes: boolean; snapshot?: { existingProjects: ReadonlyArray<{ id: string; name: string; organization_id: string }>; projectsUnavailable: boolean }; pick?: string; sameRun?: boolean }) => Promise<{ ok: boolean; code?: string }>;
  readonly checkout: () => Promise<{ ok: boolean; code?: string }>;
  readonly importAndPush: (outcome: ImportOutcome) => Promise<{ ok: boolean; code?: string }>;
}

/** A real folder (with or without a keep.lock) and the real step functions for it, under `codes`. */
async function stepWorld(root: string, codes: DiscoveryCodes, opts: { keep: boolean; service?: ServiceOverrides }): Promise<StepWorld> {
  const keyOps = { coDecrypt: async (_o: string, ct: string) => ct, wrapOuterLayer: async (_o: string, pt: string) => pt };
  await wrapAndSaveMasterKey(randomBytes(32), ORG, USER, keyOps);
  const keep: KeepFile = { version: '3.0', org_id: ORG, project_id: PROJECT, project_name: 'widgets', variables: {} };
  if (opts.keep) {
    writeFileSync(join(root, 'keep.lock'), JSON.stringify(keep));
    new FileManager(root).ensureCapyGitignore();
  }
  const serviceClient = {
    listBranches: async () => [],
    listProjects: async () => [],
    coDecrypt: async (_o: string, ct: string) => ({ plaintext: ct }),
    wrapOuterLayer: async (_o: string, pt: string) => ({ ciphertext: pt }),
    createBranch: async (pid: string, name: string) => ({ id: 'b', name, project_id: pid, is_protected: false }),
    getDecryptData: async () => ({ env_content: '', keep_file: '', decrypt_key: '', expires_at: new Date().toISOString() }),
    pushSecrets: async () => ({ keep_hash: 'h'.repeat(16) }),
    ...(opts.service ?? {}),
  };
  const ctx = { orgId: ORG, userId: USER, authService: {}, serviceClient } as unknown as DiscoveryContext;
  const depsFor = (over: { interactive: boolean; yes: boolean; snapshot?: Parameters<StepWorld['ensure']>[0]['snapshot']; pick?: string; sameRun?: boolean }, importFn: (c: never, o: ConnectOpts) => Promise<ImportOutcome>) =>
    buildRealDiscoverySequenceDeps(ctx, importFn as never, {
      noPush: false,
      interactive: over.interactive,
      json: true,
      yes: over.yes,
      importOptsFor: () => ({}),
      codes,
      gate: { json: true, nonTty: true },
      syncFolder: async () => ({ ok: true }),
      askExistingOrNewProject: async () => over.pick ?? '__capy_discovery_new_project__',
      askProjectName: async (name) => name,
      existingProjectsSnapshot: over.snapshot,
      sameRunNameCollisions: new Set(over.sameRun ? [`${root}\u0000`] : []),
    });
  const noImport = async (): Promise<ImportOutcome> => ({ ok: true, source: undefined, imported: [], unchanged: [], skipped: [], warnings: [] }) as unknown as ImportOutcome;
  const codeOf = (r: { ok: boolean; code?: string }) => ({ ok: r.ok, ...(r.ok ? {} : { code: (r as { code: string }).code }) });
  return {
    root,
    ensure: async (o) => codeOf(await depsFor(o, noImport).ensureProject(root, '', undefined)),
    checkout: async () => codeOf(await depsFor({ interactive: false, yes: true }, noImport).checkoutBranch(root, '', PROJECT, 'preview')),
    importAndPush: async (outcome) => {
      const deps = depsFor({ interactive: false, yes: true }, async () => outcome);
      await deps.checkoutBranch(root, '', PROJECT, 'preview');
      return codeOf(await deps.importIntoBranch(root, '', planEnv, false, 'x'));
    },
  };
}

const placeholderOutcome: ImportOutcome = {
  ok: true,
  source: undefined,
  imported: [],
  unchanged: [],
  skipped: [],
  warnings: [],
  placeholders: [{ name: 'HIDDEN', code: 'sensitive_unreadable', provider: 'vercel' }],
} as unknown as ImportOutcome;

/** Every step that can refuse, run once under `codes`, as the code each one reported. */
async function observe(codes: DiscoveryCodes): Promise<Record<string, string | undefined>> {
  const run = <T>(keep: boolean, service: ServiceOverrides | undefined, fn: (w: StepWorld) => Promise<T>): Promise<T> =>
    withTempDir('capy-codes', async (root) => fn(await stepWorld(root, codes, { keep, service })));
  const codeOf = (r: { ok: boolean; code?: string }) => r.code;
  const defaultName = (root: string) => defaultDiscoveryProjectName(root, '', undefined);
  return {
    folderNotInitialized: await run(false, undefined, async (w) => codeOf(await w.ensure({ interactive: false, yes: false }))),
    projectLookupFailed: await run(false, undefined, async (w) =>
      codeOf(await w.ensure({ interactive: false, yes: true, snapshot: { existingProjects: [], projectsUnavailable: true } })),
    ),
    projectNameExists: await run(false, undefined, async (w) =>
      codeOf(
        await w.ensure({
          interactive: false,
          yes: true,
          snapshot: { existingProjects: [{ id: 'p', name: defaultName(w.root), organization_id: ORG }], projectsUnavailable: false },
        }),
      ),
    ),
    projectNameExistsSameRun: await run(false, undefined, async (w) =>
      codeOf(await w.ensure({ interactive: false, yes: true, sameRun: true, snapshot: { existingProjects: [], projectsUnavailable: false } })),
    ),
    projectNotFound: await run(false, { listProjects: async () => [{ id: 'p1', name: 'a', organization_id: ORG }] }, async (w) =>
      codeOf(await w.ensure({ interactive: true, yes: false, pick: 'nope' })),
    ),
    initFailed: await run(false, { listProjects: async () => [{ id: 'p1', name: 'a', organization_id: ORG }], getDecryptData: async () => { throw new Error('refused'); } }, async (w) =>
      codeOf(await w.ensure({ interactive: true, yes: false, pick: 'p1' })),
    ),
    branchProtected: await run(true, { getDecryptData: async () => { throw new CapyError('no', ERROR_CODES.PERMISSION_DENIED, { status: 403 }); } }, async (w) => codeOf(await w.checkout())),
    checkoutFailed: await run(true, { getDecryptData: async () => { throw new Error('boom'); } }, async (w) => codeOf(await w.checkout())),
    keepMissing: await run(false, undefined, async (w) => codeOf(await w.checkout())),
    pushFailed: await run(true, { pushSecrets: async () => { throw new Error('upload refused'); } }, async (w) => codeOf(await w.importAndPush(placeholderOutcome))),
  };
}

const NEUTRAL_EXPECTED = {
  folderNotInitialized: 'CONNECTOR_FOLDER_NOT_INITIALIZED',
  projectLookupFailed: 'CONNECTOR_PROJECT_LOOKUP_FAILED',
  projectNameExists: 'CONNECTOR_PROJECT_NAME_EXISTS',
  projectNameExistsSameRun: 'CONNECTOR_PROJECT_NAME_EXISTS',
  projectNotFound: 'CONNECTOR_PROJECT_NOT_FOUND',
  initFailed: 'CONNECTOR_INIT_FAILED',
  branchProtected: 'CONNECTOR_BRANCH_PROTECTED',
  checkoutFailed: 'CONNECTOR_CHECKOUT_FAILED',
  keepMissing: 'CONNECTOR_KEEP_MISSING',
  pushFailed: 'CONNECTOR_PUSH_FAILED',
};

const DOKPLOY_EXPECTED = {
  folderNotInitialized: 'DOKPLOY_FOLDER_NOT_INITIALIZED',
  projectLookupFailed: 'DOKPLOY_PROJECT_LOOKUP_FAILED',
  projectNameExists: 'DOKPLOY_PROJECT_NAME_EXISTS',
  projectNameExistsSameRun: 'DOKPLOY_PROJECT_NAME_EXISTS',
  projectNotFound: 'DOKPLOY_PROJECT_NOT_FOUND',
  initFailed: 'DOKPLOY_INIT_FAILED',
  branchProtected: 'DOKPLOY_BRANCH_PROTECTED',
  checkoutFailed: 'DOKPLOY_CHECKOUT_FAILED',
  keepMissing: 'DOKPLOY_KEEP_MISSING',
  pushFailed: 'DOKPLOY_PUSH_FAILED',
};

describe('the shared steps, run under each provider\'s table', () => {
  test('neutral table: every refusal is the CONNECTOR_* code, and none names Dokploy', async () => {
    await withIsolatedGlobalDir(async () => {
      const seen = await observe(CONNECTOR_DISCOVERY_CODES);
      expect(seen).toEqual(NEUTRAL_EXPECTED as never);
      Object.values(seen).forEach((code) => expect(mentionsDokploy(String(code))).toBe(false));
    });
  }, 60_000);

  test('Dokploy table: every refusal is exactly the DOKPLOY_* code it has always been (output unchanged)', async () => {
    await withIsolatedGlobalDir(async () => {
      expect(await observe(DOKPLOY_DISCOVERY_CODES)).toEqual(DOKPLOY_EXPECTED as never);
    });
  }, 60_000);
});

describe('repo scan and discovery commit', () => {
  test('a repo git cannot read is CONNECTOR_REMOTE_UNREADABLE for Vercel; DOKPLOY_REMOTE_UNREADABLE by default and for Dokploy', async () => {
    await withTempDir('capy-unreadable', async (root) => {
      mkdirSync(join(root, '.git'), { recursive: true }); // a .git that is not a repository
      expect(findCandidateReposResult(root, CONNECTOR_DISCOVERY_CODES).unreadable.map((u) => u.code)).toEqual(['CONNECTOR_REMOTE_UNREADABLE']);
      expect(findCandidateReposResult(root, DOKPLOY_DISCOVERY_CODES).unreadable.map((u) => u.code)).toEqual(['DOKPLOY_REMOTE_UNREADABLE']);
      expect(findCandidateReposResult(root).unreadable.map((u) => u.code)).toEqual(['DOKPLOY_REMOTE_UNREADABLE']);
    });
  });

  test('the commit refusals: neutral for Vercel, Dokploy\'s by default and when asked', async () => {
    await withTempDir('capy-commit-codes', async (root) => {
      initRepo(root);
      const refusal = (codes: DiscoveryCodes | undefined, over: { branchName?: string; before?: ReadonlySet<string> }) =>
        commitDiscoveryChanges(root, ['keep.lock'], over.before ?? new Set(), {
          branchName: over.branchName ?? 'capy/x',
          dryRun: false,
          summaryLines: [],
          ...(codes ? { codes } : {}),
        });
      const codeOf = (r: ReturnType<typeof refusal>) => (r.ok ? 'ok' : r.code);

      expect(codeOf(refusal(CONNECTOR_DISCOVERY_CODES, { before: new Set(['keep.lock']) }))).toBe('CONNECTOR_COMMIT_WOULD_MIX');
      expect(codeOf(refusal(CONNECTOR_DISCOVERY_CODES, { branchName: 'bad name' }))).toBe('CONNECTOR_COMMIT_BRANCH_INVALID');
      git(root, ['branch', 'taken']);
      expect(codeOf(refusal(CONNECTOR_DISCOVERY_CODES, { branchName: 'taken' }))).toBe('CONNECTOR_COMMIT_BRANCH_EXISTS');

      expect(codeOf(refusal(undefined, { before: new Set(['keep.lock']) }))).toBe('DOKPLOY_COMMIT_WOULD_MIX');
      expect(codeOf(refusal(DOKPLOY_DISCOVERY_CODES, { branchName: 'bad name' }))).toBe('DOKPLOY_COMMIT_BRANCH_INVALID');
      expect(codeOf(refusal(undefined, { branchName: 'taken' }))).toBe('DOKPLOY_COMMIT_BRANCH_EXISTS');
    });
  });
});

// ── a Vercel run, end to end ─────────────────────────────────────────────────

const e = (over: Partial<RawEnv> & { id: string; key: string; type: string }): RawEnv => ({ target: ['production'], ...over });

const vercelData = (): FakeVercelData => ({
  teams: [{ id: 'team_acme', slug: 'acme' }],
  projects: { team_acme: [project('prj_web', 'web')] },
  envs: { prj_web: [e({ id: 'p1', key: 'A', type: 'plain', listValue: 'a-value-SENT-11aa' })] },
  custom: {},
  values: {},
});

describe('a Vercel run whose upload fails', () => {
  /** A repo with a committed keep.lock, a Vercel connector over a fake Vercel, and a service whose upload fails with `uploadError`. */
  const runWithUploadError = (uploadError: unknown) =>
    withIsolatedGlobalDir(() =>
      withExitCodeRestored(() =>
        withTempDir('capy-vercel-push-fail', async (root) => {
          initRepo(root, 'git@github.com:acme/widgets.git');
          const keyOps = { coDecrypt: async (_o: string, ct: string) => ct, wrapOuterLayer: async (_o: string, pt: string) => pt };
          await wrapAndSaveMasterKey(randomBytes(32), ORG, USER, keyOps);
          const keep: KeepFile = { version: '3.0', org_id: ORG, project_id: PROJECT, project_name: 'widgets', variables: {} };
          writeFileSync(join(root, 'keep.lock'), JSON.stringify(keep));
          new FileManager(root).ensureCapyGitignore();
          git(root, ['add', 'keep.lock', '.gitignore']);
          git(root, ['commit', '-q', '-m', 'add keep.lock']);

          const ctx = {
            orgId: ORG,
            userId: USER,
            authService: {},
            serviceClient: {
              listBranches: async () => [],
              listProjects: async () => [],
              coDecrypt: async (_o: string, ct: string) => ({ plaintext: ct }),
              wrapOuterLayer: async (_o: string, pt: string) => ({ ciphertext: pt }),
              createBranch: async (pid: string, name: string) => ({ id: 'b', name, project_id: pid, is_protected: false }),
              getDecryptData: async () => ({ env_content: '', keep_file: '', decrypt_key: '', expires_at: new Date().toISOString() }),
              pushSecrets: mock(async () => {
                throw uploadError;
              }),
            },
          } as unknown as DiscoveryContext;
          const connector = createVercelConnector({
            fetch: fakeVercelFetch(vercelData()) as unknown as VercelFetchLike,
            env: { T: 'tok_fake' },
            cwd: root,
            sleep: async () => {},
            syncFolder: async () => ({ ok: true }),
          });
          const run = await captureConsole(async () => {
            const outcome = await connector.discover!(ctx, { nonTty: true, tokenEnv: 'T', yes: true, json: true } as ConnectOpts);
            if (outcome.ok) await reportVercelDiscovery(outcome, { nonTty: true, tokenEnv: 'T', yes: true, json: true } as ConnectOpts, 'vercel');
            return outcome;
          });
          return { outcome: run.result, printed: [...run.stdout, ...run.stderr].join('\n') };
        }),
      ),
    );

  const failedFolder = (outcome: Awaited<ReturnType<typeof runWithUploadError>>['outcome']) => {
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    const folder = outcome.applied?.[0];
    expect(folder?.ok).toBe(false);
    if (folder?.ok !== false) throw new Error('unreachable');
    return folder;
  };

  test('the incident: the service\'s "keep_file and env_blob are required" 400 reports CONNECTOR_PUSH_FAILED, never a code that names Dokploy', async () => {
    const { outcome, printed } = await runWithUploadError(new CapyError('keep_file and env_blob are required', ERROR_CODES.SERVICE_ERROR, { status: 400 }));
    const folder = failedFolder(outcome);
    expect(folder.code).toBe('CONNECTOR_PUSH_FAILED');
    expect(folder.message).toBe('keep_file and env_blob are required');
    expect(mentionsDokploy(JSON.stringify(outcome))).toBe(false);
    expect(mentionsDokploy(printed)).toBe(false);
    expect(printed).toContain('CONNECTOR_PUSH_FAILED');
  }, 30_000);

  test('an untyped failure is CONNECTOR_PUSH_FAILED too', async () => {
    const { outcome, printed } = await runWithUploadError(new Error('socket hang up'));
    expect(failedFolder(outcome).code).toBe('CONNECTOR_PUSH_FAILED');
    expect(mentionsDokploy(printed)).toBe(false);
  }, 30_000);

  test('a typed error from the service keeps its own code through the re-wrap (decided on the code, not the message)', async () => {
    const { outcome, printed } = await runWithUploadError(new CapyError('Members cannot write to protected branches', ERROR_CODES.PERMISSION_DENIED, { status: 403 }));
    const folder = failedFolder(outcome);
    expect(folder.code).toBe(ERROR_CODES.PERMISSION_DENIED);
    expect(mentionsDokploy(printed)).toBe(false);
  }, 30_000);

});

describe('Dokploy keeps its code for a typed service error (its output does not change)', () => {
  test('a typed PERMISSION_DENIED on the upload is still DOKPLOY_PUSH_FAILED', async () => {
    await withIsolatedGlobalDir(async () => {
      const seen = await withTempDir('capy-dokploy-push', async (root) => {
        const w = await stepWorld(root, DOKPLOY_DISCOVERY_CODES, {
          keep: true,
          service: { pushSecrets: async () => { throw new CapyError('no', ERROR_CODES.PERMISSION_DENIED, { status: 403 }); } },
        });
        return w.importAndPush(placeholderOutcome);
      });
      expect(seen).toEqual({ ok: false, code: 'DOKPLOY_PUSH_FAILED' });
    });
  }, 30_000);
});

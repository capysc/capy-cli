/**
 * `capy connect vercel --discover` on a Vercel environment that leaves its Capy branch with no value.
 *
 * Two shapes, both of which used to upload an empty `env_blob` and be refused by the service (400
 * "keep_file and env_blob are required"):
 *   - a placeholder-only branch: every name in the environment is one Vercel will not return (sensitive), so keep.lock
 *     gets the placeholders and the blob holds no line;
 *   - an emptied branch: `--overwrite` on a branch that had values, in an environment with nothing readable left.
 *
 * The service here is the in-memory one of tests/helpers/fakeCapyServer.ts, which refuses an empty payload the way the
 * real one does, and keeps what was saved so that a second run pulls it back (checkout of an existing branch).
 *
 * No `mock.module()`: this file runs in the normal batch.
 */
import { describe, test, expect, mock } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVercelConnector } from '../../src/commands/connectors/vercel';
import type { DiscoveryContext, DiscoveryOutcome } from '../../src/commands/connectors/dokployDiscovery';
import type { ConnectOpts } from '../../src/commands/connectors/registry';
import { placeholdersOnBranch } from '../../src/core/placeholder';
import { FileManager } from '../../src/files/fileManager';
import { resolveProjectKey, wrapAndSaveMasterKey } from '../../src/crypto/keyResolver';
import { ProjectManager } from '../../src/core/projectManager';
import { EMPTY_ENV_BLOB } from '../../src/sync/commit';
import type { KeepFile } from '../../src/types/index';
import type { VercelFetchLike } from '../../src/deploy/vercelApi';
import { fakeCapyServer, serverValues } from '../helpers/fakeCapyServer';
import { fakeVercelFetch, project, type FakeVercelData, type RawEnv } from '../helpers/fakeVercel';
import { captureConsole, git, initRepo, withExitCodeRestored, withIsolatedGlobalDir, withTempDir } from '../helpers/testSandbox';

const ORG = 'org_empty';
const USER = 'user_empty';
const PROJECT = 'proj_empty';

const e = (over: Partial<RawEnv> & { id: string; key: string; type: string }): RawEnv => ({ target: ['production'], ...over });

/** staging has B, production has A; `preview` is whatever the test puts there. */
const vercelData = (preview: readonly RawEnv[]): FakeVercelData => ({
  teams: [{ id: 'team_acme', slug: 'acme' }],
  projects: { team_acme: [project('prj_web', 'web')] },
  envs: {
    prj_web: [
      e({ id: 'p1', key: 'A', type: 'plain', listValue: 'a-value-SENT-11aa' }),
      e({ id: 's1', key: 'B', type: 'encrypted', target: [], customEnvironmentIds: ['c_stage'], listValue: 'opaque' }),
      ...preview,
    ],
  },
  custom: { prj_web: [{ id: 'c_stage', slug: 'staging' }] },
  values: { s1: 'b-value-SENT-22bb' },
});

const PLACEHOLDER_PREVIEW = [e({ id: 'h1', key: 'HIDDEN', type: 'sensitive', target: ['preview'] })];
const VALUE_PREVIEW = [e({ id: 'x1', key: 'X', type: 'plain', target: ['preview'], listValue: 'x-value-SENT-33cc' })];
const NOTHING_READABLE_PREVIEW = [e({ id: 'bs1', key: 'BRANCHY', type: 'encrypted', target: ['preview'], gitBranch: 'dev', listValue: 'opaque' })];

type Outcome = DiscoveryOutcome;

/** A repo with a committed keep.lock, and the service the real sequencer talks to; `run` discovers against a given Vercel. */
async function inWorld<T>(
  fn: (w: {
    root: string;
    server: ReturnType<typeof fakeCapyServer>;
    projectKey: string;
    run: (data: FakeVercelData, opts?: Partial<ConnectOpts>) => Promise<Outcome>;
  }) => Promise<T>,
): Promise<T> {
  return withIsolatedGlobalDir(() =>
    withExitCodeRestored(() =>
      withTempDir('capy-vercel-empty', async (root) => {
        initRepo(root, 'git@github.com:acme/widgets.git');
        const keyOps = { coDecrypt: async (_o: string, ct: string) => ct, wrapOuterLayer: async (_o: string, pt: string) => pt };
        await wrapAndSaveMasterKey(randomBytes(32), ORG, USER, keyOps);
        const projectKey = await resolveProjectKey(ORG, PROJECT, USER, keyOps);
        const keep: KeepFile = { version: '3.0', org_id: ORG, project_id: PROJECT, project_name: 'widgets', variables: {} };
        writeFileSync(join(root, 'keep.lock'), JSON.stringify(keep));
        new FileManager(root).ensureCapyGitignore();
        git(root, ['add', 'keep.lock', '.gitignore']);
        git(root, ['commit', '-q', '-m', 'add keep.lock']);

        const server = fakeCapyServer();
        /** Branches the service was asked to create: the record of the mock is the registry. */
        const createBranch = mock(async (pid: string, name: string) => ({ id: 'b', name, project_id: pid, is_protected: false }));
        const discover = async (data: FakeVercelData, opts: Partial<ConnectOpts> = {}): Promise<Outcome> => {
          const ctx = {
            orgId: ORG,
            userId: USER,
            authService: {},
            serviceClient: {
              ...server.client,
              listBranches: async () => [...new Set(createBranch.mock.calls.map(([, name]) => name))].map((name) => ({ name })),
              listProjects: async () => [],
              coDecrypt: async (_o: string, ct: string) => ({ plaintext: ct }),
              wrapOuterLayer: async (_o: string, pt: string) => ({ ciphertext: pt }),
              createBranch,
            },
          } as unknown as DiscoveryContext;
          const connector = createVercelConnector({
            fetch: fakeVercelFetch(data) as unknown as VercelFetchLike,
            env: { T: 'tok_fake' },
            cwd: root,
            sleep: async () => {},
            syncFolder: async () => ({ ok: true }),
          });
          const run = await captureConsole(() => connector.discover!(ctx, { nonTty: true, tokenEnv: 'T', yes: true, ...opts } as ConnectOpts));
          return run.result;
        };
        return fn({ root, server, projectKey, run: discover });
      }),
    ),
  );
}

const appliedFolder = (outcome: Outcome) => {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  const folder = outcome.applied?.[0];
  if (folder === undefined) throw new Error('no folder applied');
  return folder;
};

describe('a placeholder-only branch (every name in the environment is one Vercel will not return)', () => {
  test('the upload is accepted: a non-empty env_blob and a keep_file carrying the placeholder; no value anywhere', async () => {
    await inWorld(async ({ server, projectKey, run }) => {
      const folder = appliedFolder(await run(vercelData(PLACEHOLDER_PREVIEW)));
      expect(folder).toMatchObject({ ok: true });
      if (!folder.ok) return;
      expect(folder.environments.map((env) => env.environmentName)).toEqual(['staging', 'preview', 'production']);

      const preview = folder.environments.find((env) => env.environmentName === 'preview')!;
      expect(preview.outcome.imported).toEqual([]);
      expect(preview.outcome.placeholders).toEqual([{ name: 'HIDDEN', code: 'sensitive_unreadable', provider: 'vercel' }]);

      const pushes = server.accepted().filter((c) => c.branch === 'preview');
      expect(pushes.length).toBeGreaterThan(0);
      pushes.forEach((c) => {
        expect(c.envBlob.length).toBeGreaterThan(0);
        expect(c.keepFile.length).toBeGreaterThan(0);
        expect(() => JSON.parse(c.keepFile)).not.toThrow();
      });
      const lastPreview = pushes[pushes.length - 1];
      expect(lastPreview.envBlob).toBe(EMPTY_ENV_BLOB);
      expect(placeholdersOnBranch(JSON.parse(lastPreview.keepFile) as KeepFile, 'preview').map((p) => p.name)).toEqual(['HIDDEN']);

      expect(serverValues(server.state(), 'preview', projectKey)).toEqual({});
      expect(server.tape.mock.calls.every(([c]) => (c as { envBlob: string }).envBlob.length > 0)).toBe(true);
    });
  }, 60_000);

  test('round-trips: a second run checks the saved branch out (a pull of an empty-env blob) without an error, and the placeholder is still there', async () => {
    await inWorld(async ({ root, server, projectKey, run }) => {
      const first = appliedFolder(await run(vercelData(PLACEHOLDER_PREVIEW)));
      expect(first.ok).toBe(true);

      const second = appliedFolder(await run(vercelData(PLACEHOLDER_PREVIEW)));
      expect(second).toMatchObject({ ok: true });
      if (!second.ok) return;
      const preview = second.environments.find((env) => env.environmentName === 'preview')!;
      expect(preview.branchCreated).toBe(false); // pulled from the server, not made again

      // checking `preview` out again reads its saved blob: the folder holds no variable and the placeholder
      const checkedOut = await run(vercelData(PLACEHOLDER_PREVIEW), { environment: 'preview' });
      expect(appliedFolder(checkedOut)).toMatchObject({ ok: true, activeBranch: 'preview' });
      expect(new FileManager(root).readEncryptedEnvFile(projectKey)).toEqual({});
      expect(placeholdersOnBranch(new ProjectManager(root).readKeepFile(), 'preview').map((p) => p.name)).toEqual(['HIDDEN']);
      expect(serverValues(server.state(), 'preview', projectKey)).toEqual({});
    });
  }, 60_000);
});

describe('an emptied branch (--overwrite on a branch that had values, in an environment with nothing readable left)', () => {
  test('the upload is accepted: a non-empty env_blob, and the branch reads back with no variable', async () => {
    await inWorld(async ({ server, projectKey, run }) => {
      const first = appliedFolder(await run(vercelData(VALUE_PREVIEW)));
      expect(first.ok).toBe(true);
      expect(serverValues(server.state(), 'preview', projectKey)).toEqual({ X: 'x-value-SENT-33cc' });

      const second = appliedFolder(await run(vercelData(NOTHING_READABLE_PREVIEW), { overwrite: true }));
      expect(second).toMatchObject({ ok: true });
      if (!second.ok) return;
      const preview = second.environments.find((env) => env.environmentName === 'preview')!;
      expect(preview.outcome.cleared).toEqual(['X']);

      const lastPreview = server.accepted().filter((c) => c.branch === 'preview').pop()!;
      expect(lastPreview.envBlob).toBe(EMPTY_ENV_BLOB);
      expect(lastPreview.keepFile.length).toBeGreaterThan(0);
      expect(serverValues(server.state(), 'preview', projectKey)).toEqual({});
      expect(server.tape.mock.calls.every(([c]) => (c as { envBlob: string }).envBlob.length > 0)).toBe(true);
    });
  }, 60_000);

  test('round-trips: checking the emptied branch out again pulls an empty env with no error', async () => {
    await inWorld(async ({ root, projectKey, run }) => {
      await run(vercelData(VALUE_PREVIEW));
      await run(vercelData(NOTHING_READABLE_PREVIEW), { overwrite: true });

      const again = appliedFolder(await run(vercelData(NOTHING_READABLE_PREVIEW), { environment: 'preview' }));
      expect(again).toMatchObject({ ok: true, activeBranch: 'preview' });
      expect(new FileManager(root).readEncryptedEnvFile(projectKey)).toEqual({});
    });
  }, 60_000);
});

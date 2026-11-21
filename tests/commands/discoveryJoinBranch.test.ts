/**
 * `capy connect <provider> --discover` joining an EXISTING project in a folder with no keep.lock: the branch comes from
 * the project's own branch list (the step bare `capy` uses, core/joinBranch.ts), never from an assumed name (CAP-857).
 *
 * - a project whose only branch has another name: the person is asked, and that branch is read and written;
 * - several branches: asked, and the pick is the branch;
 * - nobody to answer (`--yes`): refused with NO_ACTIVE_BRANCH and the branch names, nothing read or written;
 * - the caller named the branch: used as given, nobody asked; a name the project lacks is BRANCH_NOT_FOUND with the names;
 * - a project with no branch at all: offers to create the first one, or BRANCH_NOT_FOUND when nobody can be asked.
 *
 * No `mock.module()`: this file runs in the normal batch.
 */
import { describe, test, expect, mock, spyOn } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import inquirer from 'inquirer';
import { CONNECTOR_DISCOVERY_CODES, DOKPLOY_DISCOVERY_CODES, type DiscoveryCodes } from '../../src/commands/connectors/discoveryCodes';
import { buildRealDiscoverySequenceDeps } from '../../src/commands/connectors/discoverySteps';
import { runDiscoverySequence, type DiscoveryContext, type DiscoveryPlanFolder } from '../../src/commands/connectors/dokployDiscovery';
import { discoveryExitCode } from '../../src/commands/connectCommand';
import { wrapAndSaveMasterKey } from '../../src/crypto/keyResolver';
import { ERROR_CODES, CapyError, type Branch } from '../../src/types/index';
import { captureConsole, withIsolatedGlobalDir, withTempDir } from '../helpers/testSandbox';

const ORG = 'org_join';
const USER = 'user_join';
const PROJECT = { id: 'proj_marketing', name: 'marketing', organization_id: ORG };

const branchNamed = (name: string, is_protected = false): Branch => ({ id: `id-${name}`, name, project_id: PROJECT.id, is_protected });
const NO_SNAPSHOT = { env_content: '', keep_file: '', decrypt_key: '', expires_at: new Date().toISOString() };

interface JoinOptions {
  /** A person is at a terminal, so the existing-vs-new picker is asked. */
  readonly interactive?: boolean;
  /** `--yes`: nobody answers. */
  readonly yes?: boolean;
  /** The branch the caller already named. */
  readonly joinBranch?: string;
  readonly codes?: DiscoveryCodes;
}

/** One folder with no keep.lock, joining `PROJECT` whose branches are `branches`; every service call is recorded. */
function joinWorld(root: string, branches: readonly Branch[], over: { createBranch?: () => Promise<unknown> } = {}) {
  const getDecryptData = mock(async (_project: string, _branch: string) => NO_SNAPSHOT);
  const createBranch = mock(over.createBranch ?? (async (pid: string, name: string) => branchNamed(name)));
  const serviceClient = {
    listProjects: async () => [PROJECT],
    listBranches: async () => [...branches],
    coDecrypt: async (_o: string, ct: string) => ({ plaintext: ct }),
    wrapOuterLayer: async (_o: string, pt: string) => ({ ciphertext: pt }),
    getDecryptData,
    createBranch,
  };
  const ctx = { orgId: ORG, userId: USER, authService: {}, serviceClient } as unknown as DiscoveryContext;
  const depsFor = (o: JoinOptions) =>
    buildRealDiscoverySequenceDeps(ctx, (async () => ({ ok: true })) as never, {
      noPush: false,
      interactive: o.interactive ?? true,
      json: true,
      yes: o.yes ?? false,
      importOptsFor: () => ({}),
      codes: o.codes ?? CONNECTOR_DISCOVERY_CODES,
      gate: { json: true, nonTty: true },
      syncFolder: async () => ({ ok: true }),
      askExistingOrNewProject: async () => PROJECT.id,
      askProjectName: async (name) => name,
      sameRunNameCollisions: new Set(),
      joinBranch: o.joinBranch,
    });
  return {
    getDecryptData,
    createBranch,
    depsFor,
    /** `ensureProject` for the folder at `root`, with the person's prompts spied on. */
    ensure: async (o: JoinOptions) => depsFor(o).ensureProject(root, '', undefined),
  };
}

const activeBranchOf = (root: string): string => readFileSync(join(root, '.capy', 'branch'), 'utf-8').trim();
const folderIsUntouched = (root: string): boolean => !existsSync(join(root, 'keep.lock')) && !existsSync(join(root, '.capy')) && !existsSync(join(root, '.env'));

/** A sandboxed global dir with a master key for `ORG`, and an empty folder. */
const inFreshFolder = <T>(fn: (root: string) => Promise<T>): Promise<T> =>
  withIsolatedGlobalDir(() =>
    withTempDir('capy-discover-join', async (root) => {
      await wrapAndSaveMasterKey(randomBytes(32), ORG, USER, {
        coDecrypt: async (_o: string, ct: string) => ct,
        wrapOuterLayer: async (_o: string, pt: string) => pt,
      });
      return fn(root);
    }),
  );

interface PickerQuestion {
  readonly choices: ReadonlyArray<{ readonly value: string }>;
}

/** Runs `fn` with the person's answers to the branch pickers and prompts, and the screen output swallowed. */
async function answering<T>(answers: ReadonlyArray<Record<string, unknown>>, fn: () => Promise<T>) {
  const prompt = answers.reduce((spy, answer) => spy.mockResolvedValueOnce(answer as never), spyOn(inquirer, 'prompt'));
  try {
    const shown = await captureConsole(fn);
    // The questions asked, copied before the spy is restored (restoring clears its calls).
    return { result: shown.result, asked: prompt.mock.calls.map((c) => c[0] as ReadonlyArray<PickerQuestion>), printed: shown.stdout.join('\n') };
  } finally {
    prompt.mockRestore();
  }
}

describe('discovery joins an existing project on one of the project\'s own branches', () => {
  test('a project whose only branch is "prod": the person is asked, and "prod" (not "development") is read and written', async () => {
    await inFreshFolder(async (root) => {
      const world = joinWorld(root, [branchNamed('prod')]);
      const { result, asked } = await answering([{ selected: 'prod' }], () => world.ensure({ interactive: true }));
      expect(result).toEqual({ ok: true, projectId: PROJECT.id, created: false });
      expect(asked).toHaveLength(1);
      expect(asked[0]?.[0]?.choices.map((c) => c.value)).toEqual(['prod']);
      expect(world.getDecryptData.mock.calls.map((c) => c[1])).toEqual(['prod']);
      expect(activeBranchOf(root)).toBe('prod');
      expect(readFileSync(join(root, '.env'), 'utf-8')).not.toContain('development');
      expect(world.createBranch).not.toHaveBeenCalled();
    });
  });

  test('several branches: all are listed, the person\'s pick is the branch', async () => {
    await inFreshFolder(async (root) => {
      const world = joinWorld(root, [branchNamed('prod'), branchNamed('staging'), branchNamed('development')]);
      const { result, asked } = await answering([{ selected: 'staging' }], () => world.ensure({ interactive: true }));
      expect(result).toMatchObject({ ok: true });
      expect(asked).toHaveLength(1);
      expect(asked[0]?.[0]?.choices.map((c) => c.value)).toEqual(['prod', 'staging', 'development']);
      expect(world.getDecryptData.mock.calls.map((c) => c[1])).toEqual(['staging']);
      expect(activeBranchOf(root)).toBe('staging');
    });
  });

  test('nobody to answer (--yes), one branch: NO_ACTIVE_BRANCH naming it, and nothing is asked, read or written', async () => {
    await inFreshFolder(async (root) => {
      const world = joinWorld(root, [branchNamed('prod')]);
      const { result, asked } = await answering([], () => world.ensure({ interactive: true, yes: true }));
      expect(result).toMatchObject({ ok: false, code: ERROR_CODES.NO_ACTIVE_BRANCH, branches: ['prod'] });
      expect(asked).toHaveLength(0);
      expect(world.getDecryptData).not.toHaveBeenCalled();
      expect(folderIsUntouched(root)).toBe(true);
    });
  });

  test('nobody to answer (--yes), several branches: NO_ACTIVE_BRANCH naming every one, under either provider\'s table', async () => {
    await inFreshFolder(async (root) => {
      const world = joinWorld(root, [branchNamed('prod'), branchNamed('development')]);
      const refusals = await answering([], async () =>
        Promise.all([
          world.ensure({ interactive: true, yes: true, codes: CONNECTOR_DISCOVERY_CODES }),
          world.ensure({ interactive: true, yes: true, codes: DOKPLOY_DISCOVERY_CODES }),
        ]),
      );
      refusals.result.forEach((r) => expect(r).toMatchObject({ ok: false, code: ERROR_CODES.NO_ACTIVE_BRANCH, branches: ['prod', 'development'] }));
      expect(world.getDecryptData).not.toHaveBeenCalled();
      expect(folderIsUntouched(root)).toBe(true);
    });
  });

  test('nobody to answer but the caller named the branch: it is used as given and nobody is asked', async () => {
    await inFreshFolder(async (root) => {
      const world = joinWorld(root, [branchNamed('prod'), branchNamed('development')]);
      const { result, asked } = await answering([], () => world.ensure({ interactive: true, yes: true, joinBranch: 'prod' }));
      expect(result).toMatchObject({ ok: true, projectId: PROJECT.id });
      expect(asked).toHaveLength(0);
      expect(world.getDecryptData.mock.calls.map((c) => c[1])).toEqual(['prod']);
      expect(activeBranchOf(root)).toBe('prod');
    });
  });

  test('a named branch the project does not have: BRANCH_NOT_FOUND naming the ones it has, nothing read or written', async () => {
    await inFreshFolder(async (root) => {
      const world = joinWorld(root, [branchNamed('prod')]);
      const { result } = await answering([], () => world.ensure({ interactive: true, yes: true, joinBranch: 'development' }));
      expect(result).toMatchObject({ ok: false, code: ERROR_CODES.BRANCH_NOT_FOUND, branches: ['prod'] });
      expect(world.getDecryptData).not.toHaveBeenCalled();
      expect(folderIsUntouched(root)).toBe(true);
    });
  });

  test('a project with no branches and nobody to answer: BRANCH_NOT_FOUND, no branch is created or assumed', async () => {
    await inFreshFolder(async (root) => {
      const world = joinWorld(root, []);
      const { result, asked } = await answering([], () => world.ensure({ interactive: true, yes: true }));
      expect(result).toMatchObject({ ok: false, code: ERROR_CODES.BRANCH_NOT_FOUND, branches: [] });
      expect(asked).toHaveLength(0);
      expect(world.createBranch).not.toHaveBeenCalled();
      expect(world.getDecryptData).not.toHaveBeenCalled();
      expect(folderIsUntouched(root)).toBe(true);
    });
  });

  test('a project with no branches, at a terminal: the person names the first branch, it is created open to the project, and the join goes on with it', async () => {
    await inFreshFolder(async (root) => {
      const world = joinWorld(root, []);
      const { result } = await answering(
        [{ initialBranchChoice: 'other' }, { branchName: 'prod' }],
        () => world.ensure({ interactive: true }),
      );
      expect(result).toMatchObject({ ok: true });
      expect(world.createBranch.mock.calls).toEqual([[PROJECT.id, 'prod', false]]);
      expect(world.getDecryptData.mock.calls.map((c) => c[1])).toEqual(['prod']);
      expect(activeBranchOf(root)).toBe('prod');
    });
  });

  test('a project with no branches, joined by someone who cannot create one: FIRST_BRANCH_NEEDS_ADMIN, nothing written', async () => {
    await inFreshFolder(async (root) => {
      const world = joinWorld(root, [], { createBranch: async () => { throw new CapyError('denied', ERROR_CODES.PERMISSION_DENIED, { status: 403 }); } });
      const { result } = await answering([{ initialBranchChoice: 'development' }], () => world.ensure({ interactive: true }));
      expect(result).toMatchObject({ ok: false, code: ERROR_CODES.FIRST_BRANCH_NEEDS_ADMIN });
      expect(world.getDecryptData).not.toHaveBeenCalled();
      expect(folderIsUntouched(root)).toBe(true);
    });
  });

  test('a run with no terminal at all never reaches the join: a folder with no keep.lock is still refused as it always was', async () => {
    await inFreshFolder(async (root) => {
      const world = joinWorld(root, [branchNamed('prod')]);
      const { result } = await answering([], () => world.ensure({ interactive: false, yes: false }));
      expect(result).toMatchObject({ ok: false, code: ERROR_CODES.CONNECTOR_FOLDER_NOT_INITIALIZED });
      expect(world.getDecryptData).not.toHaveBeenCalled();
    });
  });
});

describe('the refusal reaches the folder\'s result with the branch names', () => {
  const folder = (root: string): DiscoveryPlanFolder => ({
    repoDir: root,
    folder: '',
    projectName: 'web',
    serviceName: 'web',
    environments: [{ environmentName: 'production', serviceId: 's1', serviceKind: 'vercel', variableCount: 1, skippedCount: 0, rawEnv: null } as never],
    initialized: false,
  });

  test('the folder fails NO_ACTIVE_BRANCH with `branches`, no environment ran, and the exit code is 3 (needs an answer)', async () => {
    await inFreshFolder(async (root) => {
      const world = joinWorld(root, [branchNamed('prod'), branchNamed('staging')]);
      const { result } = await answering([], () => runDiscoverySequence(folder(root), { overwrite: false }, world.depsFor({ interactive: true, yes: true })));
      expect(result).toMatchObject({ ok: false, code: ERROR_CODES.NO_ACTIVE_BRANCH, branches: ['prod', 'staging'], environments: [] });
      expect(discoveryExitCode([result])).toBe(3);
      expect(folderIsUntouched(root)).toBe(true);
    });
  });

  test('a failure with no branch names is still exit code 1', () => {
    expect(discoveryExitCode([{ ok: false }])).toBe(1);
    expect(discoveryExitCode([{ ok: false }, { ok: false, branches: ['prod'] }])).toBe(3);
  });
});

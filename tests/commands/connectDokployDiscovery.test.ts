/**
 * `capy connect dokploy --discover` (CAP-657 follow-up, 2026-09-26 REWRITE).
 *
 * Covers: git remote parsing (SSH + HTTPS), the child-repo scan when `cwd`
 * isn't a repo itself, grouping + the deepest-common-folder computation
 * (the backend-stack example from the spec, exactly), env-name → Capy
 * branch naming, collision handling (interactive asks once per collision;
 * non-TTY refuses `DOKPLOY_MAPPING_COLLISION` with zero writes), an
 * unmatched raw service, the dry-run plan (zero writes anywhere, never
 * prompts, names only), the SEQUENCE runner (`runDiscoverySequence` —
 * init/checkout/import per folder, in order, aborting THAT folder alone on
 * any coded failure), that a real apply never calls `autoCommitKeep`, and
 * that every existing single-service path (`--application`/`--compose`, no
 * `--discover`) is unaffected.
 *
 * REWRITE NOTE: this file previously covered a discovery-owned multi-branch
 * "apply plan" (`applyDiscoveryPlan`/`hasDokployEntry`/inheritance chains).
 * That subsystem was scrapped (three real defects — see `dokployDiscovery.
 * ts`'s own file doc) rather than patched a fourth time. Discovery is now a
 * PLANNER + SEQUENCER that runs the checkout/import primitives directly —
 * it never computes a clear/replace/import plan itself (that is now
 * `--overwrite`'s own job, on the single-service import — see
 * `connectDokploy.test.ts`'s `--overwrite` tests). Every test below that
 * exercised the removed apply engine directly is gone; where the SAME
 * property still needs proving under the new design, it is re-proven here
 * against `runDiscoverySequence`/`connector.discover()` instead.
 *
 * Every network-touching test injects its own `fetch` — no `mock.module()`,
 * so this file runs in `run-tests.sh`'s normal batch, not its isolated list.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { wrapAndSaveMasterKey, resolveProjectKey } from '../../src/crypto/keyResolver';
import { FileManager } from '../../src/files/fileManager';
import { hashValue } from '../../src/commands/statusCommand';
import {
  parseGitRemoteUrl,
  findCandidateRepoDirs,
  findCandidateRepos,
  deepestCommonDir,
  serviceFolder,
  buildDiscoveryPlan,
  resolveCollisions,
  applyCollisionResolutions,
  orderEnvironments,
  runDiscoverySequence,
  runDiscoverySequences,
  defaultDiscoveryProjectName,
  type DiscoveryDokployClient,
  type DiscoverySequenceDeps,
  type DiscoveryPlanEnv,
  type DiscoveryPlanFolder,
} from '../../src/commands/connectors/dokployDiscovery';
import { createDokployConnector, computeOverwritePlan, DISCOVERY_NEW_PROJECT } from '../../src/commands/connectors/dokploy';
import { ConnectCommand } from '../../src/commands/connectCommand';
import type { DiscoveryContext } from '../../src/commands/connectors/dokployDiscovery';
import type { ImportOutcome } from '../../src/commands/connectors/registry';
import type { FetchLike } from '../../src/deploy/dokployApi';
import type { ConnectOpts } from '../../src/commands/connectors/registry';
import type { KeepFile } from '../../src/types/index';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
}

function initRepo(dir: string, remoteUrl?: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  if (remoteUrl) git(dir, ['remote', 'add', 'origin', remoteUrl]);
  writeFileSync(join(dir, 'README.md'), 'x');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

// ── Git remote parsing ───────────────────────────────────────────────────────

describe('parseGitRemoteUrl', () => {
  test('HTTPS form', () => {
    expect(parseGitRemoteUrl('https://github.com/capysc/capy-cli.git')).toEqual({
      host: 'github.com',
      owner: 'capysc',
      repo: 'capy-cli',
    });
  });

  test('HTTPS form without .git', () => {
    expect(parseGitRemoteUrl('https://github.com/capysc/capy-cli')).toEqual({
      host: 'github.com',
      owner: 'capysc',
      repo: 'capy-cli',
    });
  });

  test('SSH shorthand form', () => {
    expect(parseGitRemoteUrl('git@github.com:slidespeak/backend-stack.git')).toEqual({
      host: 'github.com',
      owner: 'slidespeak',
      repo: 'backend-stack',
    });
  });

  test('ssh:// form', () => {
    expect(parseGitRemoteUrl('ssh://git@gitlab.example.com/capysc/capy-cli.git')).toEqual({
      host: 'gitlab.example.com',
      owner: 'capysc',
      repo: 'capy-cli',
    });
  });

  test('is case-insensitive', () => {
    expect(parseGitRemoteUrl('git@GitHub.com:CapySC/Capy-CLI.git')).toEqual({
      host: 'github.com',
      owner: 'capysc',
      repo: 'capy-cli',
    });
  });

  test('unparseable input returns null', () => {
    expect(parseGitRemoteUrl('/local/path/to/repo')).toBeNull();
    expect(parseGitRemoteUrl('')).toBeNull();
  });
});

// ── Repo scanning ────────────────────────────────────────────────────────────

describe('findCandidateRepoDirs / findCandidateRepos', () => {
  test('cwd itself, when it is a repo', () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-selfrepo-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      expect(findCandidateRepoDirs(ROOT)).toEqual([ROOT]);
      const found = findCandidateRepos(ROOT);
      expect(found.length).toBe(1);
      expect(found[0]).toEqual({ repoDir: ROOT, remote: { host: 'github.com', owner: 'acme', repo: 'widgets' } });
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('immediate child repos, when cwd itself is not a repo', () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-children-'));
    try {
      const repoA = join(ROOT, 'repo-a');
      const repoB = join(ROOT, 'repo-b');
      const notARepo = join(ROOT, 'just-a-folder');
      initRepo(repoA, 'git@github.com:acme/repo-a.git');
      initRepo(repoB, 'https://github.com/acme/repo-b.git');
      mkdirSync(notARepo, { recursive: true });

      expect(findCandidateRepoDirs(ROOT).sort()).toEqual([repoA, repoB].sort());
      const found = findCandidateRepos(ROOT);
      expect(found.map((f) => f.remote.repo).sort()).toEqual(['repo-a', 'repo-b']);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('a child repo with no parseable remote is silently excluded from findCandidateRepos', () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-noremote-'));
    try {
      const repoNoRemote = join(ROOT, 'repo-no-remote');
      initRepo(repoNoRemote); // no `origin` added
      expect(findCandidateRepoDirs(ROOT)).toEqual([repoNoRemote]);
      expect(findCandidateRepos(ROOT)).toEqual([]);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

// ── deepestCommonDir / serviceFolder ────────────────────────────────────────

describe('deepestCommonDir + serviceFolder — the backend-stack example', () => {
  test('two compose paths under different sub-environments share the deepest common folder', () => {
    const production = serviceFolder({
      serviceKind: 'compose',
      composePath: 'backend/deployment/production/docker-compose.yml',
    });
    const staging = serviceFolder({
      serviceKind: 'compose',
      composePath: 'backend/deployment/develop/docker-compose.yml',
    });
    expect(production).toBe('backend/deployment/production');
    expect(staging).toBe('backend/deployment/develop');
    expect(deepestCommonDir([production, staging])).toBe('backend/deployment');
  });

  test("a single-environment compose service folders at its own compose file's folder", () => {
    const only = serviceFolder({ serviceKind: 'compose', composePath: 'infra/one-env/docker-compose.yml' });
    expect(deepestCommonDir([only])).toBe('infra/one-env');
  });

  test('an Application (no composePath) folders at the repo root', () => {
    expect(serviceFolder({ serviceKind: 'application' })).toBe('');
    expect(deepestCommonDir([''])).toBe('');
  });

  test('a leading "./" is stripped', () => {
    expect(serviceFolder({ serviceKind: 'compose', composePath: './deploy/docker-compose.yml' })).toBe('deploy');
  });
});

// ── defaultDiscoveryProjectName ──────────────────────────────────────────────

describe('defaultDiscoveryProjectName', () => {
  test('<repo>/<folder> normalized, lowercase, non-alnum collapsed to a dash', () => {
    expect(defaultDiscoveryProjectName('/repos/Backend_Stack', 'backend/Deployment')).toBe(
      'backend-stack-backend-deployment',
    );
  });

  test('repo root: just <repo>, normalized', () => {
    expect(defaultDiscoveryProjectName('/repos/Widgets', '')).toBe('widgets');
  });

  test('a raw name of the reserved word falls back to my-project', () => {
    expect(defaultDiscoveryProjectName('/repos/_system', '')).toBe('my-project');
  });
});

// ── buildDiscoveryPlan: grouping, variable counts, and unmatched services ──

/** A fixture `DokployProjectSummary` tree + matching detail lookups, as a `DiscoveryDokployClient`. */
function fakeDokployClient(fixture: {
  projects: readonly {
    projectId: string;
    name: string;
    environments: readonly {
      environmentId: string;
      name: string;
      applications?: readonly { id: string; name?: string }[];
      composes?: readonly { id: string; name?: string }[];
    }[];
  }[];
  applicationDetails: Record<string, { owner?: string; repository?: string; sourceType?: string; branch?: string; env: string | null }>;
  composeDetails: Record<string, { owner?: string; repository?: string; sourceType?: string; branch?: string; composePath?: string; env: string | null }>;
}): DiscoveryDokployClient & { calls: Array<{ method: string; kind: string; id?: string }> } {
  const calls: Array<{ method: string; kind: string; id?: string }> = [];
  return {
    calls,
    async listProjects() {
      calls.push({ method: 'GET', kind: 'project.all' });
      return fixture.projects.map((p) => ({
        projectId: p.projectId,
        name: p.name,
        environments: p.environments.map((e) => ({
          environmentId: e.environmentId,
          name: e.name,
          applications: (e.applications ?? []).map((a) => ({ id: a.id, kind: 'application' as const, name: a.name })),
          composes: (e.composes ?? []).map((c) => ({ id: c.id, kind: 'compose' as const, name: c.name })),
        })),
      }));
    },
    async getApplication(applicationId: string) {
      calls.push({ method: 'GET', kind: 'application.one', id: applicationId });
      const d = fixture.applicationDetails[applicationId] ?? { env: null };
      return {
        applicationId,
        env: d.env,
        buildArgs: null,
        buildSecrets: null,
        createEnvFile: true,
        owner: d.owner,
        repository: d.repository,
        sourceType: d.sourceType,
        branch: d.branch,
      };
    },
    async getCompose(composeId: string) {
      calls.push({ method: 'GET', kind: 'compose.one', id: composeId });
      const d = fixture.composeDetails[composeId] ?? { env: null };
      return {
        composeId,
        env: d.env,
        createEnvFile: true,
        owner: d.owner,
        repository: d.repository,
        sourceType: d.sourceType,
        branch: d.branch,
        composePath: d.composePath,
      };
    },
  };
}

const noLocalKeep = () => null;
const noServerBranches = async (): Promise<ReadonlyArray<{ name: string }>> => [];
/** No local keep.lock at all — every folder previews `initialized: false`. */
const notInitializedPeek = { peekLocalKeep: noLocalKeep, listServerBranches: noServerBranches };

/** A keep.lock for an ALREADY-initialized folder — enough to preview `initialized: true` and drive `listServerBranches`. */
function fakeKeep(projectId: string): KeepFile {
  return { version: '3.0', org_id: 'o', project_id: projectId, project_name: 'demo', variables: {} };
}

describe('buildDiscoveryPlan', () => {
  const REPO = { repoDir: '/repos/backend-stack', remote: { host: 'github.com', owner: 'slidespeak', repo: 'backend-stack' } };

  test("groups a compose service's two environments into one folder, with variable + skipped counts", async () => {
    const client = fakeDokployClient({
      projects: [
        {
          projectId: 'proj_1',
          name: 'slidespeak',
          environments: [
            { environmentId: 'env_prod', name: 'production', composes: [{ id: 'compose_prod', name: 'backend-stack' }] },
            { environmentId: 'env_staging', name: 'staging', composes: [{ id: 'compose_staging', name: 'backend-stack' }] },
          ],
        },
      ],
      applicationDetails: {},
      composeDetails: {
        compose_prod: {
          owner: 'slidespeak',
          repository: 'backend-stack',
          sourceType: 'github',
          branch: 'main',
          composePath: 'backend/deployment/production/docker-compose.yml',
          env: 'A=1\nREF=${{project.OTHER}}',
        },
        compose_staging: {
          owner: 'slidespeak',
          repository: 'backend-stack',
          sourceType: 'github',
          branch: 'develop',
          composePath: 'backend/deployment/develop/docker-compose.yml',
          env: 'B=2',
        },
      },
    });

    const plan = await buildDiscoveryPlan(client, [REPO], notInitializedPeek);
    expect(plan.folders.length).toBe(1);
    const folder = plan.folders[0];
    expect(folder.repoDir).toBe(REPO.repoDir);
    expect(folder.folder).toBe('backend/deployment');
    expect(folder.projectName).toBe('slidespeak');
    expect(folder.serviceName).toBe('backend-stack');
    expect(folder.initialized).toBe(false);
    expect(folder.environments.map((e) => e.environmentName).sort()).toEqual(['production', 'staging']);
    const prod = folder.environments.find((e) => e.environmentName === 'production')!;
    expect(prod.variableCount).toBe(1); // A=1
    expect(prod.skippedCount).toBe(1); // REF=${{...}}
    expect(prod.gitBranch).toBe('main');
    expect(prod.branchExists).toBeUndefined(); // unknowable — no project exists yet
    const staging = folder.environments.find((e) => e.environmentName === 'staging')!;
    expect(staging.variableCount).toBe(1);
    expect(staging.gitBranch).toBe('develop');
    expect(plan.collisions).toEqual([]);

    // Only GET, only the expected procedures (no applications in this fixture).
    for (const c of client.calls) expect(c.method).toBe('GET');
    expect(client.calls.map((c) => c.kind).sort()).toEqual(['compose.one', 'compose.one', 'project.all'].sort());
  });

  test('an already-initialized folder previews branchExists per environment from listServerBranches', async () => {
    const client = fakeDokployClient({
      projects: [
        {
          projectId: 'proj_1',
          name: 'acme',
          environments: [
            { environmentId: 'env_1', name: 'production', composes: [{ id: 'compose_1', name: 'widgets' }] },
            { environmentId: 'env_2', name: 'staging', composes: [{ id: 'compose_1', name: 'widgets' }] },
          ],
        },
      ],
      applicationDetails: {},
      composeDetails: {
        compose_1: { owner: 'acme', repository: 'widgets', sourceType: 'github', composePath: 'docker-compose.yml', env: 'A=1' },
      },
    });
    const repo = { repoDir: '/repos/widgets', remote: { host: 'github.com', owner: 'acme', repo: 'widgets' } };
    const branchCalls: string[] = [];
    const peek = {
      peekLocalKeep: () => fakeKeep('proj_existing'),
      listServerBranches: async (projectId: string) => {
        branchCalls.push(projectId);
        return [{ name: 'production' }]; // staging does not exist yet on the server
      },
    };
    const plan = await buildDiscoveryPlan(client, [repo], peek);
    expect(branchCalls).toEqual(['proj_existing']); // called once per FOLDER, not per environment
    expect(plan.folders[0].initialized).toBe(true);
    const prod = plan.folders[0].environments.find((e) => e.environmentName === 'production')!;
    const staging = plan.folders[0].environments.find((e) => e.environmentName === 'staging')!;
    expect(prod.branchExists).toBe(true);
    expect(staging.branchExists).toBe(false);
  });

  test('an Application folders at the repo root', async () => {
    const client = fakeDokployClient({
      projects: [
        {
          projectId: 'proj_1',
          name: 'acme',
          environments: [{ environmentId: 'env_1', name: 'production', applications: [{ id: 'app_1', name: 'widgets' }] }],
        },
      ],
      applicationDetails: {
        app_1: { owner: 'acme', repository: 'widgets', sourceType: 'github', branch: 'main', env: 'X=1' },
      },
      composeDetails: {},
    });
    const repo = { repoDir: '/repos/widgets', remote: { host: 'github.com', owner: 'acme', repo: 'widgets' } };
    const plan = await buildDiscoveryPlan(client, [repo], notInitializedPeek);
    expect(plan.folders.length).toBe(1);
    expect(plan.folders[0].folder).toBe('');
  });

  test('a raw-source service (no git source) is reported unmatched, never guessed at', async () => {
    const client = fakeDokployClient({
      projects: [
        {
          projectId: 'proj_1',
          name: 'acme',
          environments: [{ environmentId: 'env_1', name: 'production', composes: [{ id: 'compose_raw', name: 'raw-svc' }] }],
        },
      ],
      applicationDetails: {},
      composeDetails: { compose_raw: { sourceType: 'raw', env: 'X=1' } },
    });
    const plan = await buildDiscoveryPlan(client, [REPO], notInitializedPeek);
    expect(plan.folders).toEqual([]);
    expect(plan.unmatched).toEqual([
      { projectName: 'acme', serviceName: 'raw-svc', serviceKind: 'compose', serviceId: 'compose_raw', reason: 'no_git_source' },
    ]);
  });

  test('a git-source service with no matching local repo is reported unmatched (no_remote_match)', async () => {
    const client = fakeDokployClient({
      projects: [
        {
          projectId: 'proj_1',
          name: 'acme',
          environments: [{ environmentId: 'env_1', name: 'production', composes: [{ id: 'compose_x', name: 'other-svc' }] }],
        },
      ],
      applicationDetails: {},
      composeDetails: {
        compose_x: { owner: 'someone-else', repository: 'unrelated-repo', sourceType: 'github', env: 'X=1' },
      },
    });
    const plan = await buildDiscoveryPlan(client, [REPO], notInitializedPeek);
    expect(plan.folders).toEqual([]);
    expect(plan.unmatched).toEqual([
      { projectName: 'acme', serviceName: 'other-svc', serviceKind: 'compose', serviceId: 'compose_x', reason: 'no_remote_match' },
    ]);
  });

  test('two distinct services landing on the same folder + environment is flagged as a collision', async () => {
    const client = fakeDokployClient({
      projects: [
        {
          projectId: 'proj_1',
          name: 'slidespeak',
          environments: [
            {
              environmentId: 'env_prod',
              name: 'production',
              composes: [
                { id: 'compose_backend', name: 'backend' },
                { id: 'compose_backend_stack', name: 'backend-stack' },
              ],
            },
          ],
        },
      ],
      applicationDetails: {},
      composeDetails: {
        compose_backend: {
          owner: 'slidespeak', repository: 'backend-stack', sourceType: 'github',
          composePath: 'backend/deployment/docker-compose.yml', env: 'A=1',
        },
        compose_backend_stack: {
          owner: 'slidespeak', repository: 'backend-stack', sourceType: 'github',
          composePath: 'backend/deployment/docker-compose.prod.yml', env: 'B=2',
        },
      },
    });
    const plan = await buildDiscoveryPlan(client, [REPO], notInitializedPeek);
    expect(plan.folders.length).toBe(2);
    expect(plan.collisions.length).toBe(1);
    const collision = plan.collisions[0];
    expect(collision.folder).toBe('backend/deployment');
    expect(collision.environmentName).toBe('production');
    expect(collision.candidates.map((c) => c.serviceName).sort()).toEqual(['backend', 'backend-stack']);
  });
});

// ── Collision resolution ─────────────────────────────────────────────────────

describe('resolveCollisions + applyCollisionResolutions', () => {
  const COLLISION = {
    repoDir: '/repos/backend-stack',
    folder: 'backend/deployment',
    environmentName: 'production',
    candidates: [
      { projectName: 'slidespeak', serviceName: 'backend', serviceId: 'compose_a', serviceKind: 'compose' as const },
      { projectName: 'slidespeak', serviceName: 'backend-stack', serviceId: 'compose_b', serviceKind: 'compose' as const },
    ],
  };

  test('a preferred service id (from --application/--compose) wins outright, no ask', async () => {
    const askWinner = async () => {
      throw new Error('should not be asked — a preferred id resolved it');
    };
    const r = await resolveCollisions([COLLISION], { preferredServiceId: 'compose_b', interactive: true, askWinner });
    expect(r).toEqual({ ok: true, resolutions: [{ repoDir: COLLISION.repoDir, folder: COLLISION.folder, environmentName: COLLISION.environmentName, winnerServiceId: 'compose_b' }] });
  });

  test('interactive with no preferred id: asks once per collision', async () => {
    const calls: true[] = [];
    const askWinner = async () => {
      calls.push(true);
      return 'compose_a';
    };
    const r = await resolveCollisions([COLLISION], { interactive: true, askWinner });
    expect(calls.length).toBe(1);
    expect(r).toEqual({ ok: true, resolutions: [{ repoDir: COLLISION.repoDir, folder: COLLISION.folder, environmentName: COLLISION.environmentName, winnerServiceId: 'compose_a' }] });
  });

  test('non-interactive with no preferred id: refuses (ok:false), never asks', async () => {
    const askWinner = async () => {
      throw new Error('must not be called when non-interactive');
    };
    const r = await resolveCollisions([COLLISION], { interactive: false, askWinner });
    expect(r).toEqual({ ok: false });
  });

  test("applyCollisionResolutions keeps the winner's environment and drops the loser's — for THIS cell only", async () => {
    const folders: readonly DiscoveryPlanFolder[] = [
      {
        repoDir: COLLISION.repoDir,
        folder: COLLISION.folder,
        projectName: 'slidespeak',
        serviceName: 'backend',
        initialized: false,
        environments: [
          { environmentName: 'production', serviceId: 'compose_a', serviceKind: 'compose', variableCount: 1, skippedCount: 0, rawEnv: 'A=1' },
        ],
      },
      {
        repoDir: COLLISION.repoDir,
        folder: COLLISION.folder,
        projectName: 'slidespeak',
        serviceName: 'backend-stack',
        initialized: false,
        environments: [
          { environmentName: 'production', serviceId: 'compose_b', serviceKind: 'compose', variableCount: 1, skippedCount: 0, rawEnv: 'B=2' },
          // A non-colliding environment on the LOSING group must survive.
          { environmentName: 'staging', serviceId: 'compose_b', serviceKind: 'compose', variableCount: 1, skippedCount: 0, rawEnv: 'B=2' },
        ],
      },
    ];
    const resolved = applyCollisionResolutions(folders, [
      { repoDir: COLLISION.repoDir, folder: COLLISION.folder, environmentName: 'production', winnerServiceId: 'compose_a' },
    ]);
    const winnerFolder = resolved.find((f) => f.serviceName === 'backend');
    expect(winnerFolder?.environments.map((e) => e.environmentName)).toEqual(['production']);
    const loserFolder = resolved.find((f) => f.serviceName === 'backend-stack');
    expect(loserFolder?.environments.map((e) => e.environmentName)).toEqual(['staging']);
  });
});

// ── orderEnvironments: production first, then alphabetical ─────────────────

describe('orderEnvironments', () => {
  test('production always first, everything else alphabetical, regardless of input order', () => {
    const names = ['zeta', 'staging', 'production', 'alpha'].map((environmentName) => ({ environmentName }));
    expect(orderEnvironments(names).map((e) => e.environmentName)).toEqual(['production', 'alpha', 'staging', 'zeta']);
  });

  test('no production present: everything alphabetical', () => {
    const names = ['zeta', 'alpha'].map((environmentName) => ({ environmentName }));
    expect(orderEnvironments(names).map((e) => e.environmentName)).toEqual(['alpha', 'zeta']);
  });
});

// ── computeOverwritePlan (pure) ──────────────────────────────────────────────

describe('computeOverwritePlan', () => {
  test('categorizes clear / replace / import / unchanged correctly', () => {
    const plan = computeOverwritePlan(
      [
        { name: 'SAME', value: '1' },
        { name: 'CHANGED', value: 'dokploy-value' },
        { name: 'NEW', value: 'v' },
      ],
      [],
      { SAME: '1', CHANGED: 'local-value', LOCAL_ONLY: 'x' },
    );
    expect(plan.unchanged).toEqual(['SAME']);
    expect(plan.toReplace).toEqual([{ name: 'CHANGED', value: 'dokploy-value' }]);
    expect(plan.toImport).toEqual([{ name: 'NEW', value: 'v' }]);
    expect(plan.toClear).toEqual(['LOCAL_ONLY']);
  });

  test('a reference-valued name is never cleared, even though it is absent from the candidate set', () => {
    const plan = computeOverwritePlan([{ name: 'PLAIN', value: '1' }], ['REF_VAR'], { PLAIN: '1', REF_VAR: 'old-value', GONE: 'x' });
    expect(plan.toClear).toEqual(['GONE']);
    expect(plan.toClear).not.toContain('REF_VAR');
  });
});

// ── runDiscoverySequence: init → checkout → import, per folder ─────────────

function samplePlanEnv(overrides: Partial<DiscoveryPlanEnv> = {}): DiscoveryPlanEnv {
  return {
    environmentName: 'production',
    serviceId: 'compose_1',
    serviceKind: 'compose',
    variableCount: 1,
    skippedCount: 0,
    rawEnv: 'A=1',
    ...overrides,
  };
}

function samplePlanFolder(overrides: Partial<DiscoveryPlanFolder> = {}): DiscoveryPlanFolder {
  return {
    repoDir: '/repos/widgets',
    folder: '',
    projectName: 'acme',
    serviceName: 'widgets',
    initialized: true,
    environments: [samplePlanEnv()],
    ...overrides,
  };
}

const okImport = (names: readonly string[]): Extract<ImportOutcome, { ok: true }> => ({
  ok: true,
  imported: names.map((n) => ({ varName: n, value: 'v', entry: { provider: 'dokploy', source: 'import', created_at: 1, fingerprint: 'x' } })),
  unchanged: [],
  skipped: [],
  warnings: [],
  deployTargetSaved: false,
});

describe('runDiscoverySequence', () => {
  test('ensureProject runs ONCE, then checkout + import run per environment, production first then alphabetical', async () => {
    const calls: string[] = [];
    const folder = samplePlanFolder({
      environments: [
        samplePlanEnv({ environmentName: 'zeta' }),
        samplePlanEnv({ environmentName: 'production' }),
        samplePlanEnv({ environmentName: 'alpha' }),
      ],
    });
    const deps: DiscoverySequenceDeps = {
      ensureProject: async () => {
        calls.push('ensureProject');
        return { ok: true, projectId: 'proj_1', created: false };
      },
      checkFolderDirty: async () => {
        calls.push('checkFolderDirty');
        return { ok: true };
      },
      checkoutBranch: async (_r, _f, _p, branchName) => {
        calls.push(`checkout:${branchName}`);
        return { ok: true, created: false };
      },
      importIntoBranch: async (_r, _f, env) => {
        calls.push(`import:${env.environmentName}`);
        return okImport(['A']);
      },
    };
    const result = await runDiscoverySequence(folder, { overwrite: false }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual([
      'ensureProject',
      'checkFolderDirty',
      'checkout:production',
      'import:production',
      'checkout:alpha',
      'import:alpha',
      'checkout:zeta',
      'import:zeta',
    ]);
    expect(result.activeBranch).toBe('zeta'); // the last step actually run
    expect(result.environments.map((e) => e.environmentName)).toEqual(['production', 'alpha', 'zeta']);
  });

  test('ensureProject refusing aborts the folder before any checkout/import runs', async () => {
    const calls: string[] = [];
    const deps: DiscoverySequenceDeps = {
      ensureProject: async () => ({ ok: false, code: 'DOKPLOY_FOLDER_NOT_INITIALIZED', message: 'no keep.lock' }),
      checkFolderDirty: async () => {
        calls.push('checkFolderDirty');
        return { ok: true };
      },
      checkoutBranch: async () => {
        calls.push('checkout');
        return { ok: true, created: false };
      },
      importIntoBranch: async () => {
        calls.push('import');
        return okImport([]);
      },
    };
    const result = await runDiscoverySequence(samplePlanFolder(), { overwrite: false }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DOKPLOY_FOLDER_NOT_INITIALIZED');
    expect(result.environments).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('a checkout failure on environment 2 aborts the REST of the folder — environment 1 still reports', async () => {
    const importCalls: string[] = [];
    const folder = samplePlanFolder({
      environments: [samplePlanEnv({ environmentName: 'production' }), samplePlanEnv({ environmentName: 'staging' })],
    });
    const deps: DiscoverySequenceDeps = {
      ensureProject: async () => ({ ok: true, projectId: 'proj_1', created: false }),
      checkFolderDirty: async () => ({ ok: true }),
      checkoutBranch: async (_r, _f, _p, branchName) => {
        if (branchName === 'staging') return { ok: false, code: 'DOKPLOY_CHECKOUT_FAILED', message: 'boom' };
        return { ok: true, created: false };
      },
      importIntoBranch: async (_r, _f, env) => {
        importCalls.push(env.environmentName);
        return okImport(['A']);
      },
    };
    const result = await runDiscoverySequence(folder, { overwrite: false }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DOKPLOY_CHECKOUT_FAILED');
    expect(result.environments.map((e) => e.environmentName)).toEqual(['production']); // only the completed one
    expect(importCalls).toEqual(['production']); // staging's import never ran
  });

  test('a service-read error from importIntoBranch aborts the folder with no push attempted for that step', async () => {
    const folder = samplePlanFolder({
      environments: [samplePlanEnv({ environmentName: 'production' })],
    });
    const deps: DiscoverySequenceDeps = {
      ensureProject: async () => ({ ok: true, projectId: 'proj_1', created: false }),
      checkFolderDirty: async () => ({ ok: true }),
      checkoutBranch: async () => ({ ok: true, created: false }),
      importIntoBranch: async () => ({ ok: false, code: 'DOKPLOY_APP_NOT_FOUND', message: 'no such compose service' }),
    };
    const result = await runDiscoverySequence(folder, { overwrite: false }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DOKPLOY_APP_NOT_FOUND');
    expect(result.environments).toEqual([]);
  });

  test('a dirty folder (checkFolderDirty refuses) aborts with zero checkout/import calls (defect fix)', async () => {
    const calls: string[] = [];
    const deps: DiscoverySequenceDeps = {
      ensureProject: async () => ({ ok: true, projectId: 'proj_1', created: false }),
      checkFolderDirty: async () => ({ ok: false, code: 'DOKPLOY_FOLDER_DIRTY', message: 'unpushed changes' }),
      checkoutBranch: async () => {
        calls.push('checkout');
        return { ok: true, created: false };
      },
      importIntoBranch: async () => {
        calls.push('import');
        return okImport([]);
      },
    };
    const result = await runDiscoverySequence(samplePlanFolder(), { overwrite: false }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DOKPLOY_FOLDER_DIRTY');
    expect(result.environments).toEqual([]);
    expect(calls).toEqual([]); // no checkout, no import
  });

  test('checkFolderDirty is never called for a folder whose project was just created this run', async () => {
    const dirtyCalls: true[] = [];
    const deps: DiscoverySequenceDeps = {
      ensureProject: async () => ({ ok: true, projectId: 'proj_new', created: true }),
      checkFolderDirty: async () => {
        dirtyCalls.push(true);
        throw new Error('should not be called — a brand-new project has nothing to be dirty about');
      },
      checkoutBranch: async () => ({ ok: true, created: true }),
      importIntoBranch: async () => okImport(['A']),
    };
    const result = await runDiscoverySequence(samplePlanFolder(), { overwrite: false }, deps);
    expect(result.ok).toBe(true);
    expect(dirtyCalls.length).toBe(0);
  });

  test('--overwrite is threaded through to every importIntoBranch call unchanged', async () => {
    const overwriteFlags: boolean[] = [];
    const folder = samplePlanFolder({
      environments: [samplePlanEnv({ environmentName: 'production' }), samplePlanEnv({ environmentName: 'staging' })],
    });
    const deps: DiscoverySequenceDeps = {
      ensureProject: async () => ({ ok: true, projectId: 'proj_1', created: false }),
      checkFolderDirty: async () => ({ ok: true }),
      checkoutBranch: async () => ({ ok: true, created: false }),
      importIntoBranch: async (_r, _f, _env, overwrite) => {
        overwriteFlags.push(overwrite);
        return okImport(['A']);
      },
    };
    await runDiscoverySequence(folder, { overwrite: true }, deps);
    expect(overwriteFlags).toEqual([true, true]);
  });
});

describe('runDiscoverySequences', () => {
  test('one folder failing does not stop the NEXT folder from running', async () => {
    const folderA = samplePlanFolder({ repoDir: '/repos/a', serviceName: 'a' });
    const folderB = samplePlanFolder({ repoDir: '/repos/b', serviceName: 'b' });
    const deps: DiscoverySequenceDeps = {
      ensureProject: async (repoDir) =>
        repoDir === '/repos/a' ? { ok: false, code: 'DOKPLOY_FOLDER_NOT_INITIALIZED', message: 'x' } : { ok: true, projectId: 'proj_b', created: false },
      checkFolderDirty: async () => ({ ok: true }),
      checkoutBranch: async () => ({ ok: true, created: false }),
      importIntoBranch: async () => okImport(['A']),
    };
    const results = await runDiscoverySequences([folderA, folderB], { overwrite: false }, deps);
    expect(results.length).toBe(2);
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
  });
});

// ── Connector-level: dry run (zero writes anywhere, never prompts, names only) ──

describe('connector.discover — dry run', () => {
  const SENTINEL = 'discover-sentinel-do-not-leak-4d2a';

  function fakeDiscoveryFetch(calls: Array<{ method: string; url: string }>): FetchLike {
    return (async (url: string, init: { method: string }) => {
      if (init.method !== 'GET') throw new Error(`fakeDiscoveryFetch: unexpected non-GET ${init.method} ${url}`);
      calls.push({ method: init.method, url });
      if (url.includes('project.all')) {
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify([
              {
                projectId: 'proj_1',
                name: 'acme',
                environments: [
                  { environmentId: 'env_1', name: 'production', compose: [{ composeId: 'compose_1', name: 'widgets' }] },
                ],
              },
            ]),
        };
      }
      if (url.includes('compose.one')) {
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              composeId: 'compose_1',
              env: `SECRET=${SENTINEL}`,
              createEnvFile: true,
              owner: 'acme',
              repository: 'widgets',
              sourceType: 'github',
              branch: 'main',
              composePath: 'docker-compose.yml',
            }),
        };
      }
      throw new Error(`unexpected discovery request: ${url}`);
    }) as FetchLike;
  }

  function ctxWith(): DiscoveryContext {
    return { orgId: 'o', userId: 'u' } as unknown as DiscoveryContext;
  }

  test('resolves the key, reads Dokploy (GET only), and reports the plan — writes nothing, never prompts', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-dryrun-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      const calls: Array<{ method: string; url: string }> = [];
      const confirmCalls: true[] = [];
      const pickWinnerCalls: true[] = [];
      const selectVarsCalls: true[] = [];
      const connector = createDokployConnector({
        fetch: fakeDiscoveryFetch(calls),
        env: { T: 'x' },
        cwd: ROOT,
        confirm: async () => {
          confirmCalls.push(true);
          return true;
        },
        pickCollisionWinner: async () => {
          pickWinnerCalls.push(true);
          return 'compose_1';
        },
        selectVars: async (c: readonly string[]) => {
          selectVarsCalls.push(true);
          return c;
        },
      });

      const outcome = await connector.discover!(ctxWith(), {
        nonTty: true,
        dryRun: true,
        baseUrl: 'https://dokploy.example.com',
        tokenEnv: 'T',
      } as ConnectOpts);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.dryRun).toBe(true);
      expect(outcome.applied).toBeUndefined();
      expect(outcome.plan.folders.length).toBe(1);
      expect(outcome.plan.folders[0].folder).toBe('');
      expect(outcome.plan.folders[0].initialized).toBe(false);
      expect(outcome.plan.folders[0].environments[0].variableCount).toBe(1);

      for (const c of calls) expect(c.method).toBe('GET');
      expect(calls.every((c) => c.url.includes('project.all') || c.url.includes('compose.one'))).toBe(true);

      expect(confirmCalls.length).toBe(0);
      expect(pickWinnerCalls.length).toBe(0);
      expect(selectVarsCalls.length).toBe(0);

      expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
      expect(existsSync(join(ROOT, '.env'))).toBe(false);

      const chunks: string[] = [];
      const record = (...a: unknown[]) => void chunks.push(a.map(String).join(' '));
      const logSpy = spyOn(console, 'log').mockImplementation(record as never);
      const errSpy = spyOn(console, 'error').mockImplementation(record as never);
      const command = new ConnectCommand(false);
      try {
        await (command as unknown as { executeDiscovery: Function }).executeDiscovery(
          connector,
          'dokploy',
          ctxWith(),
          { nonTty: true, dryRun: true, baseUrl: 'https://dokploy.example.com', tokenEnv: 'T', json: true } as ConnectOpts,
        );
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
      const printed = chunks.join('\n');
      expect(printed).not.toContain(SENTINEL);
      expect(JSON.parse(printed.trim())).toMatchObject({ ok: true, dryRun: true });
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('the plan prints the exact command sequence per folder — checkout -b for an uninitialized folder, --overwrite named when passed', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-sequence-print-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      const calls: Array<{ method: string; url: string }> = [];
      const connector = createDokployConnector({ fetch: fakeDiscoveryFetch(calls), env: { T: 'x' }, cwd: ROOT });

      const textChunks: string[] = [];
      const logSpy = spyOn(console, 'log').mockImplementation(((...a: unknown[]) => void textChunks.push(a.map(String).join(' '))) as never);
      const errSpy = spyOn(console, 'error').mockImplementation((() => {}) as never);
      try {
        await (new ConnectCommand(false) as unknown as { executeDiscovery: Function }).executeDiscovery(
          connector,
          'dokploy',
          ctxWith(),
          { nonTty: true, dryRun: true, baseUrl: 'https://d', tokenEnv: 'T', overwrite: true } as ConnectOpts,
        );
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
      const printed = textChunks.join('\n');
      expect(printed).toContain('capy (init)');
      expect(printed).toContain('checkout -b production');
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('runs from an uninitialized clone (a git repo with no keep.lock): does not exit, plan produced', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-dryrun-uninit-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
      const calls: Array<{ method: string; url: string }> = [];
      const connector = createDokployConnector({ fetch: fakeDiscoveryFetch(calls), env: { T: 'x' }, cwd: ROOT });
      const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code}) should not have been called — discovery needs no keep.lock`);
      }) as never);
      try {
        const outcome = await connector.discover!(ctxWith(), {
          nonTty: true,
          dryRun: true,
          baseUrl: 'https://dokploy.example.com',
          tokenEnv: 'T',
        } as ConnectOpts);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.plan.folders.length).toBe(1);
      } finally {
        exitSpy.mockRestore();
      }
      expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('runs from a PARENT folder of several repos (cwd itself is not a repo, no keep.lock anywhere): does not exit, plan produced', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-dryrun-parent-'));
    try {
      const repoA = join(ROOT, 'widgets');
      const repoB = join(ROOT, 'gadgets');
      initRepo(repoA, 'git@github.com:acme/widgets.git');
      initRepo(repoB, 'git@github.com:acme/gadgets.git');
      expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
      expect(existsSync(join(repoA, 'keep.lock'))).toBe(false);
      expect(existsSync(join(repoB, 'keep.lock'))).toBe(false);

      const calls: Array<{ method: string; url: string }> = [];
      const fetchImpl: FetchLike = (async (url: string, init: { method: string }) => {
        if (init.method !== 'GET') throw new Error(`unexpected non-GET ${init.method} ${url}`);
        calls.push({ method: init.method, url });
        if (url.includes('project.all')) {
          return {
            status: 200,
            ok: true,
            text: async () =>
              JSON.stringify([
                {
                  projectId: 'proj_1',
                  name: 'acme',
                  environments: [
                    {
                      environmentId: 'env_1',
                      name: 'production',
                      compose: [
                        { composeId: 'compose_widgets', name: 'widgets' },
                        { composeId: 'compose_gadgets', name: 'gadgets' },
                      ],
                    },
                  ],
                },
              ]),
          };
        }
        const isWidgets = url.includes('compose_widgets');
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              composeId: isWidgets ? 'compose_widgets' : 'compose_gadgets',
              env: 'A=1',
              createEnvFile: true,
              owner: 'acme',
              repository: isWidgets ? 'widgets' : 'gadgets',
              sourceType: 'github',
              composePath: 'docker-compose.yml',
            }),
        };
      }) as FetchLike;

      const connector = createDokployConnector({ fetch: fetchImpl, env: { T: 'x' }, cwd: ROOT });
      const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code}) should not have been called — discovery needs no keep.lock`);
      }) as never);
      try {
        const outcome = await connector.discover!(ctxWith(), {
          nonTty: true,
          dryRun: true,
          baseUrl: 'https://d',
          tokenEnv: 'T',
        } as ConnectOpts);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.plan.folders.map((f) => f.serviceName).sort()).toEqual(['gadgets', 'widgets']);
        expect(outcome.plan.folders.map((f) => f.repoDir).sort()).toEqual([repoA, repoB].sort());
      } finally {
        exitSpy.mockRestore();
      }
      expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
      expect(existsSync(join(repoA, 'keep.lock'))).toBe(false);
      expect(existsSync(join(repoB, 'keep.lock'))).toBe(false);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('never prompts for the key, even with a real TTY and a store that would otherwise ask', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-dryrun-nokey-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      const promptCalls: boolean[] = [];
      const getConnectorSecret = async (_name: string, opts: { interactive: boolean }) => {
        if (opts.interactive) promptCalls.push(true);
        return null;
      };
      const connector = createDokployConnector({ fetch: async () => { throw new Error('must not fetch — token missing'); }, env: {}, cwd: ROOT, getConnectorSecret });
      const savedTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      try {
        const outcome = await connector.discover!(ctxWith(), {
          nonTty: false,
          dryRun: true,
          baseUrl: 'https://dokploy.example.com',
        } as ConnectOpts);
        expect(outcome.ok).toBe(false);
        expect((outcome as { code: string }).code).toBe('DOKPLOY_TOKEN_MISSING');
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
      }
      expect(promptCalls.length).toBe(0);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

// ── Connector-level: collisions ──────────────────────────────────────────────

describe('connector.discover — collisions', () => {
  function collidingFetch(calls: Array<{ method: string; url: string }>): FetchLike {
    return (async (url: string, init: { method: string }) => {
      if (init.method !== 'GET') throw new Error(`collidingFetch: unexpected non-GET ${init.method} ${url}`);
      calls.push({ method: init.method, url });
      if (url.includes('project.all')) {
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify([
              {
                projectId: 'proj_1',
                name: 'slidespeak',
                environments: [
                  {
                    environmentId: 'env_1',
                    name: 'production',
                    compose: [
                      { composeId: 'compose_a', name: 'backend' },
                      { composeId: 'compose_b', name: 'backend-stack' },
                    ],
                  },
                ],
              },
            ]),
        };
      }
      const id = url.includes('compose_a') ? 'compose_a' : 'compose_b';
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            composeId: id,
            env: `V_${id}=1`,
            createEnvFile: true,
            owner: 'slidespeak',
            repository: 'backend-stack',
            sourceType: 'github',
            composePath: 'backend/deployment/docker-compose.yml',
          }),
      };
    }) as FetchLike;
  }

  function ctxWith(): DiscoveryContext {
    return { orgId: 'o', userId: 'u' } as unknown as DiscoveryContext;
  }

  test('non-interactive with an unresolved collision: DOKPLOY_MAPPING_COLLISION, zero writes', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-collision-nontty-'));
    try {
      initRepo(ROOT, 'git@github.com:slidespeak/backend-stack.git');
      const calls: Array<{ method: string; url: string }> = [];
      const connector = createDokployConnector({ fetch: collidingFetch(calls), env: { T: 'x' }, cwd: ROOT });
      const outcome = await connector.discover!(ctxWith(), {
        nonTty: true,
        baseUrl: 'https://d',
        tokenEnv: 'T',
      } as ConnectOpts);
      expect(outcome.ok).toBe(false);
      expect((outcome as { code: string }).code).toBe('DOKPLOY_MAPPING_COLLISION');
      expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

// ── Confirmation gate for a real (non-dry-run) apply ────────────────────────
//
// A single, non-colliding service — collisions have their own gate (above),
// checked first. The plan-level gate is checked BEFORE any per-folder work
// starts, so `ctx.serviceClient.initializeProject` throwing a SENTINEL the
// moment it is actually called proves whether the gate held (never reached)
// or was passed (the folder's own `ensureProject` step ran far enough to
// attempt it — surfaced as a coded per-folder failure, never a rejected
// promise: `runDiscoverySequence` never lets a step's throw escape
// unconverted, see its own doc).

describe('connector.discover — confirmation required for a real apply', () => {
  const SENTINEL_APPLY_ATTEMPTED = '__apply_attempted_sentinel__';

  function singleServiceFetch(calls: Array<{ method: string; url: string }>): FetchLike {
    return (async (url: string, init: { method: string }) => {
      if (init.method !== 'GET') throw new Error(`singleServiceFetch: unexpected non-GET ${init.method} ${url}`);
      calls.push({ method: init.method, url });
      if (url.includes('project.all')) {
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify([
              {
                projectId: 'proj_1',
                name: 'acme',
                environments: [
                  { environmentId: 'env_1', name: 'production', compose: [{ composeId: 'compose_1', name: 'widgets' }] },
                ],
              },
            ]),
        };
      }
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            composeId: 'compose_1',
            env: 'A=1',
            createEnvFile: true,
            owner: 'acme',
            repository: 'widgets',
            sourceType: 'github',
            composePath: 'docker-compose.yml',
          }),
      };
    }) as FetchLike;
  }

  /** Throws the moment a real apply's project-init step is attempted — never reached if the plan-level gate holds. */
  function ctxThatThrowsOnApply(): DiscoveryContext {
    return {
      orgId: 'o',
      userId: 'u',
      serviceClient: {
        // An empty (successful) listing — never `DOKPLOY_PROJECT_LOOKUP_FAILED`
        // — so the run reaches `initializeProject`, which is the sentinel.
        listProjects: async () => [],
        initializeProject: async () => {
          throw new Error(SENTINEL_APPLY_ATTEMPTED);
        },
      },
    } as unknown as DiscoveryContext;
  }

  test('non-interactive, no --yes: refuses DOKPLOY_CONFIRMATION_REQUIRED, zero writes, apply never attempted', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-confirm-required-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      const calls: Array<{ method: string; url: string }> = [];
      const connector = createDokployConnector({ fetch: singleServiceFetch(calls), env: { T: 'x' }, cwd: ROOT });
      const outcome = await connector.discover!(ctxThatThrowsOnApply(), {
        nonTty: true,
        baseUrl: 'https://d',
        tokenEnv: 'T',
      } as ConnectOpts);
      expect(outcome.ok).toBe(false);
      expect((outcome as { code: string }).code).toBe('DOKPLOY_CONFIRMATION_REQUIRED');
      expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('non-interactive with --yes: proceeds past the plan-level gate, but a folder with no keep.lock STILL refuses DOKPLOY_FOLDER_NOT_INITIALIZED (never auto-creates non-interactively)', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-confirm-yes-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      const calls: Array<{ method: string; url: string }> = [];
      const connector = createDokployConnector({ fetch: singleServiceFetch(calls), env: { T: 'x' }, cwd: ROOT });
      const outcome = await connector.discover!(ctxThatThrowsOnApply(), {
        nonTty: true,
        baseUrl: 'https://d',
        tokenEnv: 'T',
        yes: true,
      } as ConnectOpts);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.applied?.length).toBe(1);
      const folderResult = outcome.applied![0];
      expect(folderResult.ok).toBe(false);
      if (folderResult.ok) return;
      expect(folderResult.code).toBe('DOKPLOY_FOLDER_NOT_INITIALIZED');
      // The sentinel never fired — `initializeProject` was never called,
      // because a non-interactive run refuses BEFORE ever reaching it.
      expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('--json with a real TTY: the confirmation gate is still non-interactive (never a raw prompt interleaved with JSON)', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-confirm-json-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      const calls: Array<{ method: string; url: string }> = [];
      const confirmCalls: true[] = [];
      const connector = createDokployConnector({
        fetch: singleServiceFetch(calls),
        env: { T: 'x' },
        cwd: ROOT,
        confirm: async () => {
          confirmCalls.push(true);
          return true;
        },
      });
      const savedTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      try {
        const outcome = await connector.discover!(ctxThatThrowsOnApply(), {
          nonTty: false,
          json: true,
          baseUrl: 'https://d',
          tokenEnv: 'T',
        } as ConnectOpts);
        expect(outcome.ok).toBe(false);
        expect((outcome as { code: string }).code).toBe('DOKPLOY_CONFIRMATION_REQUIRED');
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
      }
      expect(confirmCalls.length).toBe(0);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('interactive: the confirm message states the command sequence, never a value', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-confirm-message-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      const calls: Array<{ method: string; url: string }> = [];
      const messages: string[] = [];
      const connector = createDokployConnector({
        fetch: singleServiceFetch(calls),
        env: { T: 'x' },
        cwd: ROOT,
        confirm: async (message: string) => {
          messages.push(message);
          return false; // decline — proves the message was shown before any write, without needing real crypto.
        },
      });
      const savedTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const outcome = await (async () => {
        try {
          return await connector.discover!(ctxThatThrowsOnApply(), {
            nonTty: false,
            baseUrl: 'https://d',
            tokenEnv: 'T',
          } as ConnectOpts);
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
        }
      })();
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.cancelled).toBe(true);
      expect(outcome.applied).toEqual([]);
      expect(messages.length).toBe(1);
      expect(messages[0]).toContain('1 step(s)');
      expect(messages[0]).toContain('widgets');
      expect(messages[0]).toContain('checkout -b production');
      expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('TTY + --yes: skips the plan-level confirm entirely and proceeds into the folder sequence (defect fix)', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-confirm-yes-tty-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      const calls: Array<{ method: string; url: string }> = [];
      const confirmCalls: true[] = [];
      const connector = createDokployConnector({
        fetch: singleServiceFetch(calls),
        env: { T: 'x' },
        cwd: ROOT,
        confirm: async () => {
          confirmCalls.push(true);
          return false;
        },
        // Interactive, so `ensureProject` asks — answering "new project"
        // lets the run reach `initializeProject`, which throws the sentinel,
        // proving the plan-level confirm really was skipped.
        askExistingOrNewProject: async () => DISCOVERY_NEW_PROJECT,
      });
      const savedTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const outcome = await (async () => {
        try {
          return await connector.discover!(ctxThatThrowsOnApply(), {
            nonTty: false,
            baseUrl: 'https://d',
            tokenEnv: 'T',
            yes: true,
          } as ConnectOpts);
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
        }
      })();
      // Never asked to confirm the PLAN — --yes means proceed, on a TTY or not.
      expect(confirmCalls.length).toBe(0);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const folderResult = outcome.applied![0];
      expect(folderResult.ok).toBe(false);
      if (folderResult.ok) return;
      // The sentinel surfaced INSIDE the coded failure — proving `initializeProject`
      // really was reached, i.e. the plan-level gate was passed.
      expect(folderResult.message).toContain(SENTINEL_APPLY_ATTEMPTED);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

// ── ensureProjectSafe defect fixes: lookup failure, project naming ─────────
//
// Both reachable with the SAME sentinel-throwing `initializeProject`
// pattern the confirmation-gate tests above use — no real master key
// needed, since these two defects are both resolved BEFORE key resolution
// ever runs.

describe('connector.discover — ensureProjectSafe defect fixes', () => {
  function singleServiceFetch(calls: Array<{ method: string; url: string }>): FetchLike {
    return (async (url: string, init: { method: string }) => {
      if (init.method !== 'GET') throw new Error(`unexpected non-GET ${init.method} ${url}`);
      calls.push({ method: init.method, url });
      if (url.includes('project.all')) {
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify([
              {
                projectId: 'proj_1',
                name: 'acme',
                environments: [
                  { environmentId: 'env_1', name: 'production', compose: [{ composeId: 'compose_1', name: 'widgets' }] },
                ],
              },
            ]),
        };
      }
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            composeId: 'compose_1',
            env: 'A=1',
            createEnvFile: true,
            owner: 'acme',
            repository: 'widgets',
            sourceType: 'github',
            composePath: 'docker-compose.yml',
          }),
      };
    }) as FetchLike;
  }

  test('a listProjects failure aborts the folder DOKPLOY_PROJECT_LOOKUP_FAILED — never silently offers "create new"', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-lookup-failed-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      const calls: Array<{ method: string; url: string }> = [];
      const askExistingOrNewCalls: true[] = [];
      const initializeProjectCalls: true[] = [];
      const connector = createDokployConnector({
        fetch: singleServiceFetch(calls),
        env: { T: 'x' },
        cwd: ROOT,
        // Never asked — a lookup failure aborts BEFORE the existing-vs-new
        // choice, which is the whole point of the fix (offering "create
        // new" on a failed lookup risks a duplicate project).
        askExistingOrNewProject: async () => {
          askExistingOrNewCalls.push(true);
          return DISCOVERY_NEW_PROJECT;
        },
      });
      const ctx: DiscoveryContext = {
        orgId: 'o',
        userId: 'u',
        serviceClient: {
          listProjects: async () => {
            throw new Error('network down');
          },
          initializeProject: async () => {
            initializeProjectCalls.push(true);
            throw new Error('should not be called — the lookup failed first');
          },
        },
      } as unknown as DiscoveryContext;
      const savedTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const outcome = await (async () => {
        try {
          return await connector.discover!(ctx, { nonTty: false, baseUrl: 'https://d', tokenEnv: 'T', yes: true } as ConnectOpts);
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
        }
      })();
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const folderResult = outcome.applied![0];
      expect(folderResult.ok).toBe(false);
      if (folderResult.ok) return;
      expect(folderResult.code).toBe('DOKPLOY_PROJECT_LOOKUP_FAILED');
      expect(askExistingOrNewCalls.length).toBe(0);
      expect(initializeProjectCalls.length).toBe(0);
      expect(existsSync(join(ROOT, 'keep.lock'))).toBe(false);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('a new project asks for its name (default = the computed default), and initializes with the CHOSEN name', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-name-ask-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      const calls: Array<{ method: string; url: string }> = [];
      const nameAskCalls: string[] = [];
      const initNames: string[] = [];
      const connector = createDokployConnector({
        fetch: singleServiceFetch(calls),
        env: { T: 'x' },
        cwd: ROOT,
        // Answers the PLAN-level "proceed?" gate directly (rather than
        // --yes) so that gate passes WITHOUT also skipping the (separate,
        // non-confirmation) new-project-name ask this test needs to fire.
        confirm: async () => true,
        askExistingOrNewProject: async () => DISCOVERY_NEW_PROJECT,
        askDiscoveryProjectName: async (defaultName: string) => {
          nameAskCalls.push(defaultName);
          return 'human-chosen-name';
        },
      });
      const ctx: DiscoveryContext = {
        orgId: 'o',
        userId: 'u',
        serviceClient: {
          listProjects: async () => [],
          initializeProject: async (name: string) => {
            initNames.push(name);
            throw new Error('stop here — naming is all this test needs to prove');
          },
        },
      } as unknown as DiscoveryContext;
      const savedTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const outcome = await (async () => {
        try {
          // Interactive, NOT --yes: the name prompt must fire.
          return await connector.discover!(ctx, { nonTty: false, baseUrl: 'https://d', tokenEnv: 'T' } as ConnectOpts);
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
        }
      })();
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(nameAskCalls.length).toBe(1);
      expect(nameAskCalls[0]).toBe(defaultDiscoveryProjectName(ROOT, ''));
      expect(initNames).toEqual(['human-chosen-name']);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  test('--yes skips the name prompt and initializes with the DEFAULT name, unasked', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-name-default-'));
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');
      const calls: Array<{ method: string; url: string }> = [];
      const initNames: string[] = [];
      const connector = createDokployConnector({
        fetch: singleServiceFetch(calls),
        env: { T: 'x' },
        cwd: ROOT,
        askExistingOrNewProject: async () => DISCOVERY_NEW_PROJECT,
        askDiscoveryProjectName: async () => {
          throw new Error('must not be asked — --yes uses the default outright');
        },
      });
      const ctx: DiscoveryContext = {
        orgId: 'o',
        userId: 'u',
        serviceClient: {
          listProjects: async () => [],
          initializeProject: async (name: string) => {
            initNames.push(name);
            throw new Error('stop here — naming is all this test needs to prove');
          },
        },
      } as unknown as DiscoveryContext;
      const savedTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const outcome = await (async () => {
        try {
          return await connector.discover!(ctx, { nonTty: false, baseUrl: 'https://d', tokenEnv: 'T', yes: true } as ConnectOpts);
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
        }
      })();
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(initNames).toEqual([defaultDiscoveryProjectName(ROOT, '')]);
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

// ── A real apply honors --no-push (defect fix) ──────────────────────────────
//
// Seeds a REAL master key for a throwaway org (identity co-decrypt/wrap —
// `wrapAndSaveMasterKey`'s local K_local inner wrap is real; the "server"
// side is a no-op) under an isolated `CAPY_GLOBAL_DIR_NAME`, so
// `resolveProjectKey` succeeds for real without touching this developer's
// actual `~/.capy` or any network. A keep.lock is pre-seeded (non-interactive
// discovery never initializes a folder itself — see the confirmation-gate
// tests above), so the sequence goes straight to checkout + import.

describe('connector.discover — a real apply honors --no-push', () => {
  test('--yes --no-push: writes locally, makes zero pushSecrets calls', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-nopush-'));
    const globalDirName = `.capy-test-nopush-${process.pid}-${Date.now()}`;
    const savedDirName = process.env.CAPY_GLOBAL_DIR_NAME;
    process.env.CAPY_GLOBAL_DIR_NAME = globalDirName;
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');

      const orgId = 'org_nopush_test';
      const userId = 'user_nopush_test';
      const masterKey = randomBytes(32);
      await wrapAndSaveMasterKey(masterKey, orgId, userId, {
        coDecrypt: async (_oid: string, ct: string) => ct,
        wrapOuterLayer: async (_oid: string, pt: string) => pt,
      });

      // Pre-seeded keep.lock: this folder is ALREADY initialized, matching
      // what a non-interactive discovery run requires (see the
      // confirmation-gate describe block above).
      const projectId = 'proj_nopush';
      writeFileSync(
        join(ROOT, 'keep.lock'),
        JSON.stringify({ version: '3.0', org_id: orgId, project_id: projectId, project_name: 'widgets', variables: {} }),
      );

      const pushCalls: true[] = [];
      const ctx: DiscoveryContext = {
        orgId,
        userId,
        authService: {} as unknown as DiscoveryContext['authService'],
        serviceClient: {
          coDecrypt: async (_oid: string, ct: string) => ({ plaintext: ct }),
          wrapOuterLayer: async (_oid: string, pt: string) => ({ ciphertext: pt }),
          listBranches: async () => [],
          createBranch: async () => ({ id: 'b1', name: 'production', project_id: projectId, is_protected: false }),
          getDecryptData: async () => ({ env_content: '', keep_file: '', decrypt_key: '', expires_at: new Date().toISOString() }),
          pushSecrets: async () => {
            pushCalls.push(true);
            throw new Error('must not be called — --no-push');
          },
        } as unknown as DiscoveryContext['serviceClient'],
      };

      const calls: Array<{ method: string; url: string }> = [];
      const fetchImpl: FetchLike = (async (url: string, init: { method: string }) => {
        if (init.method !== 'GET') throw new Error(`unexpected non-GET ${init.method} ${url}`);
        calls.push({ method: init.method, url });
        if (url.includes('project.all')) {
          return {
            status: 200,
            ok: true,
            text: async () =>
              JSON.stringify([
                {
                  projectId: 'proj_1',
                  name: 'acme',
                  environments: [
                    { environmentId: 'env_1', name: 'production', compose: [{ composeId: 'compose_1', name: 'widgets' }] },
                  ],
                },
              ]),
          };
        }
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              composeId: 'compose_1',
              env: 'A=1',
              createEnvFile: true,
              owner: 'acme',
              repository: 'widgets',
              sourceType: 'github',
              composePath: 'docker-compose.yml',
            }),
        };
      }) as FetchLike;

      const connector = createDokployConnector({ fetch: fetchImpl, env: { T: 'x' }, cwd: ROOT });
      const outcome = await connector.discover!(ctx, {
        nonTty: true,
        baseUrl: 'https://d',
        tokenEnv: 'T',
        yes: true,
        noPush: true,
      } as ConnectOpts);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(pushCalls.length).toBe(0);
      const folderResult = outcome.applied?.[0];
      expect(folderResult?.ok).toBe(true);
      if (!folderResult?.ok) return;
      expect(folderResult.environments[0].outcome.imported.map((e) => e.varName)).toEqual(['A']);

      // The write DID happen — just locally, never pushed.
      expect(existsSync(join(ROOT, '.env'))).toBe(true);
      const envFile = readFileSync(join(ROOT, '.env'), 'utf-8');
      expect(envFile).toContain('A=capy:');
    } finally {
      if (savedDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
      else process.env.CAPY_GLOBAL_DIR_NAME = savedDirName;
      rmSync(join(homedir(), globalDirName), { recursive: true, force: true });
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

// ── An unpushed local edit aborts the folder (defect fix) ───────────────────
//
// Drives the REAL `checkFolderDirtySafe` → `findDirtyBranchIssue` wiring
// (not an injected `checkFolderDirty` dep — the sequence-level tests above
// already cover that contract) through `connector.discover()` end to end.

describe('connector.discover — an unpushed local edit aborts the folder DOKPLOY_FOLDER_DIRTY', () => {
  test('a local .env value that no longer matches keep.lock\'s pin: DOKPLOY_FOLDER_DIRTY, .env untouched, no checkout, no import', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-dirty-'));
    const globalDirName = `.capy-test-dirty-${process.pid}-${Date.now()}`;
    const savedDirName = process.env.CAPY_GLOBAL_DIR_NAME;
    process.env.CAPY_GLOBAL_DIR_NAME = globalDirName;
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');

      const orgId = 'org_dirty_test';
      const userId = 'user_dirty_test';
      const projectId = 'proj_dirty';
      const masterKey = randomBytes(32);
      const keyOps = {
        coDecrypt: async (_oid: string, ct: string) => ct,
        wrapOuterLayer: async (_oid: string, pt: string) => pt,
      };
      await wrapAndSaveMasterKey(masterKey, orgId, userId, keyOps);
      const encryptionKey = await resolveProjectKey(orgId, projectId, userId, keyOps);

      // keep.lock pins FOO="correct-value" on "production" — the branch
      // this folder's `.env` header will say it's on.
      const keep: KeepFile = {
        version: '3.0',
        org_id: orgId,
        project_id: projectId,
        project_name: 'widgets',
        variables: { FOO: [{ resource_id: 'r1', branch: 'production', value_hash: hashValue('correct-value') }] },
      };
      writeFileSync(join(ROOT, 'keep.lock'), JSON.stringify(keep));

      // The local .env has a DIFFERENT value for FOO — an uncommitted edit —
      // while still declaring itself to be on "production" (same branch
      // header keep.lock's pin above is for).
      const fm = new FileManager(ROOT);
      fm.writeEncryptedEnvFile({ FOO: 'edited-locally-not-yet-committed' }, encryptionKey, undefined, keep, 'production');
      const envBefore = readFileSync(join(ROOT, '.env'), 'utf-8');

      // `listBranches` is ALSO called during plan-building, for the plan's
      // own `branchExists` preview (see `buildDiscoveryPlan`) — so it alone
      // isn't a "checkout ran" signal. `createBranch`/`getDecryptData` are
      // not: both are ONLY ever reached from inside `checkoutBranchSafe`.
      const checkoutCalls: true[] = [];
      const ctx: DiscoveryContext = {
        orgId,
        userId,
        authService: {} as unknown as DiscoveryContext['authService'],
        serviceClient: {
          coDecrypt: async (_oid: string, ct: string) => ({ plaintext: ct }),
          wrapOuterLayer: async (_oid: string, pt: string) => ({ ciphertext: pt }),
          listBranches: async () => [],
          createBranch: async () => {
            checkoutCalls.push(true);
            return { id: 'b1', name: 'production', project_id: projectId, is_protected: false };
          },
          getDecryptData: async () => {
            checkoutCalls.push(true);
            throw new Error('must not be called — checkout never ran');
          },
          pushSecrets: async () => {
            throw new Error('must not be called — the folder is dirty, nothing should be written');
          },
        } as unknown as DiscoveryContext['serviceClient'],
      };

      const fetchImpl: FetchLike = (async (url: string, init: { method: string }) => {
        if (init.method !== 'GET') throw new Error(`unexpected non-GET ${init.method} ${url}`);
        if (url.includes('project.all')) {
          return {
            status: 200,
            ok: true,
            text: async () =>
              JSON.stringify([
                {
                  projectId: 'proj_1',
                  name: 'acme',
                  environments: [
                    { environmentId: 'env_1', name: 'production', compose: [{ composeId: 'compose_1', name: 'widgets' }] },
                  ],
                },
              ]),
          };
        }
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              composeId: 'compose_1',
              env: 'FOO=dokploy-value',
              createEnvFile: true,
              owner: 'acme',
              repository: 'widgets',
              sourceType: 'github',
              composePath: 'docker-compose.yml',
            }),
        };
      }) as FetchLike;

      const connector = createDokployConnector({ fetch: fetchImpl, env: { T: 'x' }, cwd: ROOT });
      const outcome = await connector.discover!(ctx, { nonTty: true, baseUrl: 'https://d', tokenEnv: 'T', yes: true } as ConnectOpts);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const folderResult = outcome.applied?.[0];
      expect(folderResult?.ok).toBe(false);
      if (folderResult?.ok !== false) return;
      expect(folderResult.code).toBe('DOKPLOY_FOLDER_DIRTY');
      expect(folderResult.message).toContain('production');

      // No CHECKOUT ever ran: `createBranch`/`getDecryptData` were never
      // called, and `pushSecrets` throws if it's ever reached at all.
      expect(checkoutCalls.length).toBe(0);

      // .env is byte-for-byte untouched.
      expect(readFileSync(join(ROOT, '.env'), 'utf-8')).toBe(envBefore);
    } finally {
      if (savedDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
      else process.env.CAPY_GLOBAL_DIR_NAME = savedDirName;
      rmSync(join(homedir(), globalDirName), { recursive: true, force: true });
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

// ── A protected branch (403) gets its own code (defect fix) ────────────────

describe('connector.discover — a protected branch (403) is DOKPLOY_BRANCH_PROTECTED', () => {
  test('checkout hitting a 403 aborts the folder DOKPLOY_BRANCH_PROTECTED — never the generic DOKPLOY_CHECKOUT_FAILED', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-protected-'));
    const globalDirName = `.capy-test-protected-${process.pid}-${Date.now()}`;
    const savedDirName = process.env.CAPY_GLOBAL_DIR_NAME;
    process.env.CAPY_GLOBAL_DIR_NAME = globalDirName;
    try {
      initRepo(ROOT, 'git@github.com:acme/widgets.git');

      const orgId = 'org_protected_test';
      const userId = 'user_protected_test';
      const masterKey = randomBytes(32);
      await wrapAndSaveMasterKey(masterKey, orgId, userId, {
        coDecrypt: async (_oid: string, ct: string) => ct,
        wrapOuterLayer: async (_oid: string, pt: string) => pt,
      });

      const projectId = 'proj_protected';
      writeFileSync(
        join(ROOT, 'keep.lock'),
        JSON.stringify({ version: '3.0', org_id: orgId, project_id: projectId, project_name: 'widgets', variables: {} }),
      );

      const pushCalls: true[] = [];
      const forbidden = Object.assign(new Error('forbidden'), { details: { status: 403 } });
      const ctx: DiscoveryContext = {
        orgId,
        userId,
        authService: {} as unknown as DiscoveryContext['authService'],
        serviceClient: {
          coDecrypt: async (_oid: string, ct: string) => ({ plaintext: ct }),
          wrapOuterLayer: async (_oid: string, pt: string) => ({ ciphertext: pt }),
          listBranches: async () => [],
          createBranch: async () => ({ id: 'b1', name: 'production', project_id: projectId, is_protected: false }),
          getDecryptData: async () => {
            throw forbidden;
          },
          pushSecrets: async () => {
            pushCalls.push(true);
          },
        } as unknown as DiscoveryContext['serviceClient'],
      };

      const calls: Array<{ method: string; url: string }> = [];
      const fetchImpl: FetchLike = (async (url: string, init: { method: string }) => {
        if (init.method !== 'GET') throw new Error(`unexpected non-GET ${init.method} ${url}`);
        calls.push({ method: init.method, url });
        if (url.includes('project.all')) {
          return {
            status: 200,
            ok: true,
            text: async () =>
              JSON.stringify([
                {
                  projectId: 'proj_1',
                  name: 'acme',
                  environments: [
                    { environmentId: 'env_1', name: 'production', compose: [{ composeId: 'compose_1', name: 'widgets' }] },
                  ],
                },
              ]),
          };
        }
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              composeId: 'compose_1',
              env: 'A=1',
              createEnvFile: true,
              owner: 'acme',
              repository: 'widgets',
              sourceType: 'github',
              composePath: 'docker-compose.yml',
            }),
        };
      }) as FetchLike;

      const connector = createDokployConnector({ fetch: fetchImpl, env: { T: 'x' }, cwd: ROOT });
      const outcome = await connector.discover!(ctx, { nonTty: true, baseUrl: 'https://d', tokenEnv: 'T', yes: true } as ConnectOpts);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const folderResult = outcome.applied?.[0];
      expect(folderResult?.ok).toBe(false);
      if (folderResult?.ok !== false) return;
      expect(folderResult.code).toBe('DOKPLOY_BRANCH_PROTECTED');
      expect(pushCalls.length).toBe(0);
      expect(existsSync(join(ROOT, '.env'))).toBe(false);
    } finally {
      if (savedDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
      else process.env.CAPY_GLOBAL_DIR_NAME = savedDirName;
      rmSync(join(homedir(), globalDirName), { recursive: true, force: true });
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

// ── A push failure becomes THAT folder's coded failure (defect fix) ────────

describe('connector.discover — a push failure is DOKPLOY_PUSH_FAILED, and later folders still run', () => {
  test('folder A\'s pushSecrets throws → DOKPLOY_PUSH_FAILED for A; folder B still applies successfully', async () => {
    const ROOT = mkdtempSync(join(tmpdir(), 'capy-discover-pushfail-'));
    const globalDirName = `.capy-test-pushfail-${process.pid}-${Date.now()}`;
    const savedDirName = process.env.CAPY_GLOBAL_DIR_NAME;
    process.env.CAPY_GLOBAL_DIR_NAME = globalDirName;
    try {
      const repoA = join(ROOT, 'widgets');
      const repoB = join(ROOT, 'gadgets');
      initRepo(repoA, 'git@github.com:acme/widgets.git');
      initRepo(repoB, 'git@github.com:acme/gadgets.git');

      const orgId = 'org_pushfail_test';
      const userId = 'user_pushfail_test';
      const masterKey = randomBytes(32);
      await wrapAndSaveMasterKey(masterKey, orgId, userId, {
        coDecrypt: async (_oid: string, ct: string) => ct,
        wrapOuterLayer: async (_oid: string, pt: string) => pt,
      });

      const projectIdA = 'proj_a_pushfail';
      const projectIdB = 'proj_b_pushfail';
      writeFileSync(join(repoA, 'keep.lock'), JSON.stringify({ version: '3.0', org_id: orgId, project_id: projectIdA, project_name: 'widgets', variables: {} }));
      writeFileSync(join(repoB, 'keep.lock'), JSON.stringify({ version: '3.0', org_id: orgId, project_id: projectIdB, project_name: 'gadgets', variables: {} }));

      const pushedProjectIds: string[] = [];
      const ctx: DiscoveryContext = {
        orgId,
        userId,
        authService: {} as unknown as DiscoveryContext['authService'],
        serviceClient: {
          coDecrypt: async (_oid: string, ct: string) => ({ plaintext: ct }),
          wrapOuterLayer: async (_oid: string, pt: string) => ({ ciphertext: pt }),
          listBranches: async () => [],
          createBranch: async () => ({ id: 'b1', name: 'production', project_id: 'x', is_protected: false }),
          getDecryptData: async () => ({ env_content: '', keep_file: '', decrypt_key: '', expires_at: new Date().toISOString() }),
          pushSecrets: async (projectId: string) => {
            pushedProjectIds.push(projectId);
            if (projectId === projectIdA) throw new Error('push failed for A');
            return { keep_hash: 'h'.repeat(16), keep_file: JSON.stringify({ version: '3.0', org_id: orgId, project_id: projectId, project_name: 'x', variables: {} }) };
          },
        } as unknown as DiscoveryContext['serviceClient'],
      };

      // Two matching Compose services — one per repo, both project ids
      // fixed so `pushSecrets` above can tell them apart.
      const fetchImpl: FetchLike = (async (url: string, init: { method: string }) => {
        if (init.method !== 'GET') throw new Error(`unexpected non-GET ${init.method} ${url}`);
        if (url.includes('project.all')) {
          return {
            status: 200,
            ok: true,
            text: async () =>
              JSON.stringify([
                {
                  projectId: 'proj_1',
                  name: 'acme',
                  environments: [
                    {
                      environmentId: 'env_1',
                      name: 'production',
                      compose: [
                        { composeId: 'compose_widgets', name: 'widgets' },
                        { composeId: 'compose_gadgets', name: 'gadgets' },
                      ],
                    },
                  ],
                },
              ]),
          };
        }
        const isWidgets = url.includes('compose_widgets');
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              composeId: isWidgets ? 'compose_widgets' : 'compose_gadgets',
              env: 'A=1',
              createEnvFile: true,
              owner: 'acme',
              repository: isWidgets ? 'widgets' : 'gadgets',
              sourceType: 'github',
              composePath: 'docker-compose.yml',
            }),
        };
      }) as FetchLike;

      const connector = createDokployConnector({ fetch: fetchImpl, env: { T: 'x' }, cwd: ROOT });
      const outcome = await connector.discover!(ctx, { nonTty: true, baseUrl: 'https://d', tokenEnv: 'T', yes: true } as ConnectOpts);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.applied?.length).toBe(2);

      const resultFor = (repoDir: string) => outcome.applied!.find((f) => f.repoDir === repoDir)!;
      const resultA = resultFor(repoA);
      const resultB = resultFor(repoB);

      expect(resultA.ok).toBe(false);
      if (resultA.ok !== false) return;
      expect(resultA.code).toBe('DOKPLOY_PUSH_FAILED');

      expect(resultB.ok).toBe(true);
      if (!resultB.ok) return;
      expect(resultB.environments[0].outcome.imported.map((e) => e.varName)).toEqual(['A']);

      // Both were actually attempted — A's failure never stopped B.
      expect(pushedProjectIds.sort()).toEqual([projectIdA, projectIdB].sort());
    } finally {
      if (savedDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
      else process.env.CAPY_GLOBAL_DIR_NAME = savedDirName;
      rmSync(join(homedir(), globalDirName), { recursive: true, force: true });
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

// ── Existing single-service paths: unchanged ────────────────────────────────

describe('single-service --application/--compose paths are unaffected by discovery', () => {
  test('createDokployConnector still exposes both import() and discover()', () => {
    const connector = createDokployConnector({ env: {} });
    expect(typeof connector.import).toBe('function');
    expect(typeof connector.discover).toBe('function');
    expect(connector.kind).toBe('import');
  });
});

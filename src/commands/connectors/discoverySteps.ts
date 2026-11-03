/**
 * The discovery steps every connector's `--discover` shares (`capy connect
 * dokploy --discover`, `capy connect vercel --discover`): bare `capy` in each
 * folder, init or pick the folder's project, the dirty-folder guard, checkout
 * of each environment's branch, the per-environment import and its write, and
 * the one discovery commit per repo. They were written for Dokploy first and
 * lived in `dokploy.ts`; they are moved here unchanged except that nothing in
 * them names a provider:
 *
 *   - the refusal codes come in as a `DiscoveryCodes` table (`discoveryCodes.ts`):
 *     Dokploy passes its own `DOKPLOY_*` spellings, so its output is exactly what
 *     it was; the other providers pass the neutral `CONNECTOR_*` ones;
 *   - the options of each step's import come from the provider (`importOptsFor`).
 *
 * The sequence itself (`runDiscoverySequences`) and the plan types live in
 * `dokployDiscovery.ts`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CapyError, ERROR_CODES, KeepFile } from '../../types/index';
import { isStaleBase } from '../../sync/commit';
import { ProjectManager } from '../../core/projectManager';
import { FileManager } from '../../files/fileManager';
import { resolveProjectKey } from '../../crypto/keyResolver';
import { SyncEngine } from '../../sync/syncEngine';
import { assertProjectNameAllowed, isReservedProjectName, PROJECT_NAME_RESERVED_MESSAGE } from '../../system/reservedProjectName';
import { findDirtyBranchIssue } from '../checkoutCommand';
import { listOrgProjectsOrUnavailable } from '../capyCommand';
import { commitDiscoveryChanges, isValidDiscoveryCommitBranchName } from '../../git/discoveryCommit';
import type { FolderSync, GateOptions } from '../../sync/gate';
import { isConflictRefusal } from '../../sync/conflicts';
import { writeImportOutcome, ResolvedContext } from './shared';
import { ConnectOpts, ImportOutcome } from './registry';
import { discoveryProjectQuestion } from '../../ui/projectQuestions';
import type { DiscoveryCodes } from './discoveryCodes';
import {
  DISCOVERY_PROJECT_NAME_MAX_LENGTH,
  DiscoveryCollision,
  DiscoveryContext,
  DiscoveryFolderResult,
  DiscoveryPlanEnv,
  DiscoveryPlanFolder,
  DiscoveryRepoCommitResult,
  DiscoverySequenceDeps,
  GitRemoteRef,
  defaultDiscoveryProjectName,
} from './dokployDiscovery';

export async function defaultConfirm(message: string, defaultValue: boolean): Promise<boolean> {
  const inquirer = (await import('inquirer')).default;
  const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message, default: defaultValue }]);
  return ok;
}

/** Sentinel `askExistingOrNewProject` returns to mean "create a new project", never a real project id. */
export const DISCOVERY_NEW_PROJECT = '__capy_discovery_new_project__';

// COPY-FLAG: new user-facing string, minimal/neutral wording.
export async function defaultAskExistingOrNewProject(
  existing: ReadonlyArray<{ id: string; name: string }>,
  defaultName: string,
): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const { projectChoice } = await inquirer.prompt([
    discoveryProjectQuestion(existing, defaultName, DISCOVERY_NEW_PROJECT),
  ]);
  return projectChoice;
}

// COPY-FLAG: new user-facing string, minimal/neutral wording.
/**
 * Validates a discovery project-name answer: non-empty, at most
 * `DISCOVERY_PROJECT_NAME_MAX_LENGTH` chars, not the reserved `_system` name
 * (Vince, 2026-09-26, decision #4). Deliberately no charset restriction —
 * `/` (and anything else `defaultDiscoveryProjectName` might produce) must
 * stay allowed here; that's a separate concern from this ticket's scope.
 */
function discoveryProjectNameProblem(trimmed: string): string | null {
  if (!trimmed) return 'A project name is required.';
  if (trimmed.length > DISCOVERY_PROJECT_NAME_MAX_LENGTH) {
    return `Project name must be ${DISCOVERY_PROJECT_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (isReservedProjectName(trimmed)) return PROJECT_NAME_RESERVED_MESSAGE;
  return null;
}

export async function defaultAskDiscoveryProjectName(defaultName: string): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const { name } = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'New Capy project name:',
      default: defaultName,
      filter: (v: string) => v.trim(),
      // Re-asks automatically (inquirer's own validate loop) rather than
      // ever reaching `ensureProjectSafe` with a name it would refuse
      // the project-name-too-long refusal / `PROJECT_NAME_RESERVED` for.
      validate: (v: string) => discoveryProjectNameProblem(v.trim()) ?? true,
    },
  ]);
  return name;
}

// COPY-FLAG: new user-facing string, minimal/neutral wording.
export async function defaultAskDiscoveryCommitBranchName(defaultName: string): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const { name } = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Commit the import to which git branch:',
      default: defaultName,
      filter: (v: string) => v.trim(),
      // Re-asks automatically (inquirer's own validate loop) rather than
      // ever reaching `commitDiscoveryChanges` with a name it would refuse
      // the commit-branch-invalid refusal for — that refusal is still the
      // authoritative, zero-mutation-guaranteed check for every OTHER
      // path into this function (non-interactive, an injected test dep).
      validate: (v: string) => (isValidDiscoveryCommitBranchName(v.trim()) ? true : 'Not a valid git branch name.'),
    },
  ]);
  return name;
}

// COPY-FLAG: new user-facing string, minimal/neutral wording.
export async function defaultPickCollisionWinner(collision: DiscoveryCollision): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const { winner } = await inquirer.prompt([
    {
      type: 'list',
      name: 'winner',
      message: `${collision.folder || '.'} / ${collision.environmentName}: which service feeds this branch?`,
      choices: collision.candidates.map((c) => ({ name: `${c.projectName} / ${c.serviceName}`, value: c.serviceId })),
    },
  ]);
  return winner;
}

// ── --overwrite ──────────────────────────────────────────────────────────────

export interface OverwritePlan {
  /** Local names the provider no longer has, and that aren't a reference value — removed entirely. */
  toClear: readonly string[];
  /** Present in both with a DIFFERENT value — overwritten with the provider's. */
  toReplace: ReadonlyArray<{ name: string; value: string }>;
  /** Only at the provider — a plain new write. */
  toImport: ReadonlyArray<{ name: string; value: string }>;
  /** Present in both with the SAME value — no-op. */
  unchanged: readonly string[];
}

/**
 * `--overwrite`'s own rule: the branch's vars become EXACTLY the provider's
 * importable set. `localPlaintext` names absent from the provider's set are
 * cleared — EXCEPT a reference-valued name (`${{...}}`, `referenceNames`):
 * there is no resolved value to replace it with, so it is left alone rather
 * than cleared (the caller's reference-value warning already says
 * so). `sourceCandidates` must be the provider's FULL importable set, never one
 * already narrowed by `--var` — narrowing it here would make a restricted
 * overwrite clear a name the provider still has, just outside the restriction
 * (see the call site in `import()`, which computes this from the
 * unrestricted list on purpose).
 */
export function computeOverwritePlan(
  sourceCandidates: ReadonlyArray<{ name: string; value: string }>,
  referenceNames: readonly string[],
  localPlaintext: Readonly<Record<string, string>>,
): OverwritePlan {
  const sourceNames = new Set(sourceCandidates.map((c) => c.name));
  const referenceSet = new Set(referenceNames);
  return {
    toClear: Object.keys(localPlaintext).filter((k) => !sourceNames.has(k) && !referenceSet.has(k)),
    toReplace: sourceCandidates.filter((c) => localPlaintext[c.name] !== undefined && localPlaintext[c.name] !== c.value),
    toImport: sourceCandidates.filter((c) => localPlaintext[c.name] === undefined),
    unchanged: sourceCandidates.filter((c) => localPlaintext[c.name] === c.value).map((c) => c.name),
  };
}

/** Plan-time-only local keep.lock read (no auth) — see `PeekLocalKeep`'s own doc. */
export function peekLocalKeepForFolder(repoDir: string, folder: string): KeepFile | null {
  return new ProjectManager(folder ? join(repoDir, folder) : repoDir).readKeepFile();
}

const folderPath = (repoDir: string, folder: string): string => (folder ? join(repoDir, folder) : repoDir);

/** keep.lock and .gitignore, relative to `repoDir` — the ONLY paths discovery's own commit step ever touches. */
export function discoveryCommitPathsFor(folder: string): readonly string[] {
  const prefix = folder ? `${folder}/` : '';
  return [`${prefix}keep.lock`, `${prefix}.gitignore`];
}

/**
 * Every REPO the plan touches, and the branch/files a real run WOULD commit
 * for it — dry-run preview only, never runs a git-mutating command (see
 * `commitDiscoveryChanges`'s own `dryRun` handling).
 *
 * `paths` is de-duplicated per repo (cosmetic defect fix): two DISTINCT
 * `DiscoveryPlanFolder` entries can share the same (repoDir, folder) — e.g.
 * two colliding services that both resolve to the same folder, still shown
 * as separate candidates in the pre-resolution `plan.folders` a dry run
 * previews (a dry run never asks for a collision winner) — and
 * `discoveryCommitPathsFor` would otherwise be counted once per entry,
 * reporting `keep.lock`/`.gitignore` twice for what is really one write.
 */
export function commitPreviewForFolders(
  folders: readonly DiscoveryPlanFolder[],
  branchName: string,
  /** How this provider spells the commit refusals. */
  codes: DiscoveryCodes,
  /** The commit subject. */
  commitMessage?: string,
): readonly DiscoveryRepoCommitResult[] {
  const repoDirs = [...new Set(folders.map((f) => f.repoDir))];
  return repoDirs.map((repoDir) => {
    const paths = [...new Set(folders.filter((f) => f.repoDir === repoDir).flatMap((f) => discoveryCommitPathsFor(f.folder)))];
    const outcome = commitDiscoveryChanges(repoDir, paths, new Set(), { branchName, dryRun: true, summaryLines: [], codes, ...(commitMessage ? { commitMessage } : {}) });
    return { repoDir, ...outcome };
  });
}

/**
 * The commit step's real run: per repo touched by `applied`, commits ONLY
 * the SUCCESSFULLY-applied folders' keep.lock/.gitignore (see
 * `commitDiscoveryChanges`'s own doc for the refusal codes) — a repo with
 * zero successful folders is skipped entirely (nothing to commit, no
 * refusal either).
 */
export function commitForAppliedRepos(
  applied: readonly DiscoveryFolderResult[],
  beforeStatusByRepo: ReadonlyMap<string, ReadonlySet<string>>,
  branchName: string,
  /** How this provider spells the commit refusals. */
  codes: DiscoveryCodes,
  /** The commit subject. */
  commitMessage?: string,
): readonly DiscoveryRepoCommitResult[] {
  const repoDirs = [...new Set(applied.map((f) => f.repoDir))];
  return repoDirs.flatMap((repoDir) => {
    const okFolders = applied.filter((f) => f.repoDir === repoDir && f.ok);
    if (okFolders.length === 0) return [];
    const paths = okFolders.flatMap((f) => discoveryCommitPathsFor(f.folder));
    const summaryLines = okFolders.map((f) => `- ${f.folder || '.'}: ${(f as Extract<DiscoveryFolderResult, { ok: true }>).activeBranch}`);
    const outcome = commitDiscoveryChanges(repoDir, paths, beforeStatusByRepo.get(repoDir) ?? new Set(), {
      branchName,
      dryRun: false,
      summaryLines,
      codes,
      ...(commitMessage ? { commitMessage } : {}),
    });
    return [{ repoDir, ...outcome }];
  });
}

/** What `listOrgProjectsOrUnavailable` returns — named here so the non-interactive `--yes` snapshot (see `ensureProjectSafe`'s doc) and the interactive per-folder lookup share one type. */
export type ExistingProjectsSnapshot = {
  existingProjects: ReadonlyArray<{ id: string; name: string; organization_id: string }>;
  projectsUnavailable: boolean;
};

/** A project name, normalized for EQUALITY comparison only (never for storage/display) — trimmed, then lower-cased, so `" Widgets "` and `widgets` compare equal (Vince, 2026-09-26 decision). */
function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase();
}

/** The project-name-exists refusal's message — shared by the org-snapshot collision and the same-run collision below, since a human reads the same instruction either way. */
// COPY-FLAG: new user-facing string, minimal/neutral wording.
function projectNameExistsMessage(folder: string, name: string): string {
  return `${folder || '.'}: a project named "${name}" already exists — reuse or duplicate is a human choice; run interactively or \`capy\` in ${folder || '.'}.`;
}

/** Stable per-(repoDir, folder) key — mirrors `dokployDiscovery.ts`'s own `groupKey` shape (`\u0000`-joined, so neither part can collide with the separator). */
function sameRunFolderKey(repoDir: string, folder: string): string {
  return `${repoDir}\u0000${folder}`;
}

/**
 * Pure, run-once precomputation of "two folders in this SAME run would try
 * to create a project under the SAME default name" (Vince, 2026-09-26
 * decision) — computed from `resolvedFolders` alone, entirely before any
 * folder's own `ensureProject` call runs, so no mutable "names created so
 * far" state needs to be threaded through the sequential per-folder loop
 * (`runDiscoverySequences`'s `ensureProject` dependency has no such
 * accumulator parameter, and this file's own immutability rule forbids
 * inventing one via a mutated `Set`/`Map`).
 *
 * Only folders WITHOUT a local keep.lock are candidates (`!f.initialized`) —
 * an already-initialized folder never creates anything, so it can never
 * collide with, or be collided into by, another folder's create. Folded over
 * `folders` in their OWN array order — the exact order `runDiscoverySequences`
 * processes them in — so "the first one wins" here means the same thing it
 * means at run time. Returns the set of `sameRunFolderKey`s for every folder
 * that is NOT the first candidate to claim its (normalized) default name;
 * the very first claimant of a name is never in the returned set.
 */
export function computeSameRunNameCollisions(folders: readonly DiscoveryPlanFolder[]): ReadonlySet<string> {
  const candidates = folders
    .filter((f) => !f.initialized)
    .map((f) => ({ key: sameRunFolderKey(f.repoDir, f.folder), normalizedName: normalizeProjectName(defaultDiscoveryProjectName(f.repoDir, f.folder, f.remote)) }));

  return candidates.reduce(
    (acc, c) =>
      acc.seenNames.has(c.normalizedName)
        ? { seenNames: acc.seenNames, collisionKeys: new Set([...acc.collisionKeys, c.key]) }
        : { seenNames: new Set([...acc.seenNames, c.normalizedName]), collisionKeys: acc.collisionKeys },
    { seenNames: new Set<string>(), collisionKeys: new Set<string>() },
  ).collisionKeys;
}

/**
 * No keep.lock at (repoDir, folder) → interactive: reuses `capy`'s own
 * existing-project-picking (list the org's projects, ask new-vs-existing —
 * see `defaultAskExistingOrNewProject`), never invents its own project flow.
 * A keep.lock already there is just read for its project id — no network
 * call.
 *
 * Non-interactive WITHOUT `--yes` refuses `codes.folderNotInitialized`
 * naming the folder and never auto-creates — unchanged.
 *
 * Non-interactive WITH `--yes` (Vince, 2026-09-26 decision, SUPERSEDING the
 * original "org has none" rule): creates a new project named `defaultName`
 * UNLESS a project with that EXACT name (trimmed, compared case-insensitively
 * — see `normalizeProjectName`) already exists — an UNRELATED existing
 * project in the org (e.g. a stray empty `root`) no longer blocks anything.
 * A same-name collision refuses `codes.projectNameExists`, naming both
 * the project and the folder — reusing or duplicating an existing project is
 * a genuine human choice with no safe default, same reasoning the old rule
 * used for "org has ANY project", now narrowed to "org has THIS name".
 * `opts.existingProjectsSnapshot` is this run's OWN snapshot (see
 * `buildRealDiscoverySequenceDeps`'s doc): taken ONCE, before any folder in
 * this run starts, so a project an EARLIER folder in this same run created
 * is never counted as "existing" when deciding a LATER folder's own
 * name-collision answer. A snapshot that failed to load is
 * `codes.projectLookupFailed`, same as the interactive branch below and
 * same as before this decision.
 *
 * The snapshot alone cannot catch two DIFFERENT folders in this SAME run
 * both defaulting to the same name (neither one is "existing" yet when the
 * snapshot was taken) — `opts.sameRunNameCollision` is `ensureProjectSafe`'s
 * OWN pure precomputed answer to exactly that (see
 * `computeSameRunNameCollisions`), and refuses the SAME
 * `codes.projectNameExists` code for whichever folder is the SECOND (or
 * later) occurrence in run order; the first occurrence proceeds normally.
 *
 * Deliberately NOT a call into `CapyCommand` itself: that class calls
 * `process.exit()` on several failure paths and always builds its own
 * `ProjectManager()`/`FileManager()` against `process.cwd()`, neither of
 * which a multi-folder run can tolerate (one folder's exit would kill every
 * other folder still to run, and there is no way to point it at a folder
 * other than `cwd`). This reuses the SAME underlying `ServiceClient` calls
 * (`listProjects`, `initializeProject`) and mirrors `capyCommand.ts`'s own
 * `bootstrapExistingProject` for the existing-project branch (see
 * `bootstrapExistingProjectSafe`, below), scoped to one folder and returning
 * a coded outcome instead of exiting.
 */
async function ensureProjectSafe(
  ctx: DiscoveryContext,
  repoDir: string,
  folder: string,
  /** This folder's repo's own parsed `origin`, when known — see `defaultDiscoveryProjectName`'s decision #2 doc; passed through rather than re-read here. */
  remote: GitRemoteRef | undefined,
  opts: {
    interactive: boolean;
    /** Discovery's OWN `--yes` — skips the new-project NAME prompt (defaulting to `defaultName`) the same way it skips every other confirmation, never the existing-vs-new picker itself (that one isn't a confirmation, it's a genuine choice with no safe default) — EXCEPT non-interactively, where a same-name collision has no choice left to make (see this function's own doc). */
    yes: boolean;
    askExistingOrNewProject: (existing: ReadonlyArray<{ id: string; name: string }>, defaultName: string) => Promise<string>;
    askProjectName: (defaultName: string) => Promise<string>;
    /** This run's ONE pre-apply snapshot of the org's existing projects — only consulted on the non-interactive `--yes` auto-create path; `undefined` there means the snapshot itself failed to load. */
    existingProjectsSnapshot?: ExistingProjectsSnapshot;
    /** This folder's own precomputed answer to "does an EARLIER folder in this SAME run already claim this default name" (see `computeSameRunNameCollisions`) — only consulted on the non-interactive `--yes` auto-create path. */
    sameRunNameCollision: boolean;
    /** How this provider spells the refusals. */
    codes: DiscoveryCodes;
  },
): Promise<{ ok: true; projectId: string; created: boolean } | { ok: false; code: string; message: string }> {
  const path = folderPath(repoDir, folder);
  const pm = new ProjectManager(path);
  const existing = pm.readKeepFile();
  if (existing) {
    return { ok: true, projectId: existing.project_id, created: false };
  }
  const defaultName = defaultDiscoveryProjectName(repoDir, folder, remote);

  if (!opts.interactive) {
    if (!opts.yes) {
      return {
        ok: false,
        code: opts.codes.folderNotInitialized,
        message: `${folder || '.'} has no keep.lock. Run \`capy\` there to initialize it, then re-run discovery.`,
      };
    }
    const snapshot = opts.existingProjectsSnapshot;
    if (!snapshot || snapshot.projectsUnavailable) {
      return {
        ok: false,
        code: opts.codes.projectLookupFailed,
        message: `${folder || '.'}: could not list this org's existing projects — refusing to offer "create new" blind.`,
      };
    }
    const sameNameProject = snapshot.existingProjects.find((p) => normalizeProjectName(p.name) === normalizeProjectName(defaultName));
    if (sameNameProject || opts.sameRunNameCollision) {
      return {
        ok: false,
        code: opts.codes.projectNameExists,
        message: projectNameExistsMessage(folder, defaultName),
      };
    }
    return createNewProjectSafe(ctx, path, folder, defaultName, opts.codes);
  }

  // A lookup failure is NOT "this org has no projects" — offering only
  // "create new" on a transient network/auth error risks a duplicate
  // project the human never asked for. Abort THIS folder instead (a
  // follow-up defect fix) — the SAME distinction `capy`'s own init makes
  // (`listOrgProjectsOrUnavailable`, extracted from `capyCommand.ts`).
  const { existingProjects, projectsUnavailable } = await listOrgProjectsOrUnavailable(ctx.serviceClient);
  if (projectsUnavailable) {
    return {
      ok: false,
      code: opts.codes.projectLookupFailed,
      message: `${folder || '.'}: could not list this org's existing projects — refusing to offer "create new" blind.`,
    };
  }
  const picked = await opts.askExistingOrNewProject(existingProjects.map((p) => ({ id: p.id, name: p.name })), defaultName);

  if (picked !== DISCOVERY_NEW_PROJECT) {
    const project = existingProjects.find((p) => p.id === picked);
    if (!project) {
      return { ok: false, code: opts.codes.projectNotFound, message: `No project ${picked} in this org.` };
    }
    try {
      await bootstrapExistingProjectSafe(ctx, pm, new FileManager(path), project);
      return { ok: true, projectId: project.id, created: false };
    } catch (err) {
      return { ok: false, code: opts.codes.initFailed, message: err instanceof Error ? err.message : String(err) };
    }
  }
  // Mirrors `capyCommand.ts#resolveProjectName`: ask for the new project's
  // name (default = `defaultName`). `--yes` skips the ask — same "proceed
  // without asking" contract as every other discovery confirmation — and
  // uses the default outright.
  const chosenName = opts.yes ? defaultName : await opts.askProjectName(defaultName);
  return createNewProjectSafe(ctx, path, folder, chosenName, opts.codes);
}

/**
 * Creates a brand-new project named `chosenName` and initializes (repoDir,
 * folder) onto it — the exact write sequence the interactive "New project"
 * choice runs (`ensureProjectSafe`'s own interactive branch), reused
 * verbatim by the non-interactive `--yes` auto-create path (Vince,
 * 2026-09-26 decision) so the two can never drift apart.
 */
async function createNewProjectSafe(
  ctx: DiscoveryContext,
  path: string,
  folder: string,
  chosenName: string,
  codes: DiscoveryCodes,
): Promise<{ ok: true; projectId: string; created: boolean } | { ok: false; code: string; message: string }> {
  // Vince, 2026-09-26, decision #4: refuse before any write when the name
  // (default or human-typed) is over 255 chars — never truncated. The real
  // `defaultAskDiscoveryProjectName` prompt validates this itself and
  // re-asks (so an interactive human self-corrects before ever returning
  // here); this is the zero-write guarantee for `--yes` and for any
  // injected `askProjectName` test double that skips that validation.
  if (chosenName.length > DISCOVERY_PROJECT_NAME_MAX_LENGTH) {
    return {
      ok: false,
      code: codes.projectNameTooLong,
      message: `${folder || '.'}: project name is longer than ${DISCOVERY_PROJECT_NAME_MAX_LENGTH} characters.`,
    };
  }
  try {
    assertProjectNameAllowed(chosenName);
    const initResult = await ctx.serviceClient.initializeProject(chosenName, ctx.orgId);
    const keep: KeepFile = {
      version: '3.0',
      org_id: initResult.org_id,
      project_id: initResult.project_id,
      project_name: initResult.project_name,
      variables: {},
    };
    // A discovered folder several levels deep (e.g. `backend/deployment`)
    // may not exist yet under `repoDir` — `writeKeepFile` writes directly,
    // with no directory creation of its own (unlike `writeEncryptedEnvFile`,
    // which does).
    mkdirSync(path, { recursive: true });
    const fm = new FileManager(path);
    fm.writeKeepFile(keep);
    fm.ensureCapyGitignore();
    return { ok: true, projectId: initResult.project_id, created: true };
  } catch (err) {
    return { ok: false, code: codes.initFailed, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The entries of `encrypted` that `encryptionKey` decrypts; the rest (the person lacks variable-level permission) are skipped. */
function decryptableEntries(fm: FileManager, encrypted: Readonly<Record<string, string>>, encryptionKey: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(encrypted).flatMap(([k, v]): ReadonlyArray<readonly [string, string]> => {
      try {
        return [[k, fm.decryptValue(v, encryptionKey)]];
      } catch {
        return [];
      }
    }),
  );
}

/**
 * Bootstrap an EXISTING project into (repoDir, folder) — mirrors
 * `capyCommand.ts#bootstrapExistingProject` exactly (pull `development`'s
 * keep.json + env blob, decrypt, write keep.lock + `.env`), scoped to one
 * folder's own `pm`/`fm` rather than `process.cwd()`, and — unlike the
 * original — branching on `err.details?.status === 404` alone rather than
 * ALSO matching a `/No secrets/i` message (Rule 5: never branch on
 * human-readable text; the status code alone already says "no snapshot").
 */
async function bootstrapExistingProjectSafe(
  ctx: DiscoveryContext,
  pm: ProjectManager,
  fm: FileManager,
  project: { id: string; name: string; organization_id: string },
): Promise<void> {
  const branch = 'development';
  const keyOps = {
    coDecrypt: (oid: string, ct: string) => ctx.serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
    wrapOuterLayer: (oid: string, pt: string) => ctx.serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
  };
  const encryptionKey = await resolveProjectKey(project.organization_id, project.id, ctx.userId, keyOps);

  const decryptData = await ctx.serviceClient.getDecryptData(project.id, branch, undefined, true).catch((err) => {
    if ((err as { details?: { status?: number } })?.details?.status === 404) {
      return { env_content: '', keep_file: '', decrypt_key: '', expires_at: new Date().toISOString() };
    }
    throw err;
  });

  const stub: KeepFile = { version: '3.0', org_id: project.organization_id, project_id: project.id, project_name: project.name, variables: {} };
  const serverKeep: KeepFile = decryptData.keep_file
    ? { ...(JSON.parse(decryptData.keep_file) as KeepFile), org_id: project.organization_id, project_id: project.id, project_name: project.name }
    : stub;

  const plaintext: Record<string, string> = decryptData.env_content
    ? decryptableEntries(fm, fm.parseEnvContent(decryptData.env_content), encryptionKey)
    : {};

  fm.writeKeepFile(serverKeep);
  pm.writeActiveBranch(branch);
  fm.ensureCapyGitignore();
  fm.writeEncryptedEnvFile(plaintext, encryptionKey, undefined, serverKeep, branch);
}

/**
 * The SAME dirty-working-tree guard `capy checkout` enforces
 * (`checkoutCommand.ts#findDirtyBranchIssue`), run ONCE per folder before
 * its FIRST checkout — never per environment, and never for a folder whose
 * project was just created this run (nothing to be dirty about yet). A
 * dirty folder aborts with zero writes; every later checkout in the SAME
 * folder just switched away from a branch this run itself wrote, which is
 * clean by construction, so re-checking per environment would be pure
 * overhead for a result that can't change mid-run.
 */
async function checkFolderDirtySafe(
  ctx: DiscoveryContext,
  repoDir: string,
  folder: string,
  projectId: string,
  codes: DiscoveryCodes,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const path = folderPath(repoDir, folder);
  const pm = new ProjectManager(path);
  const fm = new FileManager(path);
  const keyOps = {
    coDecrypt: (oid: string, ct: string) => ctx.serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
    wrapOuterLayer: (oid: string, pt: string) => ctx.serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
  };
  const tryResolveKey = async (): Promise<{ ok: true; value: string } | { ok: false; message: string }> => {
    try {
      return { ok: true, value: await resolveProjectKey(ctx.orgId, projectId, ctx.userId, keyOps) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
  const keyResult = await tryResolveKey();
  if (!keyResult.ok) {
    return { ok: false, code: codes.keyResolutionFailed, message: keyResult.message };
  }
  const issue = findDirtyBranchIssue(pm, fm, keyResult.value);
  if (!issue) return { ok: true };
  const detail = issue.code === 'UNCOMMITTED_CHANGES' ? `an uncommitted change (${issue.varName})` : 'unpushed changes';
  return {
    ok: false,
    code: codes.folderDirty,
    message: `${folder || '.'} has ${detail} on "${issue.branch}". Run \`capy\` there to push, or discard the change, then re-run discovery.`,
  };
}

/**
 * Switches (repoDir, folder) onto `branchName` — pulls it if it already
 * exists on the server (same as `capy checkout <branch>`), or creates it,
 * seeded from the folder's CURRENT `.env` (same as `capy checkout -b
 * <branch>` — the git-model copy), otherwise. Mirrors
 * `checkoutCommand.ts#_execute`'s core — including its dirty-working-tree
 * guard, run ONCE per folder before the first call to this function (see
 * `DiscoverySequenceDeps.checkFolderDirty`; every LATER checkout in the same
 * folder just switched away from a branch this run itself wrote, which is
 * clean by construction) — scoped to ONE folder and never `process.exit`s;
 * a failure comes back as `{ ok: false }` so the caller can abort just this
 * folder. `createBranch(..., false)`: a discovery-created branch is never
 * protected — there is no flow yet for discovery to ask "should this be
 * invite-only", so it always defaults to the same open access every other
 * branch this run creates gets.
 */
async function checkoutBranchSafe(
  ctx: DiscoveryContext,
  repoDir: string,
  folder: string,
  projectId: string,
  branchName: string,
  codes: DiscoveryCodes,
): Promise<{ ok: true; created: boolean } | { ok: false; code: string; message: string }> {
  const path = folderPath(repoDir, folder);
  const pm = new ProjectManager(path);
  const fm = new FileManager(path);
  try {
    const keyOps = {
      coDecrypt: (oid: string, ct: string) => ctx.serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
      wrapOuterLayer: (oid: string, pt: string) => ctx.serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
    };
    const encryptionKey = await resolveProjectKey(ctx.orgId, projectId, ctx.userId, keyOps);

    const branches = await ctx.serviceClient.listBranches(projectId);
    const created = !branches.some((b) => b.name === branchName);
    if (created) {
      await ctx.serviceClient.createBranch(projectId, branchName, false);
    }

    const decryptResult = await (async (): Promise<
      | { ok: true; data: Awaited<ReturnType<typeof ctx.serviceClient.getDecryptData>> }
      | { ok: false; code: string; message: string }
    > => {
      try {
        return { ok: true, data: await ctx.serviceClient.getDecryptData(projectId, branchName, undefined, true) };
      } catch (err) {
        const status = (err as { details?: { status?: number } })?.details?.status;
        if (status === 404) {
          return { ok: true, data: { env_content: '', keep_file: '', decrypt_key: '', expires_at: new Date().toISOString() } };
        }
        if (status === 403) {
          return { ok: false, code: codes.branchProtected, message: `"${branchName}" is a protected branch — access is invite-only.` };
        }
        throw err; // an anomaly — let the outer catch report it as `codes.checkoutFailed`.
      }
    })();
    if (!decryptResult.ok) return decryptResult;
    const decryptData = decryptResult.data;

    const existingKeep = pm.readKeepFile();
    if (!existingKeep) {
      return { ok: false, code: codes.keepMissing, message: `${folder || '.'} has no keep.lock.` };
    }
    // Splice in only THIS branch's server pins — keep.lock holds every
    // branch's metadata and is git-owned; a sibling branch's pins must not
    // move just because this one was checked out.
    const keepForWrite: KeepFile = decryptData.keep_file
      ? SyncEngine.spliceKeepBranch(existingKeep, JSON.parse(decryptData.keep_file) as KeepFile, branchName)
      : existingKeep;
    if (keepForWrite !== existingKeep) fm.writeKeepFile(keepForWrite);

    if (decryptData.env_content) {
      const decrypted = decryptableEntries(fm, fm.parseEnvContent(decryptData.env_content), encryptionKey);
      fm.writeEncryptedEnvFile(decrypted, encryptionKey, undefined, keepForWrite, branchName);
    } else if (created) {
      // Git model: a brand-new branch inherits the folder's CURRENT `.env` —
      // the exact seed `capy checkout -b` performs. Unreadable current
      // `.env` (or none yet) falls through to an empty seed.
      const tryReadCurrentEnv = (): Record<string, string> => {
        try {
          return fm.readEncryptedEnvFile(encryptionKey);
        } catch {
          return {};
        }
      };
      fm.writeEncryptedEnvFile(tryReadCurrentEnv(), encryptionKey, undefined, keepForWrite, branchName);
    } else {
      // An EXISTING branch with no snapshot yet: stamp an empty file for it.
      fm.writeEncryptedEnvFile({}, encryptionKey, undefined, keepForWrite, branchName);
    }

    pm.writeActiveBranch(branchName);
    return { ok: true, created };
  } catch (err) {
    return { ok: false, code: codes.checkoutFailed, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs the single-service import itself (`importFn` — the very function
 * `import()` above defines, reused directly rather than going through
 * `ConnectCommand`: that class's `executeImport` prints its own terminal/
 * JSON lines as a side effect, which would corrupt discovery's OWN single
 * JSON line under `--json`, and `resolveContext()` re-authenticates and
 * re-reads `process.cwd()` rather than accepting an already-resolved
 * folder + session) against the branch `checkoutBranchSafe` just switched
 * onto, then writes the result via the SAME `writeImportOutcome` helper
 * `executeImport` uses — same push, same skip-auto-commit, same
 * clear-pruning for `--overwrite`.
 */
async function importIntoBranchSafe(
  ctx: DiscoveryContext,
  importFn: (ctx: ResolvedContext, opts: ConnectOpts) => Promise<ImportOutcome>,
  repoDir: string,
  folder: string,
  env: DiscoveryPlanEnv,
  overwrite: boolean,
  runOpts: {
    noPush: boolean;
    interactive: boolean;
    json: boolean;
    yes: boolean;
    gate: GateOptions;
    /** The provider supplies the per-step import options itself (its source, its token, the names already known from its plan). */
    importOptsFor: (env: DiscoveryPlanEnv, projectName: string, folderPath: string) => ConnectOpts;
    /** How this provider spells the refusals. */
    codes: DiscoveryCodes;
  },
  /** This environment's provider PROJECT name — already known from the plan's own read, threaded through so `import()` never re-fetches it. */
  projectName: string,
): Promise<ImportOutcome> {
  const path = folderPath(repoDir, folder);
  const pm = new ProjectManager(path);
  const fm = new FileManager(path);

  const projectState = await pm.detectProjectState();
  if (!projectState.initialized || !projectState.organizationId || !projectState.projectId || !projectState.activeBranch) {
    return { ok: false, code: runOpts.codes.keepMissing, message: `${folder || '.'} is not on a branch after checkout.` };
  }
  const keep = pm.readKeepFile();
  if (!keep) {
    return { ok: false, code: runOpts.codes.keepMissing, message: `${folder || '.'} has no keep.lock.` };
  }

  const keyOps = {
    coDecrypt: (oid: string, ct: string) => ctx.serviceClient.coDecrypt(oid, ct).then((r) => r.plaintext),
    wrapOuterLayer: (oid: string, pt: string) => ctx.serviceClient.wrapOuterLayer(oid, pt).then((r) => r.ciphertext),
  };
  const tryResolveProjectKey = async (): Promise<{ ok: true; value: string } | { ok: false; message: string }> => {
    try {
      return { ok: true, value: await resolveProjectKey(projectState.organizationId!, projectState.projectId!, ctx.userId, keyOps) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
  const projectKeyResult = await tryResolveProjectKey();
  if (!projectKeyResult.ok) {
    return { ok: false, code: runOpts.codes.keyResolutionFailed, message: projectKeyResult.message };
  }
  const projectKey = projectKeyResult.value;

  const localPlaintext: Record<string, string> = Object.fromEntries(
    Object.entries(fm.readEnvFile()).flatMap(([k, v]): ReadonlyArray<readonly [string, string]> => {
      if (!v.startsWith('capy:')) return [[k, v]];
      try {
        return [[k, fm.decryptValue(v, projectKey)]];
      } catch {
        // Skip undecryptable.
        return [];
      }
    }),
  );

  const resolvedCtx: ResolvedContext = {
    pm,
    fileManager: fm,
    authService: ctx.authService,
    serviceClient: ctx.serviceClient,
    orgId: projectState.organizationId,
    projectId: projectState.projectId,
    branch: projectState.activeBranch,
    userId: ctx.userId,
    projectKey,
    keep,
    localPlaintext,
    // This folder's own gate: if Capy refuses the upload as stale, bare `capy` runs again IN THIS FOLDER and the write retries.
    gate: { ...runOpts.gate, cwd: path, throwConflicts: true },
  };
  const sharedImportOpts = {
    overwrite,
    noPush: runOpts.noPush,
    nonTty: !runOpts.interactive,
    json: runOpts.json,
    yes: runOpts.yes,
  };
  const importOpts: ConnectOpts = { ...sharedImportOpts, ...runOpts.importOptsFor(env, projectName, path) };

  const outcome = await importFn(resolvedCtx, importOpts);
  if (!outcome.ok) return outcome;

  // A push failure here must become THIS folder's coded failure, never an
  // uncaught rejection — `runDiscoverySequences` awaits one folder's
  // sequence at a time, so letting this throw would abort every folder
  // still queued behind this one, not just this one.
  try {
    await writeImportOutcome(resolvedCtx, outcome, { push: !runOpts.noPush, dryRun: false });
  } catch (err) {
    // A refused-as-stale upload keeps its own code; anything else is the push failing.
    return { ok: false, code: pushFailureCode(err, runOpts.codes), message: err instanceof Error ? err.message : String(err) };
  }
  return outcome;
}

/**
 * The coded reason a folder's upload failed: a difference found by the retry's bare `capy` and a second stale refusal keep
 * their own codes. For a provider that reports the neutral codes (`DiscoveryCodes.keepsServiceCode`), a typed error from
 * the service (`PERMISSION_DENIED`, `QUOTA_EXCEEDED`, …) keeps its own code too, instead of being flattened to the push code;
 * the generic `SERVICE_ERROR` and an untyped error are the push code. The decision reads the code, never the message.
 */
function pushFailureCode(err: unknown, codes: DiscoveryCodes): string {
  if (isConflictRefusal(err)) return err.code;
  if (isStaleBase(err)) return ERROR_CODES.SECRETS_STALE_BASE;
  if (codes.keepsServiceCode && err instanceof CapyError && err.code !== ERROR_CODES.SERVICE_ERROR) return err.code;
  return codes.pushFailed;
}

/**
 * The REAL `DiscoverySequenceDeps`, wired to an already-authenticated `ctx`
 * — the discovery scan's own org/session, reused for every folder rather
 * than re-authenticating per folder.
 */
export function buildRealDiscoverySequenceDeps(
  ctx: DiscoveryContext,
  importFn: (ctx: ResolvedContext, opts: ConnectOpts) => Promise<ImportOutcome>,
  runOpts: {
    noPush: boolean;
    interactive: boolean;
    json: boolean;
    yes: boolean;
    /** The provider's per-step import options (see `importIntoBranchSafe`). */
    importOptsFor: (env: DiscoveryPlanEnv, projectName: string, folderPath: string) => ConnectOpts;
    /** How this provider spells the refusals. */
    codes: DiscoveryCodes;
    /** How bare `capy` runs in each discovered folder (discovery never prompts: it answers by protocol). */
    gate: GateOptions;
    /** Runs bare `capy` in one folder: the real `syncFolder` unless a test supplies its own. */
    syncFolder: (dir: string, gate: GateOptions) => Promise<FolderSync>;
    askExistingOrNewProject: (existing: ReadonlyArray<{ id: string; name: string }>, defaultName: string) => Promise<string>;
    askProjectName: (defaultName: string) => Promise<string>;
    /**
     * The non-interactive `--yes` auto-create snapshot (see
     * `ensureProjectSafe`'s doc) — taken ONCE by `discover()` itself, before
     * `runDiscoverySequences` starts, and handed to EVERY folder's own
     * `ensureProject` call unchanged, so a project one folder creates this
     * run never alters a later folder's "org has none" answer. `undefined`
     * when this run's mode never needs it (interactive, or non-interactive
     * without `--yes`).
     */
    existingProjectsSnapshot?: ExistingProjectsSnapshot;
    /**
     * This run's OWN pure precomputation (see `computeSameRunNameCollisions`)
     * of "which candidate folders' default project name collides with an
     * EARLIER folder in this same run" — keyed by `sameRunFolderKey`. Passed
     * through unchanged to every folder's own `ensureProject` call, same
     * shape as `existingProjectsSnapshot` above.
     */
    sameRunNameCollisions: ReadonlySet<string>;
  },
): DiscoverySequenceDeps {
  return {
    syncFolder: (repoDir, folder) => runOpts.syncFolder(folderPath(repoDir, folder), runOpts.gate),
    ensureProject: (repoDir, folder, remote) =>
      ensureProjectSafe(ctx, repoDir, folder, remote, {
        interactive: runOpts.interactive,
        yes: runOpts.yes,
        askExistingOrNewProject: runOpts.askExistingOrNewProject,
        askProjectName: runOpts.askProjectName,
        existingProjectsSnapshot: runOpts.existingProjectsSnapshot,
        sameRunNameCollision: runOpts.sameRunNameCollisions.has(sameRunFolderKey(repoDir, folder)),
        codes: runOpts.codes,
      }),
    checkFolderDirty: (repoDir, folder, projectId) => checkFolderDirtySafe(ctx, repoDir, folder, projectId, runOpts.codes),
    checkoutBranch: (repoDir, folder, projectId, branchName) => checkoutBranchSafe(ctx, repoDir, folder, projectId, branchName, runOpts.codes),
    importIntoBranch: (repoDir, folder, env, overwrite, projectName) =>
      importIntoBranchSafe(ctx, importFn, repoDir, folder, env, overwrite, runOpts, projectName),
  };
}

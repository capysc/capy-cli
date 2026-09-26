/**
 * `capy connect dokploy` — a ONE-TIME IMPORT of env vars from a Dokploy
 * Application OR Compose service into this project's `.env`, then encrypted
 * + synced the same way every other connector's write lands (CAP-662, parent
 * CAP-657; Compose support + `--dry-run` are a CAP-657 follow-up — every one
 * of the target org's Dokploy services is a Compose service, not an
 * Application).
 *
 * This is the PULL half of the Dokploy integration; `capy deploy` (the PUSH
 * half, see `../../deploy/adapters/dokploy.ts` and
 * `docs/dokploy-deploy-adapter.md`) delivers Capy's own runtime pair back out
 * to an Application only — there is no compose deploy adapter, so a compose
 * import never offers a deploy target (see `maybeOfferDeployTarget`'s call
 * site in `import()`, below).
 *
 * Import is READ-ONLY on the Dokploy side: the only call this file ever makes
 * is `GET application.one` or `GET compose.one` — never a write. The API
 * token itself is never stored by THIS file — it comes from
 * `resolveDokployApiKey` (CAP-664): the org system store's
 * `_CONNECTOR_DOKPLOY_API_KEY` entry by default (which the store itself may
 * prompt for and save, once, on an admin's first use), or the NAME of an env
 * var holding it (`--token-env`, default `DOKPLOY_API_KEY` /
 * `dokployApi.DEFAULT_TOKEN_ENV`) when that's explicitly set. Resolved before
 * any Dokploy request, and never prompted under `--dry-run` (Vince's rule: a
 * dry run changes nothing).
 *
 * `kind: 'import'` (see `registry.ts`) routes `capy connect dokploy` to
 * `import()` below instead of the single-variable `connect()`/`rotate()`
 * pair every other connector uses — there is no sensible "which variable"
 * question for a run that pulls many at once, and no rotation: re-running is
 * how you refresh it, and `capy rotate` refuses on a dokploy-managed var
 * (see `rotateCommand.ts`).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TargetConfig } from '../../deploy/adapter';
import { baseUrlProblem } from '../../deploy/adapters/dokploy';
import {
  DEFAULT_TOKEN_ENV,
  DokployApiError,
  DokployClient,
  DokployImportSource,
  DokploySystemStoreCallOptions,
  FetchLike,
  classifyImportCandidates,
  createDokployClient,
  describeDokployTokenProblem,
  dokploySecretsMayPrompt,
  listImportableEntries,
  resolveDokployApiKey,
} from '../../deploy/dokployApi';
import { ConnectorMetadata, KeepFile } from '../../types/index';
import { isInteractive } from '../../ui/interactive';
import { ProjectManager } from '../../core/projectManager';
import { FileManager } from '../../files/fileManager';
import { resolveProjectKey } from '../../crypto/keyResolver';
import { SyncEngine } from '../../sync/syncEngine';
import { assertProjectNameAllowed, isReservedProjectName, PROJECT_NAME_RESERVED_MESSAGE } from '../../system/reservedProjectName';
import { findDirtyBranchIssue } from '../checkoutCommand';
import { listOrgProjectsOrUnavailable } from '../capyCommand';
import { commitDiscoveryChanges, defaultDiscoveryCommitBranchName, isValidDiscoveryCommitBranchName, snapshotPathStatus } from '../../git/discoveryCommit';
import { fingerprint, writeImportedAndSync, writeImportOutcome, ResolvedContext } from './shared';
import { ConnectOpts, ConnectorModule, ConnectResult, ImportOutcome, ImportWarning, RotateResult } from './registry';
import {
  CandidateRepo,
  DISCOVERY_PROJECT_NAME_MAX_LENGTH,
  DiscoveryCollision,
  DiscoveryContext,
  DiscoveryFolderResult,
  DiscoveryOutcome,
  DiscoveryPlan,
  DiscoveryPlanEnv,
  DiscoveryPlanFolder,
  DiscoveryRepoCommitResult,
  DiscoverySequenceDeps,
  GitRemoteRef,
  applyCollisionResolutions,
  buildDiscoveryPlan,
  defaultDiscoveryProjectName,
  findCandidateReposResult,
  orderEnvironments,
  resolveCollisions,
  runDiscoverySequences,
} from './dokployDiscovery';

/** Same option shape `capy deploy dokploy` targets store (see adapters/dokploy.ts). */
interface DokployTargetOptions {
  baseUrl?: string;
  applicationId?: string;
  tokenEnv?: string;
}

// ── Settings resolution ─────────────────────────────────────────────────────

export type DokploySettingsResult =
  | { ok: true; baseUrl: string; applicationId: string; tokenEnv: string }
  | { ok: false; code: 'DOKPLOY_TARGET_AMBIGUOUS' | 'DOKPLOY_SETTINGS_MISSING'; message: string };

export interface DokploySettingsDeps {
  pickTarget: (names: readonly string[]) => Promise<string>;
  askSettings: () => Promise<{ baseUrl: string; applicationId: string }>;
}

/**
 * Base URL + application id + token-var-name, in the priority order CAP-662
 * decided: `--base-url`/`--application` flags, then the lone saved Dokploy
 * deploy target, then an interactive ask, then a non-interactive refusal.
 * `--token-env` (or a saved target's own `tokenEnv`) always overrides
 * independently — it is a simple knob, not part of what makes targets
 * ambiguous.
 *
 * Pure aside from the two injected prompts, so it is testable with a plain
 * array of `TargetConfig` and stub callbacks — no fs, no network.
 */
export async function resolveDokploySettings(
  opts: ConnectOpts,
  dokployTargets: readonly TargetConfig[],
  interactive: boolean,
  deps: DokploySettingsDeps,
): Promise<DokploySettingsResult> {
  const tokenEnvFlag = opts.tokenEnv?.trim();
  const fromTarget = (t: TargetConfig): DokploySettingsResult => {
    const saved = t.options as DokployTargetOptions;
    return {
      ok: true,
      baseUrl: (opts.baseUrl ?? saved.baseUrl ?? '').trim(),
      applicationId: (opts.application ?? saved.applicationId ?? '').trim(),
      tokenEnv: tokenEnvFlag || saved.tokenEnv || DEFAULT_TOKEN_ENV,
    };
  };

  if (opts.baseUrl && opts.application) {
    return {
      ok: true,
      baseUrl: opts.baseUrl.trim(),
      applicationId: opts.application.trim(),
      tokenEnv: tokenEnvFlag || DEFAULT_TOKEN_ENV,
    };
  }

  if (dokployTargets.length === 1) {
    return fromTarget(dokployTargets[0]);
  }

  if (dokployTargets.length > 1) {
    if (!interactive) {
      return {
        ok: false,
        code: 'DOKPLOY_TARGET_AMBIGUOUS',
        message:
          `Several Dokploy deploy targets are configured (${dokployTargets.map((t) => t.name).join(', ')}). ` +
          'Pass --base-url and --application, or run this interactively to pick one.',
      };
    }
    const picked = await deps.pickTarget(dokployTargets.map((t) => t.name));
    return fromTarget(dokployTargets.find((t) => t.name === picked) ?? dokployTargets[0]);
  }

  if (!interactive) {
    return {
      ok: false,
      code: 'DOKPLOY_SETTINGS_MISSING',
      message: 'No Dokploy settings found. Pass --base-url <url> and --application <id>, or run this interactively.',
    };
  }
  const asked = await deps.askSettings();
  return {
    ok: true,
    baseUrl: asked.baseUrl.trim(),
    applicationId: asked.applicationId.trim(),
    tokenEnv: tokenEnvFlag || DEFAULT_TOKEN_ENV,
  };
}

export type DokploySourceResult =
  | { ok: true; baseUrl: string; source: DokployImportSource; tokenEnv: string }
  | {
      ok: false;
      code: 'DOKPLOY_SOURCE_AMBIGUOUS' | 'DOKPLOY_TARGET_AMBIGUOUS' | 'DOKPLOY_SETTINGS_MISSING';
      message: string;
    };

export interface DokploySourceDeps extends DokploySettingsDeps {
  /** Interactive-only, no-flags-and-no-saved-target ask: base URL + compose service id. */
  askComposeSettings: () => Promise<{ baseUrl: string; composeId: string }>;
  /** Interactive-only, no-flags-and-no-saved-target ask: which kind to import from. */
  askSourceKind: () => Promise<'application' | 'compose'>;
}

/** `resolveDokploySettings`'s application result, reshaped as a `DokployImportSource`. */
function settingsToSource(r: DokploySettingsResult): DokploySourceResult {
  if (!r.ok) return r;
  return { ok: true, baseUrl: r.baseUrl, source: { kind: 'application', id: r.applicationId }, tokenEnv: r.tokenEnv };
}

/**
 * Which Dokploy object to import from — an Application or a Compose service
 * (CAP-657 follow-up: every service in the target org is Compose, never
 * Application) — plus the same `baseUrl`/`tokenEnv` `resolveDokploySettings`
 * already resolves.
 *
 * `--application` and `--compose` together is refused outright as
 * `DOKPLOY_SOURCE_AMBIGUOUS`, before anything else runs — zero requests
 * either way. With exactly one of the two flags, that flag picks the kind:
 * `--compose` resolves only a base URL alongside it (from `--base-url`, or an
 * interactive ask) — Compose services have no saved deploy target to fall
 * back to, since `capy deploy` targets are Application-only.
 *
 * With NEITHER flag, this delegates to `resolveDokploySettings`'s existing
 * flags/target/ask/refuse order COMPLETELY UNCHANGED whenever there is
 * already an `--application` flag or at least one saved target to resolve
 * against (a saved target is always an Application). Only when there is
 * nothing to go on AND this run can prompt does it ask which KIND first —
 * the one behaviour change this adds to the no-flags path; a non-TTY run
 * with nothing still refuses `DOKPLOY_SETTINGS_MISSING`, exactly as before.
 */
export async function resolveDokployImportSource(
  opts: ConnectOpts,
  dokployTargets: readonly TargetConfig[],
  interactive: boolean,
  deps: DokploySourceDeps,
): Promise<DokploySourceResult> {
  if (opts.application && opts.compose) {
    return {
      ok: false,
      code: 'DOKPLOY_SOURCE_AMBIGUOUS',
      message: '--application and --compose are mutually exclusive. Pass exactly one.',
    };
  }

  const tokenEnv = opts.tokenEnv?.trim() || DEFAULT_TOKEN_ENV;

  if (opts.compose) {
    const composeId = opts.compose.trim();
    const flagBaseUrl = opts.baseUrl?.trim();
    if (flagBaseUrl) {
      return { ok: true, baseUrl: flagBaseUrl, source: { kind: 'compose', id: composeId }, tokenEnv };
    }
    if (!interactive) {
      return {
        ok: false,
        code: 'DOKPLOY_SETTINGS_MISSING',
        message: 'No Dokploy base URL. Pass --base-url <url>, or run this interactively.',
      };
    }
    const asked = await deps.askComposeSettings();
    return {
      ok: true,
      baseUrl: asked.baseUrl.trim(),
      source: { kind: 'compose', id: asked.composeId.trim() },
      tokenEnv,
    };
  }

  if (opts.application || dokployTargets.length > 0) {
    return settingsToSource(await resolveDokploySettings(opts, dokployTargets, interactive, deps));
  }

  if (!interactive) {
    return {
      ok: false,
      code: 'DOKPLOY_SETTINGS_MISSING',
      message:
        'No Dokploy settings found. Pass --base-url <url> and --application <id> or --compose <id>, or run this interactively.',
    };
  }

  const kind = await deps.askSourceKind();
  if (kind === 'compose') {
    const asked = await deps.askComposeSettings();
    return {
      ok: true,
      baseUrl: asked.baseUrl.trim(),
      source: { kind: 'compose', id: asked.composeId.trim() },
      tokenEnv,
    };
  }
  return settingsToSource(await resolveDokploySettings(opts, dokployTargets, interactive, deps));
}

/** A failed `application.one` call as a stable code + message. Never a value. */
export function mapImportApiError(err: unknown, applicationId: string): { code: string; message: string } {
  if (err instanceof DokployApiError) {
    if (err.code === 'unauthorized') {
      return { code: 'DOKPLOY_AUTH_FAILED', message: `Dokploy rejected the API token (HTTP ${err.status}).` };
    }
    if (err.code === 'not_found') {
      return { code: 'DOKPLOY_APP_NOT_FOUND', message: `No Dokploy application ${applicationId}.` };
    }
    return { code: 'DOKPLOY_API_ERROR', message: err.message };
  }
  return { code: 'DOKPLOY_API_ERROR', message: err instanceof Error ? err.message : String(err) };
}

/**
 * A failed `compose.one` call as a stable code + message. Never a value.
 * Mirrors `mapImportApiError` exactly (same codes — `DOKPLOY_AUTH_FAILED`,
 * `DOKPLOY_APP_NOT_FOUND`, `DOKPLOY_API_ERROR`), with wording that names the
 * compose service rather than an application. Kept as its own function
 * rather than a shared helper with a `kind` parameter so `mapImportApiError`
 * — already directly unit-tested with a plain `applicationId: string` second
 * argument — never has its signature touched by this change.
 */
export function mapImportComposeApiError(err: unknown, composeId: string): { code: string; message: string } {
  if (err instanceof DokployApiError) {
    if (err.code === 'unauthorized') {
      return { code: 'DOKPLOY_AUTH_FAILED', message: `Dokploy rejected the API token (HTTP ${err.status}).` };
    }
    if (err.code === 'not_found') {
      return { code: 'DOKPLOY_APP_NOT_FOUND', message: `No Dokploy compose service ${composeId}.` };
    }
    return { code: 'DOKPLOY_API_ERROR', message: err.message };
  }
  return { code: 'DOKPLOY_API_ERROR', message: err instanceof Error ? err.message : String(err) };
}

type FetchSourceEnvResult = { ok: true; env: string | null } | ({ ok: false } & { code: string; message: string });

/** `GET application.one`, mapped to a stable code + message on failure — never a thrown value. */
async function fetchApplicationEnv(client: DokployClient, applicationId: string): Promise<FetchSourceEnvResult> {
  try {
    const { env } = await client.getApplication(applicationId);
    return { ok: true, env };
  } catch (err) {
    return { ok: false, ...mapImportApiError(err, applicationId) };
  }
}

/** `GET compose.one`, mapped to a stable code + message on failure — never a thrown value. Mirrors `fetchApplicationEnv`. */
async function fetchComposeEnv(client: DokployClient, composeId: string): Promise<FetchSourceEnvResult> {
  try {
    const { env } = await client.getCompose(composeId);
    return { ok: true, env };
  } catch (err) {
    return { ok: false, ...mapImportComposeApiError(err, composeId) };
  }
}

// ── Deploy-target offer ─────────────────────────────────────────────────────

function uniqueTargetName(existing: readonly TargetConfig[], base: string): string {
  const names = new Set(existing.map((t) => t.name));
  if (!names.has(base)) return base;
  const numbered = (n: number): string => (names.has(`${base}-${n}`) ? numbered(n + 1) : `${base}-${n}`);
  return numbered(2);
}

interface DeployTargetOfferArgs {
  importedNames: readonly string[];
  applicationId: string;
  baseUrl: string;
  tokenEnv: string;
  branch: string;
  allTargets: readonly TargetConfig[];
  interactive: boolean;
  cwd: string;
  confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
}

/**
 * After a successful import, offer to save a Dokploy deploy target for the
 * SAME application — so `capy deploy` can ship Capy's runtime pair back to
 * it. Only offered when nothing imported (nothing to offer) and only asked
 * interactively; non-interactive never asks and never saves.
 */
async function maybeOfferDeployTarget(args: DeployTargetOfferArgs): Promise<boolean> {
  if (args.importedNames.length === 0) return false;
  const already = args.allTargets.some(
    (t) => t.kind === 'dokploy' && (t.options as DokployTargetOptions).applicationId === args.applicationId,
  );
  if (already || !args.interactive) return false;

  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  const yes = await args.confirm(
    'Save a Dokploy deploy target for this application, so `capy deploy` can ship the runtime pair to it?',
    false,
  );
  if (!yes) return false;

  const { upsertTarget } = await import('../../deploy/config');
  upsertTarget(args.cwd, {
    name: uniqueTargetName(args.allTargets, 'dokploy'),
    kind: 'dokploy',
    branch: args.branch,
    vars: [...args.importedNames],
    options: { baseUrl: args.baseUrl, applicationId: args.applicationId, tokenEnv: args.tokenEnv },
  });
  return true;
}

// ── Connector ────────────────────────────────────────────────────────────────

export interface DokployConnectorDeps {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  cwd?: string;
  now?: () => Date;
  /** Injectable for tests. Real `inquirer` confirm otherwise. */
  confirm?: (message: string, defaultValue: boolean) => Promise<boolean>;
  /** Injectable for tests. Real `inquirer` checkbox (all pre-checked) otherwise. */
  selectVars?: (candidates: readonly string[]) => Promise<readonly string[]>;
  /** Injectable for tests. Real `inquirer` list otherwise. */
  pickTarget?: (names: readonly string[]) => Promise<string>;
  /** Injectable for tests. Real `inquirer` input x2 otherwise. */
  askSettings?: () => Promise<{ baseUrl: string; applicationId: string }>;
  /** Injectable for tests. Real `inquirer` input x2 otherwise. Compose sibling of `askSettings`. */
  askComposeSettings?: () => Promise<{ baseUrl: string; composeId: string }>;
  /** Injectable for tests. Real `inquirer` list otherwise: which kind (application/compose) to import from. */
  askSourceKind?: () => Promise<'application' | 'compose'>;
  /** Discovery mode only. Injectable for tests. Real `inquirer` input otherwise: the base URL to scan when nothing else resolves it. */
  askDiscoveryBaseUrl?: () => Promise<string>;
  /** Discovery mode only. Injectable for tests. Real `inquirer` list otherwise: which candidate wins one mapping collision. */
  pickCollisionWinner?: (collision: DiscoveryCollision) => Promise<string>;
  /**
   * Discovery mode only, one uninitialized folder: which project it should
   * use — an existing org project's id, or `DISCOVERY_NEW_PROJECT` to create
   * one named `defaultName`. Injectable for tests. Real `inquirer` list
   * otherwise, mirroring `capyCommand.ts`'s own existing-project picker.
   */
  askExistingOrNewProject?: (
    existing: ReadonlyArray<{ id: string; name: string }>,
    defaultName: string,
  ) => Promise<string>;
  /**
   * Discovery mode only, one uninitialized folder that picked "new
   * project": the name to use (default `defaultName`) — mirrors
   * `capyCommand.ts#resolveProjectName`'s ask. Injectable for tests. Real
   * `inquirer` input otherwise. Never asked at all under `--yes` (see
   * `ensureProjectSafe`'s own doc) — the default is used outright.
   */
  askDiscoveryProjectName?: (defaultName: string) => Promise<string>;
  /**
   * Discovery mode only, a real (non-dry-run) run: the git branch to commit
   * discovery's own keep.lock/.gitignore writes onto, per repo (default:
   * `capy/dokploy-import-<YYYYMMDD-HHMM>` — see `defaultDiscoveryCommitBranchName`).
   * Injectable for tests. Real `inquirer` input otherwise. Asked ONCE per
   * run, never per repo. Never asked under `--yes` or `--dry-run` — the
   * default is used outright either way.
   */
  askDiscoveryCommitBranchName?: (defaultName: string) => Promise<string>;
  /**
   * Reads the org system store's `_CONNECTOR_DOKPLOY_API_KEY` entry — see
   * `dokployApi.ts#ResolveDokployApiKeyDeps`. Defaults to a no-op (never
   * touches the network): every test constructs this connector directly with
   * its own `env`/`fetch` and none of them exercise the store, so this dep
   * stays opt-in here. The exported `dokployConnector` singleton below wires
   * the real `system/systemStore.ts#getConnectorSecret` explicitly — that is
   * the one instance `capy connect dokploy` actually runs.
   */
  getConnectorSecret?: (name: string, opts: DokploySystemStoreCallOptions) => Promise<string | null>;
}

async function defaultConfirm(message: string, defaultValue: boolean): Promise<boolean> {
  const inquirer = (await import('inquirer')).default;
  const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message, default: defaultValue }]);
  return ok;
}

async function defaultSelectVars(candidates: readonly string[]): Promise<readonly string[]> {
  if (candidates.length === 0) return [];
  const inquirer = (await import('inquirer')).default;
  const { picked } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'picked',
      message: 'Which variables to import from Dokploy:',
      choices: candidates.map((name) => ({ name, value: name, checked: true })),
    },
  ]);
  return picked;
}

async function defaultPickTarget(names: readonly string[]): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const { picked } = await inquirer.prompt([
    { type: 'list', name: 'picked', message: 'Which Dokploy deploy target:', choices: [...names] },
  ]);
  return picked;
}

async function defaultAskSettings(): Promise<{ baseUrl: string; applicationId: string }> {
  const inquirer = (await import('inquirer')).default;
  const ans = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Dokploy URL:',
      validate: (v: string) => baseUrlProblem(v) ?? true,
      filter: (v: string) => v.trim(),
    },
    {
      type: 'input',
      name: 'applicationId',
      message: 'Dokploy application ID:',
      validate: (v: string) => (v.trim() ? true : 'required'),
      filter: (v: string) => v.trim(),
    },
  ]);
  return { baseUrl: ans.baseUrl, applicationId: ans.applicationId };
}

async function defaultAskComposeSettings(): Promise<{ baseUrl: string; composeId: string }> {
  const inquirer = (await import('inquirer')).default;
  const ans = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Dokploy URL:',
      validate: (v: string) => baseUrlProblem(v) ?? true,
      filter: (v: string) => v.trim(),
    },
    {
      type: 'input',
      name: 'composeId',
      message: 'Dokploy compose service ID:',
      validate: (v: string) => (v.trim() ? true : 'required'),
      filter: (v: string) => v.trim(),
    },
  ]);
  return { baseUrl: ans.baseUrl, composeId: ans.composeId };
}

// COPY-FLAG: new user-facing string, minimal/neutral wording.
async function defaultAskSourceKind(): Promise<'application' | 'compose'> {
  const inquirer = (await import('inquirer')).default;
  const { kind } = await inquirer.prompt([
    {
      type: 'list',
      name: 'kind',
      message: 'Import from a Dokploy Application or a Compose service:',
      choices: [
        { name: 'Application', value: 'application' },
        { name: 'Compose service', value: 'compose' },
      ],
    },
  ]);
  return kind;
}

async function defaultAskDiscoveryBaseUrl(): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const { baseUrl } = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Dokploy URL to scan:',
      validate: (v: string) => baseUrlProblem(v) ?? true,
      filter: (v: string) => v.trim(),
    },
  ]);
  return baseUrl;
}

/** Sentinel `askExistingOrNewProject` returns to mean "create a new project", never a real project id. */
export const DISCOVERY_NEW_PROJECT = '__capy_discovery_new_project__';

// COPY-FLAG: new user-facing string, minimal/neutral wording.
async function defaultAskExistingOrNewProject(
  existing: ReadonlyArray<{ id: string; name: string }>,
  defaultName: string,
): Promise<string> {
  const inquirer = (await import('inquirer')).default;
  const choices = [
    { name: `New project (${defaultName})`, value: DISCOVERY_NEW_PROJECT },
    ...existing.map((p) => ({ name: p.name, value: p.id })),
  ];
  const { projectChoice } = await inquirer.prompt([
    { type: 'list', name: 'projectChoice', message: 'Which project should this folder use?', choices, default: DISCOVERY_NEW_PROJECT },
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

async function defaultAskDiscoveryProjectName(defaultName: string): Promise<string> {
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
      // `DOKPLOY_PROJECT_NAME_TOO_LONG`/`PROJECT_NAME_RESERVED` for.
      validate: (v: string) => discoveryProjectNameProblem(v.trim()) ?? true,
    },
  ]);
  return name;
}

// COPY-FLAG: new user-facing string, minimal/neutral wording.
async function defaultAskDiscoveryCommitBranchName(defaultName: string): Promise<string> {
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
      // `DOKPLOY_COMMIT_BRANCH_INVALID` for — that refusal is still the
      // authoritative, zero-mutation-guaranteed check for every OTHER
      // path into this function (non-interactive, an injected test dep).
      validate: (v: string) => (isValidDiscoveryCommitBranchName(v.trim()) ? true : 'Not a valid git branch name.'),
    },
  ]);
  return name;
}

// COPY-FLAG: new user-facing string, minimal/neutral wording.
async function defaultPickCollisionWinner(collision: DiscoveryCollision): Promise<string> {
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

/** `--var` on `capy connect dokploy`: comma-separated names, restricting the import. */
function parseVarRestriction(raw: string | undefined): readonly string[] | null {
  if (!raw) return null;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? names : null;
}

// ── --overwrite ──────────────────────────────────────────────────────────────

export interface OverwritePlan {
  /** Local names Dokploy no longer has, and that aren't a reference value — removed entirely. */
  toClear: readonly string[];
  /** Present in both with a DIFFERENT value — overwritten with Dokploy's. */
  toReplace: ReadonlyArray<{ name: string; value: string }>;
  /** Only in Dokploy — a plain new write. */
  toImport: ReadonlyArray<{ name: string; value: string }>;
  /** Present in both with the SAME value — no-op. */
  unchanged: readonly string[];
}

/**
 * `--overwrite`'s own rule: the branch's vars become EXACTLY Dokploy's
 * importable set. `localPlaintext` names absent from Dokploy's set are
 * cleared — EXCEPT a reference-valued name (`${{...}}`, `referenceNames`):
 * there is no resolved value to replace it with, so it is left alone rather
 * than cleared (the caller's `DOKPLOY_REFERENCE_VALUE` warning already says
 * so). `dokployCandidates` must be Dokploy's FULL importable set, never one
 * already narrowed by `--var` — narrowing it here would make a restricted
 * overwrite clear a name Dokploy still has, just outside the restriction
 * (see the call site in `import()`, which computes this from the
 * unrestricted list on purpose).
 */
export function computeOverwritePlan(
  dokployCandidates: ReadonlyArray<{ name: string; value: string }>,
  referenceNames: readonly string[],
  localPlaintext: Readonly<Record<string, string>>,
): OverwritePlan {
  const dokployNames = new Set(dokployCandidates.map((c) => c.name));
  const referenceSet = new Set(referenceNames);
  return {
    toClear: Object.keys(localPlaintext).filter((k) => !dokployNames.has(k) && !referenceSet.has(k)),
    toReplace: dokployCandidates.filter((c) => localPlaintext[c.name] !== undefined && localPlaintext[c.name] !== c.value),
    toImport: dokployCandidates.filter((c) => localPlaintext[c.name] === undefined),
    unchanged: dokployCandidates.filter((c) => localPlaintext[c.name] === c.value).map((c) => c.name),
  };
}

// COPY-FLAG: new user-facing string, minimal/neutral wording.
function overwriteConfirmMessage(plan: OverwritePlan): string {
  const lines = [
    'Overwrite local vars to match Dokploy exactly?',
    plan.toImport.length > 0 ? `  Import (${plan.toImport.length}): ${plan.toImport.map((e) => e.name).join(', ')}` : null,
    plan.toReplace.length > 0 ? `  Replace (${plan.toReplace.length}): ${plan.toReplace.map((e) => e.name).join(', ')}` : null,
    plan.toClear.length > 0 ? `  Clear (${plan.toClear.length}): ${plan.toClear.join(', ')}` : null,
  ].filter((l): l is string => l !== null);
  return lines.join('\n');
}

/**
 * `--overwrite`'s own run: compute the plan from Dokploy's FULL importable
 * set (never `--var`-restricted — see `computeOverwritePlan`'s doc), confirm
 * (default no; `--yes` skips it; non-interactive without `--yes` refuses;
 * `--dry-run` never prompts and never writes), then return the outcome for
 * the caller (`executeImport`, or discovery's own per-environment step) to
 * write via `writeImportOutcome`. This function never writes anything
 * itself — same contract as the rest of `import()`.
 */
async function runOverwriteImport(args: {
  ctx: ResolvedContext;
  opts: ConnectOpts;
  source: DokployImportSource;
  sourceEnv: string | null;
  interactive: boolean;
  dryRun: boolean;
  confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
  now: () => Date;
}): Promise<ImportOutcome> {
  const { ctx, opts, source, sourceEnv, interactive, dryRun, confirm, now } = args;

  // Dokploy's FULL importable set — `--var` is ignored under `--overwrite`
  // (see `computeOverwritePlan`'s doc for why a restricted clear would be unsafe).
  const fullImportable = listImportableEntries(sourceEnv);
  const referenceNames = fullImportable.filter((e) => e.skip === 'DOKPLOY_REFERENCE_VALUE').map((e) => e.name);
  const fullCandidates = fullImportable.filter((e) => !e.skip).map((e) => ({ name: e.name, value: e.value }));
  const plan = computeOverwritePlan(fullCandidates, referenceNames, ctx.localPlaintext);

  const hasWrite = plan.toClear.length > 0 || plan.toReplace.length > 0 || plan.toImport.length > 0;
  const promptable = interactive && !opts.json;

  if (!dryRun && hasWrite) {
    if (promptable && !opts.yes) {
      const proceed = await confirm(overwriteConfirmMessage(plan), false);
      if (!proceed) {
        return {
          ok: true,
          ...(source.kind === 'application' ? { applicationId: source.id } : {}),
          source,
          imported: [],
          cleared: [],
          replacedNames: [],
          unchanged: plan.unchanged,
          skipped: [],
          warnings: referenceNames.length > 0 ? [{ code: 'DOKPLOY_REFERENCE_VALUE', names: referenceNames }] : [],
          deployTargetSaved: false,
        };
      }
    } else if (!promptable && !opts.yes) {
      return {
        ok: false,
        code: 'DOKPLOY_CONFIRMATION_REQUIRED',
        message: 'Pass --yes to overwrite non-interactively, or run this interactively.',
      };
    }
  }

  const importedAt = now().toISOString();
  const createdAtSec = Math.floor(now().getTime() / 1000);
  const buildEntry = (name: string, value: string): ConnectorMetadata => ({
    provider: 'dokploy',
    source: 'import',
    created_at: createdAtSec,
    fingerprint: fingerprint(value),
    ...(source.kind === 'application' ? { application_id: source.id } : { compose_id: source.id }),
    imported_at: importedAt,
  });
  const written = [...plan.toImport, ...plan.toReplace].map(({ name, value }) => ({
    varName: name,
    value,
    entry: buildEntry(name, value),
  }));
  const replacedNames = plan.toReplace.map((e) => e.name);

  return {
    ok: true,
    ...(source.kind === 'application' ? { applicationId: source.id } : {}),
    source,
    imported: written,
    cleared: plan.toClear,
    replacedNames,
    unchanged: plan.unchanged,
    skipped: [],
    warnings: [
      ...(referenceNames.length > 0 ? [{ code: 'DOKPLOY_REFERENCE_VALUE', names: referenceNames }] : []),
      ...(written.length > 0 && !dryRun ? [{ code: 'DOKPLOY_PLAINTEXT_REMAINS', names: written.map((w) => w.varName) }] : []),
    ],
    deployTargetSaved: false,
  };
}

export function createDokployConnector(deps: DokployConnectorDeps = {}): ConnectorModule {
  const cwd = () => deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const confirm = deps.confirm ?? defaultConfirm;
  const selectVars = deps.selectVars ?? defaultSelectVars;
  const pickTarget = deps.pickTarget ?? defaultPickTarget;
  const askSettings = deps.askSettings ?? defaultAskSettings;
  const askComposeSettings = deps.askComposeSettings ?? defaultAskComposeSettings;
  const askSourceKind = deps.askSourceKind ?? defaultAskSourceKind;
  const askDiscoveryBaseUrl = deps.askDiscoveryBaseUrl ?? defaultAskDiscoveryBaseUrl;
  const pickCollisionWinner = deps.pickCollisionWinner ?? defaultPickCollisionWinner;
  const askExistingOrNewProject = deps.askExistingOrNewProject ?? defaultAskExistingOrNewProject;
  const askDiscoveryProjectName = deps.askDiscoveryProjectName ?? defaultAskDiscoveryProjectName;
  const askDiscoveryCommitBranchName = deps.askDiscoveryCommitBranchName ?? defaultAskDiscoveryCommitBranchName;

  // A `const` holding the object (rather than a bare `return {...}`) so
  // `discover()`, below, can call `connector.import!(...)` directly — the
  // SAME function a plain `capy connect dokploy --compose <id>` runs,
  // reused rather than duplicated (see `importIntoBranchSafe`'s own doc for
  // why that call goes straight to this function and not through
  // `ConnectCommand`).
  const connector: ConnectorModule = {
    name: 'dokploy',
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    description: 'One-time import of env vars from a Dokploy Application or Compose service',
    kind: 'import',

    // Never reached: `connectCommand.ts` and `rotateCommand.ts`'s promotion
    // flow both route on `kind === 'import'` before this could be called.
    // Kept only because `ConnectorModule.connect` is a required method —
    // defence in depth against a future call site that forgets the branch.
    async connect(): Promise<ConnectResult> {
      throw new Error('dokploy is import-only; connectCommand should have routed to import() instead.');
    },
    async rotate(): Promise<RotateResult> {
      throw new Error('dokploy is import-only; rotateCommand should have refused before calling rotate().');
    },

    async import(ctx: ResolvedContext, opts: ConnectOpts): Promise<ImportOutcome> {
      // No `--web` branching here by design: browser screens are a separate
      // surface (built in the Keep workbench, later phase — see
      // docs/dokploy-deploy-adapter.md's "Browser setup" section for the
      // equivalent stance on the deploy side). `--web` flows through
      // unchanged, exactly as the shared `connect` code path already handles
      // it for every connector.
      // `--environment` is a DISCOVERY-mode concept (there is no "plan" to
      // filter for a single-service import) — refused outright, zero
      // requests, before anything else. Never true for discovery's OWN
      // internal per-step calls into this function, which never set it.
      if (opts.environment && !opts.discover) {
        return {
          ok: false,
          code: 'DOKPLOY_ENVIRONMENT_NOT_APPLICABLE',
          message: '--environment only applies under --discover.',
        };
      }

      const interactive = isInteractive(opts.nonTty);
      // Vince's rule: a dry run changes nothing. Threaded through every
      // decision below that would otherwise write, push, or prompt.
      const dryRun = !!opts.dryRun;

      const { listTargets } = await import('../../deploy/config');
      const allTargets = listTargets(cwd());
      const dokployTargets = allTargets.filter((t) => t.kind === 'dokploy');

      const settings = await resolveDokployImportSource(opts, dokployTargets, interactive, {
        pickTarget,
        askSettings,
        askComposeSettings,
        askSourceKind,
      });
      if (!settings.ok) return { ok: false, code: settings.code, message: settings.message };
      const { baseUrl, source, tokenEnv } = settings;

      // Resolved BEFORE any Dokploy request — a missing/refused token still
      // means zero requests (see the class doc's "READ-ONLY" note). A
      // SEPARATE interactive flag from the one above: `--web` (the store's
      // prompt is a raw terminal prompt, not a browser screen), `--json`
      // (machine output must never have a prompt interleaved with it) and
      // `--dry-run` (a preview must never have the side effect of saving a
      // new key into the org store) all suppress ONLY this prompt, not the
      // settings prompts above.
      const secretsInteractive = dokploySecretsMayPrompt(interactive, !!opts.web || !!opts.json || dryRun);
      const resolved = await resolveDokployApiKey({
        tokenEnv,
        env: deps.env ?? process.env,
        interactive: secretsInteractive,
        orgId: ctx.orgId,
        devMode: opts.devMode,
        deps: deps.getConnectorSecret ? { getConnectorSecret: deps.getConnectorSecret } : undefined,
      });
      if (!resolved.ok) {
        const { reason } = describeDokployTokenProblem(resolved.code, tokenEnv);
        return { ok: false, code: resolved.code, message: `${reason}.` };
      }
      const token = resolved.value;

      const client = createDokployClient(baseUrl, token, deps.fetch);
      const envResult =
        source.kind === 'compose'
          ? await fetchComposeEnv(client, source.id)
          : await fetchApplicationEnv(client, source.id);
      if (!envResult.ok) return { ok: false, code: envResult.code, message: envResult.message };
      const sourceEnv = envResult.env;

      const restrict = parseVarRestriction(opts.var);
      const importable = listImportableEntries(sourceEnv).filter((e) => !restrict || restrict.includes(e.name));
      const referenceSkipped = importable.filter((e) => e.skip === 'DOKPLOY_REFERENCE_VALUE').map((e) => e.name);
      const candidates = importable.filter((e) => !e.skip);

      if (opts.overwrite) {
        return await runOverwriteImport({ ctx, opts, source, sourceEnv, interactive, dryRun, confirm, now });
      }

      // A dry run previews the WHOLE plan rather than a hand-picked subset —
      // the checkbox picker is skipped exactly like the non-interactive case.
      const selectedNames = restrict
        ? candidates.map((e) => e.name)
        : interactive && !dryRun
          ? await selectVars(candidates.map((e) => e.name))
          : candidates.map((e) => e.name);
      const selected = candidates.filter((e) => selectedNames.includes(e.name));

      // Same rule the discovery apply step uses (CAP-657 follow-up) — see
      // `classifyImportCandidates`'s own doc in `dokployApi.ts`.
      const { unchanged, skipped, toImport, wouldAsk } = await classifyImportCandidates(
        selected.map((e) => ({ name: e.name, value: e.value })),
        ctx.localPlaintext,
        { dryRun, interactive, confirm },
      );

      const importedAt = now().toISOString();
      const createdAtSec = Math.floor(now().getTime() / 1000);
      const imported = toImport.map(({ name, value }) => ({
        varName: name,
        value,
        entry: {
          provider: 'dokploy',
          source: 'import',
          created_at: createdAtSec,
          fingerprint: fingerprint(value),
          ...(source.kind === 'application' ? { application_id: source.id } : { compose_id: source.id }),
          imported_at: importedAt,
        } as ConnectorMetadata,
      }));

      const warnings: ImportWarning[] = [
        ...(referenceSkipped.length > 0 ? [{ code: 'DOKPLOY_REFERENCE_VALUE', names: referenceSkipped }] : []),
        // Reminder, names only: the plaintext stays in Dokploy — reversible by
        // design (see docs/dokploy-deploy-adapter.md) — and is ignored at
        // boot once `capy deploy` writes the runtime pair. Not under a dry
        // run: nothing was actually imported, so nothing has landed yet for
        // this to be a reminder about.
        ...(imported.length > 0 && !dryRun
          ? [{ code: 'DOKPLOY_PLAINTEXT_REMAINS', names: imported.map((i) => i.varName) }]
          : []),
      ];

      // Compose has no deploy target in this change — there is no compose
      // deploy adapter yet, so it is never offered, regardless of TTY. A dry
      // run never saves anything either way (Vince's rule: changes nothing).
      const deployTargetSaved =
        !dryRun && source.kind === 'application'
          ? await maybeOfferDeployTarget({
              importedNames: imported.map((i) => i.varName),
              applicationId: source.id,
              baseUrl,
              tokenEnv,
              branch: ctx.branch,
              allTargets,
              interactive,
              cwd: cwd(),
              confirm,
            })
          : false;

      return {
        ok: true,
        ...(source.kind === 'application' ? { applicationId: source.id } : {}),
        source,
        imported,
        unchanged,
        skipped,
        warnings,
        deployTargetSaved,
        ...(dryRun ? { wouldAsk } : {}),
      };
    },

    /**
     * `capy connect dokploy --discover` (CAP-657 follow-up): find every
     * Dokploy service whose git source matches a repo reachable from `cwd`,
     * instead of importing one named `--application`/`--compose`. See
     * `dokployDiscovery.ts`'s file doc for the full design + the shape
     * assumptions this makes about `project.all`.
     */
    async discover(ctx: DiscoveryContext, opts: ConnectOpts): Promise<DiscoveryOutcome> {
      const interactive = isInteractive(opts.nonTty);
      const dryRun = !!opts.dryRun;

      const { listTargets } = await import('../../deploy/config');
      const dokployTargets = listTargets(cwd()).filter((t) => t.kind === 'dokploy');

      const tokenEnv = opts.tokenEnv?.trim() || DEFAULT_TOKEN_ENV;
      const flagBaseUrl = opts.baseUrl?.trim();
      const savedBaseUrl = (dokployTargets[0]?.options as DokployTargetOptions | undefined)?.baseUrl;
      const baseUrl = flagBaseUrl || savedBaseUrl;
      const resolvedBaseUrl: string | null = baseUrl
        ? baseUrl
        : interactive
          ? (await askDiscoveryBaseUrl()).trim()
          : null;
      if (!resolvedBaseUrl) {
        return {
          ok: false,
          code: 'DOKPLOY_SETTINGS_MISSING',
          message: 'No Dokploy base URL. Pass --base-url <url>, or run this interactively.',
        };
      }

      // Same suppression rule as the single-service import: never prompt for
      // the key under --web/--json/--dry-run.
      const secretsInteractive = dokploySecretsMayPrompt(interactive, !!opts.web || !!opts.json || dryRun);
      const resolved = await resolveDokployApiKey({
        tokenEnv,
        env: deps.env ?? process.env,
        interactive: secretsInteractive,
        orgId: ctx.orgId,
        devMode: opts.devMode,
        deps: deps.getConnectorSecret ? { getConnectorSecret: deps.getConnectorSecret } : undefined,
      });
      if (!resolved.ok) {
        const { reason } = describeDokployTokenProblem(resolved.code, tokenEnv);
        return { ok: false, code: resolved.code, message: `${reason}.` };
      }

      const client = createDokployClient(resolvedBaseUrl, resolved.value, deps.fetch);
      const scan = findCandidateReposResult(cwd());
      const environmentFilter = parseVarRestriction(opts.environment) ?? undefined;
      const planCore = await buildDiscoveryPlan(
        client,
        scan.repos,
        {
          peekLocalKeep: peekLocalKeepForFolder,
          listServerBranches: (projectId) => ctx.serviceClient.listBranches(projectId),
        },
        environmentFilter,
      );
      const plan: DiscoveryPlan = { ...planCore, unreadableRepos: scan.unreadable };

      if (environmentFilter) {
        const unknown = environmentFilter.filter((name) => !plan.allEnvironmentNames.includes(name));
        if (unknown.length > 0) {
          return {
            ok: false,
            code: 'DOKPLOY_ENVIRONMENT_NOT_FOUND',
            message: `No such environment(s): ${unknown.join(', ')}. Environments found: ${plan.allEnvironmentNames.join(', ') || '(none)'}.`,
          };
        }
      }

      if (dryRun) {
        // Vince's rule: a dry run changes nothing — never asks for a
        // branch name either; the DEFAULT is what it previews.
        const commits = commitPreviewForFolders(plan.folders, defaultDiscoveryCommitBranchName());
        return { ok: true, dryRun: true, plan, ...(commits.length > 0 ? { commits } : {}) };
      }

      // `--json` must never have a prompt interleaved with it, same reason
      // the key resolution above suppresses under it — a real TTY combined
      // with `--json` still resolves every choice below from flags, never a
      // raw terminal prompt.
      const promptable = interactive && !opts.json;

      // --application/--compose is a DISAMBIGUATING HINT here, not "the
      // source to read" (that meaning belongs to the single-service path
      // above) — whichever one is set names the service that should win any
      // collision it is a candidate of.
      const preferredServiceId = opts.application ?? opts.compose;
      // Asked in STEP order (staging, then others, then production) — the
      // same order the sequence itself runs in — never in whatever order
      // `detectCollisions` happened to build its cells. `orderEnvironments`
      // already sorts by `environmentName` this way, and `DiscoveryCollision`
      // carries that same field.
      const orderedCollisions = orderEnvironments(plan.collisions);
      const resolution = await resolveCollisions(orderedCollisions, {
        preferredServiceId,
        interactive: promptable,
        askWinner: pickCollisionWinner,
      });
      if (!resolution.ok) {
        return {
          ok: false,
          code: 'DOKPLOY_MAPPING_COLLISION',
          message:
            'Several Dokploy services map to the same folder + branch. Pass --application/--compose to pick one, ' +
            'or run this interactively.',
        };
      }

      const resolvedFolders = applyCollisionResolutions(plan.folders, resolution.resolutions);
      if (resolvedFolders.length === 0) {
        return { ok: true, dryRun: false, plan, applied: [] };
      }

      // A real (non-dry-run) run must never write without confirmation.
      // `--yes` skips the ask REGARDLESS of TTY — interactive or not, it
      // means "proceed". Without it: interactive asks (default no), the
      // exact command sequence spelled out in the prompt itself — never a
      // value; non-interactive (including `--json`) refuses before anything
      // runs. Each folder's own `--overwrite` step (when discovery itself
      // got `--overwrite`) asks AGAIN, separately, once it knows that
      // service's real by-name clear/replace/import lists — this gate is
      // only the plan-level "proceed at all?" ask.
      if (promptable && !opts.yes) {
        const proceed = await confirm(discoveryConfirmMessage(resolvedFolders, !!opts.overwrite, environmentFilter), false);
        if (!proceed) {
          return { ok: true, dryRun: false, plan, applied: [], cancelled: true };
        }
      } else if (!promptable && !opts.yes) {
        return {
          ok: false,
          code: 'DOKPLOY_CONFIRMATION_REQUIRED',
          message: 'Pass --yes to apply non-interactively, or run this interactively.',
        };
      }

      // Asked ONCE per run, never per repo — every repo discovery touches
      // gets a branch of this SAME name, independently. `--yes` uses the
      // default outright, same "proceed without asking" contract as every
      // other discovery confirmation. Asked only AFTER the plan-level
      // confirm passes — a decline above must never reach this ask.
      const commitBranchName =
        promptable && !opts.yes ? await askDiscoveryCommitBranchName(defaultDiscoveryCommitBranchName()) : defaultDiscoveryCommitBranchName();

      // Snapshotted BEFORE any write, per repo — so the commit step below
      // can tell "discovery itself made this change" apart from "this path
      // was already dirty before the run started" (DOKPLOY_COMMIT_WOULD_MIX).
      const beforeStatusByRepo = new Map(
        [...new Set(resolvedFolders.map((f) => f.repoDir))].map((repoDir) => {
          const paths = resolvedFolders.filter((f) => f.repoDir === repoDir).flatMap((f) => discoveryCommitPathsFor(f.folder));
          return [repoDir, snapshotPathStatus(repoDir, paths)] as const;
        }),
      );

      const sequenceDeps = buildRealDiscoverySequenceDeps(ctx, connector.import!, {
        noPush: !!opts.noPush,
        interactive: promptable,
        json: !!opts.json,
        yes: !!opts.yes,
        baseUrl: resolvedBaseUrl,
        tokenEnv,
        askExistingOrNewProject,
        askProjectName: askDiscoveryProjectName,
      });
      const applied = await runDiscoverySequences(resolvedFolders, { overwrite: !!opts.overwrite }, sequenceDeps);

      // Commit ONLY the successful folders' keep.lock/.gitignore, per repo —
      // a failed folder's files are left uncommitted and unstaged, and the
      // caller (executeDiscovery) reports which folders were left out by
      // cross-referencing `applied`'s own ok:false entries. Runs the same
      // whether or not `--no-push` was passed — keep.lock/.env are written
      // locally either way (see `writeImportOutcome`), so there is always
      // something local for this step to pin.
      const commits = commitForAppliedRepos(applied, beforeStatusByRepo, commitBranchName);

      return { ok: true, dryRun: false, plan, applied, ...(commits.length > 0 ? { commits } : {}) };
    },
  };
  return connector;
}

/** Plan-time-only local keep.lock read (no auth) — see `PeekLocalKeep`'s own doc. */
function peekLocalKeepForFolder(repoDir: string, folder: string): KeepFile | null {
  return new ProjectManager(folder ? join(repoDir, folder) : repoDir).readKeepFile();
}

/**
 * The plan-level "proceed at all?" prompt's own message — the EXACT command
 * sequence per folder (never a clear/replace/import COUNT: discovery itself
 * never computes those — each `--overwrite` step works that out, and asks
 * about it separately, once it actually runs). `branchExists` is a preview
 * only (see `DiscoveryPlanEnv`'s own doc) — the real sequence always
 * re-checks for itself regardless of what this line guessed.
 */
// COPY-FLAG: new user-facing string, minimal/neutral wording.
function discoveryConfirmMessage(folders: readonly DiscoveryPlanFolder[], overwrite: boolean, environmentFilter?: readonly string[]): string {
  const totalSteps = folders.reduce((n, f) => n + f.environments.length, 0);
  const filterNote = environmentFilter && environmentFilter.length > 0 ? ` (--environment ${environmentFilter.join(',')})` : '';
  const header = `Run ${totalSteps} step(s) across ${folders.length} folder(s) from Dokploy${overwrite ? ' (--overwrite)' : ''}${filterNote}?`;
  const rows = folders.flatMap((f) => [
    `  ${f.folder || '.'} (${f.projectName}/${f.serviceName})${f.initialized ? '' : ' — capy (init)'}`,
    ...(f.mergedServices ?? []).map((m) => `    + ${m.serviceName} → ${f.folder || '.'} (branch ${m.environmentNames.join(', ')})`),
    ...orderEnvironments(f.environments).map((e) => {
      const checkoutCmd = e.branchExists === true ? `capy checkout ${e.environmentName}` : `capy checkout -b ${e.environmentName}`;
      const sourceFlag = e.serviceKind === 'application' ? `--application ${e.serviceId}` : `--compose ${e.serviceId}`;
      const stepOverwrite = overwrite || e.willAutoOverwrite;
      const importCmd = `capy connect dokploy ${sourceFlag}${stepOverwrite ? ' --overwrite' : ''}`;
      return `    ${checkoutCmd} && ${importCmd}  (${e.variableCount} var(s), ${e.skippedCount} skipped)${e.willAutoOverwrite && !overwrite ? ' [auto-overwrite]' : ''}`;
    }),
  ]);
  return [header, ...rows].join('\n');
}

const folderPath = (repoDir: string, folder: string): string => (folder ? join(repoDir, folder) : repoDir);

/** keep.lock and .gitignore, relative to `repoDir` — the ONLY paths discovery's own commit step ever touches. */
function discoveryCommitPathsFor(folder: string): readonly string[] {
  const prefix = folder ? `${folder}/` : '';
  return [`${prefix}keep.lock`, `${prefix}.gitignore`];
}

/** Every REPO the plan touches, and the branch/files a real run WOULD commit for it — dry-run preview only, never runs a git-mutating command (see `commitDiscoveryChanges`'s own `dryRun` handling). */
function commitPreviewForFolders(folders: readonly DiscoveryPlanFolder[], branchName: string): readonly DiscoveryRepoCommitResult[] {
  const repoDirs = [...new Set(folders.map((f) => f.repoDir))];
  return repoDirs.map((repoDir) => {
    const paths = folders.filter((f) => f.repoDir === repoDir).flatMap((f) => discoveryCommitPathsFor(f.folder));
    const outcome = commitDiscoveryChanges(repoDir, paths, new Set(), { branchName, dryRun: true, summaryLines: [] });
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
function commitForAppliedRepos(
  applied: readonly DiscoveryFolderResult[],
  beforeStatusByRepo: ReadonlyMap<string, ReadonlySet<string>>,
  branchName: string,
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
    });
    return [{ repoDir, ...outcome }];
  });
}

/**
 * No keep.lock at (repoDir, folder) → interactive: reuses `capy`'s own
 * existing-project-picking (list the org's projects, ask new-vs-existing —
 * see `defaultAskExistingOrNewProject`), never invents its own project flow.
 * Non-interactive refuses `DOKPLOY_FOLDER_NOT_INITIALIZED` naming the
 * folder and NEVER auto-creates. A keep.lock already there is just read for
 * its project id — no network call.
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
    /** Discovery's OWN `--yes` — skips the new-project NAME prompt (defaulting to `defaultName`) the same way it skips every other confirmation, never the existing-vs-new picker itself (that one isn't a confirmation, it's a genuine choice with no safe default). */
    yes: boolean;
    askExistingOrNewProject: (existing: ReadonlyArray<{ id: string; name: string }>, defaultName: string) => Promise<string>;
    askProjectName: (defaultName: string) => Promise<string>;
  },
): Promise<{ ok: true; projectId: string; created: boolean } | { ok: false; code: string; message: string }> {
  const path = folderPath(repoDir, folder);
  const pm = new ProjectManager(path);
  const existing = pm.readKeepFile();
  if (existing) {
    return { ok: true, projectId: existing.project_id, created: false };
  }
  if (!opts.interactive) {
    return {
      ok: false,
      code: 'DOKPLOY_FOLDER_NOT_INITIALIZED',
      message: `${folder || '.'} has no keep.lock. Run \`capy\` there to initialize it, then re-run discovery.`,
    };
  }

  const defaultName = defaultDiscoveryProjectName(repoDir, folder, remote);
  // A lookup failure is NOT "this org has no projects" — offering only
  // "create new" on a transient network/auth error risks a duplicate
  // project the human never asked for. Abort THIS folder instead (CAP-657
  // follow-up defect fix) — the SAME distinction `capy`'s own init makes
  // (`listOrgProjectsOrUnavailable`, extracted from `capyCommand.ts`).
  const { existingProjects, projectsUnavailable } = await listOrgProjectsOrUnavailable(ctx.serviceClient);
  if (projectsUnavailable) {
    return {
      ok: false,
      code: 'DOKPLOY_PROJECT_LOOKUP_FAILED',
      message: `${folder || '.'}: could not list this org's existing projects — refusing to offer "create new" blind.`,
    };
  }
  const picked = await opts.askExistingOrNewProject(existingProjects.map((p) => ({ id: p.id, name: p.name })), defaultName);

  try {
    if (picked !== DISCOVERY_NEW_PROJECT) {
      const project = existingProjects.find((p) => p.id === picked);
      if (!project) {
        return { ok: false, code: 'DOKPLOY_PROJECT_NOT_FOUND', message: `No project ${picked} in this org.` };
      }
      await bootstrapExistingProjectSafe(ctx, pm, new FileManager(path), project);
      return { ok: true, projectId: project.id, created: false };
    }
    // Mirrors `capyCommand.ts#resolveProjectName`: ask for the new
    // project's name (default = `defaultName`), reserved-name check kept.
    // `--yes` skips the ask — same "proceed without asking" contract as
    // every other discovery confirmation — and uses the default outright.
    const chosenName = opts.yes ? defaultName : await opts.askProjectName(defaultName);
    // Vince, 2026-09-26, decision #4: refuse before any write when the name
    // (default or human-typed) is over 255 chars — never truncated. The real
    // `defaultAskDiscoveryProjectName` prompt validates this itself and
    // re-asks (so an interactive human self-corrects before ever returning
    // here); this is the zero-write guarantee for `--yes` and for any
    // injected `askProjectName` test double that skips that validation.
    if (chosenName.length > DISCOVERY_PROJECT_NAME_MAX_LENGTH) {
      return {
        ok: false,
        code: 'DOKPLOY_PROJECT_NAME_TOO_LONG',
        message: `${folder || '.'}: project name is longer than ${DISCOVERY_PROJECT_NAME_MAX_LENGTH} characters.`,
      };
    }
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
    return { ok: false, code: 'DOKPLOY_INIT_FAILED', message: err instanceof Error ? err.message : String(err) };
  }
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

  const plaintext: Record<string, string> = {};
  if (decryptData.env_content) {
    const encrypted = fm.parseEnvContent(decryptData.env_content);
    for (const [k, v] of Object.entries(encrypted)) {
      try {
        plaintext[k] = fm.decryptValue(v, encryptionKey);
      } catch {
        // Skip undecryptable (user lacks variable-level permission).
      }
    }
  }

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
    return { ok: false, code: 'DOKPLOY_KEY_RESOLUTION_FAILED', message: keyResult.message };
  }
  const issue = findDirtyBranchIssue(pm, fm, keyResult.value);
  if (!issue) return { ok: true };
  const detail = issue.code === 'UNCOMMITTED_CHANGES' ? `an uncommitted change (${issue.varName})` : 'unpushed changes';
  return {
    ok: false,
    code: 'DOKPLOY_FOLDER_DIRTY',
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
          return { ok: false, code: 'DOKPLOY_BRANCH_PROTECTED', message: `"${branchName}" is a protected branch — access is invite-only.` };
        }
        throw err; // an anomaly — let the outer catch report it as DOKPLOY_CHECKOUT_FAILED.
      }
    })();
    if (!decryptResult.ok) return decryptResult;
    const decryptData = decryptResult.data;

    const existingKeep = pm.readKeepFile();
    if (!existingKeep) {
      return { ok: false, code: 'DOKPLOY_KEEP_MISSING', message: `${folder || '.'} has no keep.lock.` };
    }
    // Splice in only THIS branch's server pins — keep.lock holds every
    // branch's metadata and is git-owned; a sibling branch's pins must not
    // move just because this one was checked out (CAP-303).
    const keepForWrite: KeepFile = decryptData.keep_file
      ? SyncEngine.spliceKeepBranch(existingKeep, JSON.parse(decryptData.keep_file) as KeepFile, branchName)
      : existingKeep;
    if (keepForWrite !== existingKeep) fm.writeKeepFile(keepForWrite);

    if (decryptData.env_content) {
      const remoteEnv = fm.parseEnvContent(decryptData.env_content);
      const decrypted: Record<string, string> = {};
      for (const [k, v] of Object.entries(remoteEnv)) {
        try {
          decrypted[k] = fm.decryptValue(v, encryptionKey);
        } catch {
          // Skip undecryptable.
        }
      }
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
    return { ok: false, code: 'DOKPLOY_CHECKOUT_FAILED', message: err instanceof Error ? err.message : String(err) };
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
  runOpts: { noPush: boolean; interactive: boolean; json: boolean; yes: boolean; baseUrl: string; tokenEnv: string },
): Promise<ImportOutcome> {
  const path = folderPath(repoDir, folder);
  const pm = new ProjectManager(path);
  const fm = new FileManager(path);

  const projectState = await pm.detectProjectState();
  if (!projectState.initialized || !projectState.organizationId || !projectState.projectId || !projectState.activeBranch) {
    return { ok: false, code: 'DOKPLOY_KEEP_MISSING', message: `${folder || '.'} is not on a branch after checkout.` };
  }
  const keep = pm.readKeepFile();
  if (!keep) {
    return { ok: false, code: 'DOKPLOY_KEEP_MISSING', message: `${folder || '.'} has no keep.lock.` };
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
    return { ok: false, code: 'DOKPLOY_KEY_RESOLUTION_FAILED', message: projectKeyResult.message };
  }
  const projectKey = projectKeyResult.value;

  const localPlaintext: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm.readEnvFile())) {
    if (!v.startsWith('capy:')) {
      localPlaintext[k] = v;
      continue;
    }
    try {
      localPlaintext[k] = fm.decryptValue(v, projectKey);
    } catch {
      // Skip undecryptable.
    }
  }

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
  };
  const importOpts: ConnectOpts = {
    ...(env.serviceKind === 'application' ? { application: env.serviceId } : { compose: env.serviceId }),
    overwrite,
    noPush: runOpts.noPush,
    nonTty: !runOpts.interactive,
    json: runOpts.json,
    yes: runOpts.yes,
    baseUrl: runOpts.baseUrl,
    tokenEnv: runOpts.tokenEnv,
  };

  const outcome = await importFn(resolvedCtx, importOpts);
  if (!outcome.ok) return outcome;

  // A push failure here must become THIS folder's coded failure, never an
  // uncaught rejection — `runDiscoverySequences` awaits one folder's
  // sequence at a time, so letting this throw would abort every folder
  // still queued behind this one, not just this one.
  try {
    await writeImportOutcome(resolvedCtx, outcome, { push: !runOpts.noPush, quiet: true, skipAutoCommit: true, dryRun: false });
  } catch (err) {
    return { ok: false, code: 'DOKPLOY_PUSH_FAILED', message: err instanceof Error ? err.message : String(err) };
  }
  return outcome;
}

/**
 * The REAL `DiscoverySequenceDeps`, wired to an already-authenticated `ctx`
 * — the discovery scan's own org/session, reused for every folder rather
 * than re-authenticating per folder.
 */
function buildRealDiscoverySequenceDeps(
  ctx: DiscoveryContext,
  importFn: (ctx: ResolvedContext, opts: ConnectOpts) => Promise<ImportOutcome>,
  runOpts: {
    noPush: boolean;
    interactive: boolean;
    json: boolean;
    yes: boolean;
    baseUrl: string;
    tokenEnv: string;
    askExistingOrNewProject: (existing: ReadonlyArray<{ id: string; name: string }>, defaultName: string) => Promise<string>;
    askProjectName: (defaultName: string) => Promise<string>;
  },
): DiscoverySequenceDeps {
  return {
    ensureProject: (repoDir, folder, remote) =>
      ensureProjectSafe(ctx, repoDir, folder, remote, {
        interactive: runOpts.interactive,
        yes: runOpts.yes,
        askExistingOrNewProject: runOpts.askExistingOrNewProject,
        askProjectName: runOpts.askProjectName,
      }),
    checkFolderDirty: (repoDir, folder, projectId) => checkFolderDirtySafe(ctx, repoDir, folder, projectId),
    checkoutBranch: (repoDir, folder, projectId, branchName) => checkoutBranchSafe(ctx, repoDir, folder, projectId, branchName),
    importIntoBranch: (repoDir, folder, env, overwrite) => importIntoBranchSafe(ctx, importFn, repoDir, folder, env, overwrite, runOpts),
  };
}

/**
 * The `capy connect dokploy` production instance — the only place this file
 * wires the org system store for real (every other construction, including
 * every test, gets the safe env-only default — see `DokployConnectorDeps`).
 */
export const dokployConnector: ConnectorModule = createDokployConnector({
  getConnectorSecret: async (name, opts) => {
    const { getConnectorSecret } = await import('../../system/systemStore');
    return getConnectorSecret(name, opts);
  },
});

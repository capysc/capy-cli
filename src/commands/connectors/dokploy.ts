/**
 * `capy connect dokploy` — a ONE-TIME IMPORT of env vars from a Dokploy
 * Application OR Compose service into this project's `.env`, then encrypted
 * + synced the same way every other connector's write lands (CAP-662, parent
 * CAP-657; Compose support + `--dry-run` are a CAP-657 follow-up — every one
 * of the target org's Dokploy services is a Compose service, not an
 * Application).
 *
 * This is the PULL half of the Dokploy integration: "connect is for
 * retrieval, target is for deploy" (Vince, 2026-10-03). It imports values
 * (and keep.lock connector entries) and NEVER creates, offers or writes a
 * deploy target — `capy deploy dokploy --discover` (CAP-703) is what creates
 * targets, and it pushes no values. `capy deploy` (the PUSH half, see
 * `../../deploy/adapters/dokploy.ts` and `docs/dokploy-deploy-adapter.md`)
 * delivers Capy's own runtime pair back out.
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
import { TargetConfig } from '../../deploy/adapter';
import { dokployKeyHelp, keyHelpFields } from '../../deploy/keyHelp';
import { baseUrlProblem } from '../../deploy/adapters/dokploy';
import {
  DEFAULT_TOKEN_ENV,
  DOKPLOY_CONNECTOR_SECRET_NAME,
  DOKPLOY_TARGET_SECRET_NAME,
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
import { ConnectorMetadata, ERROR_CODES } from '../../types/index';
import { isInteractive } from '../../ui/interactive';
import { listOrgProjectsOrUnavailable } from '../capyCommand';
import { defaultDiscoveryCommitBranchName, snapshotPathStatus } from '../../git/discoveryCommit';
import { BaseUrlStore, Unanswered, offerSaveAskedBaseUrl, realBaseUrlStoreOpener, resolveDokployBaseUrl, settingsUnanswered } from '../../deploy/dokployBaseUrl';
import { syncFolder, type FolderSync, type GateOptions } from '../../sync/gate';
import { fingerprint, ResolvedContext } from './shared';
import { ConnectOpts, ConnectorModule, ConnectResult, ImportOutcome, ImportWarning, RotateResult } from './registry';
import { DOKPLOY_DISCOVERY_CODES } from './discoveryCodes';
import {
  ExistingProjectsSnapshot,
  OverwritePlan,
  buildRealDiscoverySequenceDeps,
  commitForAppliedRepos,
  commitPreviewForFolders,
  computeOverwritePlan,
  computeSameRunNameCollisions,
  defaultAskDiscoveryCommitBranchName,
  defaultAskDiscoveryProjectName,
  defaultAskExistingOrNewProject,
  defaultConfirm,
  defaultPickCollisionWinner,
  discoveryCommitPathsFor,
  peekLocalKeepForFolder,
} from './discoverySteps';
import {
  DiscoveryCollision,
  DiscoveryContext,
  DiscoveryOutcome,
  DiscoveryPlan,
  DiscoveryPlanFolder,
  applyCollisionResolutions,
  buildDiscoveryPlan,
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
  | { ok: true; baseUrl: string; applicationId: string; tokenEnv: string; /** CAP-703: the URL was typed at a prompt (so it may be offered to the org). */ baseUrlAsked?: true }
  | { ok: false; code: 'DOKPLOY_TARGET_AMBIGUOUS' | 'DOKPLOY_SETTINGS_MISSING'; message: string; unanswered?: readonly Unanswered[] };

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
      unanswered: settingsUnanswered({ baseUrl: !opts.baseUrl, service: !opts.application }),
    };
  }
  const asked = await deps.askSettings();
  return {
    ok: true,
    baseUrl: asked.baseUrl.trim(),
    applicationId: asked.applicationId.trim(),
    tokenEnv: tokenEnvFlag || DEFAULT_TOKEN_ENV,
    baseUrlAsked: true,
  };
}

export type DokploySourceResult =
  | { ok: true; baseUrl: string; source: DokployImportSource; tokenEnv: string; baseUrlAsked?: true }
  | {
      ok: false;
      code: 'DOKPLOY_SOURCE_AMBIGUOUS' | 'DOKPLOY_TARGET_AMBIGUOUS' | 'DOKPLOY_SETTINGS_MISSING';
      message: string;
      unanswered?: readonly Unanswered[];
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
  return {
    ok: true,
    baseUrl: r.baseUrl,
    source: { kind: 'application', id: r.applicationId },
    tokenEnv: r.tokenEnv,
    ...(r.baseUrlAsked ? { baseUrlAsked: true as const } : {}),
  };
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
        unanswered: settingsUnanswered({ baseUrl: true }),
      };
    }
    const asked = await deps.askComposeSettings();
    return {
      ok: true,
      baseUrl: asked.baseUrl.trim(),
      source: { kind: 'compose', id: asked.composeId.trim() },
      tokenEnv,
      baseUrlAsked: true,
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
      unanswered: settingsUnanswered({ baseUrl: !opts.baseUrl, service: true }),
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
      baseUrlAsked: true,
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

type FetchSourceEnvResult =
  | {
      ok: true;
      env: string | null;
      /**
       * CAP-673: the service's own name in Dokploy (`name`, falling back to
       * `appName`), off the SAME `application.one`/`compose.one` response
       * this function already reads — zero extra requests. Undefined when
       * Dokploy set neither field.
       */
      serviceName?: string;
    }
  | ({ ok: false } & { code: string; message: string });

/** `GET application.one`, mapped to a stable code + message on failure — never a thrown value. */
async function fetchApplicationEnv(client: DokployClient, applicationId: string): Promise<FetchSourceEnvResult> {
  try {
    const app = await client.getApplication(applicationId);
    return { ok: true, env: app.env, serviceName: app.name ?? app.appName };
  } catch (err) {
    return { ok: false, ...mapImportApiError(err, applicationId) };
  }
}

/** `GET compose.one`, mapped to a stable code + message on failure — never a thrown value. Mirrors `fetchApplicationEnv`. */
async function fetchComposeEnv(client: DokployClient, composeId: string): Promise<FetchSourceEnvResult> {
  try {
    const compose = await client.getCompose(composeId);
    return { ok: true, env: compose.env, serviceName: compose.name ?? compose.appName };
  } catch (err) {
    return { ok: false, ...mapImportComposeApiError(err, composeId) };
  }
}

// ── Connector ────────────────────────────────────────────────────────────────

export interface DokployConnectorDeps {
  /**
   * Discovery mode only: bare `capy` in one discovered folder (sync/gate.ts `syncFolder`). Injectable for tests that drive
   * discovery over throwaway folders with a fake service; the real sync otherwise.
   */
  syncFolder?: (dir: string, gate: GateOptions) => Promise<FolderSync>;
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
  /**
   * Opens the org system store for the Dokploy base URL variable (`_CONNECTOR_DOKPLOY_BASE_URL`). Opt-in like
   * `getConnectorSecret`: every test constructs the connector without it and never touches the store; the
   * exported `dokployConnector` singleton wires the real one.
   */
  openBaseUrlStore?: (orgId: string, devMode: boolean) => Promise<BaseUrlStore>;
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

/** `--var` on `capy connect dokploy`: comma-separated names, restricting the import. */
function parseVarRestriction(raw: string | undefined): readonly string[] | null {
  if (!raw) return null;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? names : null;
}

// COPY-FLAG: new user-facing string, minimal/neutral wording.
function overwriteConfirmMessage(
  plan: OverwritePlan,
  dollarWarnedNames: readonly string[],
  quotedNames: readonly string[] = [],
): string {
  const lines = [
    'Overwrite local vars to match Dokploy exactly?',
    plan.toImport.length > 0 ? `  Import (${plan.toImport.length}): ${plan.toImport.map((e) => e.name).join(', ')}` : null,
    plan.toReplace.length > 0 ? `  Replace (${plan.toReplace.length}): ${plan.toReplace.map((e) => e.name).join(', ')}` : null,
    plan.toClear.length > 0 ? `  Clear (${plan.toClear.length}): ${plan.toClear.join(', ')}` : null,
    dollarWarnedNames.length > 0
      ? `  review these: Dokploy/Compose may treat \`$\` specially: ${dollarWarnedNames.join(', ')}`
      : null,
    quotedNames.length > 0
      ? `  review these: the value is wrapped in quotes: ${quotedNames.join(', ')}`
      : null,
  ].filter((l): l is string => l !== null);
  return lines.join('\n');
}

/**
 * A CAP-673 connector entry for one dokploy-imported value: the provider
 * fields every dokploy import has always set, plus (when known)
 * `service_name` from the compose/application response and
 * `dokploy_project`/`environment` when the caller already resolved them
 * from `project.all` (discovery only — see `ConnectOpts.dokployProjectName`'s
 * doc). Shared by the plain import path, its unchanged-value backfill, and
 * `--overwrite`'s own build step — ONE shape, not three copies that could
 * drift.
 */
function buildDokployConnectorEntry(
  source: DokployImportSource,
  value: string,
  serviceMeta: { serviceName?: string; dokployProject?: string; environment?: string },
  createdAtSec: number,
  importedAt: string,
): ConnectorMetadata {
  return {
    provider: 'dokploy',
    source: 'import',
    created_at: createdAtSec,
    fingerprint: fingerprint(value),
    ...(source.kind === 'application' ? { application_id: source.id } : { compose_id: source.id }),
    imported_at: importedAt,
    ...(serviceMeta.serviceName ? { service_name: serviceMeta.serviceName } : {}),
    ...(serviceMeta.dokployProject ? { dokploy_project: serviceMeta.dokployProject } : {}),
    ...(serviceMeta.environment ? { environment: serviceMeta.environment } : {}),
  };
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
  serviceMeta: { serviceName?: string; dokployProject?: string; environment?: string };
  interactive: boolean;
  dryRun: boolean;
  confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
  now: () => Date;
}): Promise<ImportOutcome> {
  const { ctx, opts, source, sourceEnv, serviceMeta, interactive, dryRun, confirm, now } = args;

  // Dokploy's FULL importable set — `--var` is ignored under `--overwrite`
  // (see `computeOverwritePlan`'s doc for why a restricted clear would be unsafe).
  const fullImportable = listImportableEntries(sourceEnv);
  const referenceNames = fullImportable.filter((e) => e.skip === 'DOKPLOY_REFERENCE_VALUE').map((e) => e.name);
  // Names only — never a value. Still imported; just worth a second look.
  const dollarWarnedNames = fullImportable.filter((e) => e.warning === 'DOKPLOY_VALUE_HAS_DOLLAR').map((e) => e.name);
  // Names only — never a value (CAP-679 follow-up). Still imported, never
  // stripped — see `classifyImportValue`'s doc.
  const quotedNames = fullImportable.filter((e) => e.warning === 'DOKPLOY_VALUE_QUOTED').map((e) => e.name);
  const fullCandidates = fullImportable.filter((e) => !e.skip).map((e) => ({ name: e.name, value: e.value }));
  const plan = computeOverwritePlan(fullCandidates, referenceNames, ctx.localPlaintext);

  const hasWrite = plan.toClear.length > 0 || plan.toReplace.length > 0 || plan.toImport.length > 0;
  const promptable = interactive && !opts.json;

  if (!dryRun && hasWrite) {
    if (promptable && !opts.yes) {
      const proceed = await confirm(overwriteConfirmMessage(plan, dollarWarnedNames, quotedNames), false);
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
          warnings: [
            ...(referenceNames.length > 0 ? [{ code: 'DOKPLOY_REFERENCE_VALUE', names: referenceNames }] : []),
            ...(dollarWarnedNames.length > 0 ? [{ code: 'DOKPLOY_VALUE_HAS_DOLLAR', names: dollarWarnedNames }] : []),
            ...(quotedNames.length > 0 ? [{ code: 'DOKPLOY_VALUE_QUOTED', names: quotedNames }] : []),
          ],
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
  const buildEntry = (value: string): ConnectorMetadata =>
    buildDokployConnectorEntry(source, value, serviceMeta, createdAtSec, importedAt);
  const written = [...plan.toImport, ...plan.toReplace].map(({ name, value }) => ({
    varName: name,
    value,
    entry: buildEntry(value),
  }));
  const replacedNames = plan.toReplace.map((e) => e.name);
  // CAP-673: a re-run of `--overwrite` over a name whose value already
  // matches must still refresh its connector metadata (service_name/
  // dokploy_project/environment) — see `ImportOutcome.unchangedEntries`'s
  // doc. Same value, same fingerprint; only the provider fields move.
  const unchangedEntries = plan.unchanged.map((name) => {
    const value = fullCandidates.find((c) => c.name === name)!.value;
    return { varName: name, value, entry: buildEntry(value) };
  });

  return {
    ok: true,
    ...(source.kind === 'application' ? { applicationId: source.id } : {}),
    source,
    imported: written,
    cleared: plan.toClear,
    replacedNames,
    unchanged: plan.unchanged,
    unchangedEntries,
    skipped: [],
    warnings: [
      ...(referenceNames.length > 0 ? [{ code: 'DOKPLOY_REFERENCE_VALUE', names: referenceNames }] : []),
      ...(dollarWarnedNames.length > 0 ? [{ code: 'DOKPLOY_VALUE_HAS_DOLLAR', names: dollarWarnedNames }] : []),
      ...(quotedNames.length > 0 ? [{ code: 'DOKPLOY_VALUE_QUOTED', names: quotedNames }] : []),
      ...(written.length > 0 && !dryRun ? [{ code: 'DOKPLOY_PLAINTEXT_REMAINS', names: written.map((w) => w.varName) }] : []),
    ],
  };
}

/** The stored base URL for a run that was not given `--base-url`; `undefined` when a flag was given, the variable is unset, or it cannot be read. */
async function storedBaseUrlFor(
  opts: ConnectOpts,
  orgId: string,
  openBaseUrlStore: DokployConnectorDeps['openBaseUrlStore'],
): Promise<string | undefined> {
  if (opts.baseUrl?.trim() || openBaseUrlStore === undefined) return undefined;
  const resolved = await resolveDokployBaseUrl({
    dryRun: true,
    openStore: () => openBaseUrlStore(orgId, !!opts.devMode),
    savedTargetUrl: () => undefined,
  });
  return resolved.ok ? resolved.baseUrl : undefined;
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
      const dokployTargets = listTargets(cwd()).filter((t) => t.kind === 'dokploy');

      // CAP-703: with no `--base-url`, the org system variable (`_CONNECTOR_DOKPLOY_BASE_URL`) comes before a saved
      // target and the interactive ask - the same shared resolver, read-only here (the discover commands save it).
      const storedBaseUrl = await storedBaseUrlFor(opts, ctx.orgId, deps.openBaseUrlStore);
      const settings = await resolveDokployImportSource(storedBaseUrl === undefined ? opts : { ...opts, baseUrl: storedBaseUrl }, dokployTargets, interactive, {
        pickTarget,
        askSettings,
        askComposeSettings,
        askSourceKind,
      });
      if (!settings.ok) {
        return { ok: false, code: settings.code, message: settings.message, ...(settings.unanswered === undefined ? {} : { unanswered: settings.unanswered }) };
      }
      const { baseUrl, source, tokenEnv } = settings;

      // Resolved BEFORE any Dokploy request — a missing/refused token still
      // means zero requests (see the class doc's "READ-ONLY" note). A
      // SEPARATE interactive flag from the one above: `--json` (machine output
      // must never have a prompt interleaved with it) and `--dry-run` (a
      // preview must never have the side effect of saving a new key into the
      // org store) suppress ONLY this prompt, not the settings prompts above.
      const secretsInteractive = dokploySecretsMayPrompt(interactive, !!opts.json || dryRun);
      const resolved = await resolveDokployApiKey({
        tokenEnv,
        env: deps.env ?? process.env,
        interactive: secretsInteractive,
        orgId: ctx.orgId,
        devMode: opts.devMode,
        helpBaseUrl: baseUrl,
        storeName: DOKPLOY_CONNECTOR_SECRET_NAME,
        deps: deps.getConnectorSecret ? { getConnectorSecret: deps.getConnectorSecret } : undefined,
      });
      if (!resolved.ok) {
        const { reason } = describeDokployTokenProblem(resolved.code, tokenEnv, DOKPLOY_CONNECTOR_SECRET_NAME);
        return { ok: false, code: resolved.code, message: `${reason}.`, ...keyHelpFields(dokployKeyHelp(DOKPLOY_CONNECTOR_SECRET_NAME, baseUrl)) };
      }
      const token = resolved.value;

      const client = createDokployClient(baseUrl, token, deps.fetch);
      const envResult =
        source.kind === 'compose'
          ? await fetchComposeEnv(client, source.id)
          : await fetchApplicationEnv(client, source.id);
      if (!envResult.ok) {
        // A rejected key says where to get another.
        return {
          ok: false,
          code: envResult.code,
          message: envResult.message,
          ...(envResult.code === 'DOKPLOY_AUTH_FAILED' ? keyHelpFields(dokployKeyHelp(DOKPLOY_CONNECTOR_SECRET_NAME, baseUrl)) : {}),
        };
      }
      // CAP-703: a URL typed at a prompt is offered to the org once Dokploy has answered with it - saved only when the
      // variable is unset and the caller is an org admin (never overwritten), a dry run saves nothing.
      if (settings.baseUrlAsked === true && !dryRun) {
        const openStore = deps.openBaseUrlStore;
        await offerSaveAskedBaseUrl({
          baseUrl,
          openStore: openStore === undefined ? undefined : () => openStore(ctx.orgId, !!opts.devMode),
        });
      }
      const sourceEnv = envResult.env;
      // CAP-673: `service_name` is free (same response as `env`, above);
      // `dokploy_project`/`environment` are only known when the caller
      // already resolved them from `project.all` — discovery's own
      // per-environment call always does (see `ConnectOpts.dokployProjectName`'s
      // doc); a plain `--application`/`--compose` import never fetches
      // `project.all` for it, so those two stay absent there.
      const serviceMeta = {
        serviceName: envResult.serviceName,
        dokployProject: opts.dokployProjectName,
        environment: opts.dokployEnvironmentName,
      };

      const restrict = parseVarRestriction(opts.var);
      const importable = listImportableEntries(sourceEnv).filter((e) => !restrict || restrict.includes(e.name));
      const referenceSkipped = importable.filter((e) => e.skip === 'DOKPLOY_REFERENCE_VALUE').map((e) => e.name);
      // Names only — never a value. Still imported; just worth a second look
      // (bcrypt hashes written `$$escaped$$`, an unresolved `${VAR}`, …).
      const dollarWarned = importable.filter((e) => e.warning === 'DOKPLOY_VALUE_HAS_DOLLAR').map((e) => e.name);
      // Names only — never a value (CAP-679 follow-up). Still imported, never
      // stripped — see `classifyImportValue`'s doc.
      const quotedWarned = importable.filter((e) => e.warning === 'DOKPLOY_VALUE_QUOTED').map((e) => e.name);
      const candidates = importable.filter((e) => !e.skip);

      if (opts.overwrite) {
        return await runOverwriteImport({ ctx, opts, source, sourceEnv, serviceMeta, interactive, dryRun, confirm, now });
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
        entry: buildDokployConnectorEntry(source, value, serviceMeta, createdAtSec, importedAt),
      }));
      // CAP-673: a re-import over a name whose value already matches must
      // still refresh its connector metadata — see
      // `ImportOutcome.unchangedEntries`'s doc. Never populated under a dry
      // run (nothing should look written in a preview).
      const unchangedEntries = dryRun
        ? []
        : unchanged.map((name) => {
            const value = selected.find((e) => e.name === name)!.value;
            return { varName: name, value, entry: buildDokployConnectorEntry(source, value, serviceMeta, createdAtSec, importedAt) };
          });

      const warnings: ImportWarning[] = [
        ...(referenceSkipped.length > 0 ? [{ code: 'DOKPLOY_REFERENCE_VALUE', names: referenceSkipped }] : []),
        ...(dollarWarned.length > 0 ? [{ code: 'DOKPLOY_VALUE_HAS_DOLLAR', names: dollarWarned }] : []),
        ...(quotedWarned.length > 0 ? [{ code: 'DOKPLOY_VALUE_QUOTED', names: quotedWarned }] : []),
        // Reminder, names only: the plaintext stays in Dokploy — reversible by
        // design (see docs/dokploy-deploy-adapter.md) — and is ignored at
        // boot once `capy deploy` writes the runtime pair. Not under a dry
        // run: nothing was actually imported, so nothing has landed yet for
        // this to be a reminder about.
        ...(imported.length > 0 && !dryRun
          ? [{ code: 'DOKPLOY_PLAINTEXT_REMAINS', names: imported.map((i) => i.varName) }]
          : []),
      ];

      return {
        ok: true,
        ...(source.kind === 'application' ? { applicationId: source.id } : {}),
        source,
        imported,
        unchanged,
        unchangedEntries,
        skipped,
        warnings,
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
      // The one shared base-URL resolver: --base-url, then the org system
      // variable, then the saved deploy target, else a structured refusal.
      const openBaseUrlStore = deps.openBaseUrlStore;
      const savedBaseUrl = (dokployTargets[0]?.options as DokployTargetOptions | undefined)?.baseUrl;
      const baseUrlResolution = await resolveDokployBaseUrl({
        flag: opts.baseUrl,
        dryRun,
        openStore: openBaseUrlStore === undefined ? undefined : () => openBaseUrlStore(ctx.orgId, !!opts.devMode),
        savedTargetUrl: () => savedBaseUrl,
      });
      // A direct caller at a real terminal may still be asked; the CLI never is (see `ConnectCommand`).
      const asked: string | null =
        !baseUrlResolution.ok && baseUrlResolution.code === 'DOKPLOY_SETTINGS_MISSING' && interactive
          ? (await askDiscoveryBaseUrl()).trim()
          : null;
      if (!baseUrlResolution.ok && !asked) {
        return {
          ok: false,
          code: baseUrlResolution.code,
          message: baseUrlResolution.error,
          ...(baseUrlResolution.unanswered === undefined ? {} : { unanswered: baseUrlResolution.unanswered }),
        };
      }
      const resolvedBaseUrl: string = baseUrlResolution.ok ? baseUrlResolution.baseUrl : (asked as string);
      // Reported in the discover output: `saved: { base_url: true }` and the coded notices.
      const baseUrlReport = baseUrlResolution.ok
        ? {
            ...(baseUrlResolution.saved === undefined ? {} : { saved: baseUrlResolution.saved }),
            ...(baseUrlResolution.notices.length === 0 ? {} : { notices: baseUrlResolution.notices }),
          }
        : {};

      // Same suppression rule as the single-service import: never prompt for
      // the key under --json/--dry-run.
      const secretsInteractive = dokploySecretsMayPrompt(interactive, !!opts.json || dryRun);
      const resolved = await resolveDokployApiKey({
        tokenEnv,
        env: deps.env ?? process.env,
        interactive: secretsInteractive,
        orgId: ctx.orgId,
        devMode: opts.devMode,
        helpBaseUrl: resolvedBaseUrl,
        storeName: DOKPLOY_CONNECTOR_SECRET_NAME,
        deps: deps.getConnectorSecret ? { getConnectorSecret: deps.getConnectorSecret } : undefined,
      });
      if (!resolved.ok) {
        const { reason } = describeDokployTokenProblem(resolved.code, tokenEnv, DOKPLOY_CONNECTOR_SECRET_NAME);
        return { ok: false, code: resolved.code, message: `${reason}.`, ...keyHelpFields(dokployKeyHelp(DOKPLOY_CONNECTOR_SECRET_NAME, resolvedBaseUrl)) };
      }

      const client = createDokployClient(resolvedBaseUrl, resolved.value, deps.fetch);
      const scan = findCandidateReposResult(cwd(), DOKPLOY_DISCOVERY_CODES);
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
        const commits = commitPreviewForFolders(plan.folders, defaultDiscoveryCommitBranchName(), DOKPLOY_DISCOVERY_CODES);
        return { ok: true, dryRun: true, plan, ...(commits.length > 0 ? { commits } : {}), ...baseUrlReport };
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
        return { ok: true, dryRun: false, plan, applied: [], ...baseUrlReport };
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
          return { ok: true, dryRun: false, plan, applied: [], cancelled: true, ...baseUrlReport };
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

      // Vince, 2026-09-26 decision: the non-interactive `--yes` auto-create
      // rule (see `ensureProjectSafe`'s doc) needs to know "does this org
      // have ANY existing project" — taken as ONE snapshot right here,
      // before `runDiscoverySequences` runs a single folder, so a project
      // folder A's own `ensureProject` creates this run is never counted as
      // "existing" when folder B (later in the SAME run) asks the same
      // question. Only fetched in the mode that can ever consult it —
      // interactive runs make their own fresh per-folder call instead (see
      // `ensureProjectSafe`), and non-interactive without `--yes` refuses
      // before ever needing a project list.
      const existingProjectsSnapshot: ExistingProjectsSnapshot | undefined =
        !promptable && !!opts.yes ? await listOrgProjectsOrUnavailable(ctx.serviceClient) : undefined;

      // Vince, 2026-09-26 decision: "two folders in the SAME run would
      // create a project with the same default name" is knowable BEFORE any
      // folder runs — every candidate folder's own default name is a pure
      // function of (repoDir, folder, remote), all already sitting in
      // `resolvedFolders` — so this is computed ONCE, up front, exactly like
      // `existingProjectsSnapshot` above, rather than tracked as mutable
      // state threaded through the sequential per-folder run below.
      const sameRunNameCollisions: ReadonlySet<string> =
        !promptable && !!opts.yes ? computeSameRunNameCollisions(resolvedFolders) : new Set();

      const sequenceDeps = buildRealDiscoverySequenceDeps(ctx, connector.import!, {
        noPush: !!opts.noPush,
        interactive: promptable,
        json: !!opts.json,
        yes: !!opts.yes,
        codes: DOKPLOY_DISCOVERY_CODES,
        importOptsFor: (env, projectName) => ({
          ...(env.serviceKind === 'application' ? { application: env.serviceId } : { compose: env.serviceId }),
          baseUrl: resolvedBaseUrl,
          tokenEnv,
          // Already known from the plan — see `dokployProjectName`'s doc.
          dokployProjectName: projectName,
          dokployEnvironmentName: env.environmentName,
        }),
        // Discovery never prompts: a folder that differs from Capy is reported (its rows and `conflict_id`), not asked.
        gate: { devMode: opts.devMode, json: true, nonTty: true, conflictFlags: opts.conflictFlags },
        syncFolder: deps.syncFolder ?? syncFolder,
        askExistingOrNewProject,
        askProjectName: askDiscoveryProjectName,
        existingProjectsSnapshot,
        sameRunNameCollisions,
      });
      const applied = await runDiscoverySequences(resolvedFolders, { overwrite: !!opts.overwrite }, sequenceDeps);

      // Commit ONLY the successful folders' keep.lock/.gitignore, per repo —
      // a failed folder's files are left uncommitted and unstaged, and the
      // caller (executeDiscovery) reports which folders were left out by
      // cross-referencing `applied`'s own ok:false entries. Runs the same
      // whether or not `--no-push` was passed — keep.lock/.env are written
      // locally either way (see `writeImportOutcome`), so there is always
      // something local for this step to pin.
      const commits = commitForAppliedRepos(applied, beforeStatusByRepo, commitBranchName, DOKPLOY_DISCOVERY_CODES);

      return { ok: true, dryRun: false, plan, applied, ...(commits.length > 0 ? { commits } : {}), ...baseUrlReport };
    },
  };
  return connector;
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

/**
 * The real org system store read for the Dokploy IMPORT key (`_CONNECTOR_DOKPLOY_API_KEY`).
 * Shared by `capy connect dokploy` and `capy deploy dokploy --discover`, which read the same
 * Dokploy inventory with the same key.
 *
 * CAP-679 follow-up: import's own direction — see
 * `system/systemStore.ts#getDirectionalConnectorSecret`'s doc, and
 * `deploy/adapters/dokploy.ts`'s `dokployAdapter` for the symmetric
 * deploy-side wiring.
 */
export async function dokployConnectorSecret(name: string, opts: DokploySystemStoreCallOptions): Promise<string | null> {
  const { getDirectionalConnectorSecret } = await import('../../system/systemStore');
  return getDirectionalConnectorSecret(name, DOKPLOY_TARGET_SECRET_NAME, {
    ...opts,
    missingWithFallbackCode: ERROR_CODES.DOKPLOY_CONNECTOR_KEY_MISSING,
  });
}

/**
 * The `capy connect dokploy` production instance — the only place this file
 * wires the org system store for real (every other construction, including
 * every test, gets the safe env-only default — see `DokployConnectorDeps`).
 */
export const dokployConnector: ConnectorModule = createDokployConnector({
  getConnectorSecret: dokployConnectorSecret,
  openBaseUrlStore: (orgId, devMode) => realBaseUrlStoreOpener(orgId, devMode)(),
});

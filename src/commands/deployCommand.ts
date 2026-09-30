/**
 * `capy deploy [target] [options]`
 *
 * Top-level deploy verb. Runs an interactive picker to set up a target on
 * first use, persists to `.capy/deploy.json`, then ships secrets + code to
 * the chosen vendor. Subsequent runs skip the picker.
 *
 * NOT to be confused with `capy deploy token …` — that's the legacy deploy-
 * token issuance flow (see deployTokenCommand.ts) used to inject secrets
 * into CI for `capy run` deployed mode. This command is the inverse: it
 * runs the deploy itself.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import inquirer from 'inquirer';
import { FileManager } from '../files/fileManager';
import {
  DeployAdapter,
  DeployContext,
  DeployMode,
  DeployResult,
  PreflightResult,
  TargetConfig,
} from '../deploy/adapter';
import {
  isGitRepo,
  hasKeepLockChanges,
  stageAndCommit,
  currentBranch,
  checkoutBranch,
  discardPaths,
  restorePathsToHead,
  stashOtherChanges,
  popStash,
  pushBranch,
  createPr,
  listLocalBranches,
  listAllBranches,
  fetchRemoteBranch,
  repoRelPath,
  readFileAtRef,
  worktreeAddNewBranch,
  worktreeRemove,
  deleteLocalBranch,
} from '../deploy/git';
import { buildDeployKeep, touchDeployKeep, reconcileVars, hashValue } from '../deploy/keepGate';
import {
  branchPushProblem,
  describeBranchProblem,
  recordTargetDeliveries,
  stripTargetsForProviderTarget,
  supersededDeployIdsForTarget,
  clearSupersededDeployIds,
  allDeployIdsForTarget,
  deliveryWorthGating,
  TargetDeliveryDescriptor,
  VarDelivery,
} from '../deploy/targetsGate';
import { KeepFile, ERROR_CODES, AuthResult, ErrorCode } from '../types/index';
import type { AuthService } from '../auth/authService';
import { ProjectManager } from '../core/projectManager';
import { tmpdir } from 'os';
import { ALL_ADAPTERS, getAdapter, listPlanned } from '../deploy/registry';
import { detectAwsRegion, leafFor } from '../deploy/adapters/awsSsm';
import {
  baseUrlProblem,
  dokploySecretsMayPrompt,
  dokployConnectionProblem,
  resolveDokployApiKey,
  parseDokployServiceUrl,
  looksLikeUrl,
  verifyDokployService,
  resolveDokployEnvironmentLabel,
} from '../deploy/adapters/dokploy';
import type { ResolveDokployApiKeyResult, DokployServiceKind, DokployServiceUrlOk } from '../deploy/adapters/dokploy';
import {
  DOKPLOY_CONNECTOR_SECRET_NAME,
  DOKPLOY_TARGET_SECRET_NAME,
  DokploySystemStoreCallOptions,
  createDokployClient,
} from '../deploy/dokployApi';
import { classify, isBuildTime } from '../deploy/classify';
import type { WebDeployAdapterContext } from '../ui/deployScreens';
import { deployPlan, unansweredDeployStops, type DeployStopId } from '../core/deployPlan';
import type {
  DeployAdapterChoice,
  DeployPlanConfirmStop,
  DeployPlanTarget,
  DeployPreflightCheck,
  DeployRunResultData,
  DeployRunStep,
  DeploySetupStep,
  DeployTargetRow,
} from '../ui/screens/contract';
import { CHECKBOX_INSTRUCTIONS, CHECKBOX_THEME, LIST_THEME } from '../ui/promptStyle';
import { keypressConfirm } from '../ui/keypressConfirm';
import {
  deployConfigPath,
  getTarget,
  listTargets,
  removeTarget,
  upsertTarget,
} from '../deploy/config';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;

export interface DeployCliOptions {
  /** Skip picker; run by adapter id directly (CI-friendly). */
  target?: string;
  /** Skip all prompts (CI). */
  yes?: boolean;
  /** Preflight + show plan, do not push. */
  dryRun?: boolean;
  /** Force re-entry into the picker for an existing target. */
  edit?: boolean;
  /**
   * Force a deploy even when keep.lock is unchanged: bump keep.lock with a
   * deploy nonce so there's a change to commit + PR, triggering a fresh CI run.
   */
  force?: boolean;
  /**
   * Run against the dev service (capy-dev). Propagated to the auth/service
   * clients used for decryption — without it they default to prod
   * (api.capy.sc) and co-decrypt fails for dev-only orgs.
   */
  devMode?: boolean;
  /**
   * Ask this run's questions in a browser instead of at the TTY.
   *
   * Changes only where a question is RENDERED. The same plan decides which
   * questions exist, the same answers reach the same code, and nothing about
   * what is decrypted, committed, pushed or written to `.capy/deploy.json`
   * moves.
   */
  web?: boolean;
  /**
   * Describe the route instead of travelling it.
   *
   * The SAME stop array the browser screens are served, so a headless caller
   * can see which stops argv already settled and which it would be asked
   * about. Printed before any network call and before anything is decrypted,
   * because a plan you had to deploy to obtain is not a plan.
   *
   * (argv wiring for this — and for `--web` — lives in src/index.ts, which the
   * coordinator owns; both are threaded here and settable by any caller.)
   */
  json?: boolean;
  /**
   * The platform answer from earlier in the run, when `capy deploy` reached
   * here through the destination picker. It is a stop this run really
   * travelled, so the rail continues rather than restarting.
   */
  platformAnswer?: string;
  /** The mode answer, when that question was really asked. */
  modeAnswer?: string;
  /**
   * Write and verify the target's configuration, but skip the platform
   * deploy/redeploy (CAP-679). The user, or the platform's own auto-deploy,
   * ships it later. `targets` are still recorded — the write happened.
   */
  noDeploy?: boolean;
}

/** Whether a question is asked in a browser, and what the rail already holds. */
interface WebContext {
  web?: boolean;
  platformAnswer?: string;
  modeAnswer?: string;
}

/** Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI / headless in. */
const openBrowser = (): boolean => !process.env.CAPY_WEB_NO_OPEN;

/**
 * Dokploy only: resolves the org system store's API key ONCE for this whole
 * command, wiring the REAL `system/systemStore.ts#getConnectorSecret` — this
 * is the production entry point for CAP-664. The result is threaded into
 * every `preflight`/`deploy`/`onRemove` call via `ctx.resolvedApiKey`, so the
 * store is asked (and an admin prompted) at most once per command no matter
 * how many of those run. `undefined` for every other adapter — they never
 * read that field.
 *
 * Never resolves (never prompts, never touches the store) when the target
 * can't even be reached — `dokployConnectionProblem` (an unusable `baseUrl`,
 * a missing `applicationId`, or a malformed `tokenEnv`): `preflight()` fails
 * on that regardless of any token, so asking for (or prompting to save) a
 * key first would be wasted at best and a needless prompt at worst.
 * Deliberately NOT the full `optionsProblem` — `onRemove` has no vars to
 * ship and must still reach a target that check would otherwise reject.
 */
async function resolveDokployApiKeyOnce(
  adapter: DeployAdapter,
  target: TargetConfig,
  orgId: string | undefined,
  devMode: boolean | undefined,
  interactive: boolean,
): Promise<ResolveDokployApiKeyResult | undefined> {
  if (adapter.id !== 'dokploy') return undefined;
  if (dokployConnectionProblem(target)) return undefined;
  const { getDirectionalConnectorSecret } = await import('../system/systemStore');
  // CAP-679 follow-up: deploy asks for `_TARGET_DOKPLOY_API_KEY` first, and
  // — only when that's missing — offers to reuse (or shadow-refuse without a
  // TTY) `_CONNECTOR_DOKPLOY_API_KEY`, the import-side key. See
  // `system/systemStore.ts#getDirectionalConnectorSecret`'s own doc.
  const getConnectorSecret = (name: string, opts: DokploySystemStoreCallOptions) =>
    getDirectionalConnectorSecret(name, DOKPLOY_CONNECTOR_SECRET_NAME, {
      ...opts,
      missingWithFallbackCode: ERROR_CODES.DOKPLOY_TARGET_KEY_MISSING,
    });
  return resolveDokployApiKey({
    tokenEnv: (target.options as { tokenEnv?: string }).tokenEnv,
    env: process.env,
    interactive,
    orgId,
    devMode,
    storeName: DOKPLOY_TARGET_SECRET_NAME,
    deps: { getConnectorSecret },
  });
}

/**
 * `authenticateSilent`'s common "org-scoped, then unscoped" probe as one
 * value rather than a reassigned local — the org-scoped attempt wins
 * outright; the unscoped one only runs (and is only returned) when it
 * failed. Shared by every CAP-679 write path below that needs to
 * authenticate without ever prompting (they are all best-effort follow-ups
 * to an operation that already succeeded).
 */
async function authenticateSilentWithFallback(
  authService: AuthService,
  orgId: string,
): Promise<AuthResult> {
  const scoped = await authService.authenticateSilent(orgId);
  return scoped.success ? scoped : await authService.authenticateSilent();
}

// ── Project-level keep.lock parsing ────────────────────────────────────────

export interface KeepInfo {
  orgId: string;
  projectId: string;
  variables: string[];
  branches: string[];
}

/** One (variable, branch) entry, as loosely as `readKeep` needs to read it. */
interface ParsedKeepEntry {
  branch?: string;
}

/**
 * The keep.lock shape `readKeep` needs — org_id/project_id required (nothing
 * useful can come from a file missing either), variables optional and only
 * as deep as `readKeep` reads it. Deliberately looser than a fully validated
 * `KeepFile` (that's `ProjectManager.readKeepFile`, which additionally
 * requires `project_name`/`version` and is used by every OTHER reader) — the
 * runtime check in `readKeep` below is still what actually enforces
 * org_id/project_id being present; this type just replaces `any` in the
 * code that reads the parsed result.
 */
interface ParsedKeepJson {
  org_id: string;
  project_id: string;
  variables?: Record<string, ParsedKeepEntry[]>;
}

/**
 * Best-effort JSON read: null on anything short of a parsed object (missing
 * file, unreadable, malformed JSON) — `readKeep` below only ever needs
 * org_id/project_id/variables out of this, not a fully validated KeepFile.
 */
function tryReadKeepJson(path: string): ParsedKeepJson | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ParsedKeepJson;
  } catch {
    return null;
  }
}

/**
 * Reads the CURRENT keep.lock — capy's untracked working copy at
 * `.capy/keep.lock` when present, else the tracked file (same preference
 * `ProjectManager.readKeepFile` applies, CAP-667). This is deploy's LOCAL
 * picture of what variables/branches exist, used for the target picker and
 * for decrypting the branch about to ship; it is NOT the CI change-gate's
 * base read, which deliberately reads `origin/<base>`'s keep.lock via git
 * and is untouched by this.
 *
 * Before this fix, deploy read the tracked file directly — which the rest
 * of capy no longer updates after project init, so a deploy run any time
 * after the first `capy push` would see a stale, empty-ish variable/branch
 * list here.
 */
export function readKeep(cwd: string): KeepInfo | null {
  const pm = new ProjectManager(cwd);
  const raw = tryReadKeepJson(pm.getWorkingKeepPath()) ?? tryReadKeepJson(pm.getKeepPath());
  if (!raw || !raw.org_id || !raw.project_id) return null;
  const variables = Object.keys(raw.variables ?? {}).sort();
  const branches = Array.from(
    new Set(
      Object.values(raw.variables ?? {})
        .flatMap((entries) => (Array.isArray(entries) ? entries : []))
        .map((e) => e?.branch)
        .filter((b): b is string => Boolean(b)),
    ),
  ).sort();
  return {
    orgId: raw.org_id,
    projectId: raw.project_id,
    variables,
    branches,
  };
}

/**
 * Copies capy's untracked working copy (`.capy/keep.lock`) over the tracked
 * `keep.lock`, when it exists and differs — so direct-mode deploy's
 * "keep.lock dirty? commit it" check (below) and its commit both see the
 * CURRENT pins, not whatever was frozen into the tracked file at project
 * init. A no-op when there's no working copy yet (fresh worktree, or a
 * project that predates it) — the tracked file is already the best
 * information available, same as `ProjectManager.readKeepFile`'s fallback.
 *
 * Never touches `.capy/keep.lock` itself, so it stays exactly what it was —
 * only the tracked file is brought in line with it.
 */
export function syncTrackedKeepForDirectDeploy(cwd: string): void {
  const workingPath = new ProjectManager(cwd).getWorkingKeepPath();
  if (!existsSync(workingPath)) return;
  const workingContent = readFileSync(workingPath, 'utf-8');
  const trackedPath = join(cwd, 'keep.lock');
  if (existsSync(trackedPath) && readFileSync(trackedPath, 'utf-8') === workingContent) return;
  writeFileSync(trackedPath, workingContent, 'utf-8');
}

// ── Decryption (uses same path as `capy export` / `capy run`) ──────────────

async function decryptCurrentBranch(
  cwd: string,
  devMode: boolean = false,
): Promise<Record<string, string>> {
  // CAP-682 fix: this constructed `FileManager()` with no `cwd`, silently
  // reading `.env` from `process.cwd()` instead of the `cwd` this function
  // was actually called with — every OTHER `new FileManager(cwd)` call site
  // in this file passes it. Dormant for token adapters (their secrets never
  // reach this function — see `loadDeploySecrets`), but Dokploy's plain-value
  // delivery (CAP-682) now decrypts for real, which is what surfaced it.
  const fm = new FileManager(cwd);
  const envFromFile = fm.readEnvFile();

  const out: Record<string, string> = {};
  const toDecrypt: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(envFromFile)) {
    if (typeof v !== 'string') continue;
    if (fm.isEncrypted(v)) toDecrypt.push([k, v]);
    else out[k] = v;
  }
  if (toDecrypt.length === 0) return out;

  const keep = readKeep(cwd);
  if (!keep) {
    throw new Error('no keep.lock — run `capy` to sync first.');
  }

  const { AuthService, silentAuthFailureMessage } = await import('../auth/authService');
  const { ServiceClient } = await import('../service/serviceClient');
  const { resolveProjectKey } = await import('../crypto/keyResolver');

  const auth = new AuthService(undefined, devMode);
  const result = await auth.authenticateSilent(keep.orgId);
  if (!result.success || !result.user_id) {
    throw new Error(silentAuthFailureMessage(result));
  }
  const svc = new ServiceClient(undefined, devMode);
  svc.setTokenProvider(() => auth.getValidToken());
  const keyServiceOps = {
    coDecrypt: (o: string, c: string) =>
      svc.coDecrypt(o, c).then((r) => r.plaintext),
    wrapOuterLayer: (o: string, p: string) =>
      svc.wrapOuterLayer(o, p).then((r) => r.ciphertext),
  };
  const projectKeyHex = await resolveProjectKey(
    keep.orgId,
    keep.projectId,
    result.user_id,
    keyServiceOps,
  );
  for (const [k, v] of toDecrypt) {
    out[k] = fm.decryptValue(v, projectKeyHex);
  }
  return out;
}

/**
 * Mint the SECRETS_BLOB + PROJECT_KEY pair for build-time injection (what
 * `capy run` consumes). Same devMode-aware auth as decryptCurrentBranch — so
 * under capy-dev it talks to the dev service, not prod. The bundle carries
 * only `vars` — the target's selection — never the whole `.env`.
 *
 * CAP-682: no shipped adapter has `needsDeployToken: true` anymore (Dokploy
 * — the only one that ever did — moved to plain-value delivery), so this
 * function's one call site below (inside `loadDeploySecrets`) is currently
 * unreachable. Deliberately KEPT, not deleted: the original CAP-682 spec is
 * explicit that "the blob/token machinery stays for other adapters and
 * `capy run`" — this is the mechanism a future token-based adapter opts
 * into by setting `needsDeployToken: true`, and removing it now would
 * silently retract that documented capability rather than leave it dormant.
 */
async function mintForDeploy(
  cwd: string,
  vars: readonly string[],
  devMode: boolean = false,
): Promise<{ secretsBlob: string; projectKey: string; deployId: string; valueHashes: Record<string, string> }> {
  const keep = readKeep(cwd);
  if (!keep) throw new Error('no keep.lock — run `capy` to sync first.');

  const { AuthService, silentAuthFailureMessage } = await import('../auth/authService');
  const { ServiceClient } = await import('../service/serviceClient');
  const { mintDeployToken } = await import('./deployTokenCommand');

  const auth = new AuthService(undefined, devMode);
  const result = await auth.authenticateSilent(keep.orgId);
  if (!result.success || !result.user_id) {
    throw new Error(silentAuthFailureMessage(result));
  }
  const svc = new ServiceClient(undefined, devMode);
  svc.setTokenProvider(() => auth.getValidToken());
  const minted = await mintDeployToken({
    serviceClient: svc,
    fm: new FileManager(),
    orgId: keep.orgId,
    projectId: keep.projectId,
    userId: result.user_id,
    vars,
  });
  return {
    secretsBlob: minted.secretsBlob,
    projectKey: minted.projectKey,
    deployId: minted.deployId,
    valueHashes: minted.valueHashes,
  };
}

/** What the deploy hands its adapter, or `null` once the failure is printed. */
interface DeploySecrets {
  env: Record<string, string>;
  deployToken?: { secretsBlob: string; projectKey: string; deployId: string };
  /**
   * sha256(value).slice(0,16) per variable actually delivered (CAP-679) —
   * from the minted bundle's own plaintext for a token adapter, or hashed
   * from `env` directly otherwise. Used only to RECORD `targets`, never to
   * decide anything about the deploy itself.
   */
  valueHashes: Record<string, string>;
}

/**
 * Decrypt the secrets we're about to push — or, for an adapter that ships the
 * `capy run` pair, mint it. Runs only after preflight has passed.
 */
async function loadDeploySecrets(
  cwd: string,
  adapter: DeployAdapter,
  target: TargetConfig,
  options: DeployCliOptions,
): Promise<DeploySecrets | null> {
  if (options.dryRun) {
    console.log(YELLOW('  --dry-run: no secrets will be decrypted or pushed.'));
    return { env: {}, valueHashes: {} };
  }
  if (adapter.needsDeployToken) {
    try {
      const minted = await mintForDeploy(cwd, target.vars, options.devMode);
      return { env: {}, deployToken: minted, valueHashes: minted.valueHashes };
    } catch (err: any) {
      console.error(`${RED('✗')} mint deploy token: ${err.message}`);
      return null;
    }
  }
  try {
    const env = await decryptCurrentBranch(cwd, options.devMode);
    const valueHashes = Object.fromEntries(
      target.vars.filter((v) => env[v] !== undefined).map((v) => [v, hashValue(env[v])]),
    );
    return { env, valueHashes };
  } catch (err: any) {
    console.error(`${RED('✗')} decrypt: ${err.message}`);
    return null;
  }
}

// ── Targets recording (CAP-679) ─────────────────────────────────────────────

/**
 * Adapter-specific handle for what a target actually points at, when one is
 * knowable from `target.options` alone. Only Dokploy defines this today
 * (`composeId` / `applicationId`); every other adapter gets `undefined` —
 * there is no spec'd `ref` shape for them yet.
 */
function targetRefFor(target: TargetConfig): Record<string, string> | undefined {
  const opts = target.options as Record<string, unknown>;
  if (typeof opts.composeId === 'string') return { composeId: opts.composeId };
  if (typeof opts.applicationId === 'string') return { applicationId: opts.applicationId };
  return undefined;
}

/**
 * Read → transform → push keep.lock through the existing sync path, for a
 * pure `KeepFile → KeepFile` change that isn't a value edit (targets
 * recording/stripping). Mirrors `capy connect`'s import write
 * (`connectors/shared.ts#writeImportedAndSync`) — same push — but
 * generalized over the transform instead of "add these new vars".
 *
 * Writes only the untracked working copy (`writeKeepFile` — CAP-667); it
 * never auto-commits the tracked keep.lock onto whatever branch the caller
 * happens to be on. Only `capy deploy`'s own explicit, isolated commit
 * steps (direct mode's own-branch commit, CI mode's worktree PR) ever touch
 * the tracked file.
 *
 * `transform` returning the SAME object (`===`) is treated as "nothing to
 * do" and skips the network entirely. Best-effort: errors are logged, never
 * thrown — the caller's own operation (a deploy, a remove, a revoke) already
 * succeeded or is already committed to happening by the time this runs.
 */
async function pushKeepTransform(
  cwd: string,
  branch: string,
  transform: (keep: KeepFile) => KeepFile,
  devMode: boolean | undefined,
  label: string,
): Promise<void> {
  try {
    const pm = new ProjectManager(cwd);
    // Never push an env blob for a branch other than the one `.env` is
    // actually on — `.env`'s plaintext below is encrypted and pushed as
    // `branch`'s secrets; if `.env` is on a different branch (or none is
    // knowable), that would mislabel one branch's values as another's.
    const branchProblem = branchPushProblem(pm.deriveActiveBranch(), branch);
    if (branchProblem) {
      console.error(`  ${YELLOW('!')} could not ${label} in keep.lock — ${describeBranchProblem(branchProblem)}`);
      return;
    }
    const projectState = await pm.detectProjectState();
    if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) return;
    const keep = pm.readKeepFile();
    if (!keep) return;
    const nextKeep = transform(keep);
    if (nextKeep === keep) return;

    const { AuthService, silentAuthFailureMessage } = await import('../auth/authService');
    const { ServiceClient } = await import('../service/serviceClient');
    const { resolveProjectKey } = await import('../crypto/keyResolver');
    const { Encryptor } = await import('../crypto/encryptor');
    const { deriveResourceId } = await import('../crypto/resourceId');

    const authService = new AuthService(undefined, devMode, projectState.userId);
    const serviceClient = new ServiceClient(undefined, devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    const authResult = await authenticateSilentWithFallback(authService, projectState.organizationId);
    if (!authResult.success || !authResult.user_id) {
      console.error(`  ${YELLOW('!')} could not ${label} in keep.lock — ${silentAuthFailureMessage(authResult)}`);
      return;
    }
    const projectKey = await resolveProjectKey(projectState.organizationId, projectState.projectId, authResult.user_id, {
      coDecrypt: (o, c) => serviceClient.coDecrypt(o, c).then((r) => r.plaintext),
      wrapOuterLayer: (o, p) => serviceClient.wrapOuterLayer(o, p).then((r) => r.ciphertext),
    });

    const fm = new FileManager(cwd);
    const rawLocal = fm.readEnvFile();
    const localPlaintext = Object.fromEntries(
      Object.entries(rawLocal).map(([k, v]) => [k, v.startsWith('capy:') ? fm.decryptValue(v, projectKey) : v]),
    );
    const envBlob = Object.entries(localPlaintext)
      .map(([k, v]) => `${k}=capy:${deriveResourceId(branch, k)}:${Encryptor.encrypt(v, projectKey)}`)
      .join('\n');

    const pushed = await serviceClient.pushSecrets(projectState.projectId, JSON.stringify(nextKeep), envBlob, branch);
    const { SyncEngine } = await import('../sync/syncEngine');
    fm.writeKeepFile(SyncEngine.adoptServerKeep(pushed.keep_file, nextKeep, branch));
  } catch (err: any) {
    console.error(`  ${YELLOW('!')} could not ${label} in keep.lock: ${err?.message ?? err}`);
  }
}

/**
 * Direct-mode-only: after a verified successful deploy (or, when `noDeploy`,
 * after the config write `--no-deploy` still performs), record this
 * target's delivery into every (var, branch) entry it actually shipped.
 *
 * `noDeploy` marks the fresh element `deployed: false` (CAP-679 follow-up,
 * "pending") — the config landed but the platform deploy itself never ran.
 * Absent/false means a real deploy, which OMITS the field (see
 * `targetsGate.ts#upsertTargetElement`'s doc for why, and how this also
 * clears a PRIOR pending element once a real deploy follows it).
 *
 * Best-effort: the platform write already succeeded by the time this runs,
 * so a failure here is reported but does not flip the command's exit code —
 * the deploy itself did not fail.
 */
async function recordDeployTargets(
  cwd: string,
  target: TargetConfig,
  adapter: DeployAdapter,
  valueHashes: Record<string, string>,
  deployId: string | undefined,
  devMode: boolean | undefined,
  noDeploy: boolean = false,
): Promise<void> {
  const deliveredAt = new Date().toISOString();
  const delivery: TargetDeliveryDescriptor = {
    provider: adapter.id,
    target: target.name,
    ref: targetRefFor(target),
    deployId,
    ...(noDeploy ? { deployed: false } : {}),
  };
  const values = target.vars
    .filter((v) => valueHashes[v] !== undefined)
    .map((v) => ({ name: v, valueHash: valueHashes[v] }));
  if (values.length === 0) return;
  await pushKeepTransform(
    cwd,
    target.branch,
    (keep) => recordTargetDeliveries(keep, target.branch, delivery, deliveredAt, values),
    devMode,
    'record deploy targets',
  );
}

/**
 * Direct-mode-only, real deploys only (never `--no-deploy`, never a dry
 * run): after `recordDeployTargets` above has folded this delivery in — which
 * is what moves a superseded token's id into `superseded_deploy_ids`, see
 * `targetsGate.ts#upsertTargetElement`'s "no untracked tokens" note — revoke
 * every id that call just recorded as superseded, then strip them from
 * keep.lock so a later run never tries again.
 *
 * Called ONLY after `result.ok` (the deploy adapter itself considers the
 * redeploy done and successful — see `dokploy.ts`'s Compose sequence doc:
 * write → verify → poll deployment to a real outcome) — a failed deploy
 * never reaches this function at all, so it never revokes anything a failed
 * run might still need. Best-effort, same as `recordDeployTargets`: the
 * deploy already succeeded, so a failure here is reported but never flips
 * the exit code.
 */
async function revokeSupersededDeployTokens(
  cwd: string,
  target: TargetConfig,
  adapter: DeployAdapter,
  devMode: boolean | undefined,
): Promise<void> {
  try {
    const pm = new ProjectManager(cwd);
    const keep = pm.readKeepFile();
    if (!keep) return;
    const supersededIds = supersededDeployIdsForTarget(keep, adapter.id, target.name);
    if (supersededIds.length === 0) return;

    const { AuthService } = await import('../auth/authService');
    const { ServiceClient } = await import('../service/serviceClient');
    const projectState = await pm.detectProjectState();
    if (!projectState.organizationId) return;
    const authService = new AuthService(undefined, devMode, projectState.userId);
    const serviceClient = new ServiceClient(undefined, devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    const authResult = await authenticateSilentWithFallback(authService, projectState.organizationId);
    if (!authResult.success) return;

    await Promise.all(supersededIds.map((id) => serviceClient.revokeDeployToken(id).catch(() => {})));
    console.log(`  ${GREEN('✓')} revoked ${supersededIds.length} superseded deploy token(s) for "${target.name}".`);

    await pushKeepTransform(
      cwd,
      target.branch,
      (k) => clearSupersededDeployIds(k, adapter.id, target.name, new Set(supersededIds)),
      devMode,
      'clear superseded deploy tokens',
    );
  } catch (err: any) {
    console.error(`  ${YELLOW('!')} could not revoke superseded deploy token(s) for "${target.name}": ${err?.message ?? err}`);
  }
}

/**
 * Every deploy token id a (provider, target) pair might still need revoking
 * — its CURRENT `deploy_id` plus every `superseded_deploy_ids` entry it has
 * accumulated (CAP-679 follow-up: "no untracked tokens" — see
 * `targetsGate.ts#allDeployIdsForTarget`), read straight off keep.lock.
 * `deployRemove` revokes ALL of these before stripping the record — removal
 * is the one place that's safe to revoke everything at once, since the
 * target itself is going away.
 */
function deployIdsForTarget(keep: KeepFile, provider: string, target: string): readonly string[] {
  return allDeployIdsForTarget(keep, provider, target);
}

// ── Picker (interactive setup) ─────────────────────────────────────────────

/**
 * Ask which GIT branch the Vercel Preview environment is wired to, picking
 * from the repo's real branches (local + origin) rather than free text — a
 * typo or a capy branch name here fails at `vercel env add` with "Branch not
 * found in the connected Git repository". Free input stays available behind
 * an "other" choice for branches the local clone hasn't fetched.
 */
async function promptVercelGitBranch(
  cwd: string,
  preferred?: string,
): Promise<string> {
  const message = 'Which git branch is the Vercel Preview environment wired to?';
  const branches = listAllBranches(cwd);
  if (branches.length === 0) {
    const ans = await inquirer.prompt([
      {
        type: 'input',
        name: 'gitBranch',
        message,
        default: preferred,
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
    ]);
    return (ans.gitBranch as string).trim();
  }
  const fallback = ['main', 'master'].find((b) => branches.includes(b));
  const ans = await inquirer.prompt([
    {
      type: 'list',
      name: 'gitBranch',
      message,
      theme: LIST_THEME,
      choices: [
        ...branches.map((b) => ({ name: b, value: b })),
        new inquirer.Separator() as any,
        { name: 'Other — type a branch name', value: '__other__' },
      ],
      default:
        preferred && branches.includes(preferred)
          ? preferred
          : fallback ?? branches[0],
    } as any,
  ]);
  if (ans.gitBranch !== '__other__') return ans.gitBranch;
  const typed = await inquirer.prompt([
    {
      type: 'input',
      name: 'gitBranch',
      message,
      validate: (v: string) => (v.trim() ? true : 'required'),
    },
  ]);
  return (typed.gitBranch as string).trim();
}

/**
 * The adapter list the picker offers, planned rows included.
 *
 * Announced-but-unbuilt adapters are offered and immediately refused — the
 * terminal renders them disabled with the `capy export` pipeline that stands in
 * until they land. Keeping them is right: "Fly.io is coming" is the answer a
 * Fly user actually has.
 */
/**
 * Adapters whose settings step has no browser screen yet. They are left out of
 * the browser's adapter list, and a run that already knows it is one of them
 * asks its questions in the terminal instead.
 */
const TERMINAL_ONLY_SETUP: ReadonlySet<string> = new Set(['dokploy']);

function adapterChoices(): DeployAdapterChoice[] {
  return [
    ...ALL_ADAPTERS.filter((a) => !TERMINAL_ONLY_SETUP.has(a.id)).map((a) => ({
      id: a.id,
      label: a.label,
      detail: [a.description],
    })),
    ...listPlanned()
      .filter((p) => !ALL_ADAPTERS.some((a) => a.id === p.id))
      .map((p) => ({
        id: p.id,
        label: p.label,
        detail: [p.description],
        planned: true,
        plannedCommand: p.fallbackHint,
      })),
  ];
}

/**
 * Settings defaults for the browser, with the terminal's own precedence.
 *
 * Every line here is the `default:` of one inquirer prompt, lifted verbatim —
 * saved value first, then what the adapter sniffed out of the directory, then
 * the CLI's fallback. Two lists of defaults would be two answers to "what does
 * this box start as", and the box is what a target gets saved with.
 */
export function settingsDefaults(
  adapterId: string,
  cwd: string,
  existingOpts: Record<string, string>,
  detectedOpts: Record<string, string>,
): Record<string, string> {
  switch (adapterId) {
    case 'cf-worker':
      return {
        workerName: existingOpts.workerName ?? detectedOpts.workerName ?? '',
        workerDir: existingOpts.workerDir ?? detectedOpts.workerDir ?? '.',
      };
    case 'cf-pages':
      return {
        projectName: existingOpts.projectName ?? detectedOpts.projectName ?? '',
        buildCwd: existingOpts.buildCwd ?? detectedOpts.buildCwd ?? '.',
        buildCmd: existingOpts.buildCmd ?? detectedOpts.buildCmd ?? 'bun run build',
        distDir: existingOpts.distDir ?? detectedOpts.distDir ?? 'dist',
      };
    case 'vercel':
      return {
        projectDir: existingOpts.projectDir ?? detectedOpts.projectDir ?? '.',
        vercelEnv: existingOpts.vercelEnv ?? 'preview',
        // The terminal asks this in a separate prompt one question later, with
        // the saved value as its `preferred`. Here it is the same step, which
        // is the point: a *git* branch asked one prompt after a *capy* branch,
        // in almost the same words, is the failure this screen exists to stop.
        gitBranch: existingOpts.gitBranch ?? '',
      };
    case 'aws-ssm':
      return {
        region:
          existingOpts.region ?? detectedOpts.region ?? detectAwsRegion() ?? 'us-east-1',
        pathPrefix:
          existingOpts.pathPrefix ??
          detectedOpts.pathPrefix ??
          `/capy/${basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-')}/`,
        naming: existingOpts.naming ?? detectedOpts.naming ?? 'verbatim',
      };
    case 'dokploy':
      // tokenEnv is no longer asked by default (CAP-664: the org system
      // store is the default source) — only an EXISTING target's own value
      // is shown here, never defaulted to the fallback env var name.
      //
      // CAP-679 follow-up (item 6, validator fix-first): the terminal picker
      // now asks Compose vs. Application up front (`resolveAdapterOptions`'s
      // dokploy branch) and defaults `kind`/`composeId` from an existing
      // target. This is the web surface's copy of that same default — the
      // web flow doesn't have its own Dokploy settings screen (it isn't
      // being built here), but keeping these two defaults in sync means
      // neither surface silently disagrees about what a re-edit starts from
      // if/when one is added.
      return {
        baseUrl: existingOpts.baseUrl ?? '',
        applicationId: existingOpts.applicationId ?? '',
        composeId: existingOpts.composeId ?? '',
        kind: existingOpts.applicationId && !existingOpts.composeId ? 'application' : 'compose',
        ...(existingOpts.tokenEnv ? { tokenEnv: existingOpts.tokenEnv } : {}),
      };
    default:
      return {};
  }
}

/**
 * Which variables are pre-ticked, and what chose them.
 *
 * The same two lines the checkbox prompt computes. `presetLabel` is the
 * parenthetical in its message, which is the only thing on that prompt saying
 * why anything is ticked at all — and on a build-time adapter what is ticked
 * decides what ends up in a bundle the browser downloads.
 */
function presumedVars(
  adapter: DeployAdapter,
  branchVars: string[],
  existing?: TargetConfig,
): { defaultPicks: string[]; presetLabel: string } {
  const cls = classify(branchVars);
  const presumedRelevant = adapter.presumeVars
    ? adapter.presumeVars(cls)
    : adapter.varKind === 'build-time'
      ? cls.buildTime
      : cls.runtime;
  return {
    defaultPicks: existing?.vars ?? presumedRelevant,
    presetLabel: adapter.presumeVars
      ? 'all vars'
      : adapter.varKind === 'build-time'
        ? 'VITE_/NEXT_PUBLIC_/PUBLIC_/REACT_APP_'
        : 'non-public-prefixed',
  };
}

/**
 * The PR base the CI question defaults to: the branch you are on, then the
 * target's saved value, then main/master. The terminal's own fallback chain.
 */
function defaultPrBase(cwd: string, existing?: TargetConfig): string {
  const local = listLocalBranches(cwd);
  return (
    currentBranch(cwd) ??
    existing?.gitBaseBranch ??
    (local.includes('main') ? 'main' : local.includes('master') ? 'master' : 'main')
  );
}

/**
 * Everything downstream of the adapter, resolved once it is known.
 *
 * Async because `adapter.detect(cwd)` is, and because the adapter can be
 * chosen IN the browser — so this runs in the wizard's reducer, exactly where
 * the terminal runs it: one line after the picker.
 */
function adapterContextFor(
  cwd: string,
  branchVars: string[],
  existing?: TargetConfig,
): (id: string) => Promise<WebDeployAdapterContext> {
  return async (id: string) => {
    const adapter = getAdapter(id);
    if (!adapter) throw new Error(`Unknown adapter: ${id}`);
    const detected = await adapter.detect(cwd);
    const detectedOpts = (detected.options ?? {}) as Record<string, string>;
    const existingOpts = (existing?.options ?? {}) as Record<string, string>;
    const { defaultPicks, presetLabel } = presumedVars(adapter, branchVars, existing);

    // Drift, so the checkbox can mark what appeared and what vanished rather
    // than presenting a stale list as if it were current.
    const known = existing?.knownVars ?? branchVars;
    const { added, removed } = existing
      ? reconcileVars(existing.vars, known, branchVars)
      : { added: [] as string[], removed: [] as string[] };

    return {
      id,
      label: adapter.label,
      detail: [adapter.description],
      detected: detected.summary,
      defaults: settingsDefaults(id, cwd, existingOpts, detectedOpts),
      vars: [
        ...branchVars.map((name) => ({
          name,
          buildTime: isBuildTime(name),
          checked: defaultPicks.includes(name),
          addedSinceSave: added.includes(name),
        })),
        // A variable the project no longer has cannot ship, but dropping it
        // from the list is how a removed secret goes unnoticed.
        ...removed.map((name) => ({
          name,
          buildTime: isBuildTime(name),
          checked: false,
          goneSinceSave: true,
        })),
      ],
      presetLabel,
      delivery: {
        mode: existing?.mode ?? adapter.defaultMode,
        prBase: defaultPrBase(cwd, existing),
        ciOnly: adapter.ciOnly,
      },
      gitBranches: listAllBranches(cwd),
      // The terminal presents a guessed region and a real one identically, so
      // a wrong region is only found once the parameters land in it.
      regionDetected: Boolean(existingOpts.region ?? detectedOpts.region ?? detectAwsRegion()),
      exampleVar: classify(branchVars).runtime[0] ?? 'DATABASE_URL',
    };
  };
}

/** How this picker run was reached, for the browser's copy and its rail. */
interface WebPickerOptions extends WebContext {
  intent?: 'create' | 'edit' | 'reconfirm';
}

/**
 * Which adapter this run targets. An existing target's kind wins (the picker
 * is re-editing it), then a caller-preselected id, and only then does the
 * interactive "Where are you deploying?" list get asked — planned-but-unshipped
 * adapters appear disabled with a fallback hint.
 */
async function resolveAdapterChoice(
  existing: TargetConfig | undefined,
  preselectedAdapterId: string | undefined,
): Promise<string> {
  if (existing) return existing.kind;
  if (preselectedAdapterId) return preselectedAdapterId;
  const realChoices = ALL_ADAPTERS.map((a) => ({
    name: `${a.label}  ${DIM('— ' + a.description)}`,
    value: a.id,
    short: a.label,
  }));
  const planned = listPlanned().filter((p) => !ALL_ADAPTERS.some((a) => a.id === p.id));
  const plannedChoices = planned.map((p) => ({
    name: `${p.label}  ${DIM('(coming soon — ' + p.fallbackHint + ')')}`,
    value: p.id,
    short: p.label,
    disabled: 'use capy export until adapter lands',
  }));
  const choices: any[] = [...realChoices];
  if (plannedChoices.length > 0) {
    choices.push(new inquirer.Separator() as any, ...plannedChoices);
  }
  const ans: { kind: string } = (await inquirer.prompt([
    {
      type: 'list',
      name: 'kind',
      message: 'Where are you deploying?',
      theme: LIST_THEME,
      choices,
    } as any,
  ])) as any;
  return ans.kind;
}

/**
 * Resolve the Dokploy API key for the SETUP PICKER's own verification call
 * (CAP-657 URL input follow-up) — deliberately separate from
 * `resolveDokployApiKeyOnce` (which needs a saved `TargetConfig` that
 * doesn't exist yet while the picker is still building one). Same store,
 * same "target key first, connector key as a fallback" wiring
 * (`getDirectionalConnectorSecret`) — just callable with only a `tokenEnv`
 * and an org id.
 *
 * `interactive: false` ALWAYS — a validator review flagged the original
 * `true` here as a `--dry-run` prompt leak: `capy deploy --dry-run` with no
 * saved targets yet still reaches this picker (that fallthrough predates
 * CAP-657 and isn't touched here), and "a human is right there, it's a
 * terminal prompt" is true regardless of `--dry-run` — dry-run must change
 * NOTHING, and letting this verification's own key lookup interactively
 * PREREQ-PROMPT-AND-SAVE a brand-new org system-store secret is a real
 * side effect, not a preview. `interactive: false` makes this a pure READ:
 * an already-saved key is used silently; a missing one falls through to
 * "could not verify, saving as entered" (`resolveDokployServiceOptions`)
 * with no prompt and no write, exactly like every other verification
 * failure mode. The real deploy-time key resolution
 * (`resolveDokployApiKeyOnce`, used by `preflight`/`deploy`) is unaffected
 * and still prompts-and-saves when genuinely interactive.
 */
async function resolveDokployApiKeyForPicker(
  tokenEnv: string | undefined,
  orgId: string | undefined,
): Promise<ResolveDokployApiKeyResult> {
  const { getDirectionalConnectorSecret } = await import('../system/systemStore');
  const getConnectorSecret = (name: string, opts: DokploySystemStoreCallOptions) =>
    getDirectionalConnectorSecret(name, DOKPLOY_CONNECTOR_SECRET_NAME, {
      ...opts,
      missingWithFallbackCode: ERROR_CODES.DOKPLOY_TARGET_KEY_MISSING,
    });
  return resolveDokployApiKey({
    tokenEnv,
    env: process.env,
    interactive: false,
    orgId,
    storeName: DOKPLOY_TARGET_SECRET_NAME,
    deps: { getConnectorSecret },
  });
}

/** `new URL(raw).host`, or `undefined` for anything that doesn't parse — never throws. */
function hostOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).host;
  } catch {
    return undefined;
  }
}

/** Whether a setup-picker answer reads as a bare Dokploy id rather than a URL. */
function isBareDokployId(answer: string): boolean {
  return !looksLikeUrl(answer);
}

/**
 * The legacy three-question shape (kind, then base URL — the id is already
 * known, either typed just now as a bare id or carried over from an existing
 * target): still reachable when the picker's one URL question gets a bare
 * id instead of a link, or when re-editing a target whose URL can't be
 * reconstructed (see `resolveDokployServiceOptions`'s doc for why).
 */
async function askDokployKindAndBaseUrl(
  id: string,
  existingOpts: Record<string, string>,
  existingKind: DokployServiceKind,
): Promise<DokployServiceUrlOk> {
  const ans = (await inquirer.prompt([
    {
      type: 'list',
      name: 'kind',
      message: 'Dokploy service kind:',
      theme: LIST_THEME,
      choices: [
        { name: 'Compose', value: 'compose' },
        { name: 'Application', value: 'application' },
      ],
      default: existingKind,
    },
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Dokploy URL:',
      default: existingOpts.baseUrl,
      validate: (v: string) => baseUrlProblem(v) ?? true,
      filter: (v: string) => v.trim(),
    },
  ] as any[])) as { kind: DokployServiceKind; baseUrl: string };
  return { ok: true, baseUrl: ans.baseUrl, kind: ans.kind, id };
}

/**
 * CAP-657 URL input: the Dokploy setup picker's ONE question, replacing the
 * old baseUrl → kind → composeId/applicationId sequence. Loops (always at a
 * TTY — this whole branch is terminal-only, see `TERMINAL_ONLY_SETUP`) until
 * a usable target is confirmed or the underlying id/URL genuinely can't be
 * resolved:
 *
 *  1. Ask for the service's Dokploy dashboard URL (or, still, a bare id).
 *  2. A bare id (no `scheme://`) falls back to asking kind + base URL, same
 *     shape as before this URL question existed — no verification, exactly
 *     like today's behavior for a hand-typed id.
 *  3. Anything that looks like a URL is parsed with `parseDokployServiceUrl`.
 *     A parse failure is a coded refusal (`DOKPLOY_URL_INVALID`), shown and
 *     re-asked — never silently downgraded to "treat it as an id" once the
 *     input clearly claimed to be a URL.
 *  4. A successful parse is VERIFIED against the live API
 *     (`compose.one`/`application.one`) before being trusted: a 404 is a
 *     coded refusal (`DOKPLOY_SERVICE_NOT_FOUND`), re-asked the same way;
 *     any other API problem (no key yet, unauthorized, unreachable, …) is
 *     never a hard block — it's logged and the parsed URL is saved as
 *     entered, same trust level as the bare-id path always had.
 *  5. A verified service is named back to the user ("Use "<name>" (<project>
 *     · <environment>) as this target?") for a yes/no confirmation before
 *     being saved — declining loops back to step 1 instead of saving.
 *
 * Re-editing an existing target prefills the URL question with the id alone
 * (never the full old URL): the saved fields are `baseUrl` +
 * `composeId`/`applicationId` only — no `projectId`/`environmentId` is ever
 * persisted (`DokployOptions` has never carried them), so a full dashboard
 * URL genuinely cannot be reconstructed from what's on disk. Prefilling the
 * id keeps a plain Enter-to-continue re-edit working exactly as it always
 * has (step 2's bare-id path, defaulted to the existing baseUrl/kind).
 */
export async function resolveDokployServiceOptions(
  existingOpts: Record<string, string>,
  orgId: string | undefined,
): Promise<DokployServiceUrlOk> {
  const existingKind: DokployServiceKind =
    existingOpts.applicationId && !existingOpts.composeId ? 'application' : 'compose';
  const existingId = existingOpts.composeId ?? existingOpts.applicationId;

  const askUrlOrId = async (): Promise<string> => {
    const ans = (await inquirer.prompt([
      {
        type: 'input',
        name: 'serviceUrl',
        // COPY-FLAG: minimal neutral wording.
        message: 'Dokploy service URL (paste the dashboard link for this app or compose service, or its id):',
        default: existingId,
        validate: (v: string) => (v.trim() ? true : 'required'),
        filter: (v: string) => v.trim(),
      },
    ])) as { serviceUrl: string };
    return ans.serviceUrl;
  };

  // No mutable loop state: each iteration either returns or recurses on the
  // next answer, so retries never need a reassigned local.
  const resolve = async (): Promise<DokployServiceUrlOk> => {
    const answer = await askUrlOrId();

    if (isBareDokployId(answer)) {
      return askDokployKindAndBaseUrl(answer, existingOpts, existingKind);
    }

    const parsed = parseDokployServiceUrl(answer);
    if (!parsed.ok) {
      // COPY-FLAG: minimal neutral wording.
      console.error(`${RED('✗')} ${parsed.code}: ${parsed.reason}`);
      console.error(`  Paste the Dokploy dashboard link for this app or compose service, or just its id.`);
      return resolve();
    }

    // Validator finding (key exposure): verifying sends the resolved Dokploy
    // API key to `parsed.baseUrl` as an `x-api-key` header — confirm the
    // HOST before that happens whenever it's not the host the existing
    // target (if any) already trusted. A brand-new target (no
    // `existingOpts.baseUrl` at all) always confirms; re-editing a target
    // whose URL parses to the SAME host never re-asks.
    const parsedHost = hostOf(parsed.baseUrl);
    const existingHost = hostOf(existingOpts.baseUrl);
    if (parsedHost && parsedHost !== existingHost) {
      const { proceed } = (await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          // COPY-FLAG: minimal neutral wording.
          message: `Capy will send your Dokploy API key to ${parsedHost} to check this service. Continue?`,
          default: true,
        },
      ])) as { proceed: boolean };
      if (!proceed) return resolve();
    }

    const apiKey = await resolveDokployApiKeyForPicker(existingOpts.tokenEnv, orgId);
    if (!apiKey.ok) {
      // COPY-FLAG: minimal neutral wording.
      console.log(`  ${DIM('Could not verify against Dokploy yet (no API key) — saving as entered.')}`);
      return parsed;
    }

    const client = createDokployClient(parsed.baseUrl, apiKey.value);
    const verification = await verifyDokployService(client, parsed.kind, parsed.id);
    if (!verification.ok) {
      if (verification.error.code === 'not_found') {
        // COPY-FLAG: minimal neutral wording.
        console.error(
          `${RED('✗')} ${ERROR_CODES.DOKPLOY_SERVICE_NOT_FOUND}: no ${parsed.kind} service with that id at ${parsed.baseUrl}.`,
        );
        console.error(`  Check the link and try again.`);
        return resolve();
      }
      // COPY-FLAG: minimal neutral wording.
      console.log(
        `  ${DIM(`Could not verify against Dokploy (${verification.error.code}) — saving as entered.`)}`,
      );
      return parsed;
    }

    const label = verification.value.name || verification.value.appName || parsed.id;
    const envLabel = await resolveDokployEnvironmentLabel(client, verification.value.environmentId);
    const suffix = envLabel ? ` ${DIM(`(${envLabel})`)}` : '';
    const { confirmed } = (await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        // COPY-FLAG: minimal neutral wording.
        message: `Use "${label}"${suffix} as this target?`,
        default: true,
      },
    ])) as { confirmed: boolean };
    return confirmed ? parsed : resolve();
  };

  return resolve();
}

/**
 * Adapter-specific options, asked once the adapter and branch are known.
 *
 * Exported (additive) so `tests/commands/deployDokployPickerTokenEnv.test.ts`
 * can prove the Dokploy branch's `tokenEnv` behavior directly — no tokenEnv
 * question for a NEW target, but an EXISTING target's saved value survives
 * — without driving the whole multi-prompt `runPicker` flow, whose result
 * this function's return value becomes verbatim (`options` in `runPicker`)
 * and then gets written to `.capy/deploy.json` verbatim (`upsertTarget`):
 * proving this function never puts `tokenEnv` in its result for a new
 * target is the same fact as `.capy/deploy.json` never getting one written.
 */
export async function resolveAdapterOptions(
  adapter: DeployAdapter,
  cwd: string,
  branchVars: string[],
  detectedOpts: Record<string, string>,
  existingOpts: Record<string, string>,
  /**
   * The active org id, used ONLY by the Dokploy branch's live verification
   * call (`resolveDokployServiceOptions`) to resolve the org system store's
   * API key. Optional and additive: every other adapter branch, and every
   * existing caller that never had an org id to pass, is unaffected.
   */
  orgId?: string,
): Promise<Record<string, unknown>> {
  if (adapter.id === 'cf-worker') {
    return await inquirer.prompt([
      {
        type: 'input',
        name: 'workerName',
        message: 'Worker name (from wrangler.toml):',
        default: existingOpts.workerName ?? detectedOpts.workerName ?? '',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'input',
        name: 'workerDir',
        message: 'Worker directory (contains wrangler.toml):',
        default: existingOpts.workerDir ?? detectedOpts.workerDir ?? '.',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
    ]);
  }
  if (adapter.id === 'vercel') {
    // Vercel: code ships via the keep.lock PR (Vercel git CI builds on merge),
    // but capy pushes each var as a plaintext Environment Variable into the
    // chosen Vercel environment via the vercel CLI — so the build reads them
    // natively with no `capy run` decrypt step. Capture the app dir, which
    // Vercel environment these vars go to, and — for Preview — exactly which
    // git branch that Preview env is wired to. The Preview scope is a GIT
    // branch Vercel knows about, which is NOT a capy branch name nor necessarily
    // the branch you're checked out on, so we pick from the repo's real branches.
    const ans = await inquirer.prompt([
      {
        type: 'input',
        name: 'projectDir',
        message: 'Project directory (contains .vercel/project.json or package.json):',
        default: existingOpts.projectDir ?? detectedOpts.projectDir ?? '.',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'list',
        name: 'vercelEnv',
        message: 'Which Vercel environment should these secrets go to?',
        choices: [
          { name: 'Preview — scoped to a specific git branch', value: 'preview' },
          { name: 'Production', value: 'production' },
        ],
        default: existingOpts.vercelEnv ?? 'preview',
      },
    ]);
    // Drop gitBranch entirely for production — it has no meaning there.
    return ans.vercelEnv === 'preview'
      ? {
          projectDir: ans.projectDir,
          vercelEnv: 'preview',
          gitBranch: await promptVercelGitBranch(cwd, existingOpts.gitBranch),
        }
      : { projectDir: ans.projectDir, vercelEnv: 'production' };
  }
  if (adapter.id === 'cf-pages') {
    return await inquirer.prompt([
      {
        type: 'input',
        name: 'projectName',
        message: 'Pages project name (from wrangler pages project list):',
        default: existingOpts.projectName ?? detectedOpts.projectName ?? '',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'input',
        name: 'buildCwd',
        message: 'Build directory (contains package.json):',
        default: existingOpts.buildCwd ?? detectedOpts.buildCwd ?? '.',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'input',
        name: 'buildCmd',
        message: 'Build command (run inside the build directory):',
        default: existingOpts.buildCmd ?? detectedOpts.buildCmd ?? 'bun run build',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'input',
        name: 'distDir',
        message: 'Dist directory (relative to build directory):',
        default: existingOpts.distDir ?? detectedOpts.distDir ?? 'dist',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
    ]);
  }
  if (adapter.id === 'aws-ssm') {
    // Show the live name transformation in the naming prompt so the
    // env-var ↔ parameter mapping is never abstract.
    const exampleVar = classify(branchVars).runtime[0] ?? 'DATABASE_URL';
    return await inquirer.prompt([
      {
        type: 'input',
        name: 'region',
        message: 'AWS region:',
        default: existingOpts.region ?? detectedOpts.region ?? detectAwsRegion() ?? 'us-east-1',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'input',
        name: 'pathPrefix',
        message: 'Parameter path prefix:',
        default:
          existingOpts.pathPrefix ??
          detectedOpts.pathPrefix ??
          `/capy/${basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-')}/`,
        validate: (v: string) =>
          /^\/[a-zA-Z0-9_.\-/]*\/$/.test(v.trim()) ? true : "must start and end with '/' (e.g. /capy/prod/)",
        filter: (v: string) => v.trim(),
      },
      {
        type: 'list',
        name: 'naming',
        message: 'Parameter naming:',
        theme: LIST_THEME,
        choices: [
          {
            name: `verbatim    ${DIM(`${exampleVar} → ${leafFor(exampleVar, 'verbatim')}`)}`,
            value: 'verbatim',
            short: 'verbatim',
          },
          {
            name: `kebab-case  ${DIM(`${exampleVar} → ${leafFor(exampleVar, 'kebab')}`)}`,
            value: 'kebab',
            short: 'kebab',
          },
        ],
        default: existingOpts.naming ?? detectedOpts.naming ?? 'verbatim',
      },
    ]);
  }
  if (adapter.id === 'dokploy') {
    // The API token itself is never asked for or saved here. CAP-664: the
    // org system store's _TARGET_DOKPLOY_API_KEY entry (CAP-679 follow-up:
    // deploy's OWN direction — see `dokployApi.ts#DOKPLOY_TARGET_SECRET_NAME`)
    // is the default source now — no tokenEnv question for a NEW target. An
    // EXISTING target's own tokenEnv (saved before the system store existed,
    // or set via `--token-env`) is carried through untouched: re-entering
    // this picker must never silently drop it.
    //
    // CAP-657 URL input follow-up: what used to be three questions (baseUrl,
    // kind, composeId/applicationId) is now ONE — the service's Dokploy
    // dashboard URL, parsed and verified against the live API — with the old
    // three-question shape still reachable as a fallback for a bare id. See
    // `resolveDokployServiceOptions`'s own doc for the full decision tree.
    const resolved = await resolveDokployServiceOptions(existingOpts, orgId);
    const result: Record<string, unknown> =
      resolved.kind === 'compose'
        ? { baseUrl: resolved.baseUrl, composeId: resolved.id }
        : { baseUrl: resolved.baseUrl, applicationId: resolved.id };
    return existingOpts.tokenEnv ? { ...result, tokenEnv: existingOpts.tokenEnv } : result;
  }
  return {};
}

/**
 * CI vs direct. CI-only adapters (Vercel) have no direct mode at all — capy
 * never runs their CLI — so the question is skipped and 'ci' is forced.
 */
async function resolveMode(
  adapter: DeployAdapter,
  existing: TargetConfig | undefined,
): Promise<DeployMode> {
  if (adapter.ciOnly) return 'ci';
  const ciHelp = adapter.ciOnly
    ? `commit keep.lock on a branch + open PR; ${adapter.label}'s git CI deploys on merge`
    : `commit keep.lock on a branch + push secrets + open PR; CI deploys on merge`;
  const ans = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'How should this target deploy?',
      theme: LIST_THEME,
      choices: [
        {
          name: `Via CI/CD        ${DIM('— ' + ciHelp)}`,
          value: 'ci',
          short: 'ci',
        },
        {
          name: `Deploy directly  ${DIM('— commit keep.lock + push secrets + deploy now')}`,
          value: 'direct',
          short: 'direct',
        },
      ],
      // Existing target's mode wins over the adapter default on subsequent
      // picker passes.
      default: existing?.mode ?? adapter.defaultMode,
    } as any,
  ]);
  return ans.mode as DeployMode;
}

/**
 * CI mode only — type the git branch the deploy PR opens against. Repos can
 * have hundreds of branches, so a list picker is the wrong shape. Text entry
 * defaulting to the current branch (you usually open the PR against the
 * branch you're on), then the existing target's saved value, then main/master.
 */
async function resolveGitBaseBranch(
  cwd: string,
  mode: DeployMode,
  existing: TargetConfig | undefined,
): Promise<string | undefined> {
  if (mode !== 'ci') return undefined;
  const local = listLocalBranches(cwd);
  const fallback =
    currentBranch(cwd) ??
    existing?.gitBaseBranch ??
    (local.includes('main') ? 'main' : local.includes('master') ? 'master' : 'main');
  const ans = await inquirer.prompt([
    {
      type: 'input',
      name: 'gitBaseBranch',
      message: 'Open the deploy PR against which target branch?',
      default: fallback,
      validate: (v: string) => (v.trim().length > 0 ? true : 'enter a branch name'),
    },
  ]);
  return ans.gitBaseBranch.trim();
}

/**
 * A saved target after its project's variables changed: removed variables are
 * dropped, the chosen new ones are added, and `knownVars` becomes the current
 * set so the same drift is not asked about again. Nothing else changes.
 */
export function applyVarDrift(
  target: TargetConfig,
  currentVars: readonly string[],
  includedNew: readonly string[],
): TargetConfig {
  const wanted = new Set([...target.vars, ...includedNew]);
  return {
    ...target,
    vars: currentVars.filter((v) => wanted.has(v)),
    knownVars: [...currentVars],
  };
}

/** Asks which newly added project variables this target should deliver (Ctrl-C is handled globally). */
async function pickNewVars(target: TargetConfig, added: readonly string[]): Promise<string[]> {
  const ans = (await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'vars',
      // COPY-FLAG
      message: `Include these new variable(s) in "${target.name}"?`,
      instructions: CHECKBOX_INSTRUCTIONS,
      theme: CHECKBOX_THEME,
      choices: added.map((v) => ({ name: v, value: v, checked: true })),
    } as any,
  ])) as { vars: string[] };
  return ans.vars;
}

async function runPicker(
  cwd: string,
  keep: KeepInfo,
  existing?: TargetConfig,
  /** When set, skip adapter-selection (caller has already picked). */
  preselectedAdapterId?: string,
  web?: WebPickerOptions,
): Promise<TargetConfig | null> {
  // Scope the picker to the ACTIVE branch's vars. keep.lock's `variables` is the
  // union across EVERY branch, so it would offer vars that only exist on
  // prod/development and then fail/skip at deploy. The materialized .env is the
  // active branch's var set — that's what actually gets deployed.
  //
  // `cwd`, not process.cwd(): every other read in this command is scoped to the
  // directory it was handed, and this one deciding which variables are offered
  // off a different directory is how the picker ends up ticking a variable the
  // target does not have. Identical whenever the two agree, which is every
  // production call.
  const branchVarSet = new Set(Object.keys(new FileManager(cwd).readEnvFile()));
  const branchVars = keep.variables.filter((v) => branchVarSet.has(v));

  // Dokploy has no browser settings screen yet (browser screens are built in
  // the Keep workbench first), so its setup stays in the terminal.
  const knownAdapterId = existing?.kind ?? preselectedAdapterId;
  const browserSetup = !!web?.web && !(knownAdapterId && TERMINAL_ONLY_SETUP.has(knownAdapterId));
  if (web?.web && !browserSetup) {
    console.log(`  ${DIM('Dokploy setup runs in the terminal.')}`);
  }

  if (web?.web && browserSetup) {
    // Same computation, same defaults, same validators — only the surface the
    // questions are drawn on differs. The route is declared before the first
    // page opens, including the adapter stop a preselected run never visits.
    if (branchVars.length === 0) {
      throw new Error(
        `no variables on the active branch — run \`capy\` to sync, or switch branches.`,
      );
    }
    const adapterId = existing?.kind ?? preselectedAdapterId;
    const intent = web.intent ?? (existing ? 'edit' : 'create');
    const steps: DeploySetupStep[] = [];
    if (!adapterId) steps.push('adapter');
    steps.push('branch', 'settings');
    // A re-confirm is the same variable question with the drift spelled out.
    steps.push(intent === 'reconfirm' ? 'drift' : 'variables');
    steps.push('delivery', 'name');

    const { setUpDeployTargetInBrowser } = await import('../ui/deployScreens');
    const picked = await setUpDeployTargetInBrowser({
      intent,
      steps,
      platformAnswer: web.platformAnswer,
      modeAnswer: web.modeAnswer,
      adapters: adapterId ? undefined : adapterChoices(),
      adapterId,
      capyBranches: keep.branches,
      branch:
        existing?.branch ??
        (keep.branches.includes('production') ? 'production' : keep.branches[0] ?? 'development'),
      existingNames: listTargets(cwd).map((t) => t.name),
      existingName: existing?.name,
      resolveAdapter: adapterContextFor(cwd, branchVars, existing),
      open: openBrowser(),
    });
    // Cancelling is a refusal: nothing is saved and nothing is deployed. The
    // caller stops rather than falling through with a half-built target.
    if (picked.cancelled) return null;

    return {
      name: picked.name.trim(),
      kind: picked.adapterId,
      branch: picked.branch,
      vars: picked.vars,
      knownVars: branchVars,
      options: picked.options,
      mode: picked.mode,
      gitBaseBranch: picked.gitBaseBranch,
    };
  }

  // 1. Pick adapter (when not pre-selected). Real adapters are selectable;
  // planned-but-not-shipped ones appear disabled with a fallback hint, so
  // the picker doubles as a roadmap and points users at `capy export` until
  // each adapter lands.
  const adapterChoice = await resolveAdapterChoice(existing, preselectedAdapterId);

  const adapter = getAdapter(adapterChoice);
  if (!adapter) throw new Error(`Unknown adapter: ${adapterChoice}`);

  // 2. Detect defaults from cwd.
  const detected = await adapter.detect(cwd);
  if (detected.summary) {
    console.log(`  ${DIM('Detected:')} ${detected.summary}`);
  }

  // 3. Branch. Asked BEFORE adapter-specific options so adapters whose options
  // depend on the branch (e.g. Vercel scopes its Preview env to a git branch)
  // can default to and name it in their prompts.
  const branch = (await inquirer.prompt([
    {
      type: 'list',
      name: 'branch',
      message: 'Which capy branch ships to this target?',
      theme: LIST_THEME,
      choices: keep.branches.length > 0 ? keep.branches : ['development'],
      default: existing?.branch ?? (keep.branches.includes('production') ? 'production' : keep.branches[0]),
    } as any,
  ])).branch;

  // 4. Adapter-specific options.
  const detectedOpts = (detected.options ?? {}) as Record<string, string>;
  const existingOpts = (existing?.options ?? {}) as Record<string, string>;
  const options = await resolveAdapterOptions(adapter, cwd, branchVars, detectedOpts, existingOpts, keep.orgId);

  // 5. Var picking — show every var in keep.lock and pre-select the ones
  // most likely to be relevant for this adapter (runtime for cf-worker,
  // build-time prefixes for cf-pages). The user is the authority: they can
  // toggle anything in or out. No silent exclusion.
  const cls = classify(branchVars);
  const presumedRelevant = adapter.presumeVars
    ? adapter.presumeVars(cls)
    : adapter.varKind === 'build-time'
      ? cls.buildTime
      : cls.runtime;
  const defaultPicks = existing?.vars ?? presumedRelevant;
  const verb = adapter.varKind === 'build-time' ? 'inline into' : 'push to';
  const presetLabel = adapter.presumeVars
    ? 'all vars'
    : adapter.varKind === 'build-time'
      ? 'VITE_/NEXT_PUBLIC_/PUBLIC_/REACT_APP_'
      : 'non-public-prefixed';
  if (branchVars.length === 0) {
    throw new Error(
      `no variables on the active branch — run \`capy\` to sync, or switch branches.`,
    );
  }
  const varsAns = (await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'vars',
      message: `Which vars to ${verb} ${adapter.label}? (pre-selected: ${presetLabel})`,
      instructions: CHECKBOX_INSTRUCTIONS,
      theme: CHECKBOX_THEME,
      choices: branchVars.map((v) => ({
        name: v,
        value: v,
        checked: defaultPicks.includes(v),
      })),
      validate: (v: readonly string[]) =>
        v.length > 0 ? true : 'select at least one',
    } as any,
  ])) as { vars: string[] };
  const vars = varsAns.vars;

  // 6. Mode — direct vs CI/CD. Default comes from the adapter: vendors
  // with turnkey git CI (Vercel, etc.) default to 'ci'; vendors where capy
  // is the deploy actor default to 'direct'. Existing target's mode wins
  // over the adapter default on subsequent picker passes.
  //
  // CI-only adapters (Vercel) have no direct mode at all — capy never runs
  // their CLI — so skip the question and force 'ci'.
  const mode = await resolveMode(adapter, existing);

  // 6b. CI mode only — type the git branch the deploy PR opens against.
  // Repos can have hundreds of branches, so a list picker is the wrong
  // shape. Text entry defaulting to the current branch (you usually open the
  // PR against the branch you're on), then the existing target's saved value,
  // then main/master.
  const gitBaseBranch = await resolveGitBaseBranch(cwd, mode, existing);

  // 7. Target name.
  const defaultName = existing?.name ?? `${adapter.id}-${branch}`;
  const name = (await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Save this target as:',
      default: defaultName,
      validate: (v: string) =>
        /^[a-z0-9][a-z0-9-]*$/.test(v.trim())
          ? true
          : 'lowercase alphanumeric + dashes only',
    },
  ])).name;

  return {
    name: name.trim(),
    kind: adapter.id,
    branch,
    vars,
    knownVars: branchVars,
    options,
    mode,
    gitBaseBranch,
  };
}

// ── Plan rendering ─────────────────────────────────────────────────────────

function renderPlan(target: TargetConfig, adapter: DeployAdapter): void {
  console.log('');
  console.log(`  ${B('Target:')}  ${target.name}  ${DIM(`(${adapter.label})`)}`);
  console.log(`  ${B('Branch:')}  ${target.branch}`);
  if (target.mode === 'ci' && target.gitBaseBranch) {
    console.log(`  ${B('PR base:')} ${target.gitBaseBranch}`);
  }
  for (const [k, v] of Object.entries(target.options)) {
    console.log(`  ${DIM(k.padEnd(7))}: ${String(v)}`);
  }
  console.log(`  ${B('Vars:')}    ${target.vars.join(', ')}`);
  console.log('');
}

function renderResult(result: DeployResult): void {
  console.log('');
  for (const step of result.steps) {
    const mark =
      step.status === 'ok' ? GREEN('✓') : step.status === 'fail' ? RED('✗') : DIM('·');
    const detail = step.detail ? `  ${DIM(step.detail)}` : '';
    const url = step.url ? `  ${step.url}` : '';
    console.log(`  ${mark} ${step.label}${detail}${url}`);
  }
  // `result.warnings` (e.g. Dokploy's DOKPLOY_SHADOWED_VAR) is printed once,
  // right after preflight (see the `preflight.warnings` loop above this
  // function's call site) — not here too. The data still rides on
  // `DeployResult` for any caller reading it structurally; this function just
  // doesn't ALSO print it, so one deploy prints one line, not two or three.
  console.log('');
  if (result.epilogue) {
    console.log(result.epilogue);
    console.log('');
  }
}

// ── Subcommand: list / remove ──────────────────────────────────────────────

/**
 * Saved targets as rows the browser can draw.
 *
 * Two fields the terminal listing omits are first-class here, and both decide
 * what a deploy actually does: `mode` (whether Capy ships live or opens a PR)
 * and `prBase` (what that PR opens against). A target saved before `mode`
 * existed resolves to `direct`, so the printed listing can show a row whose
 * next `capy deploy` performs a live vendor deploy with nothing on screen
 * having said so.
 *
 * Variable NAMES only — `.capy/deploy.json` holds no value, which is why it is
 * committed to the repository.
 */
function targetRows(cwd: string, targets: TargetConfig[]): DeployTargetRow[] {
  const keep = readKeep(cwd);
  const branchVarSet = new Set(Object.keys(new FileManager(cwd).readEnvFile()));
  const currentVars = (keep?.variables ?? []).filter((v) => branchVarSet.has(v));
  return targets.map((t) => {
    const adapter = getAdapter(t.kind);
    const known = t.knownVars ?? currentVars;
    const { added, removed, drifted } = reconcileVars(t.vars, known, currentVars);
    return {
      name: t.name,
      kind: t.kind,
      // Absent when the id is no longer in the registry: the terminal prints
      // the raw id and says nothing else, so the row reads like any other
      // right up until a deploy dies on `Unknown adapter`.
      adapterLabel: adapter?.label,
      branch: t.branch,
      mode: t.mode,
      prBase: t.gitBaseBranch,
      options: Object.entries(t.options).map(([key, value]) => ({
        key,
        value: String(value),
      })),
      vars: t.vars,
      drift: drifted ? { added, removed } : undefined,
    };
  });
}

export async function deployList(
  cwd: string = process.cwd(),
  opts: { web?: boolean } = {},
): Promise<number> {
  const targets = listTargets(cwd);

  if (opts.web) {
    // The printed listing stops. Here it answers: the rows carry mode, PR base
    // and the drift the CLI otherwise only computes mid-deploy, and editing or
    // removing one is the same act as `capy deploy --edit` and
    // `capy deploy targets-remove <name>` — both named on the page.
    const keep = readKeep(cwd);
    const { chooseDeployTargetInBrowser } = await import('../ui/deployScreens');
    let picked: { action: string | null; target: string };
    try {
      picked = await chooseDeployTargetInBrowser({
        projectName: basename(cwd),
        configPath: deployConfigPath(cwd),
        purpose: 'browse',
        targets: targetRows(cwd, targets),
        allow: ['edit', 'remove', 'new'],
        open: openBrowser(),
      });
    } catch (err) {
      // The screen resolves every refusal — closed window, deadline, Ctrl-C —
      // so anything that reaches here is the SERVER, not the user. A listing
      // that never opened must not exit 0 with nothing on screen.
      console.error(`${RED('✗')} could not open the targets page: ${err instanceof Error ? err.message : err}`);
      return 1;
    }

    // Nobody chose a row. A listing that ends having changed nothing is an
    // ending, and it says so rather than returning silently.
    if (picked.action === null) {
      console.log('No changes.');
      return 0;
    }

    if (picked.action === 'remove') return deployRemove(picked.target, cwd);
    if (picked.action === 'edit' || picked.action === 'new') {
      if (!keep) {
        console.error(
          `No keep.lock in ${basename(cwd)}. Run ${B('capy')} here first to sync.`,
        );
        return 1;
      }
      const edited = await runPicker(
        cwd,
        keep,
        picked.action === 'edit' ? getTarget(cwd, picked.target) ?? undefined : undefined,
        undefined,
        { web: true, intent: picked.action === 'edit' ? 'edit' : 'create' },
      );
      if (!edited) {
        console.log('No changes.');
        return 0;
      }
      upsertTarget(cwd, edited);
      console.log(GREEN(`✓ Saved target "${edited.name}" to .capy/deploy.json`));
    }
    return 0;
  }

  if (targets.length === 0) {
    console.log(`No targets configured. Run ${B('capy deploy')} to set one up.`);
    return 0;
  }
  console.log('');
  for (const t of targets) {
    const adapter = getAdapter(t.kind);
    const label = adapter ? adapter.label : t.kind;
    console.log(`  ${B(t.name)}  ${DIM(`(${label}, branch=${t.branch})`)}`);
    for (const [k, v] of Object.entries(t.options)) {
      console.log(`    ${DIM(k)}: ${String(v)}`);
    }
    console.log(`    ${DIM('vars')}: ${t.vars.join(', ')}`);
  }
  console.log('');
  return 0;
}

export async function deployRemove(
  name: string,
  cwd: string = process.cwd(),
  opts: { web?: boolean; devMode?: boolean; noDeploy?: boolean } = {},
): Promise<number> {
  if (opts.web) {
    // The terminal removes on a bare argument with no question at all. The
    // settings behind that name took seven prompts to produce and
    // `.capy/deploy.json` keeps no history, so the browser wants it typed back.
    const targets = listTargets(cwd);
    if (!targets.some((t) => t.name === name)) {
      console.error(`No target named "${name}".`);
      return 1;
    }
    const { chooseDeployTargetInBrowser } = await import('../ui/deployScreens');
    const picked = await chooseDeployTargetInBrowser({
      projectName: basename(cwd),
      configPath: deployConfigPath(cwd),
      purpose: 'browse',
      targets: targetRows(cwd, targets),
      view: 'confirm-remove',
      subjectTarget: name,
      allow: ['remove'],
      open: openBrowser(),
    }).catch((err: unknown) => {
      // An unanswered delete is a refusal and the screen resolves it as one —
      // clicking "Keep it" ends the run at once, and a window nobody came back
      // to ends on the screen's deadline. So a throw here is the SERVER, which
      // is a different fact and must not read as a decline.
      console.error(`${RED('✗')} could not open the confirm page: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (picked === null) return 1;
    if (picked.action !== 'remove') {
      console.log(`Kept target ${B(name)}.`);
      return 0;
    }
  }

  // Best-effort cleanup for adapters that left something outside
  // `.capy/deploy.json` (Dokploy's Capy-managed env block). Never gates the
  // local removal below — it is an offer, not a precondition.
  const target = getTarget(cwd, name);
  const adapter = target ? getAdapter(target.kind) : null;
  const onRemove = adapter?.onRemove;
  const offer =
    target && onRemove
      ? await (async () => {
          const interactive = process.stdin.isTTY === true;
          const confirm = async (message: string): Promise<boolean> => {
            if (!interactive) return false;
            const ans = await inquirer.prompt([
              { type: 'confirm', name: 'yes', message, default: false },
            ]);
            return !!ans.yes;
          };
          // Dokploy only: resolve the system store's key ONCE for this command —
          // see `resolveDokployApiKeyOnce`'s doc. `undefined` for every other
          // adapter's target. `orgId` is a HINT, not a requirement: when this cwd
          // has no keep.lock (or none was found), `openSystemStore` (inside
          // `system/systemStore.ts#getConnectorSecret`) still resolves the org
          // itself via `resolveOrgContext` — passing `undefined` here still
          // reaches the store, it just skips the keep.lock-org shortcut.
          const orgId = readKeep(cwd)?.orgId;
          // A SEPARATE interactive flag from the removal `confirm` above: `--web`
          // suppresses the store's own terminal prompt (it isn't a browser
          // screen) even though the removal confirm itself already went through
          // the browser earlier in this function.
          const secretsInteractive = dokploySecretsMayPrompt(interactive, !!opts.web);
          const resolvedApiKey = await resolveDokployApiKeyOnce(adapter!, target, orgId, opts.devMode, secretsInteractive);
          return onRemove(target, {
            cwd,
            interactive,
            confirm,
            orgId,
            devMode: opts.devMode,
            resolvedApiKey,
            noDeploy: opts.noDeploy,
          });
        })()
      : null;
  if (offer) {
    console.log(`  ${offer.ok ? GREEN('✓') : DIM('·')} ${offer.detail}`);
    if (offer.manualHint) console.log(`  ${DIM(offer.manualHint)}`);
  }

  // CAP-679: strip this target's `targets` elements from keep.lock, and
  // revoke every deploy token it ever delivered with — today `remove` left
  // the token live.
  //
  // Revocation is GATED on the onRemove offer above: only when the platform
  // side was actually cleaned up (`offer.ok`, which is also true for
  // `nothing_to_remove`) or there was nothing to offer at all (no
  // `onRemove` hook — vacuously fine) does the token get revoked. When the
  // platform-side strip failed or was declined, the token stays live and
  // the deploy it minted keeps working — revoking it would leave secrets
  // sitting in a Dokploy env with no way to rotate them out.
  //
  // The keep.lock strip below is UNCONDITIONAL on the offer's outcome —
  // whether or not the adapter could clean up its own side, the LOCAL
  // record of "this target received these vars" should not survive removal
  // — but it has its own independent guard (the branch check inside
  // `pushKeepTransform`).
  if (target) {
    const stripSucceededOrNothingToDo = !offer || offer.ok;
    const pm = new ProjectManager(cwd);
    const keep = pm.readKeepFile();
    if (keep) {
      const deployIds = deployIdsForTarget(keep, target.kind, target.name);
      if (deployIds.length > 0) {
        if (!stripSucceededOrNothingToDo) {
          console.log(
            `  ${YELLOW('!')} keeping ${deployIds.length} deploy token(s) for "${name}" live — the platform-side ` +
              `cleanup above did not succeed, so revoking now would strand secrets it already delivered.`,
          );
        } else {
          try {
            const { AuthService } = await import('../auth/authService');
            const { ServiceClient } = await import('../service/serviceClient');
            const projectState = await pm.detectProjectState();
            if (!projectState.organizationId) throw new Error('no organization id in keep.lock');
            const authService = new AuthService(undefined, opts.devMode, projectState.userId);
            const serviceClient = new ServiceClient(undefined, opts.devMode);
            serviceClient.setTokenProvider(() => authService.getValidToken());
            const authResult = await authenticateSilentWithFallback(authService, projectState.organizationId);
            if (authResult.success) {
              await Promise.all(deployIds.map((id) => serviceClient.revokeDeployToken(id).catch(() => {})));
              console.log(`  ${GREEN('✓')} revoked ${deployIds.length} deploy token(s) for "${name}".`);
            }
          } catch (err: any) {
            console.error(`  ${YELLOW('!')} could not revoke deploy token(s) for "${name}": ${err?.message ?? err}`);
          }
        }
      }
      await pushKeepTransform(
        cwd,
        target.branch,
        (k) => stripTargetsForProviderTarget(k, target.kind, target.name),
        opts.devMode,
        'strip deploy targets',
      );
    }
  }

  const ok = removeTarget(cwd, name);
  if (!ok) {
    console.error(`No target named "${name}".`);
    return 1;
  }
  console.log(`Removed target ${B(name)}.`);
  return 0;
}

/**
 * Resolve which deploy target to use, setting one up interactively if needed —
 * but WITHOUT deploying. This is the side-effect-free "resolve" step callers
 * like `capy rotate` run before showing a plan: it guarantees a configured
 * target exists (running the picker + saving to `.capy/deploy.json` when none
 * does) and returns it, so the plan can name a real destination. The actual
 * deploy happens later via `deployCommand(target.name, …)`.
 *
 * Returns null only when resolution can't proceed (no keep.lock, or the user
 * cancels). Requires a TTY for the picker; callers in non-interactive contexts
 * should pre-resolve via a target name instead.
 */
export async function ensureDeployTarget(
  cwd: string = process.cwd(),
  web: WebContext = {},
): Promise<TargetConfig | null> {
  const existing = listTargets(cwd);
  if (existing.length === 1) return existing[0];

  const keep = readKeep(cwd);
  if (!keep) {
    console.error(
      `No keep.lock in ${basename(cwd)}. Run ${B('capy')} here first to sync.`,
    );
    return null;
  }

  const setUpNew = async (): Promise<TargetConfig | null> => {
    const target = await runPicker(cwd, keep, undefined, undefined, web.web ? web : undefined);
    if (!target) return null;
    upsertTarget(cwd, target);
    console.log(GREEN(`✓ Saved target "${target.name}" to .capy/deploy.json`));
    return target;
  };

  if (existing.length === 0) return setUpNew();

  // Multiple saved targets — pick one (or set up a new one).
  if (web.web) {
    const picked = await pickTargetInBrowser(cwd, existing);
    if (picked.action === 'new') return setUpNew();
    if (picked.action !== 'use') return null;
    return existing.find((t) => t.name === picked.target) ?? null;
  }

  const ans = await inquirer.prompt([
    {
      type: 'list',
      name: 'name',
      message: 'Which deploy target?',
      theme: LIST_THEME,
      choices: [
        ...existing.map((t) => ({
          name: `${t.name}  ${DIM(`(${t.kind}, branch=${t.branch})`)}`,
          value: t.name,
        })),
        new inquirer.Separator() as any,
        { name: '+ new target', value: '__new__' },
      ],
    } as any,
  ]);
  if (ans.name === '__new__') return setUpNew();
  return existing.find((t) => t.name === ans.name) ?? null;
}

/**
 * The listing, as the answer to "which target?".
 *
 * Three prompts in this command ask that question with three different
 * sentences — `Which target?`, `Which deploy target?`, `Use saved target?` —
 * and they are one question about one list. `filterKind` carries the situation
 * (a run narrowed by `--target <id>`) and the screen supplies one wording for
 * all of them.
 *
 * `null` is the refusal, and it is the ONLY thing an unanswered page produces:
 * the pick view has no Cancel — its two buttons are `Use this target` and `Set
 * up a new target` — so closing the window is the whole vocabulary a user has
 * for "not this". `chooseDeployTargetInBrowser` resolves that rather than
 * rejecting, so it arrives here as an answer and every caller already treats it
 * as one ("Cancelled.", exit 0). A throw from this call is a broken server, and
 * still a throw.
 */
async function pickTargetInBrowser(
  cwd: string,
  targets: TargetConfig[],
  filterKind?: string,
): Promise<{ action: 'use' | 'new' | null; target: string }> {
  const { chooseDeployTargetInBrowser } = await import('../ui/deployScreens');
  const picked = await chooseDeployTargetInBrowser({
    projectName: basename(cwd),
    configPath: deployConfigPath(cwd),
    purpose: 'pick',
    filterKind,
    filterKindLabel: filterKind ? (getAdapter(filterKind)?.label ?? undefined) : undefined,
    targets: targetRows(cwd, targets),
    allow: ['use', 'new'],
    open: openBrowser(),
  });
  return {
    action: picked.action === 'use' || picked.action === 'new' ? picked.action : null,
    target: picked.target,
  };
}

/**
 * The Vercel Preview git branch, asked on the settings step and nowhere else.
 *
 * A target saved before `options.gitBranch` existed scoped its Preview
 * environment to the CAPY branch name, which fails at `vercel env add` with
 * "Branch not found in the connected Git repository" whenever the two names do
 * not coincide. The terminal heals it with a three-prompt free-text-or-list
 * question; here it is one step, on the page that states in as many words that
 * this is a git branch rather than a capy branch.
 *
 * The whole Vercel settings block comes back rather than `gitBranch` alone:
 * the step also asks which environment this target is, and switching it to
 * Production is a legitimate answer to a target whose Preview branch is
 * missing. Taking only the branch would discard that silently and leave the
 * run stuck on the same question next time.
 */
async function promptVercelGitBranchInBrowser(
  cwd: string,
  keep: KeepInfo,
  target: TargetConfig,
): Promise<Record<string, unknown> | null> {
  const branchVarSet = new Set(Object.keys(new FileManager(cwd).readEnvFile()));
  const branchVars = keep.variables.filter((v) => branchVarSet.has(v));
  const { setUpDeployTargetInBrowser } = await import('../ui/deployScreens');
  const answered = await setUpDeployTargetInBrowser({
    intent: 'edit',
    steps: ['settings'],
    adapterId: target.kind,
    capyBranches: keep.branches,
    branch: target.branch,
    existingNames: listTargets(cwd).map((t) => t.name),
    existingName: target.name,
    resolveAdapter: adapterContextFor(cwd, branchVars, target),
    open: openBrowser(),
  });
  return answered.cancelled ? null : answered.options;
}

/**
 * The plan gate, on a page.
 *
 * The terminal prints a seven-line block and reads ONE raw keypress. Three
 * things move here and nothing else does: every preflight check keeps a row
 * rather than only the first failure being printed, `delete` asks a second
 * question before removing a target that took seven prompts to build, and the
 * three endings a gate can have are never rendered as each other.
 *
 * `edit` is an ANSWER the caller acts on — it re-enters the picker and comes
 * back here — not a way out of the browser.
 */
async function confirmDeployOnScreen(
  cwd: string,
  target: TargetConfig,
  adapter: DeployAdapter,
  mode: DeployMode,
  options: DeployCliOptions,
  web: WebContext,
  preflight: { ok: boolean; reason?: string; hint?: string },
  changeGate?: { baseBranch: string; changed: boolean },
): Promise<{ action: 'confirm' | 'edit' | 'delete' | 'cancel'; force: boolean }> {
  const saved = getTarget(cwd, target.name) !== null;
  const branchVarSet = new Set(Object.keys(new FileManager(cwd).readEnvFile()));
  const keep = readKeep(cwd);
  const currentVars = (keep?.variables ?? []).filter((v) => branchVarSet.has(v));
  const { added, removed, drifted } = reconcileVars(
    target.vars,
    target.knownVars ?? currentVars,
    currentVars,
  );

  const plan: DeployPlanTarget = {
    name: target.name,
    adapterId: adapter.id,
    adapterLabel: adapter.label,
    branch: target.branch,
    mode,
    prBase: mode === 'ci' ? target.gitBaseBranch : undefined,
    options: Object.entries(target.options).map(([key, value]) => ({
      key,
      value: String(value),
    })),
    vars: target.vars,
    saved,
  };

  // One row, because one check is what the adapter reports: `preflight()`
  // returns the FIRST problem it hits and stops. Inventing per-check rows the
  // adapter never ran would be the browser claiming knowledge the CLI has not
  // got.
  const checks: DeployPreflightCheck[] = [
    {
      id: 'preflight',
      label: `${adapter.label} preflight`,
      state: preflight.ok ? 'ok' : 'fail',
      detail: preflight.reason,
      fix: preflight.hint,
    },
  ];

  const { confirmDeployInBrowser } = await import('../ui/deployScreens');
  const out = await confirmDeployInBrowser({
    target: plan,
    action: mode,
    dryRun: !!options.dryRun,
    preflight: checks,
    // Preflight is the only place Capy learns whether the vendor session the
    // user established by hand actually exists.
    signedIn: preflight.ok,
    drift: drifted ? { added, removed } : undefined,
    changeGate,
    modeAnswer: web.modeAnswer,
    // Past the change gate the plan was already approved and the secrets are
    // already decrypted: there is no picker left to re-enter and no target
    // that could be deleted without stranding the run half-done.
    allow: changeGate ? ['deploy'] : ['deploy', 'edit', 'delete'],
    open: openBrowser(),
  });

  if (out.cancelled || out.decision === null) return { action: 'cancel', force: false };
  if (out.decision === 'edit') return { action: 'edit', force: false };
  if (out.decision === 'delete') return { action: 'delete', force: false };
  return { action: 'confirm', force: out.force };
}

/**
 * The step log, as a page.
 *
 * `renderResult` prints a glyph, a label and a dim detail per step and then
 * returns an exit code, and the exit code is where it goes wrong: a CI run
 * that pushed secrets and opened a pull request has not deployed, and a run
 * whose change gate found nothing has not even queued one. Both print ticks
 * and exit 0. The outcome is computed here, from what actually happened.
 */
async function showRunResult(
  cwd: string,
  target: TargetConfig,
  adapter: DeployAdapter,
  mode: DeployMode,
  options: DeployCliOptions,
  result: DeployResult,
  extra: {
    stashed: boolean;
    keepLockChanged: boolean;
    baseBranch: string;
    pr?: { branch: string; base: string; url?: string; title?: string; manualUrl?: string };
  },
): Promise<void> {
  const steps: DeployRunStep[] = result.steps.map((s, i) => ({
    id: `${i}`,
    label: stripAnsiText(s.label),
    status: s.status,
    detail: s.detail === undefined ? undefined : stripAnsiText(s.detail),
    url: s.url,
  }));

  const outcome: DeployRunResultData['outcome'] = options.dryRun
    ? 'dry-run'
    : !result.ok
      ? 'failed'
      : mode !== 'ci'
        ? 'deployed'
        : extra.keepLockChanged
          ? 'opened-pr'
          : 'nothing-to-deploy';

  // The epilogue's first line is its own heading in the terminal, so it stays
  // the heading here rather than the browser inventing one.
  let epilogue: DeployRunResultData['epilogue'];
  if (result.epilogue) {
    const lines = stripAnsiText(result.epilogue).split('\n');
    const first = lines.findIndex((l) => l.trim() !== '');
    epilogue = {
      title: (lines[first] ?? '').trim(),
      snippet: lines.slice(first + 1).join('\n').replace(/^\n+/, ''),
    };
  }

  const { showDeployRunResultInBrowser } = await import('../ui/deployScreens');
  await showDeployRunResultInBrowser(
    {
      outcome,
      projectName: basename(cwd),
      target: {
        name: target.name,
        adapterLabel: adapter.label,
        branch: target.branch,
        mode,
        prBase: mode === 'ci' ? target.gitBaseBranch : undefined,
        adhoc: getTarget(cwd, target.name) === null,
      },
      steps,
      epilogue,
      git: mode === 'direct' ? { stashed: extra.stashed } : undefined,
      pr: extra.pr,
      stall:
        outcome === 'nothing-to-deploy'
          ? {
              code: 'no-secret-changes',
              title: 'Nothing will deploy',
              detail: `The keep.lock this deploy would commit is identical to the one already on origin/${extra.baseBranch}, so no pull request was opened and nothing will rebuild.`,
              remedy: `capy deploy ${target.name} --force`,
            }
          : undefined,
      nonTty: {
        command: `capy deploy ${target.name} --yes`,
        why: '--yes is not optional off a TTY: without it the confirm resolves to cancel and the run exits 0 having deployed nothing.',
      },
    },
    { open: openBrowser() },
  );
}

/** The terminal's own colours, off anything on its way into a payload. */
const stripAnsiText = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * The route this invocation would travel, and what is still unanswered on it.
 *
 * One builder, one array: `deployPlan` is what the three browser screens draw
 * and this is what `--json` emits, so the rail a person reads and the array an
 * agent parses cannot describe different routes. `unanswered` is DERIVED from
 * the same array rather than recomputed, for the same reason.
 *
 * Only argv and `.capy/deploy.json` settle a stop here. Nothing is guessed: a
 * stop no flag answered comes back in `unanswered`, which is precisely the
 * list a headless caller needs to know it must refuse rather than pick.
 */
export function describeDeployRoute(
  nameArg: string | undefined,
  options: DeployCliOptions,
  cwd: string,
): { stops: DeployPlanConfirmStop[]; unanswered: string[]; problem?: { code: ErrorCode; activeBranch: string; targetBranch: string } } {
  const saved = nameArg ? getTarget(cwd, nameArg) : null;
  // CAP-679: `--json` never travels the route (see this function's own
  // doc — no network, no decryption), so a real run's branch check never
  // gets a chance to run under `--json` either. This is the ONE place that
  // refusal can be surfaced as parseable JSON rather than only stderr prose
  // from a run `--json` will never actually make. Cheap and local — same
  // "only refuse when the active branch is KNOWN" rule as the real check.
  const activeBranch = new ProjectManager(cwd).deriveActiveBranch();
  const branchProblem = saved && activeBranch ? branchPushProblem(activeBranch, saved.branch) : null;
  const savedAdapter = saved ? getAdapter(saved.kind) : null;
  // `--target <id>` builds an ad-hoc target that is never written to disk,
  // so the naming question does not happen rather than going unanswered.
  const targetAdapter = !saved && options.target ? getAdapter(options.target) : null;

  const answers: Partial<Record<DeployStopId, string>> = {
    ...(options.platformAnswer ? { platform: stripAnsiText(options.platformAnswer) } : {}),
    ...(options.modeAnswer ? { mode: stripAnsiText(options.modeAnswer) } : {}),
    ...(saved
      ? {
          platform: stripAnsiText(savedAdapter?.label ?? saved.kind),
          branch: saved.branch,
          variables: `${saved.vars.length} ${saved.vars.length === 1 ? 'variable' : 'variables'}`,
          delivery: (savedAdapter?.ciOnly ? 'ci' : saved.mode ?? 'direct') === 'ci' ? 'CI' : 'Direct',
          name: saved.name,
          ...(Object.keys(saved.options).length > 0 ? { settings: 'saved' } : {}),
        }
      : targetAdapter
        ? { platform: stripAnsiText(targetAdapter.label) }
        : {}),
  };
  const skipped: DeployStopId[] = [
    ...(options.modeAnswer ? [] : (['mode'] as DeployStopId[])),
    ...(!saved && options.target ? (['name'] as DeployStopId[]) : []),
  ];

  // Where the traveller stands is the FIRST outstanding stop, taken off the
  // plan itself so the two can never disagree about what is left.
  const dryRun = !!options.dryRun;
  const [at] = unansweredDeployStops(deployPlan({ answers, skipped, dryRun }));
  const stops = deployPlan({
    at: (at as DeployStopId | undefined) ?? null,
    answers,
    skipped,
    dryRun,
  });
  return {
    stops,
    unanswered: unansweredDeployStops(stops),
    ...(branchProblem
      ? { problem: { code: branchProblem.code, activeBranch: branchProblem.activeBranch!, targetBranch: saved!.branch } }
      : {}),
  };
}

/**
 * Whether to touch `keep.lock`'s `changed_at` and re-trigger CI when the
 * decrypted secrets did not actually change vs. `baseBranch` — `--force`,
 * or (only absent that) a confirm, on the terminal or the browser page,
 * whichever is asking this run's questions. Declining (or nobody able to
 * ask — no TTY, no `--web`) leaves it false, the CLI's own default.
 */
async function resolveForceRedeploy(
  options: DeployCliOptions,
  web: WebContext,
  cwd: string,
  target: TargetConfig,
  adapter: DeployAdapter,
  mode: DeployMode,
  preflight: PreflightResult,
  baseBranch: string,
): Promise<boolean> {
  if (options.force) return true;
  if (options.yes) return false;
  if (web.web) {
    // Its own gate, because the change gate can only be evaluated after the
    // secrets are decrypted — the terminal asks it here for the same reason.
    // Declining is the CLI's own default of `false`, and the page says out
    // loud what the terminal leaves implicit: without a forced redeploy this
    // run pushes the secrets, opens no pull request, and nothing deploys.
    const gate = await confirmDeployOnScreen(cwd, target, adapter, mode, options, web, preflight, {
      baseBranch,
      changed: false,
    });
    return gate.action === 'confirm' && gate.force;
  }
  if (process.stdin.isTTY) {
    const ans = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'force',
        message:
          `No secret changes vs origin/${baseBranch} — force a redeploy ` +
          `(touch keep.lock to re-trigger CI)?`,
        default: false,
      },
    ]);
    return !!ans.force;
  }
  return false;
}

/** What the CI change-gate settled on, or why the deploy must stop before anything ships. */
type CiChangeGate = { ok: true; keepLockChanged: boolean; deployKeepContent: string } | { ok: false };

/**
 * The CI gate's decision, made BEFORE anything is minted or pushed:
 *   - `error`: a git/decrypt failure — the caller returns 1.
 *   - `unchanged`: nothing worth a PR — the caller mints NOTHING, pushes
 *     NOTHING, opens no PR, and returns 0. This is the whole point of
 *     splitting the gate from `buildFinalCiKeep` below: deciding "did
 *     anything change" must never itself require a deploy token to exist.
 *   - `proceed`: a real change (or `--force`) — the caller mints (for a
 *     token adapter), then calls `buildFinalCiKeep` with the real result.
 */
type CiGateOutcome = { kind: 'error' } | { kind: 'unchanged' } | { kind: 'proceed'; baseKeep: KeepFile };

/**
 * "Does this deploy change what's recorded on the target branch?" — decided
 * off a plain decrypt (never a minted token — see `deliveryWorthGating`'s
 * own doc for why `deploy_id` must never be part of this decision), folded
 * against origin/<base>'s keep.lock, NOT the local keep.lock file (which can
 * lag `.env`).
 *
 * Runs BEFORE `loadDeploySecrets`/minting — a token adapter (Dokploy) that's
 * unchanged never gets a fresh token minted or written to the platform at
 * all, which is the fix for CI churn: minting unconditionally (the old
 * behavior) meant every CI run installed a fresh, effectively untracked
 * token on the platform (CI mode never runs `recordDeployTargets` — that's
 * direct-mode only — so a token minted-and-written here with no PR opening
 * to record it was never tracked anywhere).
 *
 * Only called when `gitOk && mode === 'ci' && !options.dryRun` — direct mode
 * and dry runs never reach this, and the caller's own fallback (unchanged,
 * empty content) covers them without calling in here at all.
 */
async function resolveCiGateOutcome(
  cwd: string,
  baseBranch: string,
  target: TargetConfig,
  adapter: DeployAdapter,
  mode: DeployMode,
  options: DeployCliOptions,
  web: WebContext,
  preflight: PreflightResult,
): Promise<CiGateOutcome> {
  const fetched = fetchRemoteBranch(cwd, baseBranch);
  if (!fetched.ok) {
    console.error(`${RED('✗')} git fetch origin ${baseBranch}: ${fetched.error}`);
    return { kind: 'error' };
  }
  const relKeep = repoRelPath(cwd, 'keep.lock');
  const baseRaw = readFileAtRef(cwd, `origin/${baseBranch}`, relKeep);
  // base branch has no keep.lock yet — scaffold identity from the local keep
  // with no variables, so the PR creates keep.lock from the deploy.
  const baseKeep: KeepFile = baseRaw
    ? JSON.parse(baseRaw)
    : { ...JSON.parse(readFileSync(join(cwd, 'keep.lock'), 'utf-8')), variables: {} };

  const gateEnv = await (async (): Promise<{ ok: true; env: Record<string, string> } | { ok: false; message: string }> => {
    try {
      return { ok: true, env: await decryptCurrentBranch(cwd, options.devMode) };
    } catch (err: any) {
      return { ok: false, message: err.message };
    }
  })();
  if (!gateEnv.ok) {
    console.error(`${RED('✗')} decrypt: ${gateEnv.message}`);
    return { kind: 'error' };
  }

  const values: VarDelivery[] = target.vars
    .filter((v) => gateEnv.env[v] !== undefined)
    .map((v) => ({ name: v, valueHash: hashValue(gateEnv.env[v]) }));
  const deployed = options.noDeploy ? false : undefined;
  const changed = deliveryWorthGating(baseKeep, target.branch, adapter.id, target.name, deployed, values);
  if (changed) return { kind: 'proceed', baseKeep };

  // No secret change vs the target. --force (or a confirm) touches
  // keep.lock's changed_at so there's a real diff to PR + re-trigger CI.
  const force = await resolveForceRedeploy(options, web, cwd, target, adapter, mode, preflight, baseBranch);
  if (force) return { kind: 'proceed', baseKeep };

  console.log(
    `  ${DIM('·')} no secret changes vs origin/${baseBranch} — nothing to deploy. ${DIM('Use --force to re-trigger CI.')}`,
  );
  return { kind: 'unchanged' };
}

/**
 * The PR's keep.lock content — called only once `resolveCiGateOutcome` has
 * already decided to proceed (a real change, or `--force`), and — for a
 * token adapter — a fresh token has been minted. Folds the delivery in WITH
 * its real `deploy_id` this time (the gate decision above never sees one),
 * so a freshly minted token IS recorded (and, if it superseded one, tracked
 * via `superseded_deploy_ids`) even when the only reason we're here is
 * `--force` on an otherwise-unchanged value.
 */
function buildFinalCiKeep(
  baseKeep: KeepFile,
  env: Record<string, string>,
  target: TargetConfig,
  adapter: DeployAdapter,
  deployId: string | undefined,
  options: DeployCliOptions,
): CiChangeGate {
  const delivery: TargetDeliveryDescriptor = {
    provider: adapter.id,
    target: target.name,
    ref: targetRefFor(target),
    deployId,
    ...(options.noDeploy ? { deployed: false } : {}),
  };
  const built = buildDeployKeep(baseKeep, env, target.vars, target.branch, delivery);
  // A `--force` on an otherwise-unchanged, non-token adapter (no deployId to
  // fold in — e.g. cf-worker/vercel) still needs SOME diff to actually
  // retrigger CI — fall back to the `deploy_revision` bump `touchDeployKeep`
  // provides, the same as before this split.
  return built.changed
    ? { ok: true, keepLockChanged: true, deployKeepContent: built.content }
    : { ok: true, keepLockChanged: true, deployKeepContent: touchDeployKeep(baseKeep, target.vars, target.branch) };
}

/** Everything `deployRemove` needs after `showRunResult`'s `pr` field. */
type OpenedPr = { branch: string; base: string; url?: string; title?: string; manualUrl?: string };

/**
 * Commit the deploy-PR keep.lock in the isolated worktree, push it, and open
 * the PR — the part of the CI-mode flow that happens INSIDE the worktree
 * `openCiDeployPr` (below) creates and always tears down.
 */
async function commitAndOpenDeployPr(
  cwd: string,
  wt: string,
  branchName: string,
  baseBranch: string,
  msg: string,
  target: TargetConfig,
  deployKeepContent: string,
): Promise<{ ok: true; openedPr?: OpenedPr; prUrl?: string } | { ok: false }> {
  try {
    const relKeep = repoRelPath(cwd, 'keep.lock');
    writeFileSync(join(wt, relKeep), deployKeepContent);
    const commit = stageAndCommit(wt, [relKeep], msg);
    if (!commit.ok) {
      console.error(`${RED('✗')} ${commit.error}`);
      return { ok: false };
    }
    const push = pushBranch(wt, branchName);
    if (!push.ok) {
      console.error(`${RED('✗')} git push: ${push.error}`);
      return { ok: false };
    }
    console.log(`  ${GREEN('✓')} push    ${branchName} ${DIM(`(off origin/${baseBranch})`)}`);
    const title = `deploy: ${target.name} → ${target.branch} (${target.kind})`;
    const body = buildDeployPrBody(target);
    const pr = createPr(wt, title, body, baseBranch);
    if (pr.ok) {
      console.log(`  ${GREEN('✓')} PR      ${pr.url ?? '(open)'}`);
      return { ok: true, openedPr: { branch: branchName, base: baseBranch, url: pr.url, title }, prUrl: pr.url };
    }
    if (pr.manualHint) {
      console.log(`  ${YELLOW('!')} ${pr.manualHint}`);
      return { ok: true, openedPr: { branch: branchName, base: baseBranch, title } };
    }
    console.error(`${RED('✗')} gh pr create: ${pr.error}`);
    return { ok: false };
  } finally {
    // Always tear down the worktree + local branch ref (the branch lives on
    // origin once pushed). The user's tree was never touched, so there is
    // nothing to restore and nothing to strand.
    worktreeRemove(cwd, wt);
    deleteLocalBranch(cwd, branchName);
  }
}

/**
 * CI mode: open the keep.lock PR in an ISOLATED git worktree. The user's
 * working tree and current branch are NEVER touched — no stash, no
 * checkout-back, nothing to strand on failure.
 */
async function openCiDeployPr(
  cwd: string,
  baseBranch: string,
  msg: string,
  target: TargetConfig,
  deployKeepContent: string,
): Promise<{ ok: true; openedPr?: OpenedPr } | { ok: false }> {
  const now = new Date();
  const ts = now.toISOString().slice(0, 10).replace(/-/g, '') + '-' + now.toISOString().slice(11, 19).replace(/:/g, '');
  const rand = Math.random().toString(36).slice(2, 6);
  const branchName = `capy-deploy-${ts}-${rand}`;
  const wt = join(tmpdir(), `capy-deploy-${ts}-${rand}`);

  const added = worktreeAddNewBranch(cwd, wt, branchName, `origin/${baseBranch}`);
  if (!added.ok) {
    console.error(`${RED('✗')} git worktree add (off origin/${baseBranch}): ${added.error}`);
    return { ok: false };
  }

  const committed = await commitAndOpenDeployPr(cwd, wt, branchName, baseBranch, msg, target, deployKeepContent);
  if (!committed.ok) return { ok: false };

  console.log('');
  console.log(`  ${B('Review and merge to deploy:')}`);
  if (committed.prUrl) console.log(`    ${committed.prUrl}`);
  console.log(`    ${DIM('branch')}    ${branchName} ${DIM(`→ ${baseBranch}`)}`);
  console.log('');
  return { ok: true, openedPr: committed.openedPr };
}

// ── Main: capy deploy [name] ───────────────────────────────────────────────

export async function deployCommand(
  nameArg?: string,
  options: DeployCliOptions = {},
  cwd: string = process.cwd(),
): Promise<number> {
  // `--json` describes the route rather than travelling it. Before keep.lock,
  // before auth, before a single value is decrypted — the plan is knowable
  // without any of that, and that is what makes it a plan.
  if (options.json) {
    console.log(JSON.stringify(describeDeployRoute(nameArg, options, cwd), null, 2));
    return 0;
  }

  const keep = readKeep(cwd);
  if (!keep) {
    console.error(
      `No keep.lock in ${basename(cwd)}. Run ${B('capy')} here first to sync.`,
    );
    return 1;
  }

  // Where this run's questions are drawn, and what the rail already holds
  // from the stops travelled before this command was entered.
  const web: WebContext = {
    web: options.web,
    platformAnswer: options.platformAnswer,
    modeAnswer: options.modeAnswer,
  };

  // Resolve target: explicit name → load from config; --target=id → ad-hoc;
  // else picker (or confirm-last if a single target exists and no --edit).
  let target: TargetConfig | null = null;

  if (nameArg) {
    target = getTarget(cwd, nameArg);
    if (!target) {
      console.error(`No target named "${nameArg}". Run \`capy deploy list\`.`);
      return 1;
    }
  } else if (options.target) {
    const adapter = getAdapter(options.target);
    if (!adapter) {
      console.error(
        `Unknown adapter "${options.target}". Known: ${ALL_ADAPTERS.map((a) => a.id).join(', ')}`,
      );
      return 1;
    }
    if (options.yes) {
      // Ad-hoc CI path: build a transient target from auto-detected defaults.
      const detected = await adapter.detect(cwd);
      const cls = classify(keep.variables);
      target = {
        name: `${adapter.id}-adhoc`,
        kind: adapter.id,
        branch: keep.branches.includes('production') ? 'production' : keep.branches[0] ?? 'development',
        vars: adapter.presumeVars
          ? adapter.presumeVars(cls)
          : adapter.varKind === 'build-time'
            ? cls.buildTime
            : cls.runtime,
        options: detected.options ?? {},
        ...(adapter.ciOnly ? { mode: 'ci' as const } : {}),
      };
    } else {
      // Interactive but adapter is pre-chosen — handoff path from the
      // existing platform picker. If the user already saved targets for
      // this adapter, offer them first so day-2 doesn't re-fill the whole
      // picker. New target is always available as a "+ new" option.
      const sameKind = listTargets(cwd).filter((t) => t.kind === adapter.id);
      let chosen: TargetConfig | '__new__' | null = '__new__';
      if (web.web && sameKind.length > 0) {
        const picked = await pickTargetInBrowser(cwd, sameKind, adapter.id);
        chosen =
          picked.action === 'new'
            ? '__new__'
            : picked.action === 'use'
              ? sameKind.find((t) => t.name === picked.target) ?? null
              : null;
      } else if (sameKind.length === 1) {
        const ans = await inquirer.prompt([
          {
            type: 'list',
            name: 'pick',
            message: `Use saved target?`,
            theme: LIST_THEME,
            choices: [
              {
                name: `${sameKind[0].name}  ${DIM(`(branch=${sameKind[0].branch}, mode=${sameKind[0].mode ?? 'direct'})`)}`,
                value: '__use__',
              },
              { name: '+ new target (re-enter picker)', value: '__new__' },
            ],
            default: '__use__',
          } as any,
        ]);
        chosen = ans.pick === '__use__' ? sameKind[0] : '__new__';
      } else if (sameKind.length > 1) {
        const ans = await inquirer.prompt([
          {
            type: 'list',
            name: 'pick',
            message: `Use a saved ${adapter.label} target?`,
            theme: LIST_THEME,
            choices: [
              ...sameKind.map((t) => ({
                name: `${t.name}  ${DIM(`(branch=${t.branch}, mode=${t.mode ?? 'direct'})`)}`,
                value: t.name,
              })),
              new inquirer.Separator() as any,
              { name: '+ new target (re-enter picker)', value: '__new__' },
            ],
          } as any,
        ]);
        chosen =
          ans.pick === '__new__'
            ? '__new__'
            : sameKind.find((t) => t.name === ans.pick)!;
      }
      if (chosen === null) {
        console.log('Cancelled.');
        return 0;
      }
      if (chosen !== '__new__') {
        target = chosen;
      } else {
        const built = await runPicker(cwd, keep, undefined, adapter.id, web.web ? web : undefined);
        if (!built) {
          console.log('Cancelled.');
          return 0;
        }
        target = built;
        upsertTarget(cwd, target);
        console.log(GREEN(`✓ Saved target "${target.name}" to .capy/deploy.json`));
      }
    }
  } else {
    // No name, no --target. Interactive.
    const targets = listTargets(cwd);
    if (targets.length === 0 || options.edit) {
      const built = await runPicker(
        cwd,
        keep,
        options.edit && targets.length === 1 ? targets[0] : undefined,
        undefined,
        web.web ? web : undefined,
      );
      if (!built) {
        console.log('Cancelled.');
        return 0;
      }
      target = built;
      upsertTarget(cwd, target);
      console.log(GREEN(`✓ Saved target "${target.name}" to .capy/deploy.json`));
    } else if (targets.length === 1) {
      target = targets[0];
    } else if (web.web) {
      const picked = await pickTargetInBrowser(cwd, targets);
      if (picked.action === 'new') {
        const built = await runPicker(cwd, keep, undefined, undefined, web);
        if (!built) {
          console.log('Cancelled.');
          return 0;
        }
        target = built;
        upsertTarget(cwd, target);
      } else if (picked.action === 'use') {
        target = targets.find((t) => t.name === picked.target) ?? null;
      }
      if (!target) {
        console.log('Cancelled.');
        return 0;
      }
    } else {
      const ans = await inquirer.prompt([
        {
          type: 'list',
          name: 'name',
          message: 'Which target?',
          theme: LIST_THEME,
          choices: [
            ...targets.map((t) => ({
              name: `${t.name}  ${DIM(`(${t.kind}, branch=${t.branch})`)}`,
              value: t.name,
            })),
            new inquirer.Separator() as any,
            { name: '+ new target', value: '__new__' },
          ],
        },
      ]);
      if (ans.name === '__new__') {
        const built = await runPicker(cwd, keep);
        if (!built) {
          console.log('Cancelled.');
          return 0;
        }
        target = built;
        upsertTarget(cwd, target);
      } else {
        target = targets.find((t) => t.name === ans.name)!;
      }
    }
  }

  const adapter = getAdapter(target.kind);
  if (!adapter) {
    console.error(`Unknown adapter "${target.kind}" in target "${target.name}".`);
    return 1;
  }

  // ── Branch check (CAP-679) ────────────────────────────────────────────────
  // Deploy reads values from `.env` but files the result under
  // `target.branch` — refuse when the two disagree, rather than shipping
  // branch A's secrets under branch B's name. Only refuses when the active
  // branch is actually KNOWN (`ProjectManager.deriveActiveBranch`, e.g. the
  // `.env` header) — a project with no such signal (a plaintext `.env` with
  // several keep.lock branches, common in tests and some early setups) stays
  // silent here exactly as it did before this check existed.
  {
    const activeBranch = new ProjectManager(cwd).deriveActiveBranch();
    // Unknown is deliberately NOT refused here (unlike `pushKeepTransform`'s
    // stricter guard at the actual write point) — a project with no branch
    // signal at all (plaintext `.env`, several keep.lock branches; common in
    // tests and some early setups) stays silent exactly as it did before
    // this check existed. A KNOWN mismatch is always refused.
    const branchProblem = activeBranch ? branchPushProblem(activeBranch, target.branch) : null;
    if (branchProblem) {
      console.error(`${RED('✗')} ${describeBranchProblem(branchProblem)}`);
      console.error(
        `\nRun \`capy checkout ${target.branch}\` first, or edit the target with \`capy deploy --edit\`.`,
      );
      return 1;
    }
  }

  // Heal Vercel Preview targets saved before options.gitBranch existed. The
  // old fallback scoped the Preview env to the CAPY branch name, which fails
  // at `vercel env add` with "Branch not found in the connected Git
  // repository" whenever the names don't coincide. Ask once and persist.
  const targetOpts = target.options as Record<string, unknown>;
  if (
    target.kind === 'vercel' &&
    targetOpts.vercelEnv === 'preview' &&
    !targetOpts.gitBranch
  ) {
    if (options.yes) {
      console.error(
        `${RED('✗')} target "${target.name}" is missing options.gitBranch ` +
          `(the git branch its Vercel Preview env is wired to).`,
      );
      console.error(`\nRun \`capy deploy --edit\` once interactively to set it.`);
      return 1;
    }
    if (web.web) {
      // One step of the setup screen — which is where this question belongs:
      // the page states in as many words that this is a GIT branch and not the
      // capy branch, which is the confusion that produced the gap being healed.
      const healed = await promptVercelGitBranchInBrowser(cwd, keep, target);
      if (!healed) {
        console.log('Cancelled.');
        return 0;
      }
      // Production is not branch-scoped, so a switch to it drops the key
      // rather than leaving a stale one behind — the same reason the picker
      // omits it.
      delete targetOpts.gitBranch;
      Object.assign(targetOpts, healed);
    } else {
      targetOpts.gitBranch = await promptVercelGitBranch(cwd);
    }
    upsertTarget(cwd, target);
    console.log(
      GREEN(
        targetOpts.gitBranch
          ? `✓ Saved gitBranch=${targetOpts.gitBranch} to target "${target.name}"`
          : `✓ Saved vercelEnv=${targetOpts.vercelEnv} to target "${target.name}"`,
      ),
    );
  }

  // Var-set reconcile: the saved selection can go stale when the
  // project's variables change. Re-confirm rather than silently deploying a
  // stale set — dropping a newly-added secret, or shipping a removed one.
  {
    const branchVarSet = new Set(Object.keys(new FileManager(cwd).readEnvFile()));
    const currentVars = keep.variables.filter((v) => branchVarSet.has(v));
    // Legacy targets have no `knownVars` baseline; treat current as known so we
    // don't false-flag intentionally-unselected vars as "newly added".
    const known = target.knownVars ?? currentVars;
    const { added, removed, drifted } = reconcileVars(target.vars, known, currentVars);
    if (drifted) {
      if (added.length)
        console.log(`  ${YELLOW('!')} new project var(s) not in this target: ${B(added.join(', '))}`);
      if (removed.length)
        console.log(`  ${YELLOW('!')} target var(s) no longer in the project: ${B(removed.join(', '))}`);
      if (!options.yes && !options.dryRun && !web.web && process.stdin.isTTY) {
        // Only the variable list changed, so only the variables are asked about.
        // Every other setting (adapter, branch, options, mode, name) is kept.
        const includedNew = added.length ? await pickNewVars(target, added) : [];
        target = applyVarDrift(target, currentVars, includedNew);
        upsertTarget(cwd, target);
        console.log(GREEN(`✓ Updated target "${target.name}" in .capy/deploy.json`));
      } else if (!options.yes && !options.dryRun && web.web) {
        console.log(`  ${DIM('The project\'s variables changed — re-confirm this target.')}`);
        const reconfirmed = await runPicker(
          cwd,
          keep,
          target,
          undefined,
          web.web ? { ...web, intent: 'reconfirm' } : undefined,
        );
        if (!reconfirmed) {
          console.log('Cancelled.');
          return 0;
        }
        target = reconfirmed;
        upsertTarget(cwd, target);
        console.log(GREEN(`✓ Updated target "${target.name}" in .capy/deploy.json`));
      } else if (options.yes && added.length) {
        console.error(
          `${RED('✗')} the project gained variable(s) since this target was saved: ${added.join(', ')}.\n` +
            `    Re-run \`capy deploy ${target.name}\` interactively to include or skip them — refusing to silently drop a secret.`,
        );
        return 1;
      } else if (options.yes && removed.length) {
        // Non-interactive: a removed var can't be pushed; drop it and carry on.
        target = { ...target, vars: target.vars.filter((v) => currentVars.includes(v)), knownVars: currentVars };
      }
    }
  }

  renderPlan(target, adapter);

  // CI-only adapters (Vercel) always take the CI/PR path, even if a legacy or
  // ad-hoc target carries a stale 'direct' mode — capy never runs their CLI.
  const mode: DeployMode = adapter.ciOnly ? 'ci' : (target.mode ?? 'direct');

  // Dokploy only: resolve the org system store's API key ONCE for this whole
  // command and reuse it across preflight, the edit-loop's re-preflight, and
  // deploy — so the store is asked (and an admin prompted) at most once, no
  // matter how many of those run. `undefined` for every other adapter; they
  // never read `ctx.resolvedApiKey`. Never prompts under `--web` (a browser
  // run — the store's own prompt renders on a terminal, not a screen),
  // `--yes`, or `--dry-run` (a preview must never save a new key) — see
  // `dokploySecretsMayPrompt`'s own doc. Never resolves at all when the
  // target's shape is already broken — `resolveDokployApiKeyOnce` skips it,
  // and `preflight()`'s own shape check fails first regardless of any token.
  const secretsInteractive = dokploySecretsMayPrompt(
    process.stdin.isTTY === true,
    !!web.web || !!options.yes || !!options.dryRun,
  );
  const dokployApiKey = await resolveDokployApiKeyOnce(adapter, target, keep.orgId, options.devMode, secretsInteractive);
  const adapterCallCtx = { orgId: keep.orgId, devMode: options.devMode, interactive: secretsInteractive, resolvedApiKey: dokployApiKey };

  // Preflight (fail BEFORE decryption). At a terminal, a failed preflight is
  // not a dead end: the user can edit the target (e.g. a wrong composeId) and
  // preflight runs again. Non-interactive runs (--yes, --dry-run, --json,
  // --web, no TTY) refuse exactly as before.
  const canFixInteractively =
    process.stdin.isTTY === true && !options.yes && !options.dryRun && !options.json && !web.web;
  const preflightOrEdit = async (
    t: TargetConfig,
  ): Promise<{ ok: true; target: TargetConfig; preflight: PreflightResult } | { ok: false }> => {
    const result = await adapter.preflight(t, { cwd, ...adapterCallCtx });
    if (result.ok) return { ok: true, target: t, preflight: result };
    console.error(`${RED('✗')} preflight: ${result.reason}`);
    if (result.hint) console.error('\n' + result.hint);
    if (!canFixInteractively) return { ok: false };
    // COPY-FLAG: minimal neutral wording, pending Vince's approval.
    const action = await keypressConfirm({ message: 'Preflight failed. Press e to edit this target, c to check again, esc to cancel.' });
    if (action === 'confirm') return preflightOrEdit(t);
    if (action !== 'edit') return { ok: false };
    const edited = await runPicker(cwd, keep, t, undefined, undefined);
    if (!edited) return { ok: false };
    upsertTarget(cwd, edited);
    console.log(GREEN(`✓ Saved target "${edited.name}" to .capy/deploy.json`));
    renderPlan(edited, adapter);
    return preflightOrEdit(edited);
  };
  const preflightOutcome = await preflightOrEdit(target);
  if (!preflightOutcome.ok) return 1;
  target = preflightOutcome.target;
  const preflight = preflightOutcome.preflight;
  for (const w of preflight.warnings ?? []) {
    console.log(`  ${YELLOW('!')} ${w.message}`);
  }

  // capy never blocks on uncommitted source changes. It only ever stages and
  // commits keep.lock — your work-in-progress is left exactly as it was.
  const gitOk = !options.dryRun && isGitRepo(cwd);

  // Confirm-or-edit loop. Single-keypress picker (c/e/d/esc) so the user
  // can fix a saved target inline instead of having to abort, run
  // `capy deploy --edit`, then re-run.
  if (!options.yes && !options.dryRun) {
    while (true) {
      const summary =
        mode === 'ci'
          ? `Open a deploy PR (commit keep.lock + push secrets, no live deploy)?`
          : `Deploy now (commit keep.lock + ship from HEAD; your WIP is stashed and restored)?`;
      // Same four answers, drawn on a page instead of read off one keypress —
      // and `delete` gets the second question the keypress never asked.
      const action = web.web
        ? (await confirmDeployOnScreen(cwd, target, adapter, mode, options, web, preflight)).action
        : await keypressConfirm({ message: summary });
      if (action === 'confirm') break;
      if (action === 'cancel') {
        console.log('Cancelled.');
        return 0;
      }
      if (action === 'delete') {
        // Only saved targets can be deleted; ad-hoc transient ones aren't on
        // disk. Either way, stop after delete — there's nothing left to do.
        const removed = removeTarget(cwd, target.name);
        if (removed) {
          console.log(`Removed target ${B(target.name)}.`);
        } else {
          console.log(`(target was not saved — nothing to delete)`);
        }
        return 0;
      }
      if (action === 'edit') {
        const edited = await runPicker(cwd, keep, target, undefined, web.web ? web : undefined);
        if (!edited) {
          console.log('Cancelled.');
          return 0;
        }
        target = edited;
        upsertTarget(cwd, target);
        console.log(GREEN(`✓ Saved target "${target.name}" to .capy/deploy.json`));
        renderPlan(target, adapter);
        // Re-run preflight after edit — paths/options may have changed.
        // Reuses the SAME resolvedApiKey from above: it was resolved once
        // for this command, and an edit here changes vars/branch/mode, never
        // the Dokploy token source.
        const recheck = await adapter.preflight(target, { cwd, ...adapterCallCtx });
        if (!recheck.ok) {
          console.error(`${RED('✗')} preflight: ${recheck.reason}`);
          if (recheck.hint) console.error('\n' + recheck.hint);
          return 1;
        }
        // Loop back to confirm prompt with the edited target.
        continue;
      }
    }
  }

  const msg = `chore(deploy): ${target.name} → ${target.branch} (${target.kind})`;
  const baseBranch = target.gitBaseBranch ?? 'main';

  // ── CI change-gate — BEFORE any mint (see resolveCiGateOutcome's own doc:
  //    deciding "did anything change" must never itself require a token, or
  //    every CI run of a token adapter mints and writes one regardless of
  //    whether anything changed). Direct mode and dry runs are never gated
  //    — `gateOutcome` stays `null` and the fallback below covers them.
  const ciGated = gitOk && mode === 'ci' && !options.dryRun;
  const gateOutcome: CiGateOutcome | null = ciGated
    ? await resolveCiGateOutcome(cwd, baseBranch, target, adapter, mode, options, web, preflight)
    : null;
  if (gateOutcome?.kind === 'error') return 1;
  if (gateOutcome?.kind === 'unchanged') return 0;

  // ── Decrypt the secrets we're about to push (and, for a token adapter,
  //    mint) — only reached when direct mode, or CI mode just decided
  //    something is actually worth shipping.
  const secrets = await loadDeploySecrets(cwd, adapter, target, options);
  if (!secrets) return 1;
  const { env, deployToken, valueHashes } = secrets;

  // The PR's keep.lock content, now that a real deploy_id (if any) is known
  // — see `buildFinalCiKeep`'s own doc.
  const changeGate: CiChangeGate =
    gateOutcome?.kind === 'proceed'
      ? buildFinalCiKeep(gateOutcome.baseKeep, env, target, adapter, deployToken?.deployId, options)
      : { ok: true, keepLockChanged: false, deployKeepContent: '' };
  if (!changeGate.ok) return 1;
  const { keepLockChanged, deployKeepContent } = changeGate;

  // ── Direct mode only: commit keep.lock on the current branch, stashing
  //    other WIP. CI mode never touches the user's tree — it builds the PR
  //    commit in an isolated worktree below.
  //
  // The tracked-keep sync (catching it up to capy's current pins — sync/
  // push/edit now write only into the untracked working copy,
  // .capy/keep.lock — see syncTrackedKeepForDirectDeploy) runs HERE,
  // immediately before deciding whether keep.lock is dirty and immediately
  // before the commit itself — not any earlier in the run. Every exit
  // between an earlier sync and this point (confirm cancel/delete/
  // edit-cancel, a failed preflight recheck, a failed mint/decrypt) would
  // otherwise leave the tracked file modified and uncommitted, reintroducing
  // the exact CAP-667 symptom: a teammate's next `git pull` refusing with
  // "local changes would be overwritten". Any failure from here on restores
  // keep.lock to HEAD's version before returning, for the same reason.
  const directCommit = await (async (): Promise<
    | { kind: 'skip' }
    | { kind: 'committed'; stashed: boolean }
    | { kind: 'failed'; stashed: boolean }
  > => {
    if (!gitOk || mode !== 'direct') return { kind: 'skip' };
    syncTrackedKeepForDirectDeploy(cwd);
    if (!hasKeepLockChanges(cwd)) return { kind: 'skip' };

    const stash = stashOtherChanges(cwd);
    if (!stash.ok) {
      console.error(`${RED('✗')} git stash: ${stash.error}`);
      restorePathsToHead(cwd, ['keep.lock']);
      return { kind: 'failed', stashed: false };
    }
    if (stash.stashed) {
      console.log(`  ${GREEN('✓')} stash   set aside other working-tree changes (will restore)`);
    }
    const commit = stageAndCommit(cwd, ['keep.lock'], msg);
    if (!commit.ok) {
      console.error(`${RED('✗')} ${commit.error}`);
      restorePathsToHead(cwd, ['keep.lock']);
      await unwindGitState(cwd, null, stash.stashed);
      return { kind: 'failed', stashed: stash.stashed };
    }
    console.log(`  ${GREEN('✓')} commit  ${msg}`);
    return { kind: 'committed', stashed: stash.stashed };
  })();

  if (directCommit.kind === 'failed') {
    return 1;
  }
  const directStashed = directCommit.kind === 'committed' ? directCommit.stashed : false;

  // ── Push the secrets.
  const result = await adapter.deploy(target, {
    env,
    deployToken,
    dryRun: !!options.dryRun,
    secretsOnly: mode === 'ci',
    noDeploy: !!options.noDeploy,
    cwd,
    ...adapterCallCtx,
  });
  renderResult(result);
  if (!result.ok) {
    await unwindGitState(cwd, null, directStashed);
    if (web.web) {
      await showRunResult(cwd, target, adapter, mode, options, result, {
        stashed: directStashed,
        keepLockChanged,
        baseBranch,
      });
    }
    return 1;
  }
  if (mode === 'direct') await unwindGitState(cwd, null, directStashed);

  // ── Record targets (CAP-679) ─────────────────────────────────────────────
  // Direct mode only: CI mode already folded this delivery into the PR's
  // keep.lock above (`buildFinalCiKeep`'s `delivery` param) — recording it
  // AGAIN here, against the user's own branch, would be wrong: CI mode never
  // touches the user's tree.
  if (mode === 'direct' && !options.dryRun) {
    await recordDeployTargets(cwd, target, adapter, valueHashes, deployToken?.deployId, options.devMode, !!options.noDeploy);
    // "No untracked tokens" (CAP-679 follow-up): only once THIS deploy is a
    // REAL one (never `--no-deploy` — that config is pending, and its
    // predecessor may still be the one actually running) does it become safe
    // to revoke whatever `recordDeployTargets` just moved to
    // `superseded_deploy_ids` — see `revokeSupersededDeployTokens`'s own doc.
    if (!options.noDeploy) {
      await revokeSupersededDeployTokens(cwd, target, adapter, options.devMode);
    }
  }

  // The pull request this run opened, for the result page. Held rather than
  // printed-and-forgotten: `✓ PR (open)` with no URL row is the terminal
  // saying a pull request exists and giving you no way to reach it.
  //
  // CI mode: open the keep.lock PR in an ISOLATED git worktree (see
  // `openCiDeployPr`). The user's working tree and current branch are NEVER
  // touched — no stash, no checkout-back, nothing to strand on failure.
  const prOutcome =
    mode === 'ci' && !options.dryRun && keepLockChanged
      ? await openCiDeployPr(cwd, baseBranch, msg, target, deployKeepContent)
      : { ok: true as const, openedPr: undefined as OpenedPr | undefined };
  if (!prOutcome.ok) return 1;
  const openedPr = prOutcome.openedPr;

  if (web.web) {
    await showRunResult(cwd, target, adapter, mode, options, result, {
      stashed: directStashed,
      keepLockChanged,
      baseBranch,
      pr: openedPr,
    });
  }

  return 0;
}

/**
 * Return the user to the branch they started on and pop any stash we made
 * during CI mode. Idempotent and best-effort — failures are logged but do
 * not propagate, since by the time we get here the PR has already been
 * opened (or the caller already errored). Stranding the user on a deploy
 * branch with stashed changes is worse than printing a hint.
 */
async function unwindGitState(
  cwd: string,
  originalBranch: string | null,
  stashedOthers: boolean,
): Promise<void> {
  if (originalBranch && currentBranch(cwd) !== originalBranch) {
    // The CI secrets-only path replays keep.lock onto the deploy branch without
    // committing it, so `git checkout <originalBranch>` aborts ("local changes
    // to keep.lock would be overwritten"). Drop that replayed copy first — the
    // user's real keep.lock is committed on originalBranch or in the stash we
    // made (popped just below). Best-effort: ignore if there's nothing to drop.
    discardPaths(cwd, ['keep.lock']);
    const co = checkoutBranch(cwd, originalBranch);
    if (co.ok) {
      console.log(`  ${DIM('↩')} back on ${originalBranch}`);
    } else {
      console.log(
        `  ${YELLOW('!')} could not return to ${originalBranch}: ${co.error}\n` +
          `    Run \`git checkout ${originalBranch}\` to switch back.`,
      );
    }
  }
  if (stashedOthers) {
    const pop = popStash(cwd);
    if (pop.ok) {
      console.log(`  ${DIM('↩')} restored stashed working-tree changes`);
    } else {
      console.log(
        `  ${YELLOW('!')} could not pop stash automatically: ${pop.error}\n` +
          `    Run \`git stash pop\` to restore your changes.`,
      );
    }
  }
}

function buildDeployPrBody(target: TargetConfig): string {
  const adapter = getAdapter(target.kind);
  const adapterLabel = adapter ? adapter.label : target.kind;
  const optionsTable = Object.entries(target.options)
    .map(([k, v]) => `- \`${k}\`: \`${String(v)}\``)
    .join('\n');
  const baseLine = target.gitBaseBranch
    ? `- **Git base:** \`${target.gitBaseBranch}\` — merging this PR is the deploy signal for that branch.`
    : '';

  // Secret-delivery wording depends on the adapter. Blob adapters (Vercel) push
  // SECRETS_BLOB + PROJECT_KEY and let the build decrypt via `capy run`; others
  // push the individual secrets into the vendor's store.
  const varsSection = adapter?.needsDeployToken
    ? [
        `Delivered to ${adapterLabel} as \`SECRETS_BLOB\` + \`PROJECT_KEY\` **before** this`,
        `PR was opened — the encrypted bundle of your secrets plus its build-time`,
        `key. Your individual secret values stay encrypted in the bundle and never`,
        `appear in git history; the build decrypts them with \`capy run\`:`,
        ``,
        `- \`SECRETS_BLOB\``,
        `- \`PROJECT_KEY\``,
      ].join('\n')
    : [
        `Already delivered to the vendor's secret store **before** this PR was`,
        `opened (e.g. \`wrangler secret bulk\` for cf-worker). Names only — values`,
        `stay in the vendor's store and never appear in git history:`,
        ``,
        target.vars.map((v) => `- \`${v}\``).join('\n'),
      ].join('\n');

  // Dokploy CI mode (CAP-682): not `needsDeployToken` (plain values now) and
  // not `ciOnly` (direct mode still exists) — but for THIS section it reads
  // exactly like a `ciOnly` adapter: Dokploy's OWN auto-deploy is what merging
  // triggers, capy never calls `compose.redeploy`/`application.deploy` in CI
  // mode. Checked before the generic `ciOnly` branch so it wins.
  const mergeSection = adapter?.needsDeployToken
    ? [
        `Merging this PR is the deploy signal. ${adapterLabel}'s git CI builds on`,
        `merge, and \`capy run\` injects your secrets from \`SECRETS_BLOB\` at build`,
        `time. capy does **not** ship code from the local machine — only the`,
        `keep.lock pin lands here.`,
      ].join('\n')
    : adapter?.id === 'dokploy'
      ? // COPY-FLAG: new user-facing string, minimal/neutral wording.
        [
          `Merging this PR is the deploy signal. Dokploy's own auto-deploy builds`,
          `and deploys on merge, reading the env vars written above directly from`,
          `its store — no decrypt step at build. capy does **not** call`,
          `\`compose.redeploy\`/\`application.deploy\` in CI mode — only the`,
          `keep.lock pin lands here.`,
        ].join('\n')
      : adapter?.ciOnly
        ? [
            `Merging this PR is the deploy signal. ${adapterLabel}'s git integration`,
            `builds and deploys on merge, reading the env vars pushed above directly`,
            `from its store — no decrypt step at build. capy does **not** ship code`,
            `from the local machine — only the keep.lock pin lands here.`,
          ].join('\n')
        : [
            `Merging this PR is the deploy signal. Your CI pipeline runs the actual`,
            `code deploy (e.g. \`capy run -- wrangler deploy\` for cf-worker) using`,
            `the secrets that were pushed above. capy itself does **not** ship code`,
            `from the local machine in CI mode — only the keep.lock pin lands here.`,
          ].join('\n');

  return [
    `Automated deploy PR opened by \`capy deploy\`.`,
    ``,
    `## What this ships`,
    ``,
    `- **Target:** \`${target.name}\``,
    `- **Adapter:** ${adapterLabel} (\`${target.kind}\`)`,
    `- **Capy branch:** \`${target.branch}\` — secrets snapshot pinned by \`keep.lock\` in this commit.`,
    baseLine,
    optionsTable,
    ``,
    `## Vars pushed`,
    ``,
    varsSection,
    ``,
    `## What happens on merge`,
    ``,
    mergeSection,
    ``,
    `## Diff scope`,
    ``,
    `This PR touches at most one file: \`keep.lock\`. An empty diff means the`,
    `pinned snapshot already matched and this is a forced redeploy. Other`,
    `working-tree changes on the author's machine were not picked up.`,
    ``,
    `_Generated by \`capy deploy\`._`,
  ].join('\n');
}

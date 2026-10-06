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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename, dirname } from 'path';
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
  deployConfigToCommit,
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
  syncTrackedKeepFromWorkingCopy,
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
import type { ServiceClient } from '../service/serviceClient';
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
import { deployPlan, unansweredDeployStops, type DeployStopId } from '../core/deployPlan';
import type { DeployPlanConfirmStop } from '../ui/screens/contract';
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
   * Describe the route instead of travelling it.
   *
   * The route as a stop array, so a headless caller
   * can see which stops argv already settled and which it would be asked
   * about. Printed before any network call and before anything is decrypted,
   * because a plan you had to deploy to obtain is not a plan.
   */
  json?: boolean;
  /**
   * Write and verify the target's configuration, but skip the platform
   * deploy/redeploy (CAP-679). The user, or the platform's own auto-deploy,
   * ships it later. `targets` are still recorded — the write happened.
   */
  noDeploy?: boolean;
}

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
 * `ProjectManager.readKeepFile` applies). This is deploy's LOCAL
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
 * `syncTrackedKeepFromWorkingCopy` (deploy/git.ts), under the name direct-
 * mode deploy and its tests already use. Kept as a re-export rather than
 * inlined here so Dokploy discovery's commit step (src/git/discoveryCommit.ts)
 * can share the exact same helper instead of duplicating it — see that
 * function's own doc for why every caller that commits the tracked
 * keep.lock explicitly needs this immediately before it does.
 */
export { syncTrackedKeepFromWorkingCopy as syncTrackedKeepForDirectDeploy } from '../deploy/git';

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
 * Writes only the untracked working copy (`writeKeepFile`); it never
 * auto-commits the tracked keep.lock onto whatever branch the caller
 * happens to be on. Only `capy deploy`'s own explicit, isolated commit
 * steps (direct mode's own-branch commit, CI mode's worktree PR) ever touch
 * the tracked file.
 *
 * `transform` returning the SAME object (`===`) is treated as "nothing to
 * do" and skips the network entirely. Best-effort: errors are logged, never
 * thrown — the caller's own operation (a deploy, a remove, a revoke) already
 * succeeded or is already committed to happening by the time this runs.
 *
 * CAP-687 (validator fix-first): this used to build the pushed env blob by
 * decrypting the LOCAL `.env` and re-encrypting it fresh. That's wrong for
 * EVERY caller here, not just CI mode — none of them are value edits, so
 * NOTHING about the branch's secret values should ever be able to change as
 * a side effect of "record a target" or "revoke a token". But a local `.env`
 * can hold unpushed edits, or a variable that was never synced at all, and
 * the server's `keep_hash` only covers `name:resource_id:value_hash` — not
 * blob content — so a keep-only write that rebuilds the blob from local
 * `.env` can silently overwrite the team's stored blob under an UNCHANGED
 * hash: the next `capy` pull anyone runs decrypts the same pin to a
 * different value, with no signal anything drifted.
 *
 * Fixed by never touching local `.env` here at all. Instead: fetch the
 * server's OWN current snapshot for `branch` (`getLatestSecrets` — one read,
 * so the returned `env_file` and `keep_hash` can never disagree with each
 * other) and verify that hash against the LOCAL keep's branch entries
 * (`SyncEngine.computeKeepHash`) — `transform` only ever touches `targets`/
 * `connector` metadata, never `resource_id`/`value_hash`, so the hash is the
 * same whether computed before or after it runs. A match proves the local
 * keep's pins for this branch are exactly what's already live, so it's safe
 * to (a) push the fetched `env_file` straight through, byte-for-byte, as
 * the SAME blob already stored, and (b) build `nextKeep` off the LOCAL keep
 * (preserving every other branch's entries exactly as the local file has
 * them, same as before). A mismatch means the local keep.lock is stale for
 * this branch — skip the write with a warning rather than risk a
 * keep/blob pair the server never actually produced together.
 *
 * `opts.writeLocal` (default `true`) gates the LOCAL side effect below —
 * writing the untracked working copy. CI mode passes `false` (CAP-687): it
 * must NEVER write keep.lock to disk — CI mode must NEVER touch the user's
 * working tree (see `openCiDeployPr`'s own doc for why). Every other
 * caller keeps the default.
 *
 * `opts.warnCode` prefixes every warning this function prints with a
 * machine-readable code (Rule 4: never branch on prose, but a human reading
 * the warning still gets a stable label for it). Omitted by callers that
 * predate CAP-687, whose warning text for the branch-mismatch/auth-failure/
 * exception cases is therefore unchanged; the two NEW warning cases this fix
 * introduces (no server snapshot yet, local keep out of sync with it) are
 * new regardless, so there's no "unchanged text" to preserve for them.
 *
 * Returns `{ ok: true }` on an actual push OR a genuine no-op (`transform`
 * found nothing to change); `{ ok: false }` on ANY refusal or failure —
 * callers that minted a deploy token before calling this (CAP-687 follow-up,
 * "no untracked tokens") check `.ok` to decide whether the mint is now
 * untracked, and `capy deploy targets-remove` checks it to decide whether
 * revoking is still safe. Never throws.
 */
async function pushKeepTransform(
  cwd: string,
  branch: string,
  transform: (keep: KeepFile) => KeepFile,
  devMode: boolean | undefined,
  label: string,
  opts: { writeLocal?: boolean; warnCode?: ErrorCode } = {},
): Promise<{ ok: boolean }> {
  const writeLocal = opts.writeLocal ?? true;
  const codePrefix = opts.warnCode ? `${opts.warnCode}: ` : '';
  try {
    const pm = new ProjectManager(cwd);
    const keep = pm.readKeepFile();
    if (!keep) return { ok: false };
    const nextKeep = transform(keep);
    if (nextKeep === keep) return { ok: true };

    const fresh = await resolveFreshSnapshot(cwd, branch, devMode, `${label} in keep.lock`, opts.warnCode);
    if (!fresh) return { ok: false };

    const pushed = await fresh.serviceClient.pushSecrets(fresh.projectId, JSON.stringify(nextKeep), fresh.latest.env_file, branch);

    if (writeLocal) {
      const { SyncEngine } = await import('../sync/syncEngine');
      const fm = new FileManager(cwd);
      fm.writeKeepFile(SyncEngine.adoptServerKeep(pushed.keep_file, nextKeep, branch));
    }
    return { ok: true };
  } catch (err: any) {
    console.error(`  ${YELLOW('!')} could not ${label} in keep.lock: ${codePrefix}${err?.message ?? err}`);
    return { ok: false };
  }
}

/**
 * The freshness check shared by `pushKeepTransform` above (its own
 * pre-push gate) AND every "no untracked tokens" PRE-check below (before
 * minting a deploy token, before a direct-mode delivery, before
 * `targets-remove` strips+revokes) — CAP-687 follow-up: minting or
 * revoking against a stale local keep.lock left a fresh token, or a
 * fresh revocation, recorded nowhere. Reads local keep.lock, authenticates,
 * fetches the server's CURRENT snapshot for `branch` (`getLatestSecrets` —
 * blob and hash from the SAME read, so they can never disagree with each
 * other), and verifies that hash against the local keep's branch entries
 * (`SyncEngine.computeKeepHash`).
 *
 * On success, returns everything a caller that's about to push needs — the
 * local `KeepFile`, the server's snapshot, and an already-authenticated
 * `ServiceClient` + `projectId`, so `pushKeepTransform` doesn't authenticate
 * a second time. On ANY refusal (branch mismatch, uninitialized project, no
 * local keep.lock, auth failure, no server snapshot yet, stale hash) or a
 * thrown exception, prints ONE coded warning (via `label`/`warnCode`) and
 * returns `null`. Never throws.
 */
async function resolveFreshSnapshot(
  cwd: string,
  branch: string,
  devMode: boolean | undefined,
  label: string,
  warnCode?: ErrorCode,
): Promise<{
  keep: KeepFile;
  latest: { env_file: string; keep_hash: string; keep_file?: string };
  projectId: string;
  serviceClient: ServiceClient;
} | null> {
  const codePrefix = warnCode ? `${warnCode}: ` : '';
  try {
    const pm = new ProjectManager(cwd);
    // Never check (or later push) against a branch other than the one
    // `.env` is actually on — proceeding under the wrong branch would file
    // this write against the wrong branch entirely.
    const branchProblem = branchPushProblem(pm.deriveActiveBranch(), branch);
    if (branchProblem) {
      console.error(`  ${YELLOW('!')} could not ${label} — ${codePrefix}${describeBranchProblem(branchProblem)}`);
      return null;
    }
    const projectState = await pm.detectProjectState();
    if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) return null;
    const keep = pm.readKeepFile();
    if (!keep) return null;

    const { AuthService, silentAuthFailureMessage } = await import('../auth/authService');
    const { ServiceClient } = await import('../service/serviceClient');
    const { SyncEngine } = await import('../sync/syncEngine');

    const authService = new AuthService(undefined, devMode, projectState.userId);
    const serviceClient = new ServiceClient(undefined, devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    const authResult = await authenticateSilentWithFallback(authService, projectState.organizationId);
    if (!authResult.success || !authResult.user_id) {
      console.error(`  ${YELLOW('!')} could not ${label} — ${codePrefix}${silentAuthFailureMessage(authResult)}`);
      return null;
    }

    const latest = await serviceClient.getLatestSecrets(projectState.projectId, branch);
    if (!latest) {
      console.error(`  ${YELLOW('!')} could not ${label} — ${codePrefix}no secrets have been pushed for branch "${branch}" yet.`);
      return null;
    }
    const localHash = SyncEngine.computeKeepHash(keep, branch);
    if (latest.keep_hash !== localHash) {
      console.error(
        `  ${YELLOW('!')} could not ${label} — ${codePrefix}local keep.lock is out of sync with the server for branch "${branch}"; run \`capy\` to sync first.`,
      );
      return null;
    }
    return { keep, latest, projectId: projectState.projectId, serviceClient };
  } catch (err: any) {
    console.error(`  ${YELLOW('!')} could not ${label}: ${codePrefix}${err?.message ?? err}`);
    return null;
  }
}

/**
 * Prints the CAP-687 follow-up "untracked token" warning when a deploy
 * token was minted but `pushKeepTransform`'s own record push (the backstop
 * — a caller should already have refused BEFORE minting via
 * `resolveFreshSnapshot`, so this only fires on a race) came back
 * `{ ok: false }`. A no-op (nothing to record) or a call with no
 * `deployId` at all is silent — there is no token to lose track of.
 */
function warnIfTokenUntracked(result: { ok: boolean }, deployId: string | undefined, targetName: string): void {
  if (result.ok || !deployId) return;
  console.error(
    `  ${RED('✗')} ${ERROR_CODES.DEPLOY_TOKEN_UNTRACKED}: deploy token "${deployId}" for "${targetName}" was minted ` +
      `but could not be recorded in keep.lock — it is now UNTRACKED. Run \`capy deploy revoke ${deployId}\` to revoke it.`,
  );
}

/**
 * The delivery descriptor + delivered-values pair shared by every "record
 * this target's delivery" caller below (direct mode, CI mode, and
 * `buildFinalCiKeep`'s own PR-content version) — same shape, same
 * `noDeploy` → `deployed: false` rule (CAP-679 follow-up, "pending"; see
 * `targetsGate.ts#upsertTargetElement`'s doc for why absent/false OMITS the
 * field instead of writing `deployed: true`, and how this also clears a
 * PRIOR pending element once a real deploy follows it).
 */
function deliveryFor(
  target: TargetConfig,
  adapter: DeployAdapter,
  deployId: string | undefined,
  noDeploy: boolean,
  valueHashes: Record<string, string>,
): { delivery: TargetDeliveryDescriptor; values: readonly VarDelivery[] } {
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
  return { delivery, values };
}

/**
 * Direct-mode-only: after a verified successful deploy (or, when `noDeploy`,
 * after the config write `--no-deploy` still performs), record this
 * target's delivery into every (var, branch) entry it actually shipped.
 *
 * Best-effort: the platform write already succeeded by the time this runs,
 * so a failure here is reported but does not flip the command's exit code —
 * the deploy itself did not fail.
 *
 * CAP-687 follow-up ("no untracked tokens"): the caller is expected to have
 * already refused to mint/deliver at all when `resolveFreshSnapshot` found
 * the local keep stale (see the main flow's own pre-check, right before
 * `loadDeploySecrets`). This call is therefore the common case, and should
 * succeed — but if keep.lock drifted again in the gap between that
 * pre-check and this post-delivery record (a race, not a bug), and a token
 * WAS minted, `warnIfTokenUntracked` escalates past the generic
 * best-effort warning `pushKeepTransform` already printed.
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
  const { delivery, values } = deliveryFor(target, adapter, deployId, noDeploy, valueHashes);
  if (values.length === 0) return;
  const result = await pushKeepTransform(
    cwd,
    target.branch,
    (keep) => recordTargetDeliveries(keep, target.branch, delivery, deliveredAt, values),
    devMode,
    'record deploy targets',
  );
  warnIfTokenUntracked(result, deployId, target.name);
}

/**
 * CI-mode counterpart to `recordDeployTargets` above (CAP-687). CI mode
 * already folds this exact delivery into the PR's OWN keep.lock content
 * (`buildFinalCiKeep`'s `delivery` param) — but that PR has to be reviewed
 * and merged before it ever reaches the base branch, and `capy secrets`
 * reads the SERVER's stored keep.lock, not any open PR's. Without this, a
 * CI-mode target's delivery never shows up in `capy secrets` — the bug this
 * function fixes.
 *
 * Server-only: `pushKeepTransform`'s `writeLocal: false` means this call
 * pushes exactly like direct mode's `recordDeployTargets` (same server
 * snapshot fetch, same re-sent-unchanged blob — see `pushKeepTransform`'s
 * own doc) but never writes keep.lock to disk and never auto-commits. CI
 * mode must NEVER touch the user's working tree — see `openCiDeployPr`'s
 * own doc for why.
 *
 * Best-effort, same contract as `recordDeployTargets`: the CI delivery
 * already succeeded by the time this runs, so a failure here is warned
 * (with a coded message — `ERROR_CODES.CI_DEPLOY_TARGETS_RECORD_FAILED`)
 * and never flips the command's exit code or un-opens the PR.
 */
async function recordDeployTargetsCi(
  cwd: string,
  target: TargetConfig,
  adapter: DeployAdapter,
  valueHashes: Record<string, string>,
  deployId: string | undefined,
  devMode: boolean | undefined,
  noDeploy: boolean = false,
): Promise<void> {
  const deliveredAt = new Date().toISOString();
  const { delivery, values } = deliveryFor(target, adapter, deployId, noDeploy, valueHashes);
  if (values.length === 0) return;
  const result = await pushKeepTransform(
    cwd,
    target.branch,
    (keep) => recordTargetDeliveries(keep, target.branch, delivery, deliveredAt, values),
    devMode,
    'record deploy targets',
    { writeLocal: false, warnCode: ERROR_CODES.CI_DEPLOY_TARGETS_RECORD_FAILED },
  );
  warnIfTokenUntracked(result, deployId, target.name);
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

/**
 * The org system variable for the Dokploy URL, read through the shared resolver (CAP-703); `undefined` when it is
 * unset, cannot be read (not an admin) or there is no org. Never prompts.
 */
async function storedDokployBaseUrl(orgId: string | undefined): Promise<string | undefined> {
  if (orgId === undefined) return undefined;
  try {
    const { resolveDokployBaseUrl, realBaseUrlStoreOpener } = await import('../deploy/dokployBaseUrl');
    const resolved = await resolveDokployBaseUrl({
      dryRun: true,
      openStore: realBaseUrlStoreOpener(orgId, false),
      savedTargetUrl: () => undefined,
    });
    return resolved.ok ? resolved.baseUrl : undefined;
  } catch {
    return undefined;
  }
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
  /** The org system variable `_CONNECTOR_DOKPLOY_BASE_URL`, offered as the default when the target has no URL of its own (CAP-703). */
  storedBaseUrl?: string,
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
      default: existingOpts.baseUrl ?? storedBaseUrl,
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
      return askDokployKindAndBaseUrl(answer, existingOpts, existingKind, await storedDokployBaseUrl(orgId));
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

  const resolved = await resolve();
  await offerSaveEnteredDokployUrl(orgId, resolved.baseUrl, existingOpts.baseUrl);
  return resolved;
}

/**
 * CAP-703: the URL the person typed at the setup prompt is offered to the org (the system variable
 * `_CONNECTOR_DOKPLOY_BASE_URL`) through the shared resolver's save path: only when the variable is unset and the
 * caller is an org admin, never overwriting. A URL the target already had is not "entered", so it is left alone.
 * Never fails the setup.
 */
async function offerSaveEnteredDokployUrl(orgId: string | undefined, baseUrl: string, existingBaseUrl: string | undefined): Promise<void> {
  if (orgId === undefined || baseUrl === existingBaseUrl) return;
  try {
    const { offerSaveAskedBaseUrl, realBaseUrlStoreOpener } = await import('../deploy/dokployBaseUrl');
    await offerSaveAskedBaseUrl({ baseUrl, openStore: realBaseUrlStoreOpener(orgId, false) });
  } catch {
    // Best effort: a failed offer never fails the target setup.
  }
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

/**
 * CAP-702: what a successful push means, and nothing more — capy put the
 * values in the target's store; it does not track whether a release ran.
 * Wording approved by Vince (2026-10-04).
 */
export function pushedLine(target: TargetConfig, noDeploy: boolean): string {
  return noDeploy ? 'pushed, release not triggered' : `pushed to ${target.name}`;
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

export async function deployList(cwd: string = process.cwd()): Promise<number> {
  const targets = listTargets(cwd);

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
  opts: { devMode?: boolean; noDeploy?: boolean } = {},
): Promise<number> {
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
          const resolvedApiKey = await resolveDokployApiKeyOnce(adapter!, target, orgId, opts.devMode, interactive);
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
  //
  // CAP-687 follow-up ("no untracked tokens"): when there ARE tokens to
  // revoke, strip and revoke must happen TOGETHER — revoking first (the old
  // order) could leave tokens revoked with their keep.lock records still
  // live, if the strip afterward then silently skipped on a stale local
  // keep.lock. So: a freshness pre-check refuses BOTH up front rather than
  // discovering the mismatch mid-way, and the strip runs BEFORE revoke —
  // revoke only fires once the strip has actually landed.
  if (target) {
    const stripSucceededOrNothingToDo = !offer || offer.ok;
    const pm = new ProjectManager(cwd);
    const keep = pm.readKeepFile();
    if (keep) {
      const deployIds = deployIdsForTarget(keep, target.kind, target.name);
      const wantsRevoke = deployIds.length > 0 && stripSucceededOrNothingToDo;

      if (deployIds.length > 0 && !stripSucceededOrNothingToDo) {
        console.log(
          `  ${YELLOW('!')} keeping ${deployIds.length} deploy token(s) for "${name}" live — the platform-side ` +
            `cleanup above did not succeed, so revoking now would strand secrets it already delivered.`,
        );
      }

      if (!wantsRevoke) {
        // Nothing to revoke (or cleanup didn't succeed) — still strip the
        // records unconditionally, same as always: the LOCAL record of
        // "this target received these vars" should not survive removal
        // regardless of the platform-side outcome.
        await pushKeepTransform(
          cwd,
          target.branch,
          (k) => stripTargetsForProviderTarget(k, target.kind, target.name),
          opts.devMode,
          'strip deploy targets',
        );
      } else {
        const fresh = await resolveFreshSnapshot(cwd, target.branch, opts.devMode, 'strip deploy targets', ERROR_CODES.DEPLOY_STALE_KEEP);
        if (!fresh) {
          // Keep the target in .capy/deploy.json: removing it here would orphan
          // its keep.lock records (the strip path needs the target to find them).
          // COPY-FLAG
          console.error(`${RED('✗')} refusing to strip targets or revoke deploy token(s) for "${name}" — see the warning above. The target was kept; run \`capy\` to sync, then remove it again.`);
          return 1;
        } else {
          const stripResult = await pushKeepTransform(
            cwd,
            target.branch,
            (k) => stripTargetsForProviderTarget(k, target.kind, target.name),
            opts.devMode,
            'strip deploy targets',
          );
          if (!stripResult.ok) {
            console.error(
              `  ${YELLOW('!')} kept ${deployIds.length} deploy token(s) for "${name}" live — the keep.lock strip ` +
                `did not complete (see the warning above), so revoking them now would leave a stale record. ` +
                // COPY-FLAG
                `The target was kept; run \`capy\` to sync, then remove it again.`,
            );
            return 1;
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
      }
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
export async function ensureDeployTarget(cwd: string = process.cwd()): Promise<TargetConfig | null> {
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
    const target = await runPicker(cwd, keep);
    if (!target) return null;
    upsertTarget(cwd, target);
    console.log(GREEN(`✓ Saved target "${target.name}" to .capy/deploy.json`));
    return target;
  };

  if (existing.length === 0) return setUpNew();

  // Multiple saved targets — pick one (or set up a new one).
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

/** The terminal's own colours, off anything on its way into a payload. */
const stripAnsiText = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * The route this invocation would travel, and what is still unanswered on it.
 *
 * One builder, one array: this is what `--json` emits. `unanswered` is DERIVED
 * from the same array rather than recomputed, so the two cannot disagree.
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
    'mode' as DeployStopId,
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
 * or (only absent that) a confirm on the terminal. Declining (or nobody able
 * to ask — no TTY) leaves it false, the CLI's own default.
 */
async function resolveForceRedeploy(
  options: DeployCliOptions,
  baseBranch: string,
): Promise<boolean> {
  if (options.force) return true;
  if (options.yes) return false;
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
  options: DeployCliOptions,
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
  const force = await resolveForceRedeploy(options, baseBranch);
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
): Promise<{ ok: true; prUrl?: string } | { ok: false }> {
  try {
    const relKeep = repoRelPath(cwd, 'keep.lock');
    writeFileSync(join(wt, relKeep), deployKeepContent);
    // The PR also carries the deploy targets file, copied from the user's
    // checkout into the isolated worktree (it's never in origin/<base> yet
    // on a first deploy).
    const deployConfig = deployConfigToCommit(cwd);
    const relDeployConfig = deployConfig ? repoRelPath(cwd, deployConfig) : null;
    if (deployConfig && relDeployConfig) {
      mkdirSync(dirname(join(wt, relDeployConfig)), { recursive: true });
      copyFileSync(join(cwd, deployConfig), join(wt, relDeployConfig));
    }
    const commit = stageAndCommit(wt, relDeployConfig ? [relKeep, relDeployConfig] : [relKeep], msg);
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
      return { ok: true, prUrl: pr.url };
    }
    if (pr.manualHint) {
      console.log(`  ${YELLOW('!')} ${pr.manualHint}`);
      return { ok: true };
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
): Promise<{ ok: true } | { ok: false }> {
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
  return { ok: true };
}

// ── Target resolution steps ────────────────────────────────────────────────

/** A step either yields a value or ends the run with an exit code. */
type StepResult<T> = { ok: true; value: T } | { ok: false; code: number };

const stepOk = <T,>(value: T): StepResult<T> => ({ ok: true, value });
const stepStop = (code: number): StepResult<never> => ({ ok: false, code });

/** Runs the picker and saves what it built; cancelling ends the run with 0. */
async function buildAndSaveTarget(
  cwd: string,
  keep: KeepInfo,
  existing: TargetConfig | undefined,
  preselectedAdapterId: string | undefined,
  announceSaved: boolean,
): Promise<StepResult<TargetConfig>> {
  const built = await runPicker(cwd, keep, existing, preselectedAdapterId);
  if (!built) {
    console.log('Cancelled.');
    return stepStop(0);
  }
  upsertTarget(cwd, built);
  if (announceSaved) console.log(GREEN(`✓ Saved target "${built.name}" to .capy/deploy.json`));
  return stepOk(built);
}

/** `--target <id> --yes`: a transient target built from auto-detected defaults. */
async function adhocTarget(cwd: string, keep: KeepInfo, adapter: DeployAdapter): Promise<TargetConfig> {
  const detected = await adapter.detect(cwd);
  const cls = classify(keep.variables);
  return {
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
}

/** A saved target of this adapter's kind, or `'__new__'` to re-enter the picker. */
async function chooseSavedTarget(
  sameKind: readonly TargetConfig[],
  adapter: DeployAdapter,
): Promise<TargetConfig | '__new__'> {
  if (sameKind.length === 1) {
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
    return ans.pick === '__use__' ? sameKind[0] : '__new__';
  }
  if (sameKind.length > 1) {
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
    return ans.pick === '__new__' ? '__new__' : sameKind.find((t) => t.name === ans.pick)!;
  }
  return '__new__';
}

/** `--target <id>`: ad-hoc with `--yes`, otherwise offer saved targets of that kind first. */
async function resolveTargetById(
  cwd: string,
  keep: KeepInfo,
  targetId: string,
  options: DeployCliOptions,
): Promise<StepResult<TargetConfig>> {
  const adapter = getAdapter(targetId);
  if (!adapter) {
    console.error(
      `Unknown adapter "${targetId}". Known: ${ALL_ADAPTERS.map((a) => a.id).join(', ')}`,
    );
    return stepStop(1);
  }
  if (options.yes) return stepOk(await adhocTarget(cwd, keep, adapter));

  // Interactive but adapter is pre-chosen — handoff path from the
  // existing platform picker. If the user already saved targets for
  // this adapter, offer them first so day-2 doesn't re-fill the whole
  // picker. New target is always available as a "+ new" option.
  const sameKind = listTargets(cwd).filter((t) => t.kind === adapter.id);
  const chosen = await chooseSavedTarget(sameKind, adapter);
  if (chosen !== '__new__') return stepOk(chosen);
  return buildAndSaveTarget(cwd, keep, undefined, adapter.id, true);
}

/** No name, no `--target`: picker on first use or `--edit`, the only saved target, or a list. */
async function resolveTargetInteractively(
  cwd: string,
  keep: KeepInfo,
  options: DeployCliOptions,
): Promise<StepResult<TargetConfig>> {
  const targets = listTargets(cwd);
  if (targets.length === 0 || options.edit) {
    return buildAndSaveTarget(cwd, keep, options.edit && targets.length === 1 ? targets[0] : undefined, undefined, true);
  }
  if (targets.length === 1) return stepOk(targets[0]);

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
  if (ans.name === '__new__') return buildAndSaveTarget(cwd, keep, undefined, undefined, false);
  return stepOk(targets.find((t) => t.name === ans.name)!);
}

/** explicit name → load from config; `--target=id` → ad-hoc; else the picker. */
async function resolveTarget(
  cwd: string,
  keep: KeepInfo,
  nameArg: string | undefined,
  options: DeployCliOptions,
): Promise<StepResult<TargetConfig>> {
  if (nameArg) {
    const target = getTarget(cwd, nameArg);
    if (!target) {
      console.error(`No target named "${nameArg}". Run \`capy deploy list\`.`);
      return stepStop(1);
    }
    return stepOk(target);
  }
  if (options.target) return resolveTargetById(cwd, keep, options.target, options);
  return resolveTargetInteractively(cwd, keep, options);
}

/**
 * Heal Vercel Preview targets saved before options.gitBranch existed. The
 * old fallback scoped the Preview env to the CAPY branch name, which fails
 * at `vercel env add` with "Branch not found in the connected Git
 * repository" whenever the names don't coincide. Ask once and persist.
 */
async function healVercelGitBranch(
  cwd: string,
  target: TargetConfig,
  options: DeployCliOptions,
): Promise<StepResult<TargetConfig>> {
  const targetOpts = target.options as Record<string, unknown>;
  if (!(target.kind === 'vercel' && targetOpts.vercelEnv === 'preview' && !targetOpts.gitBranch)) {
    return stepOk(target);
  }
  if (options.yes) {
    console.error(
      `${RED('✗')} target "${target.name}" is missing options.gitBranch ` +
        `(the git branch its Vercel Preview env is wired to).`,
    );
    console.error(`\nRun \`capy deploy --edit\` once interactively to set it.`);
    return stepStop(1);
  }
  const gitBranch = await promptVercelGitBranch(cwd);
  const healed: TargetConfig = { ...target, options: { ...target.options, gitBranch } };
  upsertTarget(cwd, healed);
  console.log(
    GREEN(
      gitBranch
        ? `✓ Saved gitBranch=${gitBranch} to target "${healed.name}"`
        : `✓ Saved vercelEnv=${targetOpts.vercelEnv} to target "${healed.name}"`,
    ),
  );
  return stepOk(healed);
}

/**
 * Var-set reconcile: the saved selection can go stale when the project's
 * variables change. Re-confirm rather than silently deploying a stale set —
 * dropping a newly-added secret, or shipping a removed one.
 */
async function reconcileTargetVars(
  cwd: string,
  keep: KeepInfo,
  target: TargetConfig,
  options: DeployCliOptions,
): Promise<StepResult<TargetConfig>> {
  const branchVarSet = new Set(Object.keys(new FileManager(cwd).readEnvFile()));
  const currentVars = keep.variables.filter((v) => branchVarSet.has(v));
  // Legacy targets have no `knownVars` baseline; treat current as known so we
  // don't false-flag intentionally-unselected vars as "newly added".
  const known = target.knownVars ?? currentVars;
  const { added, removed, drifted } = reconcileVars(target.vars, known, currentVars);
  if (!drifted) return stepOk(target);

  if (added.length)
    console.log(`  ${YELLOW('!')} new project var(s) not in this target: ${B(added.join(', '))}`);
  if (removed.length)
    console.log(`  ${YELLOW('!')} target var(s) no longer in the project: ${B(removed.join(', '))}`);
  if (!options.yes && !options.dryRun && process.stdin.isTTY) {
    // Only the variable list changed, so only the variables are asked about.
    // Every other setting (adapter, branch, options, mode, name) is kept.
    const includedNew = added.length ? await pickNewVars(target, added) : [];
    const updated = applyVarDrift(target, currentVars, includedNew);
    upsertTarget(cwd, updated);
    console.log(GREEN(`✓ Updated target "${updated.name}" in .capy/deploy.json`));
    return stepOk(updated);
  }
  if (options.yes && added.length) {
    console.error(
      `${RED('✗')} the project gained variable(s) since this target was saved: ${added.join(', ')}.\n` +
        `    Re-run \`capy deploy ${target.name}\` interactively to include or skip them — refusing to silently drop a secret.`,
    );
    return stepStop(1);
  }
  if (options.yes && removed.length) {
    // Non-interactive: a removed var can't be pushed; drop it and carry on.
    return stepOk({ ...target, vars: target.vars.filter((v) => currentVars.includes(v)), knownVars: currentVars });
  }
  return stepOk(target);
}

/**
 * Confirm-or-edit loop. Single-keypress picker (c/e/d/esc) so the user can fix
 * a saved target inline instead of having to abort, run `capy deploy --edit`,
 * then re-run.
 */
async function confirmOrEdit(
  cwd: string,
  keep: KeepInfo,
  target: TargetConfig,
  adapter: DeployAdapter,
  mode: DeployMode,
  adapterCallCtx: { orgId: string | undefined; devMode: boolean | undefined; interactive: boolean; resolvedApiKey: ResolveDokployApiKeyResult | undefined },
): Promise<StepResult<TargetConfig>> {
  const summary =
    mode === 'ci'
      ? `Open a deploy PR (commit keep.lock + push secrets, no live deploy)?`
      : `Deploy now (commit keep.lock + ship from HEAD; your WIP is stashed and restored)?`;
  const action = await keypressConfirm({ message: summary });
  if (action === 'confirm') return stepOk(target);
  if (action === 'cancel') {
    console.log('Cancelled.');
    return stepStop(0);
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
    return stepStop(0);
  }
  if (action === 'edit') {
    const edited = await runPicker(cwd, keep, target);
    if (!edited) {
      console.log('Cancelled.');
      return stepStop(0);
    }
    upsertTarget(cwd, edited);
    console.log(GREEN(`✓ Saved target "${edited.name}" to .capy/deploy.json`));
    renderPlan(edited, adapter);
    // Re-run preflight after edit — paths/options may have changed.
    // Reuses the SAME resolvedApiKey from above: it was resolved once
    // for this command, and an edit here changes vars/branch/mode, never
    // the Dokploy token source.
    const recheck = await adapter.preflight(edited, { cwd, ...adapterCallCtx });
    if (!recheck.ok) {
      console.error(`${RED('✗')} preflight: ${recheck.reason}`);
      if (recheck.hint) console.error('\n' + recheck.hint);
      return stepStop(1);
    }
    // Loop back to the confirm prompt with the edited target.
    return confirmOrEdit(cwd, keep, edited, adapter, mode, adapterCallCtx);
  }
  return confirmOrEdit(cwd, keep, target, adapter, mode, adapterCallCtx);
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

  // Resolve target: explicit name → load from config; --target=id → ad-hoc;
  // else picker (or confirm-last if a single target exists and no --edit).
  const resolved = await resolveTarget(cwd, keep, nameArg, options);
  if (!resolved.ok) return resolved.code;

  const adapter = getAdapter(resolved.value.kind);
  if (!adapter) {
    console.error(`Unknown adapter "${resolved.value.kind}" in target "${resolved.value.name}".`);
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
    // stricter guard at the actual write point). A KNOWN mismatch is always refused.
    const branchProblem = activeBranch ? branchPushProblem(activeBranch, resolved.value.branch) : null;
    if (branchProblem) {
      console.error(`${RED('✗')} ${describeBranchProblem(branchProblem)}`);
      console.error(
        `\nRun \`capy checkout ${resolved.value.branch}\` first, or edit the target with \`capy deploy --edit\`.`,
      );
      return 1;
    }
  }

  // Heal Vercel Preview targets saved before options.gitBranch existed.
  const healed = await healVercelGitBranch(cwd, resolved.value, options);
  if (!healed.ok) return healed.code;

  // Var-set reconcile: the saved selection can go stale when the
  // project's variables change.
  const reconciled = await reconcileTargetVars(cwd, keep, healed.value, options);
  if (!reconciled.ok) return reconciled.code;

  renderPlan(reconciled.value, adapter);

  // CI-only adapters (Vercel) always take the CI/PR path, even if a legacy or
  // ad-hoc target carries a stale 'direct' mode — capy never runs their CLI.
  const mode: DeployMode = adapter.ciOnly ? 'ci' : (reconciled.value.mode ?? 'direct');

  // Dokploy only: resolve the org system store's API key ONCE for this whole
  // command and reuse it across preflight, the edit-loop's re-preflight, and
  // deploy — so the store is asked (and an admin prompted) at most once, no
  // matter how many of those run. `undefined` for every other adapter; they
  // never read `ctx.resolvedApiKey`. Never prompts under `--yes` or
  // `--dry-run` (a preview must never save a new key) — see
  // `dokploySecretsMayPrompt`'s own doc. Never resolves at all when the
  // target's shape is already broken — `resolveDokployApiKeyOnce` skips it,
  // and `preflight()`'s own shape check fails first regardless of any token.
  const secretsInteractive = dokploySecretsMayPrompt(
    process.stdin.isTTY === true,
    !!options.yes || !!options.dryRun,
  );
  const dokployApiKey = await resolveDokployApiKeyOnce(adapter, reconciled.value, keep.orgId, options.devMode, secretsInteractive);
  const adapterCallCtx = { orgId: keep.orgId, devMode: options.devMode, interactive: secretsInteractive, resolvedApiKey: dokployApiKey };

  // Preflight (fail BEFORE decryption). At a terminal, a failed preflight is
  // not a dead end: the user can edit the target (e.g. a wrong composeId) and
  // preflight runs again. Non-interactive runs (--yes, --dry-run, --json, no
  // TTY) refuse exactly as before.
  const canFixInteractively =
    process.stdin.isTTY === true && !options.yes && !options.dryRun && !options.json;
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
    const edited = await runPicker(cwd, keep, t);
    if (!edited) return { ok: false };
    upsertTarget(cwd, edited);
    console.log(GREEN(`✓ Saved target "${edited.name}" to .capy/deploy.json`));
    renderPlan(edited, adapter);
    return preflightOrEdit(edited);
  };
  const preflightOutcome = await preflightOrEdit(reconciled.value);
  if (!preflightOutcome.ok) return 1;
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
  const confirmed: StepResult<TargetConfig> =
    !options.yes && !options.dryRun
      ? await confirmOrEdit(cwd, keep, preflightOutcome.target, adapter, mode, adapterCallCtx)
      : { ok: true, value: preflightOutcome.target };
  if (!confirmed.ok) return confirmed.code;
  const target = confirmed.value;

  const msg = `chore(deploy): ${target.name} → ${target.branch} (${target.kind})`;
  const baseBranch = target.gitBaseBranch ?? 'main';

  // ── CI change-gate — BEFORE any mint (see resolveCiGateOutcome's own doc:
  //    deciding "did anything change" must never itself require a token, or
  //    every CI run of a token adapter mints and writes one regardless of
  //    whether anything changed). Direct mode and dry runs are never gated
  //    — `gateOutcome` stays `null` and the fallback below covers them.
  const ciGated = gitOk && mode === 'ci' && !options.dryRun;
  const gateOutcome: CiGateOutcome | null = ciGated
    ? await resolveCiGateOutcome(cwd, baseBranch, target, adapter, options)
    : null;
  if (gateOutcome?.kind === 'error') return 1;
  if (gateOutcome?.kind === 'unchanged') return 0;

  // ── "No untracked tokens" pre-check (CAP-687 follow-up) — BEFORE minting
  //    a deploy token or delivering ANYTHING. Direct mode always (it mints
  //    and/or delivers unconditionally below); CI mode only when this
  //    adapter actually mints a token (CI's own change-gate above already
  //    stops an UNCHANGED run from minting — this catches the different
  //    case: a real change, but a stale local keep.lock). Without this, a
  //    fresh token gets minted and delivered, then `recordDeployTargets`'s
  //    own post-delivery push (below) discovers the staleness and skips —
  //    leaving that live token recorded NOWHERE. See `resolveFreshSnapshot`'s
  //    own doc; `recordDeployTargets`/`recordDeployTargetsCi`'s
  //    `warnIfTokenUntracked` is the backstop for the race this can't close
  //    (keep.lock drifting again in the gap between this check and delivery).
  if (!options.dryRun && (mode === 'direct' || (mode === 'ci' && adapter.needsDeployToken))) {
    const fresh = await resolveFreshSnapshot(cwd, target.branch, options.devMode, 'deploy', ERROR_CODES.DEPLOY_STALE_KEEP);
    if (!fresh) {
      console.error(`${RED('✗')} refusing to deploy — see the warning above.`);
      return 1;
    }
  }

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
  // .capy/keep.lock — see syncTrackedKeepFromWorkingCopy, deploy/git.ts)
  // runs HERE, immediately before deciding whether keep.lock is dirty and immediately
  // before the commit itself — not any earlier in the run. Every exit
  // between an earlier sync and this point (confirm cancel/delete/
  // edit-cancel, a failed preflight recheck, a failed mint/decrypt) would
  // otherwise leave the tracked file modified and uncommitted, reintroducing
  // the exact symptom this sync exists to prevent: a teammate's next
  // `git pull` refusing with "local changes would be overwritten". Any
  // failure from here on restores keep.lock to HEAD's version before
  // returning, for the same reason.
  const directCommit = await (async (): Promise<
    | { kind: 'skip' }
    | { kind: 'committed'; stashed: boolean }
    | { kind: 'failed'; stashed: boolean }
  > => {
    if (!gitOk || mode !== 'direct') return { kind: 'skip' };
    syncTrackedKeepFromWorkingCopy(cwd);
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
    const deployConfig = deployConfigToCommit(cwd);
    const commit = stageAndCommit(cwd, deployConfig ? ['keep.lock', deployConfig] : ['keep.lock'], msg);
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
    return 1;
  }
  if (mode === 'direct') await unwindGitState(cwd, null, directStashed);
  if (!options.dryRun) console.log(`  ${GREEN('✓')} ${pushedLine(target, !!options.noDeploy)}`);

  // ── Record targets (CAP-679, CI mode CAP-687) ────────────────────────────
  // Direct mode: record against the user's own branch, same as always.
  //
  // CI mode: the PR's OWN keep.lock already carries this delivery
  // (`buildFinalCiKeep`'s `delivery` param) — but `capy secrets` reads the
  // SERVER's stored keep.lock, not an open PR, so without also recording it
  // there this target would never show up until someone thinks to inspect
  // the PR. `recordDeployTargetsCi` is server-only (`pushKeepTransform`'s
  // `writeLocal: false`): it NEVER writes local keep.lock and NEVER commits
  // — CI mode never touches the user's tree. Gated on `keepLockChanged`,
  // same as the PR-open below it: only when the CI gate actually decided to
  // proceed is there a real delivery worth recording server-side.
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
  } else if (mode === 'ci' && !options.dryRun && keepLockChanged) {
    await recordDeployTargetsCi(cwd, target, adapter, valueHashes, deployToken?.deployId, options.devMode, !!options.noDeploy);
  }

  // CI mode: open the keep.lock PR in an ISOLATED git worktree (see
  // `openCiDeployPr`). The user's working tree and current branch are NEVER
  // touched — no stash, no checkout-back, nothing to strand on failure.
  const prOutcome =
    mode === 'ci' && !options.dryRun && keepLockChanged
      ? await openCiDeployPr(cwd, baseBranch, msg, target, deployKeepContent)
      : { ok: true as const };
  if (!prOutcome.ok) return 1;

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

export function buildDeployPrBody(target: TargetConfig): string {
  const adapter = getAdapter(target.kind);
  const adapterLabel = adapter ? adapter.label : target.kind;
  const optionsTable = Object.entries(target.options)
    .map(([k, v]) => `- \`${k}\`: \`${String(v)}\``)
    .join('\n');
  const baseLine = target.gitBaseBranch
    ? `- **Git base:** \`${target.gitBaseBranch}\``
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

  // CAP-702: capy does not track releases. The values are already in the
  // vendor's store; merging records them in keep.lock and starts a release
  // only where the vendor builds on merge. Wording approved by Vince
  // (2026-10-04), verbatim from the ticket.
  const mergeSection = [
    `The new values are already in ${adapterLabel}. The next release of this branch will use them.`,
    `Merging this PR records them in keep.lock, and it starts a release if ${adapterLabel} builds on merge.`,
  ].join(' ');

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

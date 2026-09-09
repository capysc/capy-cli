/**
 * `capy setup --json` (plan) and `capy setup --json --confirm <hash>` (apply)
 * — docs/cli-setup-json.md. The onboarding-v2 caller for this command has
 * already been through Keep signup (org exists, org's master key already
 * minted) and `capy pair` (this machine is authenticated, session installed)
 * before it ever runs — so unlike `capyCommand.ts`'s `runInitialization`
 * (auth -> org picker/creation -> project picker/creation -> branch picker
 * -> encrypt consent, TTY or `--web`), this command has a MUCH smaller
 * decision tree: which project (the org's existing one, or a new one named
 * from the directory), and whether to encrypt+push the local `.env`. See
 * docs/cli-setup-json.md's "Why a new surface, not a `--json` flag on the
 * existing wizard" for the full reasoning.
 *
 * Reuses `runInitialization`'s own internals throughout (`resolveProjectKey`,
 * `FileManager`, `ServiceClient.listProjects/initializeProject/createBranch`,
 * `SyncEngine.mergeWithKeep/adoptServerKeep/computeKeepHash`,
 * `deriveResourceId`, `Encryptor`, `installGitHooks`) rather than forking the
 * push/encrypt logic into a second copy.
 *
 * NEVER opens a browser, NEVER prompts a TTY, NEVER calls `human()` (which is
 * a bare `console.log` today — see `ui/webMode.ts`'s own doc on why its
 * stderr routing is gone). Exactly one JSON document reaches stdout per
 * invocation; anything else is a bug in this file, not a rendering choice.
 */
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { installGitHooks } from '../git/installGitHooks';
import { KeyServiceOps } from '../crypto/keyResolver';
import { createGrantResolutionOps } from '../auth/deviceKey/grantResolver';
import { deriveResourceId } from '../crypto/resourceId';
import { Encryptor } from '../crypto/encryptor';
import { writeKeepCache } from '../config/globalConfig';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import { AuthResult, CapyError, ERROR_CODES, KeepFile, setSyncKeepHash } from '../types/index';
import { planCanonicalSync } from '../sync/canonicalSyncPolicy';
import type { CanonicalSyncDecision } from '../sync/canonicalSyncPolicy';
import { resolveBillingSyncAuthority } from '../sync/billingSyncAuthority';
import { resolveFreeSyncProjectKey } from '../sync/freeSyncKeyResolver';
import { resolveActiveUrl } from '../config/profileConfig';
import { SyncCommand } from './syncCommand';

export interface SetupCommandOptions {
  readonly confirm?: string;
  readonly envPath?: string;
  readonly org?: string;
  readonly project?: string;
  readonly createProject?: string;
  readonly expectedUserId?: string;
}

/** The apply command must stay inside the same environment-specific binary
 * that produced the plan. Otherwise a `capy-dev` plan hands the agent a
 * production `capy` confirm command, which reads `~/.capy` instead of the
 * paired runtime's `~/.capy-dev` session. */
export function setupConfirmCommand(binaryName: string, planHash: string, options: SetupCommandOptions = {}): string {
  const quote = (value: string): string => /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  const flags = [
    ...(options.org ? ['--org', options.org] : []),
    ...(options.project ? ['--project', options.project] : []),
    ...(options.createProject ? ['--create-project', options.createProject] : []),
    ...(options.envPath ? ['--env-path', options.envPath] : []),
  ];
  return `${binaryName} setup --json --confirm ${planHash}${flags.length ? ` ${flags.map(quote).join(' ')}` : ''}`;
}

interface OrgRef {
  readonly id: string;
  readonly name: string;
}

interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly status: 'existing' | 'new';
}

interface SetupPlanFacts {
  readonly action: 'adopt_project' | 'create_project';
  readonly org: OrgRef;
  readonly project: ProjectRef;
  readonly branch: string;
  readonly envVariableNames: readonly string[];
  readonly syncMode: 'free' | 'paid';
  readonly syncAction: CanonicalSyncDecision['action'];
  readonly remoteVariableNames: readonly string[];
  readonly environment: string;
  readonly envPath: string;
  readonly choices: Readonly<Pick<SetupCommandOptions, 'org' | 'project' | 'createProject'>>;
}

/** Immutable equivalent of Array#sort's default UTF-16 ordering. */
function sortedStrings(values: readonly string[]): readonly string[] {
  return values.reduce<readonly string[]>((sorted, value) => {
    const insertionIndex = sorted.findIndex((candidate) => candidate > value);
    return insertionIndex === -1
      ? [...sorted, value]
      : [...sorted.slice(0, insertionIndex), value, ...sorted.slice(insertionIndex)];
  }, []);
}

/** Fixed key order, written out rather than sorted generically — see docs/cli-setup-json.md's "plan_hash: what it covers". */
function canonicalPlanInput(cwd: string, plan: SetupPlanFacts): string {
  return JSON.stringify({
    v: 1,
    cwd,
    action: plan.action,
    org_id: plan.org.id,
    project_id: plan.project.status === 'existing' ? plan.project.id : null,
    project_name: plan.project.name,
    branch: plan.branch,
    env_variable_names: sortedStrings(plan.envVariableNames),
    sync_mode: plan.syncMode,
    sync_action: plan.syncAction,
    remote_variable_names: sortedStrings(plan.remoteVariableNames),
    environment: plan.environment,
    env_path: plan.envPath,
    choices: plan.choices,
  });
}

/** Deterministic, LOCAL — never a server round trip. docs/cli-setup-json.md. */
function computePlanHash(cwd: string, plan: SetupPlanFacts): string {
  return `sha256:${createHash('sha256').update(canonicalPlanInput(cwd, plan)).digest('hex')}`;
}

/** The one JSON document this process may print per invocation. */
function printResult(body: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify(body, null, 2));
}

function refuse(code: string, detail: string, extra: Readonly<Record<string, unknown>> = {}, exitCode: number = 1): void {
  printResult({ ok: false, code, detail, ...extra });
  process.exitCode = exitCode;
}

function codeOf(err: unknown): string {
  return err instanceof CapyError ? err.code : ERROR_CODES.SERVICE_ERROR;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type IdentityResolution =
  | { readonly ok: true; readonly authResult: AuthResult; readonly org: OrgRef }
  | { readonly ok: false; readonly code: string; readonly detail: string; readonly needsInput?: boolean };

/**
 * Silent-only auth, resolved to exactly one active org. Never opens a
 * browser or a TTY prompt (`AuthService.authenticateSilent` never does
 * either — see its own doc). By the time this command runs, `capy pair` has
 * already installed a session; this only re-scopes it to an org when the
 * account has exactly one and it isn't already active (the documented edge
 * case in `pairCommand.ts` where a non-interactive multi-org pairing leaves
 * `orgId` unset).
 */
async function resolveIdentity(authService: AuthService, selectedOrg?: string): Promise<IdentityResolution> {
  const first = await authService.authenticateSilent();
  if (!first.success || !first.user_id) {
    return { ok: false, code: ERROR_CODES.AUTH_FAILED, detail: first.error ?? 'no valid session on this machine — run capy pair first' };
  }

  const orgs = first.organizations ?? [];
  if (orgs.length === 0) {
    return { ok: false, code: ERROR_CODES.NO_ORGANIZATIONS, detail: 'this account belongs to no organization yet' };
  }
  if (selectedOrg) {
    const selected = orgs.find((org) => org.id === selectedOrg);
    if (!selected) return { ok: false, code: ERROR_CODES.PERMISSION_DENIED, detail: 'The selected organization is not available to this account.' };
    const scoped = await authService.authenticateSilent(selectedOrg);
    if (!scoped.success || scoped.user_id !== first.user_id || scoped.organization_id !== selectedOrg) {
      return { ok: false, code: ERROR_CODES.AUTH_FAILED, detail: 'Could not authenticate this account in the selected organization.' };
    }
    return { ok: true, authResult: scoped, org: { id: selected.id, name: selected.name } };
  }

  const active = orgs.find((o) => o.id === first.organization_id);
  if (active) {
    return { ok: true, authResult: first, org: { id: active.id, name: active.name } };
  }
  if (orgs.length > 1) {
    return {
      ok: false,
      code: ERROR_CODES.ORG_AMBIGUOUS,
      detail: `this account belongs to ${orgs.length} organizations and none is active on this session`,
      needsInput: true,
    };
  }

  const only = orgs[0]!;
  const rescoped = await authService.authenticateSilent(only.id);
  if (!rescoped.success || !rescoped.user_id) {
    return { ok: false, code: ERROR_CODES.AUTH_FAILED, detail: rescoped.error ?? 'could not scope the session to this organization' };
  }
  return { ok: true, authResult: rescoped, org: { id: only.id, name: only.name } };
}

type ProjectResolution =
  | { readonly ok: true; readonly project: { readonly id: string; readonly name: string }; readonly keep: KeepFile }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export class SetupCommand {
  private printResult(body: Readonly<Record<string, unknown>>): void {
    (this.reporter ?? printResult)(body);
  }

  private refuse(code: string, detail: string, extra: Readonly<Record<string, unknown>> = {}, exitCode = 1): void {
    if (!this.reporter) { refuse(code, detail, extra, exitCode); return; }
    this.reporter({ ok: false, code, detail, ...extra });
  }

  private readonly projectManager: ProjectManager;
  private readonly fileManager: FileManager;
  private readonly authService: AuthService;
  private readonly serviceClient: ServiceClient;
  private readonly syncEngine: SyncEngine;
  private readonly devMode: boolean;
  private readonly cliOptions: { readonly envPath?: string };

  constructor(cliOptions: { readonly envPath?: string } = {}, devMode: boolean = false, private readonly reporter?: (body: Readonly<Record<string, unknown>>) => void) {
    this.cliOptions = cliOptions;
    this.devMode = devMode;
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = new AuthService(undefined, devMode);
    this.serviceClient = new ServiceClient(undefined, devMode);
    this.syncEngine = new SyncEngine();
    this.serviceClient.setTokenProvider(() => this.authService.getValidToken());
  }

  private keyServiceOps(): KeyServiceOps {
    return {
      coDecrypt: (orgId, ciphertext) => this.serviceClient.coDecrypt(orgId, ciphertext).then((r) => r.plaintext),
      wrapOuterLayer: (orgId, plaintext) => this.serviceClient.wrapOuterLayer(orgId, plaintext).then((r) => r.ciphertext),
    };
  }

  async execute(cmdOptions: SetupCommandOptions): Promise<void> {
    if (cmdOptions.project && cmdOptions.createProject) {
      this.refuse('SETUP_CHOICES_INVALID', 'Choose either --project or --create-project, not both.');
      return;
    }
    const projectState = await this.projectManager.detectProjectState();
    if (projectState.initialized) {
      this.refuse(ERROR_CODES.SETUP_ALREADY_INITIALIZED, 'keep.lock already exists in this directory', { remedy: 'capy sync --json' });
      return;
    }

    if (cmdOptions.expectedUserId) this.authService.setSessionUserId(cmdOptions.expectedUserId);
    const identity = await resolveIdentity(this.authService, cmdOptions.org);
    if (!identity.ok) {
      this.refuse(identity.code, identity.detail, {}, identity.needsInput ? EXIT_NEEDS_INPUT : 1);
      return;
    }
    const { authResult, org } = identity;
    if (cmdOptions.expectedUserId && authResult.user_id !== cmdOptions.expectedUserId) {
      this.refuse(ERROR_CODES.PERMISSION_DENIED, 'This setup request belongs to a different signed-in account.'); return;
    }

    const existingProjects = await (async () => {
      try {
        return { ok: true as const, value: await this.serviceClient.listProjects() };
      } catch (err) {
        return { ok: false as const, err };
      }
    })();
    if (!existingProjects.ok) {
      this.refuse(codeOf(existingProjects.err), detailOf(existingProjects.err));
      return;
    }
    const projects = existingProjects.value;

    const billingOutcome = await this.serviceClient.getBillingStatus()
      .then((value) => ({ ok: true as const, value }))
      .catch((err: unknown) => ({ ok: false as const, err }));
    if (!billingOutcome.ok) {
      this.refuse(codeOf(billingOutcome.err), detailOf(billingOutcome.err));
      return;
    }
    const isFree = billingOutcome.value.tier === 'free' && !billingOutcome.value.grandfathered;

    if (isFree && (projects.length !== 1 || projects[0]?.name !== 'default')) {
      this.refuse(
        ERROR_CODES.SERVICE_ERROR,
        'free onboarding requires the server-provisioned default project; retry signup provisioning before setup',
      );
      return;
    }

    if (!isFree && (!cmdOptions.org || (!cmdOptions.project && !cmdOptions.createProject))) {
      this.refuse(
        ERROR_CODES.AMBIGUOUS_PROJECT,
        'Choose an organization and project: pass --org <id> with --project <id> or --create-project <name>.',
        { projects: projects.map((p) => ({ id: p.id, name: p.name })) },
        EXIT_NEEDS_INPUT,
      );
      return;
    }

    const selected = isFree ? projects[0] : projects.find((project) => project.id === cmdOptions.project);
    if ((isFree && (cmdOptions.createProject || (cmdOptions.project && cmdOptions.project !== selected?.id)))
      || (!isFree && cmdOptions.project && (!selected || selected.organization_id !== org.id))) {
      this.refuse('SETUP_TARGET_INVALID', 'The selected project is not an available target in this organization.');
      return;
    }
    if (cmdOptions.createProject !== undefined && !cmdOptions.createProject.trim()) {
      this.refuse('SETUP_CHOICES_INVALID', 'Provide a non-empty project name.');
      return;
    }
    const action = selected ? 'adopt_project' as const : 'create_project' as const;
    const project: ProjectRef = selected
      ? { id: selected.id, name: selected.name, status: 'existing' }
      : { id: '', name: cmdOptions.createProject!.trim(), status: 'new' };

    const branch = SyncEngine.DEFAULT_BRANCH;

    const localEnv = this.fileManager.readEnvFile(this.cliOptions.envPath);
    const envVariableNames = sortedStrings(Object.keys(localEnv));
    const authority = resolveBillingSyncAuthority(
      billingOutcome.value,
      org.id,
      { id: project.id, name: project.name, organization_id: org.id },
      branch,
    );
    const remoteObservation = project.status === 'existing'
      ? await this.serviceClient.getDecryptData(project.id, branch, undefined, true)
        .then((value) => ({ ok: true as const, value }))
        .catch((err: unknown) => ({ ok: false as const, err }))
      : { ok: true as const, value: undefined };
    if (!remoteObservation.ok) {
      this.refuse(codeOf(remoteObservation.err), detailOf(remoteObservation.err));
      return;
    }
    const remoteKeep = remoteObservation.value?.keep_file
      ? JSON.parse(remoteObservation.value.keep_file) as KeepFile
      : undefined;
    const remoteVariableNames = sortedStrings(Object.keys(remoteKeep?.variables ?? {}));
    const rootEnvExists = this.cliOptions.envPath
      ? existsSync(this.cliOptions.envPath)
      : projectState.hasEnvFile;
    const syncDecision = planCanonicalSync({
      authority,
      rootEnv: { exists: rootEnvExists, variableNames: envVariableNames },
      remote: {
        keepMarkerExists: remoteObservation.value?.keep_file !== undefined,
        variableNames: remoteVariableNames,
      },
    });

    const plan: SetupPlanFacts = {
      action,
      org,
      project,
      branch,
      envVariableNames,
      syncMode: syncDecision.mode,
      syncAction: syncDecision.action,
      remoteVariableNames,
      environment: `${this.devMode ? 'development' : 'configured'}:${resolveActiveUrl(this.devMode)}`,
      envPath: resolve(this.cliOptions.envPath ?? '.env'),
      choices: { org: cmdOptions.org, project: cmdOptions.project, createProject: cmdOptions.createProject },
    };
    const planHash = computePlanHash(process.cwd(), plan);

    if (cmdOptions.confirm === undefined) {
      this.printResult({
        ok: true,
        action,
        plan_hash: planHash,
        org,
        project,
        branch,
        sync_mode: plan.syncMode,
        sync_action: plan.syncAction,
        // Existing setup merges local entries or pulls remote; neither deletes remote entries.
        removed_remote_variable_names: [],
        keep_lock_path: plan.syncMode === 'paid' ? 'keep.lock' : null,
        env: { path: '.env', variable_count: envVariableNames.length, variable_names: envVariableNames },
        will_write: plan.syncMode === 'paid'
          ? (envVariableNames.length > 0 || remoteVariableNames.length > 0 ? ['keep.lock', '.env'] : ['keep.lock'])
          : (plan.syncAction === 'create_empty_remote_marker' || (!rootEnvExists && remoteVariableNames.length === 0) ? [] : ['.env']),
        confirm_command: setupConfirmCommand(
          this.devMode ? 'capy-dev' : process.env.CAPY_BIN_NAME || 'capy',
          planHash,
          { ...cmdOptions, envPath: this.cliOptions.envPath },
        ),
      });
      return;
    }

    if (cmdOptions.confirm !== planHash) {
      this.refuse(ERROR_CODES.PLAN_CHANGED, 'the plan has changed since it was computed — re-run capy setup --json for a fresh one');
      return;
    }

    await this.apply(plan, authResult, localEnv);
  }

  /** Resolve the plan's project into a `KeepFile` baseline ready to write — create it, or pull the existing one's current keep.json for `branch`. */
  private async resolveOrCreateProject(plan: SetupPlanFacts): Promise<ProjectResolution> {
    if (plan.project.status === 'new') {
      try {
        const created = await this.serviceClient.initializeProject(plan.project.name, plan.org.id);
        await this.serviceClient.createBranch(created.project_id, plan.branch, false);
        const keep: KeepFile = {
          version: '3.0',
          org_id: created.org_id,
          project_id: created.project_id,
          project_name: created.project_name,
          variables: {},
        };
        return { ok: true, project: { id: created.project_id, name: created.project_name }, keep };
      } catch (err) {
        return { ok: false, code: codeOf(err), detail: detailOf(err) };
      }
    }

    // Adopt: pull the existing project's current keep.json for `branch`.
    // `getDecryptData` ALREADY classifies "no secrets pushed yet" as a normal
    // empty return (no `keep_file`, no throw) rather than surfacing it as an
    // exception — see its own doc in `service/serviceClient.ts` — so there is
    // no 404/message-sniffing branch to add here; anything it DOES throw
    // (e.g. `BRANCH_NOT_FOUND` if `branch` doesn't exist on this project yet)
    // is a real, coded refusal this command should surface, not swallow.
    try {
      const decryptData = await this.serviceClient.getDecryptData(plan.project.id, plan.branch, undefined, true);
      const keep: KeepFile = decryptData.keep_file
        ? { ...(JSON.parse(decryptData.keep_file) as KeepFile), org_id: plan.org.id, project_id: plan.project.id, project_name: plan.project.name }
        : { version: '3.0', org_id: plan.org.id, project_id: plan.project.id, project_name: plan.project.name, variables: {} };
      return { ok: true, project: { id: plan.project.id, name: plan.project.name }, keep };
    } catch (err) {
      return { ok: false, code: codeOf(err), detail: detailOf(err) };
    }
  }

  private decryptsWithKey(value: string, key: string): boolean {
    try {
      this.fileManager.decryptValue(value, key);
      return true;
    } catch {
      return false;
    }
  }

  private gitAddKeepLockBestEffort(): void {
    try {
      execSync('git add keep.lock', { stdio: 'pipe' });
    } catch {
      // Not a git repo — fine
    }
  }

  /**
   * Project-key resolution for the apply path shares the same custody-source
   * precedence as free sync. A configured runtime pair is an explicit,
   * exclusive instruction to use its live grant; setup must not silently
   * fall back to older durable key material when that grant has expired.
   * Without this alignment setup could report success through disk custody
   * and the immediately following sync would correctly fail closed with
   * DEVICE_KEY_GRANT_NOT_FOUND against the stale runtime-pair record.
   */
  private async resolveEncryptionKey(orgId: string, projectId: string, userId: string): Promise<string> {
    return resolveFreeSyncProjectKey(
      orgId,
      projectId,
      userId,
      this.keyServiceOps(),
      createGrantResolutionOps(this.serviceClient, this.authService),
    );
  }

  private async apply(plan: SetupPlanFacts, authResult: AuthResult, localEnv: Readonly<Record<string, string>>): Promise<void> {
    if (plan.syncMode === 'free') {
      await this.applyFree(plan, authResult, localEnv);
      return;
    }

    const userId = authResult.user_id!;
    const branch = plan.branch;

    const resolved = await this.resolveOrCreateProject(plan);
    if (!resolved.ok) {
      this.refuse(resolved.code, resolved.detail, { env_rewritten: false, failure_stage: 'resolve_project' });
      return;
    }
    const { project, keep: baseKeep } = resolved;

    const encryptionKeyOutcome = await this.resolveEncryptionKey(plan.org.id, project.id, userId)
      .then((key) => ({ ok: true as const, key }))
      .catch((err: unknown) => ({ ok: false as const, err }));
    if (!encryptionKeyOutcome.ok) {
      this.refuse(codeOf(encryptionKeyOutcome.err), detailOf(encryptionKeyOutcome.err), { env_rewritten: false, failure_stage: 'resolve_key' });
      return;
    }
    const encryptionKey = encryptionKeyOutcome.key;

    // The project now definitely exists (created or confirmed) and this
    // machine can decrypt for it — safe to write local state.
    this.fileManager.writeKeepFile(baseKeep);
    this.projectManager.writeActiveBranch(branch);
    this.fileManager.ensureCapyGitignore();

    const varNames = Object.keys(localEnv);
    if (varNames.length === 0) {
      if (plan.remoteVariableNames.length > 0) {
        await new SyncCommand({ envPath: this.cliOptions.envPath, org: plan.org.id, project: project.id,
          expectedUserId: userId }, this.devMode, (result) => this.printResult({ ...result, action: plan.action }))
          .execute();
        this.gitAddKeepLockBestEffort();
        return;
      }
      installGitHooks(this.devMode);
      this.gitAddKeepLockBestEffort();
      this.printResult({
        ok: true,
        action: plan.action,
        org: plan.org,
        project: { id: project.id, name: project.name, status: plan.project.status },
        branch,
        keep_lock_path: 'keep.lock',
        secrets_written: 0,
        git_hooks_installed: true,
      });
      return;
    }

    // Cross-org ciphertext guard — same check and the SAME code
    // (`PERMISSION_DENIED`, with `names`-only detail) as the TTY/`--web`
    // path's equivalent guard in `capyCommand.ts`'s `runInitialization`.
    const encryptedEntries = Object.entries(localEnv).filter(([, value]) => value.startsWith('capy:'));
    const foreignKeys: readonly string[] = encryptedEntries.filter(([, value]) => !this.decryptsWithKey(value, encryptionKey)).map(([key]) => key);
    if (foreignKeys.length > 0) {
      this.refuse(ERROR_CODES.PERMISSION_DENIED, "this .env holds values encrypted with a different project's key", { names: foreignKeys, env_rewritten: false });
      return;
    }
    const resolvedLocalEnv: Record<string, string> = Object.fromEntries(
      Object.entries(localEnv).map(([key, value]) => [key, value.startsWith('capy:') ? this.fileManager.decryptValue(value, encryptionKey) : value]),
    );

    // Two phases, tracked separately (never a mutated flag) so a mid-apply
    // failure reports exactly what `InitEncryptFailure` reports for the same
    // failure class in the TTY/`--web` path: did the push reach Keep, and is
    // `.env` on disk ciphertext now.
    const built = Object.entries(resolvedLocalEnv).reduce<{
      readonly encrypted: Record<string, string>;
      readonly pushedVars: Record<string, { resource_id: string; value_hash: string }>;
    }>(
      (acc, [key, value]) => {
        const resourceId = deriveResourceId(branch, key);
        return {
          encrypted: { ...acc.encrypted, [key]: `capy:${resourceId}:${Encryptor.encrypt(value, encryptionKey)}` },
          pushedVars: {
            ...acc.pushedVars,
            [key]: { resource_id: resourceId, value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16) },
          },
        };
      },
      { encrypted: {}, pushedVars: {} },
    );
    const envBlob = Object.entries(built.encrypted)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const updatedKeep = this.syncEngine.mergeWithKeep(baseKeep, built.pushedVars, branch);

    const pushed = await (async (): Promise<{ readonly ok: true; readonly keepFile?: string } | { readonly ok: false; readonly err: unknown }> => {
      try {
        const result = await this.serviceClient.pushSecrets(project.id, JSON.stringify(updatedKeep), envBlob, branch);
        return { ok: true, keepFile: result.keep_file };
      } catch (err) {
        return { ok: false, err };
      }
    })();
    if (!pushed.ok) {
      this.refuse(codeOf(pushed.err), detailOf(pushed.err), { env_rewritten: false, pushed: false, failure_stage: 'push' });
      return;
    }

    const localWrite = await (async (): Promise<{ readonly ok: true } | { readonly ok: false; readonly err: unknown }> => {
      try {
        const adoptedKeep = SyncEngine.adoptServerKeep(pushed.keepFile, updatedKeep, branch);
        this.fileManager.writeKeepFile(adoptedKeep);

        const keepHash = SyncEngine.computeKeepHash(adoptedKeep, branch);
        writeKeepCache(plan.org.id, project.id, keepHash, envBlob);
        this.fileManager.writeSyncState({
          last_sync: new Date().toISOString(),
          synced_variables: Object.keys(resolvedLocalEnv),
          user_id: userId,
          keep_hash: setSyncKeepHash(null, branch, keepHash),
        });

        // quiet: this surface's stdout is EXACTLY one JSON document — the
        // backup notice leaked ahead of it and tripped the purity law
        // (journey run 15, 2026-08-30). The backup file itself still lands.
        this.fileManager.backupPlaintextEnv(this.cliOptions.envPath, true);
        this.fileManager.writeEncryptedEnvFile(resolvedLocalEnv, encryptionKey, this.cliOptions.envPath, adoptedKeep, branch);
        return { ok: true };
      } catch (err) {
        return { ok: false, err };
      }
    })();
    if (!localWrite.ok) {
      this.refuse(codeOf(localWrite.err), detailOf(localWrite.err), { env_rewritten: false, pushed: true });
      return;
    }

    installGitHooks(this.devMode);
    this.gitAddKeepLockBestEffort();

    this.printResult({
      ok: true,
      action: plan.action,
      org: plan.org,
      project: { id: project.id, name: project.name, status: plan.project.status },
      branch,
      keep_lock_path: 'keep.lock',
      secrets_written: varNames.length,
      git_hooks_installed: true,
    });
  }

  /**
   * Initial single-user onboarding. The remote keep is authoritative and is
   * deliberately never written to `keep.lock`; only encrypted `.env` data and
   * gitignored runtime metadata land in the working tree.
   */
  private async applyFree(
    plan: SetupPlanFacts,
    authResult: AuthResult,
    localEnv: Readonly<Record<string, string>>,
  ): Promise<void> {
    const userId = authResult.user_id!;
    const resolved = await this.resolveOrCreateProject(plan);
    if (!resolved.ok) {
      this.refuse(resolved.code, resolved.detail, { env_rewritten: false, failure_stage: 'resolve_project' });
      return;
    }

    const encryptionKeyOutcome = await this.resolveEncryptionKey(plan.org.id, resolved.project.id, userId)
      .then((key) => ({ ok: true as const, key }))
      .catch((err: unknown) => ({ ok: false as const, err }));
    if (!encryptionKeyOutcome.ok) {
      this.refuse(codeOf(encryptionKeyOutcome.err), detailOf(encryptionKeyOutcome.err), { env_rewritten: false, failure_stage: 'resolve_key' });
      return;
    }
    const encryptionKey = encryptionKeyOutcome.key;
    const projectKeep: KeepFile = {
      ...resolved.keep,
      org_id: plan.org.id,
      project_id: resolved.project.id,
      project_name: resolved.project.name,
    };

    if (plan.syncAction === 'fetch_remote') {
      const remote = await this.serviceClient.getDecryptData(resolved.project.id, plan.branch, undefined, true)
        .then((value) => ({ ok: true as const, value }))
        .catch((err: unknown) => ({ ok: false as const, err }));
      if (!remote.ok) {
        this.refuse(codeOf(remote.err), detailOf(remote.err), { env_rewritten: false });
        return;
      }
      if (!remote.value.keep_file) {
        this.refuse(ERROR_CODES.PLAN_CHANGED, 'remote state changed since this plan was computed — re-run capy setup --json');
        return;
      }

      const remoteKeep = {
        ...(JSON.parse(remote.value.keep_file) as KeepFile),
        org_id: plan.org.id,
        project_id: resolved.project.id,
        project_name: resolved.project.name,
      };
      const remotePlaintext = Object.fromEntries(
        Object.entries(this.fileManager.parseEnvContent(remote.value.env_content ?? ''))
          .flatMap(([name, value]) => {
            try {
              return [[name, this.fileManager.decryptValue(value, encryptionKey)] as const];
            } catch {
              return [];
            }
          }),
      );
      this.projectManager.writeActiveBranch(plan.branch);
      this.fileManager.ensureCapyGitignore();
      if (Object.keys(remotePlaintext).length > 0 || existsSync(this.projectManager.getEnvPath(this.cliOptions.envPath))) {
        this.fileManager.writeEncryptedEnvFile(remotePlaintext, encryptionKey, this.cliOptions.envPath, remoteKeep, plan.branch);
      }
      const keepHash = SyncEngine.computeKeepHash(remoteKeep, plan.branch);
      this.fileManager.writeSyncState({
        last_sync: new Date().toISOString(),
        synced_variables: Object.keys(remotePlaintext),
        user_id: userId,
        org_id: plan.org.id,
        project_id: resolved.project.id,
        project_name: resolved.project.name,
        sync_mode: 'free',
        keep_hash: setSyncKeepHash(null, plan.branch, keepHash),
      });
      writeKeepCache(plan.org.id, resolved.project.id, keepHash, remote.value.env_content ?? '');
      installGitHooks(this.devMode);
      this.printResult({
        ok: true,
        action: plan.action,
        sync_mode: 'free',
        sync_action: 'fetch_remote',
        org: plan.org,
        project: { id: resolved.project.id, name: resolved.project.name, status: plan.project.status },
        branch: plan.branch,
        keep_lock_path: null,
        secrets_written: Object.keys(remotePlaintext).length,
        git_hooks_installed: true,
      });
      return;
    }

    const encryptedEntries = Object.entries(localEnv).filter(([, value]) => value.startsWith('capy:'));
    const foreignKeys = encryptedEntries
      .filter(([, value]) => !this.decryptsWithKey(value, encryptionKey))
      .map(([name]) => name);
    if (foreignKeys.length > 0) {
      this.refuse(ERROR_CODES.PERMISSION_DENIED, "this .env holds values encrypted with a different project's key", { names: foreignKeys, env_rewritten: false });
      return;
    }
    const resolvedLocalEnv = plan.syncAction === 'create_empty_remote_marker'
      ? {}
      : Object.fromEntries(
          Object.entries(localEnv).map(([name, value]) => [
            name,
            value.startsWith('capy:') ? this.fileManager.decryptValue(value, encryptionKey) : value,
          ]),
        );
    const built = Object.entries(resolvedLocalEnv).reduce<{
      readonly encrypted: Readonly<Record<string, string>>;
      readonly pushedVars: Readonly<Record<string, { readonly resource_id: string; readonly value_hash: string }>>;
    }>(
      (acc, [name, value]) => {
        const resourceId = deriveResourceId(plan.branch, name);
        return {
          encrypted: { ...acc.encrypted, [name]: `capy:${resourceId}:${Encryptor.encrypt(value, encryptionKey)}` },
          pushedVars: {
            ...acc.pushedVars,
            [name]: { resource_id: resourceId, value_hash: createHash('sha256').update(value).digest('hex').slice(0, 16) },
          },
        };
      },
      { encrypted: {}, pushedVars: {} },
    );
    const envBlob = Object.entries(built.encrypted).map(([name, value]) => `${name}=${value}`).join('\n');
    const updatedKeep = this.syncEngine.mergeWithKeep(projectKeep, built.pushedVars, plan.branch);
    const pushed = await this.serviceClient.pushSecrets(
      resolved.project.id,
      JSON.stringify(updatedKeep),
      envBlob,
      plan.branch,
    ).then((value) => ({ ok: true as const, value }))
      .catch((err: unknown) => ({ ok: false as const, err }));
    if (!pushed.ok) {
      this.refuse(codeOf(pushed.err), detailOf(pushed.err), { env_rewritten: false, pushed: false, failure_stage: 'push' });
      return;
    }

    const adoptedKeep = SyncEngine.adoptServerKeep(pushed.value.keep_file, updatedKeep, plan.branch);
    const keepHash = SyncEngine.computeKeepHash(adoptedKeep, plan.branch);
    writeKeepCache(plan.org.id, resolved.project.id, keepHash, envBlob);
    this.projectManager.writeActiveBranch(plan.branch);
    this.fileManager.ensureCapyGitignore();
    this.fileManager.writeSyncState({
      last_sync: new Date().toISOString(),
      synced_variables: Object.keys(resolvedLocalEnv),
      user_id: userId,
      org_id: plan.org.id,
      project_id: resolved.project.id,
      project_name: resolved.project.name,
      sync_mode: 'free',
      keep_hash: setSyncKeepHash(null, plan.branch, keepHash),
    });
    if (plan.syncAction === 'push_root_env') {
      this.fileManager.backupPlaintextEnv(this.cliOptions.envPath, true);
      this.fileManager.writeEncryptedEnvFile(resolvedLocalEnv, encryptionKey, this.cliOptions.envPath, adoptedKeep, plan.branch);
    }
    installGitHooks(this.devMode);
    this.printResult({
      ok: true,
      action: plan.action,
      sync_mode: 'free',
      sync_action: plan.syncAction,
      org: plan.org,
      project: { id: resolved.project.id, name: resolved.project.name, status: plan.project.status },
      branch: plan.branch,
      keep_lock_path: null,
      secrets_written: Object.keys(resolvedLocalEnv).length,
      git_hooks_installed: true,
    });
  }
}

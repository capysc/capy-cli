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
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { installGitHooks } from '../git/installGitHooks';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import { deriveResourceId } from '../crypto/resourceId';
import { Encryptor } from '../crypto/encryptor';
import { writeKeepCache } from '../config/globalConfig';
import { EXIT_NEEDS_INPUT } from '../ui/interactive';
import { AuthResult, CapyError, ERROR_CODES, KeepFile, setSyncKeepHash } from '../types/index';

export interface SetupCommandOptions {
  readonly confirm?: string;
  readonly envPath?: string;
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
    env_variable_names: [...plan.envVariableNames].sort(),
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
async function resolveIdentity(authService: AuthService): Promise<IdentityResolution> {
  const first = await authService.authenticateSilent();
  if (!first.success || !first.user_id) {
    return { ok: false, code: ERROR_CODES.AUTH_FAILED, detail: first.error ?? 'no valid session on this machine — run capy pair first' };
  }

  const orgs = first.organizations ?? [];
  if (orgs.length === 0) {
    return { ok: false, code: ERROR_CODES.NO_ORGANIZATIONS, detail: 'this account belongs to no organization yet' };
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
  private readonly projectManager: ProjectManager;
  private readonly fileManager: FileManager;
  private readonly authService: AuthService;
  private readonly serviceClient: ServiceClient;
  private readonly syncEngine: SyncEngine;
  private readonly devMode: boolean;
  private readonly cliOptions: { readonly envPath?: string };

  constructor(cliOptions: { readonly envPath?: string } = {}, devMode: boolean = false) {
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
    const projectState = await this.projectManager.detectProjectState();
    if (projectState.initialized) {
      refuse(ERROR_CODES.SETUP_ALREADY_INITIALIZED, 'keep.lock already exists in this directory', { remedy: 'capy sync --json' });
      return;
    }

    const identity = await resolveIdentity(this.authService);
    if (!identity.ok) {
      refuse(identity.code, identity.detail, {}, identity.needsInput ? EXIT_NEEDS_INPUT : 1);
      return;
    }
    const { authResult, org } = identity;

    const existingProjects = await (async () => {
      try {
        return { ok: true as const, value: await this.serviceClient.listProjects() };
      } catch (err) {
        return { ok: false as const, err };
      }
    })();
    if (!existingProjects.ok) {
      refuse(codeOf(existingProjects.err), detailOf(existingProjects.err));
      return;
    }
    const projects = existingProjects.value;

    if (projects.length > 1) {
      refuse(
        ERROR_CODES.AMBIGUOUS_PROJECT,
        `this organization has ${projects.length} projects; pass --project <id> to pick one`,
        { projects: projects.map((p) => ({ id: p.id, name: p.name })) },
        EXIT_NEEDS_INPUT,
      );
      return;
    }

    const action: 'adopt_project' | 'create_project' = projects.length === 1 ? 'adopt_project' : 'create_project';
    const project: ProjectRef =
      projects.length === 1
        ? { id: projects[0]!.id, name: projects[0]!.name, status: 'existing' }
        : { id: '', name: this.projectManager.getDefaultProjectName(), status: 'new' };

    const branch = SyncEngine.DEFAULT_BRANCH;
    const localEnv = this.fileManager.readEnvFile(this.cliOptions.envPath);
    const envVariableNames = Object.keys(localEnv).sort();

    const plan: SetupPlanFacts = { action, org, project, branch, envVariableNames };
    const planHash = computePlanHash(process.cwd(), plan);

    if (cmdOptions.confirm === undefined) {
      printResult({
        ok: true,
        action,
        plan_hash: planHash,
        org,
        project,
        branch,
        keep_lock_path: 'keep.lock',
        env: { path: '.env', variable_count: envVariableNames.length, variable_names: envVariableNames },
        will_write: envVariableNames.length > 0 ? ['keep.lock', '.env'] : ['keep.lock'],
        confirm_command: `capy setup --json --confirm ${planHash}`,
      });
      return;
    }

    if (cmdOptions.confirm !== planHash) {
      refuse(ERROR_CODES.PLAN_CHANGED, 'the plan has changed since it was computed — re-run capy setup --json for a fresh one');
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

  private async apply(plan: SetupPlanFacts, authResult: AuthResult, localEnv: Readonly<Record<string, string>>): Promise<void> {
    const userId = authResult.user_id!;
    const branch = plan.branch;

    const resolved = await this.resolveOrCreateProject(plan);
    if (!resolved.ok) {
      refuse(resolved.code, resolved.detail, { env_rewritten: false });
      return;
    }
    const { project, keep: baseKeep } = resolved;

    let encryptionKey: string;
    try {
      encryptionKey = await resolveProjectKey(plan.org.id, project.id, userId, this.keyServiceOps());
    } catch (err) {
      refuse(codeOf(err), detailOf(err), { env_rewritten: false });
      return;
    }

    // The project now definitely exists (created or confirmed) and this
    // machine can decrypt for it — safe to write local state.
    this.fileManager.writeKeepFile(baseKeep);
    this.projectManager.writeActiveBranch(branch);
    this.fileManager.ensureCapyGitignore();

    const varNames = Object.keys(localEnv);
    if (varNames.length === 0) {
      installGitHooks(this.devMode);
      this.gitAddKeepLockBestEffort();
      printResult({
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
      refuse(ERROR_CODES.PERMISSION_DENIED, "this .env holds values encrypted with a different project's key", { names: foreignKeys, env_rewritten: false });
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
      refuse(codeOf(pushed.err), detailOf(pushed.err), { env_rewritten: false, pushed: false });
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

        this.fileManager.backupPlaintextEnv(this.cliOptions.envPath);
        this.fileManager.writeEncryptedEnvFile(resolvedLocalEnv, encryptionKey, this.cliOptions.envPath, adoptedKeep, branch);
        return { ok: true };
      } catch (err) {
        return { ok: false, err };
      }
    })();
    if (!localWrite.ok) {
      refuse(codeOf(localWrite.err), detailOf(localWrite.err), { env_rewritten: false, pushed: true });
      return;
    }

    installGitHooks(this.devMode);
    this.gitAddKeepLockBestEffort();

    printResult({
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
}

/**
 * The onboard flow's actuators.
 *
 * Every executor is an ADAPTER over an entry point this CLI already has. The
 * flow layer sequences them; it does not re-implement anything, and none of
 * these functions decides when it should run — that is the service's answer,
 * arriving as a validated step.
 *
 * Each returns a structured outcome, never a thrown string: `ok` with any ids
 * the step resolved (so the service can pin them and a retry cannot create a
 * second project), or `failed` with a machine-readable code from ERROR_CODES /
 * the flow's own closed outcome set. Nothing downstream parses a message.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { CapyError, ERROR_CODES, SilentAuthFailureCode } from '../../../types/index';
import { ProjectManager } from '../../../core/projectManager';
import { FileManager } from '../../../files/fileManager';
import { resolveBranchFromLocalState } from '../../../core/branchResolver';
import { FlowStep } from '../../validate';

export interface StepResult {
  outcome: 'ok' | 'failed';
  /** Machine-readable, from ERROR_CODES or the flow's closed outcome codes. Never prose. */
  code?: string;
  result?: { org_id?: string; project_id?: string; branch?: string };
}

export interface ExecutorContext {
  targetDir: string;
  envPath?: string;
  devMode: boolean;
  /** Consent was recorded on the flow instance before this step was issued. */
  consented: boolean;
  /** Render interactive stops in a browser instead of the terminal (`capy --web`'s wizard). */
  web?: boolean;
}

export type Executor = (step: FlowStep, ctx: ExecutorContext) => Promise<StepResult>;
export type ExecutorMap = Record<string, Executor>;

/** The one code this flow mints for itself: today the CLI throws it as a generic AUTH_FAILED. */
export const KEY_NOT_ON_DEVICE = 'KEY_NOT_ON_DEVICE';

/**
 * Map a thrown CapyError onto a code the service knows. Off `err.code` only —
 * never the message. An error carrying no code is a service_error, not a guess.
 */
export function codeFor(err: unknown): string {
  if (err instanceof CapyError && typeof err.code === 'string') {
    // The device-key dead end is thrown as a generic AUTH_FAILED today, with the
    // remedy in its details. Mint the specific code at the one place that knows.
    if (err.code === ERROR_CODES.AUTH_FAILED && hasRedeemRemedy(err)) return KEY_NOT_ON_DEVICE;
    return err.code;
  }
  return ERROR_CODES.SERVICE_ERROR;
}

/**
 * Why a silent auth attempt failed, as a code the service can map to a blocked
 * reason. Off `error_code` — the reason a refresh failed is not the same thing
 * as "not signed in", and answering `auth_declined` for an unreachable service
 * would send someone into a browser round-trip that cannot succeed.
 */
export function codeForSilentAuthFailure(reason: SilentAuthFailureCode | undefined): string {
  if (reason === 'network') return ERROR_CODES.NETWORK_ERROR;
  if (reason === 'server_error') return ERROR_CODES.SERVICE_ERROR;
  if (reason === 'org_not_found') return ERROR_CODES.ORG_NOT_FOUND;
  return ERROR_CODES.AUTH_FAILED;
}

/** The redeem dead end is the only AUTH_FAILED carrying an org in details. */
function hasRedeemRemedy(err: CapyError): boolean {
  return Boolean(err.details && typeof err.details === 'object' && 'needsRedeem' in (err.details as object));
}

/**
 * Run a step body. A FAILED outcome carries whatever the body managed to
 * resolve before it died — `resolved()` is read after the throw, not before,
 * because the ids a half-finished run created are exactly the ones that must be
 * pinned so a retry adopts them instead of creating a second project.
 */
async function run(
  fn: () => Promise<void>,
  resolved: () => StepResult['result'] | undefined = () => undefined,
): Promise<StepResult> {
  try {
    await fn();
    return { outcome: 'ok', result: resolved() };
  } catch (err) {
    return { outcome: 'failed', code: codeFor(err), result: resolved() };
  }
}

/**
 * `authenticate` — the CLI's own auth path, unchanged. Silent first, browser
 * only if that fails, which is why re-running it against a live session costs
 * nothing.
 */
export const authenticate: Executor = async (step, ctx) => {
  const { AuthService } = await import('../../../auth/authService');
  const auth = new AuthService(undefined, ctx.devMode);
  const orgHint = (step.params.org_hint as string | null) ?? undefined;
  const silent = await auth.authenticateSilent(orgHint);
  if (silent.success) return { outcome: 'ok', result: { org_id: silent.organization_id } };
  // Not terminal: escalate to the interactive path, exactly as the ordinary
  // `capy` run does. Only its failure ends the step, and it reports why.
  const result = await auth.authenticate(orgHint);
  if (!result.success) return { outcome: 'failed', code: codeForSilentAuthFailure(result.error_code) };
  return { outcome: 'ok', result: { org_id: result.organization_id } };
};

/**
 * `write_capy_dir` — rebuild the gitignored local cache. Branch comes from the
 * step when the instance already pinned one, otherwise from the local signals
 * the CLI's own resolver reads. No network: a branch that can only be resolved
 * against the server is left to the executor that has a session.
 */
export const writeCapyDir: Executor = async (step, ctx) => {
  const pm = new ProjectManager(ctx.targetDir);
  const fm = new FileManager(ctx.targetDir);
  const pinned = (step.params.branch as string | null) ?? null;
  const local = resolveBranchFromLocalState({
    envBranch: fm.readEnvMeta(ctx.envPath).branch,
    fileBranch: pm.readActiveBranch() ?? undefined,
  });
  const branch = pinned ?? (local.kind === 'resolved' ? local.branch : null);
  if (!branch) return { outcome: 'failed', code: ERROR_CODES.NO_ACTIVE_BRANCH };
  return run(
    async () => {
      pm.writeActiveBranch(branch);
    },
    () => ({ branch }),
  );
};

/**
 * `write_keep_lock` — both sources are existing entry points on CapyCommand.
 *  - env_header:       adopt the project the .env header already names.
 *  - select_or_create: the ordinary first-run initialization.
 *
 * Worth knowing about the second one: it runs the WHOLE existing initialization,
 * which — in a directory that already holds a plaintext .env — encrypts and
 * pushes it in the same pass. So on a fresh repo the encrypt can happen inside
 * this step, before the wrap. The single consent dialog covers both, and the
 * next observation simply reports envStillPlaintext false, so the flow still
 * converges; but "reversible before irreversible" holds only when the two are
 * separate steps (the resumed case), and nothing here should claim otherwise.
 */
export const writeKeepLock: Executor = async (step, ctx) => {
  const { CapyCommand } = await import('../../../commands/capyCommand');
  const source = step.params.source as string;
  const command = new CapyCommand({ envPath: ctx.envPath, web: ctx.web }, ctx.devMode);

  // Ids the instance already pinned. Their whole purpose is this line: a run
  // that crashed after creating the project must ADOPT it, never walk the user
  // back through a picker that can create a second one.
  const pinnedOrg = (step.params.org_id as string | null) ?? null;
  const pinnedProject = (step.params.project_id as string | null) ?? null;
  const pinnedBranch = (step.params.branch as string | null) ?? undefined;

  const adopt = async (orgId: string, projectId: string, branch?: string): Promise<StepResult> => {
    const { AuthService } = await import('../../../auth/authService');
    const auth = new AuthService(undefined, ctx.devMode);
    const session = await auth.authenticateSilent(orgId);
    if (!session.success || !session.user_id) {
      return { outcome: 'failed', code: codeForSilentAuthFailure(session.error_code) };
    }
    const userId = session.user_id;
    return run(
      () => command.bootstrapProjectForFlow({ id: projectId, name: '', organization_id: orgId }, orgId, userId),
      () => ({ org_id: orgId, project_id: projectId, branch }),
    );
  };

  if (pinnedOrg && pinnedProject) {
    return adopt(pinnedOrg, pinnedProject, pinnedBranch);
  }

  if (source === 'env_header') {
    const fm = new FileManager(ctx.targetDir);
    const meta = fm.readEnvMeta(ctx.envPath);
    if (!meta.org_id || !meta.project_id) return { outcome: 'failed', code: ERROR_CODES.NO_KEEP_FILE };
    return adopt(meta.org_id, meta.project_id, meta.branch);
  }

  if (source === 'select_or_create') {
    // The ids are reported the moment the project is chosen or created —
    // through the callback, not read off disk afterwards — so a failure between
    // that point and the keep.lock write still pins them.
    let resolved: { org_id: string; project_id: string; branch?: string } | undefined;
    const outcome = await run(
      () =>
        command.initializeProjectForFlow({
          assumeEncryptConsent: ctx.consented,
          onProjectResolved: (ids) => {
            resolved = ids;
          },
        }),
      () => {
        if (resolved) {
          const pm = new ProjectManager(ctx.targetDir);
          return { ...resolved, branch: resolved.branch ?? pm.readActiveBranch() ?? undefined };
        }
        return undefined;
      },
    );
    return outcome;
  }

  // No default branch: a source this build does not implement is a refusal.
  return { outcome: 'failed', code: ERROR_CODES.INVALID_FORMAT };
};

/**
 * `wrap_run_commands` — the plan/apply pair moved here from the agent server,
 * with its TOCTOU guard intact (the applier re-reads every file and skips one
 * that changed since planning).
 *
 * Before applying anything it rebuilds the plan and compares its hash to the
 * one the human approved. A mismatch is a refusal, not a merge: consent was
 * given for one set of edits, and applying a different set under it would make
 * the dialog a formality. The driver sends the fresh plan with its next report
 * and the human is asked again.
 */
export const wrapRunCommands: Executor = async (step, ctx) => {
  const { buildPlan } = await import('../plan');
  const { applyPlan } = await import('../apply');
  const plan = buildPlan({ targetDir: ctx.targetDir });
  const approved = step.params.plan_hash as string | undefined;
  if (approved && approved !== plan.planHash) {
    return { outcome: 'failed', code: ERROR_CODES.PLAN_CHANGED };
  }
  return run(async () => {
    applyPlan(plan);
  });
};

/**
 * `encrypt_env` — the ordinary sync path. By the time this step is issued the
 * directory has a keep.lock and a .capy/, which is exactly the state `capy`
 * treats as "sync this": it pushes the plaintext, backs it up, and rewrites
 * .env as ciphertext. No crypto is re-implemented here.
 *
 * `syncForFlow` rather than `execute`: the latter ends its catch in
 * `displayErrorAndExit`, which would take the whole driver process down instead
 * of returning a failed outcome with a code.
 */
export const encryptEnv: Executor = async (_step, ctx) => {
  const { CapyCommand } = await import('../../../commands/capyCommand');
  const command = new CapyCommand({ envPath: ctx.envPath, web: ctx.web }, ctx.devMode);
  const pm = new ProjectManager(ctx.targetDir);
  return run(
    async () => {
      if (!existsSync(join(ctx.targetDir, 'keep.lock'))) {
        throw new CapyError('keep.lock missing', ERROR_CODES.NO_KEEP_FILE);
      }
      await command.syncForFlow();
    },
    () => ({ branch: pm.readActiveBranch() ?? undefined }),
  );
};

/** The closed executor map. A verb with no entry here is never executed — the driver refuses. */
export const EXECUTORS: ExecutorMap = {
  authenticate,
  write_capy_dir: writeCapyDir,
  write_keep_lock: writeKeepLock,
  wrap_run_commands: wrapRunCommands,
  encrypt_env: encryptEnv,
};

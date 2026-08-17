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

async function run(fn: () => Promise<void>, result?: StepResult['result']): Promise<StepResult> {
  try {
    await fn();
    return { outcome: 'ok', result };
  } catch (err) {
    return { outcome: 'failed', code: codeFor(err) };
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
  return run(async () => {
    pm.writeActiveBranch(branch);
  }, { branch });
};

/**
 * `write_keep_lock` — both sources are existing entry points on CapyCommand.
 *  - env_header:       adopt the project the .env header already names.
 *  - select_or_create: the ordinary first-run initialization.
 */
export const writeKeepLock: Executor = async (step, ctx) => {
  const { CapyCommand } = await import('../../../commands/capyCommand');
  const source = step.params.source as string;
  const command = new CapyCommand({ envPath: ctx.envPath }, ctx.devMode);

  if (source === 'env_header') {
    const fm = new FileManager(ctx.targetDir);
    const meta = fm.readEnvMeta(ctx.envPath);
    if (!meta.org_id || !meta.project_id) return { outcome: 'failed', code: ERROR_CODES.NO_KEEP_FILE };
    const { AuthService } = await import('../../../auth/authService');
    const auth = new AuthService(undefined, ctx.devMode);
    const session = await auth.authenticateSilent(meta.org_id);
    if (!session.success || !session.user_id) {
      // Report WHY, not just "failed": the service maps a network failure and a
      // dead session to different blocked reasons, and only one of them is
      // fixed by signing in again.
      return { outcome: 'failed', code: codeForSilentAuthFailure(session.error_code) };
    }
    return run(
      () =>
        command.bootstrapProjectForFlow(
          { id: meta.project_id!, name: '', organization_id: meta.org_id! },
          meta.org_id!,
          session.user_id!,
        ),
      { org_id: meta.org_id, project_id: meta.project_id, branch: meta.branch },
    );
  }

  if (source === 'select_or_create') {
    const outcome = await run(() => command.initializeProjectForFlow({ assumeEncryptConsent: ctx.consented }));
    if (outcome.outcome === 'failed') return outcome;
    // Report the ids the run resolved, read back off what it WROTE rather than
    // remembered — the service pins them so a retry can never create a second
    // project.
    const pm = new ProjectManager(ctx.targetDir);
    let keep = null;
    try {
      keep = pm.readKeepFile();
    } catch {
      keep = null;
    }
    return {
      outcome: 'ok',
      result: keep
        ? { org_id: keep.org_id, project_id: keep.project_id, branch: pm.readActiveBranch() ?? undefined }
        : undefined,
    };
  }

  // No default branch: a source this build does not implement is a refusal.
  return { outcome: 'failed', code: ERROR_CODES.INVALID_FORMAT };
};

/**
 * `wrap_run_commands` — the plan/apply pair moved here from the MCP server,
 * with its TOCTOU guard intact (apply.ts re-reads every file and skips one that
 * changed since planning).
 */
export const wrapRunCommands: Executor = async (_step, ctx) => {
  const { buildPlan } = await import('../plan');
  const { applyPlan } = await import('../apply');
  return run(async () => {
    const plan = buildPlan({ targetDir: ctx.targetDir });
    applyPlan(plan);
  });
};

/**
 * `encrypt_env` — the ordinary sync path. By the time this step is issued the
 * directory has a keep.lock and a .capy/, which is exactly the state `capy`
 * treats as "sync this": it pushes the plaintext, backs it up, and rewrites
 * .env as ciphertext. No crypto is re-implemented here.
 */
export const encryptEnv: Executor = async (_step, ctx) => {
  const { CapyCommand } = await import('../../../commands/capyCommand');
  const command = new CapyCommand({ envPath: ctx.envPath }, ctx.devMode);
  const pm = new ProjectManager(ctx.targetDir);
  return run(async () => {
    if (!existsSync(join(ctx.targetDir, 'keep.lock'))) {
      throw new CapyError('keep.lock missing', ERROR_CODES.NO_KEEP_FILE);
    }
    await command.execute();
  }, { branch: pm.readActiveBranch() ?? undefined });
};

/** The closed executor map. A verb with no entry here is never executed — the driver refuses. */
export const EXECUTORS: ExecutorMap = {
  authenticate,
  write_capy_dir: writeCapyDir,
  write_keep_lock: writeKeepLock,
  wrap_run_commands: wrapRunCommands,
  encrypt_env: encryptEnv,
};

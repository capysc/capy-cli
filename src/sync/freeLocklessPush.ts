/**
 * CAP-629 — explicit push for the free, manifest-less default project.
 *
 * Billing is the only authority for entering this path. Existing paid/local
 * projects return `false` before any free-project lookup or write, leaving the
 * established manifest PushCommand byte-for-byte authoritative.
 */
import type { ProjectManager } from '../core/projectManager';
import type { FileManager } from '../files/fileManager';
import type { AuthService } from '../auth/authService';
import type { BillingStatus, ServiceClient } from '../service/serviceClient';
import { installGitHooks } from '../git/installGitHooks';
import { CapyError, ERROR_CODES, type AuthResult, type KeepFile } from '../types/index';
import {
  conflictOverwriteQuestion,
  resolveContext,
  syncResolvedSnapshot,
} from '../commands/connectors/shared';

export interface FreeLocklessPushPlan {
  readonly localVariableNames: readonly string[];
  readonly remoteVariableNames: readonly string[];
  readonly deletedRemoteVariableNames: readonly string[];
  readonly requiresDestructiveConfirmation: boolean;
}

function sorted(values: readonly string[]): readonly string[] {
  return values.reduce<readonly string[]>((ordered, value) => {
    const insertionIndex = ordered.findIndex((candidate) => candidate.localeCompare(value) > 0);
    return insertionIndex < 0
      ? [...ordered, value]
      : [...ordered.slice(0, insertionIndex), value, ...ordered.slice(insertionIndex)];
  }, []);
}

/**
 * Explicit free push replaces the remote development snapshot. The initial
 * product contract warns only when that replacement removes multiple values;
 * per-value conflict resolution remains intentionally out of scope.
 */
export function planFreeLocklessPush(
  localVariableNames: readonly string[],
  remoteVariableNames: readonly string[],
): FreeLocklessPushPlan {
  const local = new Set(localVariableNames);
  const deleted = remoteVariableNames.filter((name) => !local.has(name));
  return {
    localVariableNames: sorted(localVariableNames),
    remoteVariableNames: sorted(remoteVariableNames),
    deletedRemoteVariableNames: sorted(deleted),
    requiresDestructiveConfirmation: deleted.length > 1,
  };
}

export function selectFreeLocklessPushMode(input: {
  readonly localOnly: boolean;
  readonly billing: BillingStatus;
}): 'local_only' | 'paid_manifest' | 'free_lockless' {
  if (input.localOnly) return 'local_only';
  return input.billing.tier === 'free' && !input.billing.grandfathered
    ? 'free_lockless'
    : 'paid_manifest';
}

type ProjectManagerDependency = Pick<ProjectManager, 'readSyncState'>;
type FileManagerDependency = Pick<
  FileManager,
  'readEnvMeta' | 'readEnvFile'
>;
type AuthServiceDependency = Pick<AuthService, 'setSessionUserId' | 'authenticateSilent' | 'getValidToken'>;
type ServiceClientDependency = Pick<ServiceClient, 'getBillingStatus'>;

export interface FreeLocklessPushDependencies {
  readonly projectManager: ProjectManagerDependency;
  readonly fileManager: FileManagerDependency;
  readonly authService: AuthServiceDependency;
  readonly serviceClient: ServiceClientDependency;
  readonly devMode: boolean;
  readonly localOnly: boolean;
  readonly confirmDestructivePush?: (plan: FreeLocklessPushPlan) => Promise<boolean>;
  readonly confirmConcurrentOverwrite?: (varNames: string[], contextLines: string[]) => Promise<boolean>;
  readonly resolveContext?: typeof resolveContext;
  readonly syncSnapshot?: typeof syncResolvedSnapshot;
  readonly installHooks?: typeof installGitHooks;
  readonly report?: (message: string) => void;
}

export type FreeLocklessPushDispatch =
  | { readonly handled: true }
  | { readonly handled: false; readonly authResult?: AuthResult };

async function defaultDestructiveConfirmation(plan: FreeLocklessPushPlan): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const inquirer = (await import('inquirer')).default;
  const names = plan.deletedRemoteVariableNames.join(', ');
  const answer = await inquirer.prompt<{ readonly ok: boolean }>([
    {
      type: 'confirm',
      name: 'ok',
      message: `This push will delete ${plan.deletedRemoteVariableNames.length} remote values (${names}). Continue?`,
      default: false,
    },
  ]);
  return answer.ok;
}

async function defaultConcurrentOverwriteConfirmation(
  varNames: string[],
  contextLines: string[],
): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  for (const line of contextLines) console.log(line);
  const inquirer = (await import('inquirer')).default;
  const answer = await inquirer.prompt<{ readonly ok: boolean }>([
    {
      type: 'confirm',
      name: 'ok',
      message: conflictOverwriteQuestion(varNames),
      default: false,
    },
  ]);
  return answer.ok;
}

function branchVariableNames(keep: KeepFile, branch: string): readonly string[] {
  return Object.entries(keep.variables)
    .filter(([, entries]) => entries.some((entry) => entry.branch === branch))
    .map(([name]) => name);
}

/**
 * Attempt the free lockless push. `false` means the caller must continue into
 * the existing paid/local manifest command; `true` means this function fully
 * handled the free push. No local keep.lock is ever read or written here.
 */
export async function tryFreeLocklessPush(deps: FreeLocklessPushDependencies): Promise<FreeLocklessPushDispatch> {
  if (deps.localOnly) return { handled: false };

  const syncState = deps.projectManager.readSyncState();
  const envMeta = deps.fileManager.readEnvMeta();
  const orgHint = syncState?.org_id ?? envMeta.org_id;
  if (syncState?.user_id) deps.authService.setSessionUserId(syncState.user_id);
  const auth = await deps.authService.authenticateSilent(orgHint);
  if (!auth.success || !auth.user_id) {
    throw new CapyError(auth.error ?? 'No valid session on this machine.', ERROR_CODES.AUTH_FAILED);
  }

  const billing = await deps.serviceClient.getBillingStatus();
  if (selectFreeLocklessPushMode({ localOnly: false, billing }) !== 'free_lockless') {
    return { handled: false, authResult: auth };
  }

  const ctx = await (deps.resolveContext ?? resolveContext)({
    devMode: deps.devMode,
    forceLockless: true,
    authService: deps.authService as AuthService,
    serviceClient: deps.serviceClient as ServiceClient,
    authResult: auth,
  });
  if (!ctx.lockless) {
    throw new CapyError('Free billing must resolve through the lockless sync corpus.', ERROR_CODES.SYNC_CONFLICT);
  }
  if (!ctx.remoteKeepExists) {
    throw new CapyError(
      'The free default project has not completed its first sync. Run capy setup --json.',
      ERROR_CODES.SYNC_NOT_INITIALIZED,
    );
  }
  const localRaw = deps.fileManager.readEnvFile();
  const plan = planFreeLocklessPush(Object.keys(localRaw), branchVariableNames(ctx.keep, ctx.branch));
  if (plan.requiresDestructiveConfirmation) {
    const confirmed = await (deps.confirmDestructivePush ?? defaultDestructiveConfirmation)(plan);
    if (!confirmed) {
      throw new CapyError(
        `Push aborted: it would delete ${plan.deletedRemoteVariableNames.length} remote values.`,
        ERROR_CODES.SYNC_CONFLICT,
        { names: plan.deletedRemoteVariableNames },
      );
    }
  }

  const localEntries = Object.entries(localRaw).map(([name, value]) => {
    if (!value.startsWith('capy:')) return { ok: true as const, name, value };
    try {
      return { ok: true as const, name, value: ctx.fileManager.decryptValue(value, ctx.projectKey) };
    } catch {
      return { ok: false as const, name };
    }
  });
  const foreignNames = localEntries.filter((entry) => !entry.ok).map((entry) => entry.name);
  if (foreignNames.length > 0) {
    throw new CapyError(
      "This .env holds values encrypted with a different project's key.",
      ERROR_CODES.PERMISSION_DENIED,
      { names: foreignNames },
    );
  }
  const localPlaintext = Object.fromEntries(
    localEntries.flatMap((entry) => entry.ok ? [[entry.name, entry.value] as const] : []),
  );
  await (deps.syncSnapshot ?? syncResolvedSnapshot)(ctx, localPlaintext, {
    primaryVarNames: [...new Set([...plan.localVariableNames, ...plan.deletedRemoteVariableNames])],
    confirmOverwrite: deps.confirmConcurrentOverwrite ?? defaultConcurrentOverwriteConfirmation,
    beforeLocalWrite: () => {
      ctx.pm.writeActiveBranch(ctx.branch);
      ctx.fileManager.ensureCapyGitignore();
      ctx.fileManager.backupPlaintextEnv(undefined, true);
    },
  });
  (deps.installHooks ?? installGitHooks)(deps.devMode);
  (deps.report ?? console.log)(
    `Pushed ${Object.keys(localPlaintext).length} secret(s) to Keep${plan.deletedRemoteVariableNames.length > 0
      ? `; deleted ${plan.deletedRemoteVariableNames.length} remote value(s)`
      : ''}.`,
  );
  return { handled: true };
}

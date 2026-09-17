import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { FileManager } from '../files/fileManager';
import { ProjectManager } from '../core/projectManager';
import { isReservedRuntimeVar, stripReservedRuntimeVars } from '../core/reservedVars';
import { isLocalOnly } from '../config/profileConfig';
import { CapyError, ERROR_CODES, type KeepFile } from '../types/index';
import { requireListIdentity, type ListMetadataDependencies } from './listMetadata';
import { resolveStatusProjectKey } from './statusKey';

/** Accidental disclosure guard, not a sandbox for arbitrary programs or repository scripts. */
export function requireHostedRunArguments(args: readonly string[]): void {
  const executable = basename((args[0] ?? '').replaceAll('\\', '/')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const dumpers = ['env', 'printenv', 'set', 'export', 'declare', 'typeset'];
  const shells = ['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'cmd', 'powershell', 'pwsh'];
  const evaluator = ['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl', 'php'];
  if (args.length === 0 || args.some((arg) => arg.includes('\0')) || dumpers.includes(executable) || shells.includes(executable)
    || evaluator.includes(executable) && args.slice(1).some((arg) => /^-[cep]|^--(?:eval|print)(?:=|$)|^eval$/.test(arg))) {
    throw new CapyError('Run the application or its repository script, not an environment dump or inline shell/evaluator.', ERROR_CODES.PERMISSION_DENIED);
  }
}

export interface HostedRunDependencies extends ListMetadataDependencies {
  readonly keep: () => KeepFile | null;
  readonly branch: () => string | null;
  readonly env: () => Readonly<Record<string, string>>;
  readonly envIdentity: () => { readonly org_id?: string; readonly project_id?: string; readonly branch?: string };
  readonly encrypted: (value: string) => boolean;
  readonly key: (orgId: string, projectId: string, userId: string) => Promise<string>;
  readonly decrypt: (value: string, key: string) => string;
  readonly spawn: (args: readonly string[], env: Readonly<Record<string, string | undefined>>) => Promise<number>;
}

/** Hosted invocation: exact caller, authoritative binding, existing key only, never a ceremony. */
export async function executeHostedRun(args: readonly string[], userId: string, deps: HostedRunDependencies,
  inherited: Readonly<Record<string, string | undefined>>): Promise<number> {
  requireHostedRunArguments(args);
  if (!/^user_[A-Za-z0-9_]{1,120}$/.test(userId)) throw new CapyError('A valid connected account is required.', ERROR_CODES.AUTH_FAILED);
  const localKeep = deps.keep();
  if (!localKeep) throw new CapyError('Complete explicit Keep setup before running.', ERROR_CODES.SYNC_NOT_INITIALIZED);
  const binding = { keep: localKeep, branch: deps.branch() };
  const { org_id: orgId, project_id: projectId } = binding.keep;
  if (!orgId || !projectId || !binding.branch) throw new CapyError('Complete project and branch setup before running.', ERROR_CODES.SYNC_NOT_INITIALIZED);
  await requireListIdentity(deps, userId, orgId);
  if (localKeep && !(await deps.projects()).some((project) => project.id === projectId && project.organization_id === orgId))
    throw new CapyError('This project is not available to the connected account.', ERROR_CODES.PERMISSION_DENIED);
  const env = Object.fromEntries(Object.entries(deps.env()).filter(([name]) => !isReservedRuntimeVar(name)));
  if (Object.values(env).some((value) => value.startsWith('capy:') && !deps.encrypted(value)))
    throw new CapyError('An encrypted value is malformed. Sync this repository first.', ERROR_CODES.DECRYPT_KEY_MISMATCH);
  const encrypted = Object.entries(env).filter(([, value]) => deps.encrypted(value));
  const identity = deps.envIdentity();
  if (encrypted.length > 0 && (identity.org_id !== orgId || identity.project_id !== projectId || identity.branch !== binding.branch)) {
    throw new CapyError('The local encrypted file belongs to another project. Sync this repository first.', ERROR_CODES.PERMISSION_DENIED);
  }
  if (!localKeep && encrypted.length === 0 && (Object.keys(env).length > 0 || Object.keys(binding.keep.variables).length > 0))
    throw new CapyError('Sync this repository before running with Capy.', ERROR_CODES.SYNC_NOT_INITIALIZED);
  const key = encrypted.length > 0 ? await deps.key(orgId, projectId, userId) : null;
  const decrypted = key === null ? {} : Object.fromEntries(encrypted.map(([name, value]) => [name, deps.decrypt(value, key)]));
  return deps.spawn(args, stripReservedRuntimeVars({ ...env, ...inherited, ...decrypted }));
}

async function spawnHosted(args: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const child = spawn(args[0]!, args.slice(1), { env, stdio: 'inherit', shell: false });
  const signals = (['SIGTERM', 'SIGINT', 'SIGHUP'] as const).map((signal) => ({ signal, forward: () => { child.kill(signal); } }));
  for (const { signal, forward } of signals) process.on(signal, forward);
  try { return await new Promise<number>((resolve) => { child.once('error', () => resolve(1)); child.once('close', (code) => resolve(code ?? 1)); }); }
  finally { for (const { signal, forward } of signals) process.off(signal, forward); }
}

export async function runHostedCommand(args: readonly string[], userId: string, devMode = false): Promise<number> {
  try {
    requireHostedRunArguments(args);
    if (!/^user_[A-Za-z0-9_]{1,120}$/.test(userId)) throw new CapyError('A valid connected account is required.', ERROR_CODES.AUTH_FAILED);
    if (isLocalOnly()) throw new CapyError('Hosted execution requires a connected account.', ERROR_CODES.AUTH_FAILED);
    const auth = new AuthService(undefined, devMode, userId);
    const service = new ServiceClient(undefined, devMode);
    service.setTokenProvider(() => auth.getValidToken());
    const project = new ProjectManager();
    const file = new FileManager();
    return await executeHostedRun(args, userId, {
      authenticate: (orgId) => auth.authenticateSilent(orgId), billing: () => service.getBillingStatus(),
      projects: () => service.listProjects(), snapshot: (projectId, branch) => service.getDecryptData(projectId, branch),
      keep: () => project.readKeepFile(), branch: () => project.deriveActiveBranch(),
      env: () => file.readEnvFile(), envIdentity: () => file.readEnvMeta(), encrypted: (value) => file.isEncrypted(value),
      key: (orgId, projectId, expected) => resolveStatusProjectKey(orgId, projectId, expected, service, auth),
      decrypt: (value, key) => file.decryptValue(value, key), spawn: spawnHosted,
    }, process.env);
  } catch (error: unknown) {
    console.error(JSON.stringify({ ok: false, code: error instanceof CapyError ? error.code : ERROR_CODES.SERVICE_ERROR,
      message: 'Could not run with Capy. Check the command, connected account, repository sync, and existing device access; no application was started.' }));
    return 1;
  }
}

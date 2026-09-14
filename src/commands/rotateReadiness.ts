import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSyncKeepHash, type KeepFile, type SessionStore, type SyncState } from '../types';
import { ProjectManager } from '../core/projectManager';
import { FileSessionStorageBackend } from '../auth/session/fileBackend';
import { resolveActiveUrl } from '../config/profileConfig';
import { getLocalRootMode, readLocalRoot, readMasterKey } from '../config/globalConfig';
import { decryptMasterKey, masterKeyAAD } from '../crypto/keyManager';
import { deriveLocalInnerKey } from '../crypto/localKeyRoot';
import { deployConfigPath } from '../deploy/config';
import { getAdapter } from '../deploy/registry';
import type { TargetConfig } from '../deploy/adapter';
import { WORKOS_CLI_MISSING } from './connectors/workos';

export type RotatePrerequisite = Readonly<{ code: string; ready: boolean; detail: string; remedy?: string; url?: string }>;
export type RotateReadiness = Readonly<{
  v: 1; command: 'rotate'; ready: boolean; checks: readonly RotatePrerequisite[];
  deploymentChoices: readonly Readonly<{ name: string; kind: string }>[];
}>;
export type RotateReadinessOptions = Readonly<{
  cwd?: string; noPush?: boolean; deployTarget?: string; deployKind?: string; devMode?: boolean; expectedUserId?: string;
}>;
export type RotateReadinessProbes = Readonly<{
  repository: () => Promise<RotatePrerequisite>;
  capy: () => Promise<readonly RotatePrerequisite[]>;
  workos: () => Promise<readonly RotatePrerequisite[]>;
  deployment: () => Promise<Readonly<{ checks: readonly RotatePrerequisite[]; choices: RotateReadiness['deploymentChoices'] }>>;
}>;

/** No executor, browser or broker participates in inspection. Only statuses escape. */
export async function inspectRotateReadiness(probes: RotateReadinessProbes): Promise<RotateReadiness> {
  const repository = await probes.repository();
  const capy = repository.ready ? await probes.capy() : [];
  const workos = await probes.workos();
  const deployment = await probes.deployment();
  const checks = [repository, ...capy, ...workos, ...deployment.checks];
  return { v: 1, command: 'rotate', ready: checks.every(check => check.ready), checks, deploymentChoices: deployment.choices };
}
const check = (code: string, ready: boolean, detail: string, remedy?: string, url?: string): RotatePrerequisite =>
  ({ code, ready, detail, ...(remedy ? { remedy } : {}), ...(url ? { url } : {}) });
export type ReadinessCommand = (binary: string, args: readonly string[], cwd: string) => Readonly<{ status: number | null; stdout: string }>;
const runReadinessCommand: ReadinessCommand = (binary, args, cwd) => {
  const result = spawnSync(binary, [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    env: { ...process.env, CI: '1', WORKOS_MODE: 'agent', WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' } });
  return { status: result.status, stdout: result.stdout ?? '' };
};
const object = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
const jsonPost = async (url: string, token: string, body: Readonly<Record<string, unknown>>): Promise<unknown> => {
  const response = await fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('READINESS_ACCESS_UNAVAILABLE');
  return response.json();
};
/** Unlike readDeployConfig, this never repairs .gitignore. */
export function readRotateDeploymentTargets(cwd: string): readonly TargetConfig[] {
  try {
    const config = object(JSON.parse(readFileSync(deployConfigPath(cwd), 'utf8')));
    if (config?.version !== '1' || !object(config.targets)) throw new Error('ROTATE_DEPLOY_CONFIG_INVALID');
    return Object.values(config.targets as Readonly<Record<string, TargetConfig>>);
  } catch (error) {
    if (object(error)?.code === 'ENOENT') return [];
    throw new Error('ROTATE_DEPLOY_CONFIG_INVALID');
  }
}
const deploymentTools: Readonly<Record<string, Readonly<{ binary: string; args: readonly string[]; remedy: string }>>> = {
  'cf-worker': { binary: 'wrangler', args: ['whoami', '--json'], remedy: 'Install wrangler, then run wrangler login.' },
  'cf-pages': { binary: 'wrangler', args: ['whoami', '--json'], remedy: 'Install wrangler, then run wrangler login.' },
  vercel: { binary: 'vercel', args: ['whoami'], remedy: 'Install vercel, then run vercel login.' },
  'aws-ssm': { binary: 'aws', args: ['sts', 'get-caller-identity'], remedy: 'Install AWS CLI, then run aws configure or aws sso login.' },
};
export type WranglerFreshnessOptions = Readonly<{ home?: string; platform?: NodeJS.Platform; environment?: Readonly<NodeJS.ProcessEnv>; now?: number }>;
/** Read expiry only; never launch Wrangler if its OAuth request could rotate a refresh token.
 * Default file locations/refresh condition match Wrangler's getGlobalWranglerConfigPath,
 * getAuthConfigFilePath and isRefreshNeeded. Opaque/new storage formats fail explicitly.
 */
export function wranglerCanInspectWithoutRefresh(options: WranglerFreshnessOptions = {}): boolean {
  const env = options.environment ?? process.env;
  if (env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || ((env.CLOUDFLARE_API_KEY || env.CF_API_KEY) && (env.CLOUDFLARE_EMAIL || env.CF_EMAIL))) return true;
  try {
    const home = options.home ?? homedir();
    const platform = options.platform ?? process.platform;
    const legacy = join(home, '.wrangler');
    const legacyExists = (() => { try { return statSync(legacy).isDirectory(); } catch { return false; } })();
    const base = env.XDG_CONFIG_HOME ?? (platform === 'darwin' ? join(home, 'Library', 'Preferences')
      : platform === 'win32' ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'xdg.config') : join(home, '.config'));
    const apiEnvironment = env.WRANGLER_API_ENVIRONMENT ?? 'production';
    if (apiEnvironment !== 'production' && apiEnvironment !== 'staging') return false;
    const directory = join(legacyExists ? legacy : join(base, '.wrangler'), 'config');
    const profile = apiEnvironment === 'production' ? 'default' : 'staging';
    const encrypted = (() => { try { return statSync(join(directory, `${profile}.enc`)).isFile(); } catch { return false; } })();
    if (encrypted) return false;
    const source = readFileSync(join(directory, `${profile}.toml`), 'utf8');
    // Accept one unambiguous top-level expiry, without parsing or returning token values.
    const topLevel = source.split(/^\s*\[/m)[0];
    const expiries = [...topLevel.matchAll(/^\s*expiration_time\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/gm)];
    return expiries.length === 1 && Date.parse(expiries[0][1]) > (options.now ?? Date.now()) + 60_000;
  } catch { return false; }
}
export type DeploymentProbeDependencies = Readonly<{ command?: ReadinessCommand; wranglerFresh?: () => boolean }>;
export async function inspectRotateDeployment(opts: RotateReadinessOptions, dependencies: DeploymentProbeDependencies = {}): Promise<Readonly<{
  checks: readonly RotatePrerequisite[]; choices: RotateReadiness['deploymentChoices'];
}>> {
  if (opts.noPush) return { checks: [], choices: [] };
  const cwd = opts.cwd ?? process.cwd();
  const targets = readRotateDeploymentTargets(cwd);
  const choices = targets.map(({ name, kind }) => ({ name, kind }));
  const selected = opts.deployTarget ? targets.find(target => target.name === opts.deployTarget)
    : targets.length === 1 ? targets[0] : undefined;
  if (opts.deployTarget && !selected) return { choices, checks: [check('ROTATE_DEPLOYMENT_TARGET_UNKNOWN', false,
    'That deployment target is not configured.', 'Select a listed target and recheck.')] };
  if (targets.length === 0 && !opts.deployTarget && !opts.deployKind) return { choices, checks: [] };
  const kind = selected?.kind ?? opts.deployKind;
  if (!kind) return { choices, checks: [check('ROTATE_DEPLOYMENT_SELECTION_REQUIRED', false,
    'Choose the intended deployment target or destination so its CLI can be checked before opening Rotate.',
    'Recheck with --deploy-target <name> or --deploy-kind <adapter>.')] };
  const adapter = getAdapter(kind);
  const tool = deploymentTools[kind];
  if (!adapter || !tool) return { choices, checks: [check('ROTATE_DEPLOYMENT_UNSUPPORTED', false,
    'This build cannot inspect that deployment destination.', 'Choose an implemented CLI deployment adapter.')] };
  if (opts.devMode && selected && tool.binary !== 'vercel' && (selected.mode ?? 'direct') !== 'ci') return { choices, checks: [] };
  const command = dependencies.command ?? runReadinessCommand;
  const installed = command(tool.binary, ['--version'], cwd).status === 0;
  // Provider authentication belongs inside the interaction, not before Flow creation.
  if (tool.binary === 'vercel') return { choices, checks: [
    check('ROTATE_DEPLOYMENT_CLI', installed, 'vercel installation', 'Install vercel.'),
  ] };
  const safeToInspect = tool.binary !== 'wrangler' || (dependencies.wranglerFresh ?? wranglerCanInspectWithoutRefresh)();
  if (installed && !safeToInspect) return { choices, checks: [
    check('ROTATE_DEPLOYMENT_CLI', true, 'wrangler installation'),
    check('ROTATE_DEPLOYMENT_AUTH_INSPECTION_UNAVAILABLE', false,
      'Wrangler OAuth freshness could not be verified without risking a session refresh. This does not establish that you are signed out.',
      'Run wrangler whoami --json in your host shell. Recheck after renewing an expired session; encrypted or custom credential stores need a supported read-only probe.'),
  ] };
  const auth = installed ? command(tool.binary, tool.args, cwd) : null;
  const authenticated = auth?.status === 0 && (tool.binary !== 'wrangler' || (() => {
    try { return object(JSON.parse(auth.stdout))?.loggedIn === true; } catch { return false; }
  })());
  const ci = selected?.mode === 'ci' || adapter.ciOnly === true;
  const github = !ci || command('gh', ['auth', 'status'], cwd).status === 0;
  return { choices, checks: [
    check('ROTATE_DEPLOYMENT_CLI', installed, `${tool.binary} installation`, tool.remedy),
    check('ROTATE_DEPLOYMENT_AUTH', authenticated, `${tool.binary} authentication`, tool.remedy),
    ...(ci ? [check('ROTATE_DEPLOYMENT_GITHUB_AUTH', github, 'GitHub authentication for the deployment PR.', 'Install gh, then run gh auth login.')] : []),
  ] };
}
export type CapyReadinessContext = Readonly<{ orgId: string; projectId: string; branch: string; userHint?: string }>;
export type CapyProbeDependencies = Readonly<{
  loadSession: (hint?: string) => Pick<SessionStore, 'user_id' | 'sessions'> | null;
  assertAuthority: (userId: string) => void;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  verifyCustody: (orgId: string, userId: string, token: string, api: string) => Promise<void>;
  now: () => number;
}>;
const capyDependencies: CapyProbeDependencies = {
  loadSession: hint => { const backend = new FileSessionStorageBackend(); return hint ? backend.load(hint) : backend.discover()?.session ?? null; },
  assertAuthority: userId => new FileSessionStorageBackend().assertRefreshAuthorityAvailable?.(userId),
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  verifyCustody: async (orgId, userId, token, api) => {
    const root = getLocalRootMode(orgId, userId) === 'file' ? readLocalRoot(orgId, userId) : null;
    const wrapped = readMasterKey(orgId, userId);
    if (!root || !wrapped) throw new Error('ROTATE_CAPY_CUSTODY');
    const inner = object(await jsonPost(`${api}/orgs/${encodeURIComponent(orgId)}/co-decrypt`, token, { ciphertext: wrapped }));
    if (typeof inner?.plaintext !== 'string') throw new Error('ROTATE_CAPY_CUSTODY');
    decryptMasterKey(inner.plaintext, deriveLocalInnerKey(root), masterKeyAAD(userId, orgId));
  },
};
export async function inspectRotateCapy(context: CapyReadinessContext, opts: RotateReadinessOptions = {}, dependencies: CapyProbeDependencies = capyDependencies): Promise<readonly RotatePrerequisite[]> {
  try {
    const session = dependencies.loadSession(context.userHint);
    if (session?.user_id && opts.expectedUserId !== undefined && session.user_id !== opts.expectedUserId)
      return [check('ROTATE_CAPY_IDENTITY_MISMATCH', false, 'The CLI account does not match the account requesting this rotation.', 'Use the CLI paired to the requesting account, then recheck.')];
    const token = session?.sessions[context.orgId];
    if (!session?.user_id || !token?.access_token || !Number.isFinite(token.expires_at) || token.expires_at <= dependencies.now() + 60_000)
      return [check('ROTATE_CAPY_AUTH', false, 'Capy needs a current authenticated session.', 'Run this Capy installation to sign in, then recheck.')];
    dependencies.assertAuthority(session.user_id);
    const api = resolveActiveUrl(opts.devMode ?? false);
    const response = await dependencies.fetch(`${api}/projects/${encodeURIComponent(context.projectId)}/branches`, {
      headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15_000),
    });
    const body = object(await response.json());
    const branches = Array.isArray(body?.branches) ? body.branches : [];
    if (!response.ok || !branches.some(value => object(value)?.name === context.branch))
      return [check('ROTATE_CAPY_ACCESS', false, 'The current Capy session cannot access this project branch.', 'Sign in to the project account with this Capy installation, then recheck.')];
    await dependencies.verifyCustody(context.orgId, session.user_id, token.access_token, api);
    return [check('ROTATE_CAPY_AUTH', true, 'Capy is authenticated for this project branch.'), check('ROTATE_CAPY_CUSTODY', true, 'Existing device key custody is usable.')];
  } catch {
    return [check('ROTATE_CAPY_READINESS_UNAVAILABLE', false, 'Capy could not verify authentication, project access and existing device key custody.', 'Run this Capy installation to restore access, then recheck.')];
  }
}
export type WorkOSProbeDependencies = Readonly<{ command: ReadinessCommand }>;
export async function inspectRotateWorkOS(cwd: string, dependencies: WorkOSProbeDependencies = { command: runReadinessCommand }): Promise<readonly RotatePrerequisite[]> {
  if (dependencies.command('workos', ['--version'], cwd).status !== 0)
    return [check('ROTATE_WORKOS_CLI_MISSING', false, WORKOS_CLI_MISSING.detail, WORKOS_CLI_MISSING.remedy, WORKOS_CLI_MISSING.link?.url)];
  return [check('ROTATE_WORKOS_CLI', true, 'workos installation')];
}
/** Local attribution only; the Capy probe still verifies identity, access and custody. */
export function rotateRepositoryContext(
  keep: KeepFile | null,
  sync: SyncState | null,
  branch: string | null,
): CapyReadinessContext | null {
  if (!branch) return null;
  if (keep) return { orgId: keep.org_id, projectId: keep.project_id, branch, userHint: sync?.user_id };
  if (sync?.sync_mode !== 'free' || sync.project_name !== 'default' || branch !== 'development'
    || !sync.org_id || !sync.project_id || !sync.user_id || !getSyncKeepHash(sync, branch)) return null;
  return { orgId: sync.org_id, projectId: sync.project_id, branch, userHint: sync.user_id };
}
export async function inspectLocalRotateReadiness(opts: RotateReadinessOptions = {}): Promise<RotateReadiness> {
  const cwd = opts.cwd ?? process.cwd();
  const pm = new ProjectManager(cwd);
  const keep = pm.readKeepFile();
  const branch = pm.deriveActiveBranch();
  const context = rotateRepositoryContext(keep, pm.readSyncState(), branch);
  return inspectRotateReadiness({
    repository: async () => check('ROTATE_REPOSITORY', Boolean(context),
      'Rotate requires an initialized project and active Capy branch.', 'Run this Capy installation in the intended project first.'),
    capy: () => inspectRotateCapy(context!, opts),
    workos: () => inspectRotateWorkOS(cwd),
    deployment: () => inspectRotateDeployment(opts).catch(() => ({ choices: [], checks: [
      check('ROTATE_DEPLOYMENT_READINESS_UNAVAILABLE', false, 'Deployment configuration could not be inspected.',
        'Check this project’s deployment configuration, then recheck readiness.'),
    ] })),
  });
}

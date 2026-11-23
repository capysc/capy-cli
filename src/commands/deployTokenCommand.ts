import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';
import { AuthService } from '../auth/authService';
import { ServiceClient, type CredentialGeneration, type DeployTokenInfo } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import {
  generateDeployId,
  generateDeployKey,
  generateInnerSecret,
  encryptEnvBlob,
  buildSecretsBlob,
} from '../crypto/deployCrypto';
import ora from '../ui/spinner';
import inquirer from 'inquirer';
import { generateDeployHtml } from '../ui/deployPage/html';
import { hashValue } from '../deploy/keepGate';
import { stripTargetsForDeployId } from '../deploy/targetsGate';
import { uploadKeepOnly } from '../sync/commit';
import { SyncEngine } from '../sync/syncEngine';
import { ERROR_CODES } from '../types/index';
import type { ProjectState } from '../types/index';
import { gateFirst } from '../sync/gate';
import { conflictFlagsOrExit, type RawConflictFlags } from '../sync/conflicts';
import { DEPLOY_KEY_RUNTIME_PAIR, OLD_RUNTIME_PAIR } from '../deploy/dokployApi';

/**
 * `deploy revoke <id>` (CAP-679): strip every `targets` element carrying
 * this `deploy_id` from keep.lock and push through the existing sync path —
 * the same "read → transform → push" shape as
 * `deployCommand.ts#pushKeepTransform`, kept local here rather than
 * cross-importing `deployCommand.ts` (which itself dynamically imports THIS
 * module for minting), to avoid a module cycle.
 *
 * Writes only the untracked working copy (`writeKeepFile`); it never
 * auto-commits the tracked keep.lock onto whatever branch the caller
 * happens to be on.
 *
 * Best-effort and silent on failure beyond a one-line warning: the token is
 * already revoked by the time this runs, so a keep.lock hiccup here must
 * never look like the revoke itself failed.
 */
async function stripRevokedTargets(
  pm: ProjectManager,
  serviceClient: ServiceClient,
  projectState: ProjectState,
  userId: string,
  deployId: string,
): Promise<void> {
  try {
    if (!projectState.projectId || !projectState.organizationId) return;
    const keep = pm.readKeepFile();
    if (!keep) return;
    const nextKeep = stripTargetsForDeployId(keep, deployId);
    if (nextKeep === keep) return;

    // Never push an env blob for a branch other than the one `.env` is
    // actually on. Revoke has no separate "target.branch" to compare
    // against — it always pushes under the ACTIVE branch — so the only
    // possible refusal here is "unknown", never "mismatch".
    const branch = projectState.activeBranch;
    if (!branch) {
      console.error(
        `  \x1b[33m!\x1b[0m could not strip revoked deploy targets in keep.lock — ` +
          `[${ERROR_CODES.DEPLOY_BRANCH_UNKNOWN}] the active branch could not be determined.`,
      );
      return;
    }

    // A keep-only change on the SERVER's latest, through the shared keep-only upload (sync/commit.ts): no value
    // moves, so nothing in this folder's `.env` can leak into the blob or revert anyone's value.
    const done = await uploadKeepOnly(serviceClient, projectState.projectId, branch, (latest) => stripTargetsForDeployId(latest, deployId));
    if (!done.ok) {
      console.error(`  \x1b[33m!\x1b[0m could not strip revoked deploy targets in keep.lock: ${done.code}`);
      return;
    }
    if (done.pushed) {
      new FileManager().writeKeepFile(SyncEngine.spliceKeepBranch(keep, SyncEngine.adoptServerKeep(done.serverKeepFile, done.keep, branch), branch));
    }
  } catch (err: any) {
    console.error(`  \x1b[33m!\x1b[0m could not strip revoked deploy targets in keep.lock: ${err?.message ?? err}`);
  }
}

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * Map of platform value → connector adapter id. When the user picks a
 * platform with a connector, an extra prompt offers connector mode (real
 * deploy) alongside the existing token+docs path. Platforms not in this map
 * always use the token+docs flow.
 */
const PLATFORM_TO_CONNECTOR: Record<string, string> = {
  'cloudflare-workers': 'cf-worker',
  'cloudflare-pages': 'cf-pages',
  'vercel': 'vercel',
  'github-actions': 'gh-actions',
  'aws-ecs': 'aws-ssm',
  'dokploy': 'dokploy',
  // Future:
  // 'fly':              'fly',
};

const PLATFORMS = [
  { name: 'AWS App Runner', value: 'aws-app-runner' },
  { name: 'AWS CDK', value: 'aws-cdk' },
  { name: 'AWS ECS', value: 'aws-ecs' },
  { name: 'Azure App Service', value: 'azure-app-service' },
  { name: 'CapRover', value: 'caprover' },
  { name: 'CircleCI', value: 'circleci' },
  { name: 'Cloudflare Pages', value: 'cloudflare-pages' },
  { name: 'Cloudflare Workers', value: 'cloudflare-workers' },
  { name: 'Coolify', value: 'coolify' },
  { name: 'DigitalOcean App Platform', value: 'digitalocean' },
  { name: 'Docker', value: 'docker' },
  { name: 'Docker Compose', value: 'docker-compose' },
  { name: 'Dokku', value: 'dokku' },
  { name: 'Dokploy', value: 'dokploy' },
  { name: 'Fly.io', value: 'fly' },
  { name: 'GitHub Actions', value: 'github-actions' },
  { name: 'GitLab CI', value: 'gitlab-ci' },
  { name: 'Google Cloud Run', value: 'google-cloud-run' },
  { name: 'Helm', value: 'helm' },
  { name: 'Heroku', value: 'heroku' },
  { name: 'Jenkins', value: 'jenkins' },
  { name: 'Kamal', value: 'kamal' },
  { name: 'Kubernetes', value: 'kubernetes' },
  { name: 'Netlify', value: 'netlify' },
  { name: 'Nomad', value: 'nomad' },
  { name: 'Pulumi', value: 'pulumi' },
  { name: 'Railway', value: 'railway' },
  { name: 'Render', value: 'render' },
  { name: 'systemd', value: 'systemd' },
  { name: 'Terraform', value: 'terraform' },
  { name: 'Vercel', value: 'vercel' },
  { name: 'Other...', value: 'other' },
] as const;

/**
 * Decorate the picker label for platforms that have a connector adapter so
 * users can see at a glance which platforms support real deploy vs. only
 * the docs flow.
 */
function decorateChoices(
  base: ReadonlyArray<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  return base.map((p) => {
    if (PLATFORM_TO_CONNECTOR[p.value]) {
      return {
        ...p,
        // CAP-679: "connector" was the umbrella word this picker uses for
        // "the platform has a real deploy adapter, not just docs" — but
        // connectors are now the INBOUND half of "integrations" (targets are
        // outbound). Approved copy change: only this label moves; internal
        // identifiers like `PLATFORM_TO_CONNECTOR` are untouched for now.
        name: `${p.name}  \x1b[90m(integration available)\x1b[0m`,
      };
    }
    return { ...p };
  });
}

const BLOB_SIZE_WARN_THRESHOLD = 32 * 1024; // 32KB

/**
 * Platforms whose environment variable names must start with a letter, so a
 * name led by an underscore cannot be set there. Netlify documents this rule:
 * a key's first character must be a letter, and its own example of an invalid
 * key is `_KEY1`. These platforms are delivered the same random per-deploy
 * key under the older names `SECRETS_BLOB` + `PROJECT_KEY`, which every
 * `capy run` still reads.
 */
export const LETTER_FIRST_NAME_PLATFORMS: readonly string[] = ['netlify'];

/** What a walkthrough shows a platform: the two variable names, and which wording of the instructions to ask the service for. */
export interface DeliveryPlan {
  readonly blobName: string;
  readonly keyName: string;
  /** The `credential_generation` to request instructions for; `undefined` means no query (the older names). */
  readonly instructionsGeneration: CredentialGeneration | undefined;
}

/** The names a platform's walkthrough delivers under. The key itself is a per-deploy key either way. */
export function deliveryPlanFor(platform: string): DeliveryPlan {
  if (LETTER_FIRST_NAME_PLATFORMS.includes(platform)) {
    return { blobName: OLD_RUNTIME_PAIR[0], keyName: OLD_RUNTIME_PAIR[1], instructionsGeneration: undefined };
  }
  return { blobName: DEPLOY_KEY_RUNTIME_PAIR[0], keyName: DEPLOY_KEY_RUNTIME_PAIR[1], instructionsGeneration: 'deploy_key' };
}

/** The platform's instructions, worded for the names its walkthrough delivers. */
export function fetchDeliveryInstructions(
  serviceClient: Pick<ServiceClient, 'fetchDeployInstructions'>,
  platform: string,
  plan: DeliveryPlan = deliveryPlanFor(platform),
): Promise<{ platform: string; markdown: string }> {
  return serviceClient.fetchDeployInstructions(platform, plan.instructionsGeneration);
}

/** The terminal fallback when the instructions page cannot be served: each value under its name. */
export function terminalDeliveryLines(
  plan: DeliveryPlan,
  secretsBlob: string,
  deployKey: string,
  platformLabel: string,
): readonly string[] {
  return [
    '',
    `  ${plan.blobName}:`,
    `  ${secretsBlob}`,
    '',
    `  ${plan.keyName}:`,
    `  ${deployKey}`,
    '',
    `  Set these as environment variables in ${platformLabel}.`,
  ];
}

/** Result of one full deploy-token mint. Shared by the token+docs flow and the
 * github-actions connector — both want the same `_SECRETS_BLOB` /
 * `_DEPLOY_KEY` pair, they just deliver it differently. The key is a
 * random per-deploy key; the project key is never part of a mint's output. */
export interface MintedDeployToken {
  secretsBlob: string;
  /** 64 hex characters: the random per-deploy key. */
  deployKey: string;
  deployId: string;
  secretCount: number;
  blobBytes: number;
  /**
   * sha256(value).slice(0,16) per minted variable — same algorithm as
   * keep.lock's `value_hash` (CAP-679). Never the plaintext itself: a caller
   * that needs to RECORD a `capy deploy` target's delivery (see
   * `deployCommand.ts`/`targetsGate.ts`) uses this instead of re-decrypting.
   */
  valueHashes: Record<string, string>;
}

export interface MintDeployTokenDeps {
  serviceClient: ServiceClient;
  fm: FileManager;
  orgId: string;
  projectId: string;
  userId: string;
  /**
   * Only these variables go into the bundle. Omitted → every `.env` value
   * (the token+docs flow and the github-actions connector, which have no
   * per-target selection).
   */
  vars?: readonly string[];
}

/** Thrown by mintDeployToken when .env has nothing to encrypt. Callers
 * surface this as a user-facing "run capy to sync secrets first" message. */
export class EmptyEnvError extends Error {
  constructor() {
    super('No secrets found in .env. Run capy first to sync secrets.');
    this.name = 'EmptyEnvError';
  }
}

/** Thrown by mintDeployToken when a selected variable is not in `.env`, so a
 * deploy never ships a bundle quietly missing a secret the target expects. */
export class MissingSelectedVarsError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(
      `Selected variable(s) not in .env: ${missing.join(', ')}. ` +
        'Run capy to sync, or untick them with `capy deploy --edit`.',
    );
    this.name = 'MissingSelectedVarsError';
  }
}

/** The `.env` entries a mint covers: all of them, or exactly the selection. */
function selectEnv(
  rawEnv: Record<string, string>,
  vars: readonly string[] | undefined,
): Record<string, string> {
  if (!vars) return rawEnv;
  const missing = vars.filter((k) => !(k in rawEnv));
  if (missing.length > 0) throw new MissingSelectedVarsError(missing);
  return Object.fromEntries(vars.map((k) => [k, rawEnv[k]]));
}

/**
 * Resolve the project key (only to open `capy:` values from `.env`), mint a
 * deploy id, KMS-wrap, and produce the `_SECRETS_BLOB` +
 * `_DEPLOY_KEY` pair the deployed app feeds into `capy run`.
 *
 * The deploy target gets a RANDOM per-deploy key, never the project key: the
 * project key stays on this machine, and revoking the token makes a leaked
 * artifact useless.
 *
 * Pure-ish: the caller owns auth and progress UI. This function reads
 * `.env`, talks to the service for KMS wrap + co-decrypt, and returns the
 * minted material. It does not exit, log, or render — throws on error.
 */
export async function mintDeployToken(deps: MintDeployTokenDeps): Promise<MintedDeployToken> {
  const { serviceClient, fm, orgId, projectId, userId, vars } = deps;
  // Before any service call: an empty or incomplete selection must not leave
  // a registered deploy token behind.
  const selected = selectEnv(fm.readEnvFile(), vars);
  if (Object.keys(selected).length === 0) throw new EmptyEnvError();

  const keyOps: KeyServiceOps = {
    coDecrypt: (oid, ct) => serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
    wrapOuterLayer: (oid, pt) => serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
  };
  const pkHex = await resolveProjectKey(orgId, projectId, userId, keyOps);

  const deployId = generateDeployId();
  const deployKey = generateDeployKey();
  const innerBlob = generateInnerSecret();

  const { outer_blob: outerBlob } = await serviceClient.createDeployToken(
    orgId,
    deployId.toString('hex'),
    projectId,
    innerBlob,
    'deploy_key',
  );

  const plaintextEnv: Record<string, string> = Object.fromEntries(
    Object.entries(selected).map(([key, value]) => [
      key,
      value.startsWith('capy:') ? fm.decryptValue(value, pkHex) : value,
    ]),
  );

  // Encrypt env vars with DECRYPT_KEY derived from the per-deploy key +
  // service_key, where service_key is derived deterministically from
  // innerBlob. The deploy key alone is insufficient to decrypt — the
  // server's KMS-gated service_key is required, so revoking the token
  // makes the artifact useless. The project key plays no part in this.
  const encryptedVars = encryptEnvBlob(plaintextEnv, deployKey, innerBlob, projectId, deployId);
  const secretsBlob = buildSecretsBlob(deployId, outerBlob, encryptedVars);
  const blobBytes = Buffer.from(secretsBlob, 'base64').length;
  const valueHashes = Object.fromEntries(
    Object.entries(plaintextEnv).map(([name, value]) => [name, hashValue(value)]),
  );

  return {
    secretsBlob,
    deployKey: deployKey.toString('hex'),
    deployId: deployId.toString('hex'),
    secretCount: Object.keys(plaintextEnv).length,
    blobBytes,
    valueHashes,
  };
}

interface CapyConfig {
  platform?: string;
}

function readConfig(projectRoot: string): CapyConfig {
  const configPath = join(projectRoot, '.capy', 'config');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(projectRoot: string, config: CapyConfig): void {
  const capyDir = join(projectRoot, '.capy');
  if (!existsSync(capyDir)) mkdirSync(capyDir, { recursive: true });
  writeFileSync(join(capyDir, 'config'), JSON.stringify(config, null, 2), 'utf-8');
}

async function openInBrowser(url: string): Promise<void> {
  const { openScreen } = await import('../ui/openScreen');
  // Wide: this is the deploy instructions — fenced blocks of platform config
  // someone is going to read and copy. A 520px dialog would wrap every one of them.
  await openScreen(url, { kind: 'dialog', wide: true });
}


/** Non-interactive flags consumed by `capy deploy`. Each `--flag` skips its
 * corresponding prompt; combinations let callers run end-to-end with no
 * stdin (CI, automated e2e, scripted operator workflows). */
export interface DeployCommandOptions {
  /** Skip platform picker. Must be a value from PLATFORMS (e.g. 'github-actions'). */
  platform?: string;
  /** Skip the connector-vs-token mode picker. */
  mode?: 'connector' | 'token';
  /** gh-actions only: skip the repo-vs-env scope picker. */
  scope?: 'repo' | 'env';
  /** gh-actions only: env name when --scope env. Created if missing. */
  envName?: string;
  /** Skip overwrite confirmations (assumes yes). */
  yes?: boolean;
  /** Forwarded to the connector flow: force a redeploy even if keep.lock is unchanged. */
  force?: boolean;
  /** `--json`: stdout belongs to JSON, so bare `capy`'s differences are reported, not asked. */
  json?: boolean;
  /** `--dry-run`: bare `capy`'s differences are reported (with `dry_run`), never answered. */
  dryRun?: boolean;
  /** `--resolve` / `--conflict` as typed (CAP-717). */
  conflictFlags?: RawConflictFlags;
}

/** org-scoped silent → unscoped silent → interactive: the first success, else the last attempt. */
async function authenticateOrgFirst(authService: AuthService, orgId: string) {
  const scoped = await authService.authenticateSilent(orgId);
  if (scoped.success) return scoped;
  const unscoped = await authService.authenticateSilent();
  return unscoped.success ? unscoped : await authService.authenticate(orgId);
}

/**
 * Serve the deploy instructions on a loopback port and open them (the
 * clipboard API needs a localhost origin). Resolves `false` when the page
 * could not be served, so the caller falls back to the terminal. Once the page
 * is being served this never resolves: the process stays up until the
 * five-minute timer or Ctrl+C ends it.
 */
async function serveDeployInstructions(html: string): Promise<boolean> {
  try {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });

    const addr = server.address();
    if (!(addr && typeof addr === 'object')) return false;

    // Use 127.0.0.1 explicitly: `localhost` resolves to ::1 (IPv6) first
    // on macOS/modern Linux, but the server above binds to 127.0.0.1 only,
    // so default browsers opened via the printed terminal URL would hit
    // a dead IPv6 port. The popup path happened to retry families and
    // hid this from users who relied on the auto-opened window.
    const url = `http://127.0.0.1:${addr.port}`;
    console.log(`\n  Temporary deploy instructions — if the browser doesn't open, visit:`);
    console.log(`  ${url}`);
    console.log('  Press Ctrl+C to close.\n');

    await openInBrowser(url);

    // Auto-shutdown after 5 minutes
    const shutdownTimer = setTimeout(() => {
      server.close();
      process.exit(0);
    }, 5 * 60 * 1000);
    shutdownTimer.unref();

    // Clean shutdown on Ctrl+C
    process.on('SIGINT', () => {
      server.close();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      server.close();
      process.exit(0);
    });

    // Keep process alive
    await new Promise(() => {});
    return true;
  } catch {
    // Fall through to terminal output
    return false;
  }
}

export class DeployCommand {
  private apiUrl?: string;
  private devMode: boolean;
  private options: DeployCommandOptions;

  constructor(apiUrl?: string, devMode: boolean = false, options: DeployCommandOptions = {}) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
    this.options = options;
  }

  /** The platform: the `--platform` flag, or the picker. An unknown flag value exits 1. */
  private async resolvePlatform(defaultPlatform: string | undefined): Promise<string> {
    const flagPlatform = this.options.platform;
    if (flagPlatform !== undefined) {
      if (!PLATFORMS.some(p => p.value === flagPlatform)) {
        console.error(`  --platform must be one of: ${PLATFORMS.map(p => p.value).join(', ')}`);
        process.exit(1);
      }
      return flagPlatform;
    }
    // Show "Other..." at the top as a ready-made escape hatch, with a
    // non-selectable Separator between it and the alphabetical list so
    // it doesn't read as "just another platform".
    const choices = [
      ...decorateChoices(PLATFORMS.filter(p => p.value === 'other')),
      new inquirer.Separator() as any,
      ...decorateChoices(PLATFORMS.filter(p => p.value !== 'other')),
    ];
    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'platform',
      message: 'Where does this project deploy?',
      choices,
      default: defaultPlatform,
      pageSize: 20,
    }]);
    return answer.platform;
  }

  /** The mode: the `--mode` flag, or the picker. */
  private async resolveMode(platform: string, isGhActions: boolean): Promise<'connector' | 'token'> {
    if (this.options.mode) return this.options.mode;
    const connectorChoice = isGhActions
      ? `Push ${DEPLOY_KEY_RUNTIME_PAIR[0]} + ${DEPLOY_KEY_RUNTIME_PAIR[1]} to GitHub secrets via gh`
      : 'Deploy now via direct target deploy (push secrets + ship code)';
    const r = await inquirer.prompt([{
      type: 'list',
      name: 'mode',
      message: `${PLATFORMS.find(p => p.value === platform)?.name} — what do you want to do?`,
      choices: [
        // `value: 'connector'` is the internal identifier, untouched —
        // only the displayed `name`/`short` moved to "target" wording.
        { name: connectorChoice, value: 'connector', short: 'target' },
        {
          name: 'Set up CI deploy token + docs (capy run in your CI)',
          value: 'token',
          short: 'token+docs',
        },
      ],
      default: 'connector',
    }]);
    return r.mode;
  }

  /** Mints the deploy credentials behind a spinner; any failure exits 1. */
  private async mintWithSpinner(deps: MintDeployTokenDeps, blobName: string): Promise<MintedDeployToken> {
    const spinner = ora('Generating deploy credentials...').start();
    try {
      const minted = await mintDeployToken(deps);
      if (minted.blobBytes > BLOB_SIZE_WARN_THRESHOLD) {
        spinner.warn(`${blobName} is ${Math.round(minted.blobBytes / 1024)}KB — some platforms have 32-64KB env var limits. Consider splitting into multiple projects.`);
      } else {
        spinner.succeed(`Deploy credentials generated (${minted.secretCount} secrets)`);
      }
      return minted;
    } catch (err: any) {
      spinner.fail(err?.message ?? 'Failed to generate deploy credentials');
      process.exit(1);
    }
  }

  async execute(): Promise<void> {
    // A bad --resolve / --conflict is refused before anything is read or authenticated.
    conflictFlagsOrExit(this.options.conflictFlags ?? {}, this.options.json === true);
    // Bare `capy` runs before anything else (docs/conflict-resolution.md): before detecting the project, signing in, the
    // picker, a mint of deploy credentials, or the GitHub Actions connector. The folder and Capy must agree before this
    // mints a token from the folder's `.env`; off a terminal (`--yes`, `--json`, `--dry-run`) a difference ends the run
    // with its payload alone on stdout.
    await gateFirst({
      devMode: this.devMode,
      nonTty: this.options.yes === true,
      json: this.options.json === true,
      conflictFlags: this.options.conflictFlags,
      dryRun: this.options.dryRun === true,
    });
    try {
      const pm = new ProjectManager();
      const fm = new FileManager();
      const projectState = await pm.detectProjectState();

      if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
        console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
        process.exit(1);
      }

      const orgId = projectState.organizationId;
      const projectId = projectState.projectId;
      const projectRoot = process.cwd();

      // Authenticate
      const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
      const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
      serviceClient.setTokenProvider((rejected) => authService.getValidToken(rejected));
      const authResult = await authenticateOrgFirst(authService, orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }

      const userId = authResult.user_id!;

      // Step 1: where this project deploys.
      const config = readConfig(projectRoot);
      const platform = await this.resolvePlatform(config.platform);
      if (platform !== config.platform) {
        writeConfig(projectRoot, { ...config, platform });
      }

      // Connector branch: when the picked platform has a real adapter,
      // offer to run the deploy directly. The existing token+docs flow
      // remains available — both modes are useful in different setups
      // (CI vs. interactive shipping).
      const connectorId = PLATFORM_TO_CONNECTOR[platform];
      if (connectorId) {
        // gh-actions is structurally different from cf-worker / vercel:
        // GitHub Actions is a CI vehicle, not a runtime target. The
        // connector pushes _SECRETS_BLOB + _DEPLOY_KEY into GitHub repo or
        // environment secrets via the `gh` CLI; the workflow itself wraps
        // its deploy step with `capy run`. So the prompt copy differs and
        // dispatch goes to a dedicated connector instead of through
        // DeployAdapter.deploy().
        const isGhActions = connectorId === 'gh-actions';
        const mode = await this.resolveMode(platform, isGhActions);
        if (mode === 'connector') {
          if (isGhActions) {
            const { runGithubActionsConnector } = await import('./githubActionsConnector');
            const code = await runGithubActionsConnector(
              { serviceClient, fm, orgId, projectId, userId },
              {
                scope: this.options.scope,
                envName: this.options.envName,
                yes: this.options.yes,
              },
            );
            process.exit(code);
          }
          const { deployCommand } = await import('./deployCommand');
          const code = await deployCommand(undefined, {
            target: connectorId,
            yes: !!this.options.yes,
            force: !!this.options.force,
            devMode: this.devMode,
          });
          process.exit(code);
        }
        // else fall through to existing token+docs flow
      }

      const platformLabel = PLATFORMS.find(p => p.value === platform)?.name || platform;

      // Step 2: Generate credentials
      const plan = deliveryPlanFor(platform);
      const { secretsBlob, deployKey } = await this.mintWithSpinner({ serviceClient, fm, orgId, projectId, userId }, plan.blobName);

      // Step 3: Fetch instructions and serve HTML page. The instructions are
      // worded for the names this walkthrough delivers (see `deliveryPlanFor`).
      const { markdown } = await fetchDeliveryInstructions(serviceClient, platform, plan);
      const html = generateDeployHtml(secretsBlob, deployKey, platformLabel, platform, markdown, [plan.blobName, plan.keyName]);

      // Try to serve via localhost (needed for clipboard API)
      const serverStarted = await serveDeployInstructions(html);

      if (!serverStarted) {
        // Fallback: print values to terminal
        terminalDeliveryLines(plan, secretsBlob, deployKey, platformLabel).forEach((line) => console.log(line));
      }

      console.log('');
    } catch (error: any) {
      if (error?.name === 'ExitPromptError') process.exit(0);
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }
}

export class DeployRevokeCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(deployIdPrefix: string, opts: { readonly nonTty?: boolean; readonly conflictFlags?: RawConflictFlags } = {}): Promise<void> {
    // A bad --resolve / --conflict is refused before anything is read or authenticated.
    conflictFlagsOrExit(opts.conflictFlags ?? {}, false);
    // Bare `capy` runs first (docs/conflict-resolution.md), before the revoke and the keep.lock strip that follows it
    // (a Keep-only upload): revoking a deploy writes from this folder like every other command does.
    await gateFirst({ devMode: this.devMode, nonTty: opts.nonTty, conflictFlags: opts.conflictFlags });
    try {
      const pm = new ProjectManager();
      const projectState = await pm.detectProjectState();

      if (!projectState.initialized || !projectState.organizationId) {
        console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
        process.exit(1);
      }

      const orgId = projectState.organizationId;

      const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
      const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
      serviceClient.setTokenProvider((rejected) => authService.getValidToken(rejected));
      const authResult = await authenticateOrgFirst(authService, orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }

      await serviceClient.revokeDeployToken(deployIdPrefix);

      console.log(`  Deploy token ${deployIdPrefix.slice(0, 12)}... revoked.`);
      // CAP-679: strip keep.lock's record of this deploy — best-effort, and
      // resolved to the FULL id (via listDeployTokens) since a prefix can't
      // be matched exactly against `targets[].deploy_id`.
      if (projectState.projectId && authResult.user_id) {
        const { tokens } = await serviceClient.listDeployTokens(orgId, projectState.projectId).catch(() => ({ tokens: [] }));
        const full = tokens.find((t) => t.deploy_id.startsWith(deployIdPrefix))?.deploy_id ?? deployIdPrefix;
        await stripRevokedTargets(pm, serviceClient, projectState, authResult.user_id, full);
      }
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }
}

/**
 * A listed token with its credential generation always present: a service
 * that predates the field means `project_key`, the only kind it could mint.
 */
export function withCredentialGeneration(
  token: DeployTokenInfo,
): DeployTokenInfo & { readonly credential_generation: CredentialGeneration } {
  return { ...token, credential_generation: token.credential_generation ?? 'project_key' };
}

/** How one token's credential generation reads in the human list. `project_key` is a legacy token that still carries the project key. */
function describeGeneration(generation: CredentialGeneration): string {
  // COPY-FLAG: minimal neutral wording.
  return generation === 'project_key' ? 'project key (legacy)' : 'deploy key';
}

/**
 * The lines `capy deploy list` prints. With `json`, exactly one JSON document
 * (every token carries `credential_generation`); otherwise the human list.
 */
export function renderDeployTokenList(
  tokens: readonly DeployTokenInfo[],
  projectName: string | undefined,
  json: boolean,
): readonly string[] {
  const listed = tokens.map(withCredentialGeneration);
  if (json) return [JSON.stringify({ tokens: listed }, null, 2)];
  if (listed.length === 0) return ['  No deploy tokens for this project.'];
  return [
    '',
    `  Deploy tokens for "${projectName}":`,
    '',
    ...listed.map((t) => {
      const status = t.revoked_at ? '\x1b[31mrevoked\x1b[0m' : '\x1b[32mactive\x1b[0m';
      const label = t.label ? ` (${t.label})` : '';
      const created = new Date(t.created_at).toLocaleDateString();
      return `  ${t.deploy_id.slice(0, 12)}...${label}  ${status}  ${describeGeneration(t.credential_generation)}  created ${created}`;
    }),
    '',
  ];
}

export class DeployListCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(options: { readonly json?: boolean } = {}): Promise<void> {
    try {
      const pm = new ProjectManager();
      const projectState = await pm.detectProjectState();

      if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
        console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
        process.exit(1);
      }

      const orgId = projectState.organizationId;
      const projectId = projectState.projectId;

      const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
      const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
      serviceClient.setTokenProvider((rejected) => authService.getValidToken(rejected));
      const authResult = await authenticateOrgFirst(authService, orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }

      const { tokens } = await serviceClient.listDeployTokens(orgId, projectId);

      renderDeployTokenList(tokens, projectState.projectName, options.json === true).forEach((line) => console.log(line));
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }
}

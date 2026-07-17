import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { resolveProjectKey, KeyServiceOps } from '../crypto/keyResolver';
import {
  generateDeployId,
  generateDerivationToken,
  deployInnerWrap,
  encryptEnvBlob,
  buildSecretsBlob,
} from '../crypto/deployCrypto';
import ora from '../ui/spinner';
import inquirer from 'inquirer';
import { generateDeployHtml } from '../ui/deployPage/html';

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
        name: `${p.name}  \x1b[90m(connector available)\x1b[0m`,
      };
    }
    return { ...p };
  });
}

const BLOB_SIZE_WARN_THRESHOLD = 32 * 1024; // 32KB

/** Result of one full deploy-token mint. Shared by the token+docs flow and the
 * github-actions connector — both want the same SECRETS_BLOB / PROJECT_KEY
 * pair, they just deliver it differently. */
export interface MintedDeployToken {
  secretsBlob: string;
  projectKey: string;
  deployId: string;
  secretCount: number;
  blobBytes: number;
}

export interface MintDeployTokenDeps {
  serviceClient: ServiceClient;
  fm: FileManager;
  orgId: string;
  projectId: string;
  userId: string;
}

/** Thrown by mintDeployToken when .env has nothing to encrypt. Callers
 * surface this as a user-facing "run capy to sync secrets first" message. */
export class EmptyEnvError extends Error {
  constructor() {
    super('No secrets found in .env. Run capy first to sync secrets.');
    this.name = 'EmptyEnvError';
  }
}

/**
 * Resolve the project key, mint a deploy id, KMS-wrap, and produce the
 * SECRETS_BLOB + PROJECT_KEY pair the deployed app feeds into `capy run`.
 *
 * Pure-ish: the caller owns auth and progress UI. This function reads
 * `.env`, talks to the service for KMS wrap + co-decrypt, and returns the
 * minted material. It does not exit, log, or render — throws on error.
 */
export async function mintDeployToken(deps: MintDeployTokenDeps): Promise<MintedDeployToken> {
  const { serviceClient, fm, orgId, projectId, userId } = deps;

  const keyOps: KeyServiceOps = {
    coDecrypt: (oid, ct) => serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
    wrapOuterLayer: (oid, pt) => serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
  };
  const pkHex = await resolveProjectKey(orgId, projectId, userId, keyOps);
  const pk = Buffer.from(pkHex, 'hex');

  const deployId = generateDeployId();
  const dt = generateDerivationToken();
  const innerBlob = deployInnerWrap(pk, dt, projectId);

  const { outer_blob: outerBlob } = await serviceClient.createDeployToken(
    orgId,
    deployId.toString('hex'),
    projectId,
    innerBlob,
  );

  const rawEnv = fm.readEnvFile();
  const plaintextEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    plaintextEnv[key] = value.startsWith('capy:') ? fm.decryptValue(value, pkHex) : value;
  }
  if (Object.keys(plaintextEnv).length === 0) throw new EmptyEnvError();

  // Encrypt env vars with DECRYPT_KEY derived from pk + service_key, where
  // service_key is derived deterministically from innerBlob. projectKey
  // alone is insufficient to decrypt — the server's KMS-gated service_key
  // is required, preserving zero-trust.
  const encryptedVars = encryptEnvBlob(plaintextEnv, pk, innerBlob, projectId, deployId);
  const secretsBlob = buildSecretsBlob(deployId, outerBlob, encryptedVars);
  const blobBytes = Buffer.from(secretsBlob, 'base64').length;

  return {
    secretsBlob,
    projectKey: pkHex,
    deployId: deployId.toString('hex'),
    secretCount: Object.keys(plaintextEnv).length,
    blobBytes,
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
  const open = (await import('open')).default;
  open(url).catch(() => {});
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

  async execute(): Promise<void> {
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
      serviceClient.setTokenProvider(() => authService.getValidToken());
      let authResult = await authService.authenticateSilent(orgId);
      if (!authResult.success) authResult = await authService.authenticateSilent();
      if (!authResult.success) authResult = await authService.authenticate(orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }

      const userId = authResult.user_id!;

      // Step 1: Platform selection — flag wins over prompt.
      const config = readConfig(projectRoot);
      const defaultPlatform = config.platform;
      let platform: string;
      if (this.options.platform) {
        if (!PLATFORMS.some(p => p.value === this.options.platform)) {
          console.error(`  --platform must be one of: ${PLATFORMS.map(p => p.value).join(', ')}`);
          process.exit(1);
        }
        platform = this.options.platform;
      } else {
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
        platform = answer.platform;
      }
      if (platform !== config.platform) {
        config.platform = platform;
        writeConfig(projectRoot, config);
      }

      // Connector branch: when the picked platform has a real adapter,
      // offer to run the deploy directly. The existing token+docs flow
      // remains available — both modes are useful in different setups
      // (CI vs. interactive shipping).
      const connectorId = PLATFORM_TO_CONNECTOR[platform];
      if (connectorId) {
        // gh-actions is structurally different from cf-worker / vercel:
        // GitHub Actions is a CI vehicle, not a runtime target. The
        // connector pushes SECRETS_BLOB + PROJECT_KEY into GitHub repo or
        // environment secrets via the `gh` CLI; the workflow itself wraps
        // its deploy step with `capy run`. So the prompt copy differs and
        // dispatch goes to a dedicated connector instead of through
        // DeployAdapter.deploy().
        const isGhActions = connectorId === 'gh-actions';
        let mode: 'connector' | 'token';
        if (this.options.mode) {
          mode = this.options.mode;
        } else {
          const connectorChoice = isGhActions
            ? 'Push SECRETS_BLOB + PROJECT_KEY to GitHub secrets via gh'
            : 'Deploy now via connector (push secrets + ship code)';
          const r = await inquirer.prompt([{
            type: 'list',
            name: 'mode',
            message: `${PLATFORMS.find(p => p.value === platform)?.name} — what do you want to do?`,
            choices: [
              { name: connectorChoice, value: 'connector', short: 'connector' },
              {
                name: 'Set up CI deploy token + docs (capy run in your CI)',
                value: 'token',
                short: 'token+docs',
              },
            ],
            default: 'connector',
          }]);
          mode = r.mode;
        }
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
          const code = await deployCommand(undefined, { target: connectorId, yes: !!this.options.yes, force: !!this.options.force, devMode: this.devMode });
          process.exit(code);
        }
        // else fall through to existing token+docs flow
      }

      const platformLabel = PLATFORMS.find(p => p.value === platform)?.name || platform!;

      // Step 2: Generate credentials
      const spinner = ora('Generating deploy credentials...').start();
      let minted: MintedDeployToken;
      try {
        minted = await mintDeployToken({ serviceClient, fm, orgId, projectId, userId });
      } catch (err: any) {
        spinner.fail(err?.message ?? 'Failed to generate deploy credentials');
        process.exit(1);
      }
      const { secretsBlob, projectKey, secretCount, blobBytes } = minted;
      if (blobBytes > BLOB_SIZE_WARN_THRESHOLD) {
        spinner.warn(`SECRETS_BLOB is ${Math.round(blobBytes / 1024)}KB — some platforms have 32-64KB env var limits. Consider splitting into multiple projects.`);
      } else {
        spinner.succeed(`Deploy credentials generated (${secretCount} secrets)`);
      }

      // Step 3: Fetch instructions and serve HTML page
      const { markdown } = await serviceClient.fetchDeployInstructions(platform!);
      const html = generateDeployHtml(secretsBlob, projectKey, platformLabel, platform!, markdown);

      // Try to serve via localhost (needed for clipboard API)
      let serverStarted = false;
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
        if (addr && typeof addr === 'object') {
          // Use 127.0.0.1 explicitly: `localhost` resolves to ::1 (IPv6) first
          // on macOS/modern Linux, but the server above binds to 127.0.0.1 only,
          // so default browsers opened via the printed terminal URL would hit
          // a dead IPv6 port. The popup path happened to retry families and
          // hid this from users who relied on the auto-opened window.
          const url = `http://127.0.0.1:${addr.port}`;
          console.log(`\n  Temporary deploy instructions opened at ${url}`);
          console.log('  Press Ctrl+C to close.\n');

          await openInBrowser(url);
          serverStarted = true;

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
        }
      } catch {
        // Fall through to terminal output
      }

      if (!serverStarted) {
        // Fallback: print values to terminal
        console.log('');
        console.log('  SECRETS_BLOB:');
        console.log(`  ${secretsBlob}`);
        console.log('');
        console.log('  PROJECT_KEY:');
        console.log(`  ${projectKey}`);
        console.log('');
        console.log(`  Set these as environment variables in ${platformLabel}.`);
      }

      console.log('');
    } catch (error: any) {
      if (error?.name === 'ExitPromptError') process.exit(0);
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
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

  async execute(deployIdPrefix: string): Promise<void> {
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
      serviceClient.setTokenProvider(() => authService.getValidToken());
      let authResult = await authService.authenticateSilent(orgId);
      if (!authResult.success) authResult = await authService.authenticateSilent();
      if (!authResult.success) authResult = await authService.authenticate(orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }

      await serviceClient.revokeDeployToken(deployIdPrefix);

      console.log(`  Deploy token ${deployIdPrefix.slice(0, 12)}... revoked.`);
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }
}

export class DeployListCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(): Promise<void> {
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
      serviceClient.setTokenProvider(() => authService.getValidToken());
      let authResult = await authService.authenticateSilent(orgId);
      if (!authResult.success) authResult = await authService.authenticateSilent();
      if (!authResult.success) authResult = await authService.authenticate(orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }

      const { tokens } = await serviceClient.listDeployTokens(orgId, projectId);

      if (tokens.length === 0) {
        console.log('  No deploy tokens for this project.');
        return;
      }

      console.log('');
      console.log(`  Deploy tokens for "${projectState.projectName}":`);
      console.log('');
      for (const t of tokens) {
        const status = t.revoked_at ? '\x1b[31mrevoked\x1b[0m' : '\x1b[32mactive\x1b[0m';
        const label = t.label ? ` (${t.label})` : '';
        const created = new Date(t.created_at).toLocaleDateString();
        console.log(`  ${t.deploy_id.slice(0, 12)}...${label}  ${status}  created ${created}`);
      }
      console.log('');
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';
import { execSync } from 'child_process';
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

const PLATFORMS = [
  { name: 'AWS App Runner', value: 'aws-app-runner' },
  { name: 'AWS CDK', value: 'aws-cdk' },
  { name: 'AWS ECS', value: 'aws-ecs' },
  { name: 'Azure App Service', value: 'azure-app-service' },
  { name: 'CapRover', value: 'caprover' },
  { name: 'CircleCI', value: 'circleci' },
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

const BLOB_SIZE_WARN_THRESHOLD = 32 * 1024; // 32KB

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

/**
 * Opens a URL in a minimal popup window (no tabs, no URL bar).
 * Tries Chrome/Chromium --app mode first, falls back to regular browser open.
 */
async function openPopupWindow(url: string): Promise<void> {
  const platform = process.platform;

  // Chrome/Chromium --app mode opens a clean, borderless window
  const chromePaths: string[] = platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
    : platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : [
        'google-chrome',
        'google-chrome-stable',
        'chromium',
        'chromium-browser',
        'brave-browser',
        'microsoft-edge',
      ];

  for (const browserPath of chromePaths) {
    try {
      const quotedPath = `"${browserPath}"`;
      const args = `--app=${url} --window-size=640,800`;
      if (platform === 'win32') {
        execSync(`start "" ${quotedPath} ${args}`, { stdio: 'ignore' });
      } else {
        execSync(`${quotedPath} ${args} &`, { stdio: 'ignore', shell: '/bin/sh' });
      }
      return;
    } catch {
      continue;
    }
  }

  // Fallback: regular browser open
  const open = (await import('open')).default;
  open(url).catch(() => {});
}


export class DeployCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
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
      const serviceClient = new ServiceClient(this.apiUrl);
      serviceClient.setTokenProvider(() => authService.getValidToken());
      let authResult = await authService.authenticateSilent(orgId);
      if (!authResult.success) authResult = await authService.authenticateSilent();
      if (!authResult.success) authResult = await authService.authenticate(orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }

      const userId = authResult.user_id!;

      // Step 1: Platform selection (always prompt)
      const config = readConfig(projectRoot);
      const defaultPlatform = config.platform;

      // Show "Other..." at the top as a ready-made escape hatch, with a
      // non-selectable Separator between it and the alphabetical list so
      // it doesn't read as "just another platform".
      const choices = [
        ...PLATFORMS.filter(p => p.value === 'other'),
        new inquirer.Separator(),
        ...PLATFORMS.filter(p => p.value !== 'other'),
      ];

      const answer = await inquirer.prompt([{
        type: 'list',
        name: 'platform',
        message: 'Where does this project deploy?',
        choices,
        default: defaultPlatform,
        pageSize: 20,
      }]);
      const platform = answer.platform;
      if (platform !== config.platform) {
        config.platform = platform;
        writeConfig(projectRoot, config);
      }

      const platformLabel = PLATFORMS.find(p => p.value === platform)?.name || platform!;

      // Step 2: Generate credentials
      const spinner = ora('Generating deploy credentials...').start();

      // Resolve project key from keyring (requires server co-decrypt)
      const keyOps: KeyServiceOps = {
        coDecrypt: (oid, ct) => serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
        wrapOuterLayer: (oid, pt) => serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
      };
      const pkHex = await resolveProjectKey(orgId, projectId, userId, keyOps);
      const pk = Buffer.from(pkHex, 'hex');

      // Generate deploy ID and derivation token
      const deployId = generateDeployId();
      const dt = generateDerivationToken();

      // Inner wrap PK with IK derived from DT
      const innerBlob = deployInnerWrap(pk, dt, projectId);

      // Service KMS-wraps the inner blob
      const { outer_blob: outerBlob } = await serviceClient.createDeployToken(
        orgId,
        deployId.toString('hex'),
        projectId,
        innerBlob,
      );

      // Read and decrypt all env vars to get plaintext values
      const rawEnv = fm.readEnvFile();
      const plaintextEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawEnv)) {
        if (value.startsWith('capy:')) {
          plaintextEnv[key] = fm.decryptValue(value, pkHex);
        } else {
          plaintextEnv[key] = value;
        }
      }

      if (Object.keys(plaintextEnv).length === 0) {
        spinner.fail('No secrets found in .env. Run capy first to sync secrets.');
        process.exit(1);
      }

      // Encrypt env vars with DECRYPT_KEY derived from pk + service_key, where
      // service_key is derived deterministically from innerBlob. This matches
      // what the consumer derives after fetching service_key at decrypt time,
      // so projectKey alone is insufficient to decrypt — the server's KMS-
      // gated service_key is required, preserving zero-trust.
      const encryptedVars = encryptEnvBlob(plaintextEnv, pk, innerBlob, projectId, deployId);

      // Build SECRETS_BLOB
      const secretsBlob = buildSecretsBlob(deployId, outerBlob, encryptedVars);
      const projectKey = pkHex;

      // Check blob size
      const blobSize = Buffer.from(secretsBlob, 'base64').length;
      if (blobSize > BLOB_SIZE_WARN_THRESHOLD) {
        spinner.warn(`SECRETS_BLOB is ${Math.round(blobSize / 1024)}KB — some platforms have 32-64KB env var limits. Consider splitting into multiple projects.`);
      } else {
        spinner.succeed(`Deploy credentials generated (${Object.keys(plaintextEnv).length} secrets)`);
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

          await openPopupWindow(url);
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
      const serviceClient = new ServiceClient(this.apiUrl);
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
      const serviceClient = new ServiceClient(this.apiUrl);
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

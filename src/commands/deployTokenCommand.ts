import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { resolveProjectKey } from '../crypto/keyResolver';
import {
  generateDeployId,
  generateDerivationToken,
  deployInnerWrap,
  encryptEnvBlob,
  buildSecretsBlob,
} from '../crypto/deployCrypto';
import ora from '../ui/spinner';
import inquirer from 'inquirer';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PLATFORMS = [
  { name: 'Vercel', value: 'vercel' },
  { name: 'GitHub Actions', value: 'github-actions' },
  { name: 'Render', value: 'render' },
  { name: 'Railway', value: 'railway' },
  { name: 'Fly.io', value: 'fly' },
  { name: 'Heroku', value: 'heroku' },
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

function generateDeployHtml(
  secretsBlob: string,
  projectKey: string,
  platformName: string,
  instructionMarkdown: string,
): string {
  // Escape values for safe embedding in HTML
  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Simple markdown to HTML conversion (handles ## headers, ```code blocks```, numbered lists, backtick inline)
  const mdToHtml = (md: string): string => {
    const lines = md.split('\n');
    const out: string[] = [];
    let inCode = false;
    for (const line of lines) {
      if (line.startsWith('```')) {
        if (inCode) {
          out.push('</code></pre>');
          inCode = false;
        } else {
          out.push('<pre><code>');
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        out.push(escHtml(line));
        continue;
      }
      if (line.startsWith('## ')) {
        out.push(`<h2>${escHtml(line.slice(3))}</h2>`);
      } else if (/^\d+\.\s/.test(line)) {
        const content = line.replace(/^\d+\.\s/, '');
        out.push(`<p style="margin:4px 0 4px 16px">${content.replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`);
      } else if (line.trim() === '') {
        out.push('<br>');
      } else {
        out.push(`<p>${line.replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`);
      }
    }
    if (inCode) out.push('</code></pre>');
    return out.join('\n');
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Capy Deploy — ${escHtml(platformName)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; background: #fafafa; }
    h1 { font-size: 24px; margin-bottom: 24px; }
    h2 { font-size: 18px; margin: 24px 0 12px; }
    .credential { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .credential label { font-weight: 600; display: block; margin-bottom: 8px; font-size: 14px; }
    .credential .value-row { display: flex; gap: 8px; }
    .credential textarea { flex: 1; font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 12px; padding: 8px; border: 1px solid #d0d0d0; border-radius: 4px; resize: vertical; min-height: 48px; background: #f8f8f8; }
    .credential button { padding: 8px 16px; background: #2563eb; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; white-space: nowrap; }
    .credential button:hover { background: #1d4ed8; }
    .credential button.copied { background: #16a34a; }
    .instructions { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 24px; margin-top: 24px; }
    .instructions code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 13px; }
    .instructions pre { background: #f0f0f0; padding: 12px; border-radius: 4px; overflow-x: auto; margin: 8px 0; }
    .instructions pre code { background: none; padding: 0; }
    p { line-height: 1.6; }
  </style>
</head>
<body>
  <h1>Capy Deploy</h1>

  <div class="credential">
    <label>SECRETS_BLOB</label>
    <div class="value-row">
      <textarea id="secrets-blob" readonly rows="3">${escHtml(secretsBlob)}</textarea>
      <button onclick="copyValue('secrets-blob', this)">Copy</button>
    </div>
  </div>

  <div class="credential">
    <label>PROJECT_KEY</label>
    <div class="value-row">
      <textarea id="project-key" readonly rows="1">${escHtml(projectKey)}</textarea>
      <button onclick="copyValue('project-key', this)">Copy</button>
    </div>
  </div>

  <div class="instructions">
    ${mdToHtml(instructionMarkdown)}
  </div>

  <script>
    async function copyValue(id, btn) {
      const el = document.getElementById(id);
      try {
        await navigator.clipboard.writeText(el.value);
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
      } catch {
        el.select();
      }
    }
  </script>
</body>
</html>`;
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
      const authResult = await authService.authenticate(orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }
      const token = authService.getToken();
      if (token) serviceClient.setToken(token);

      const userId = authResult.user_id!;

      // Step 1: Platform selection (always prompt)
      const config = readConfig(projectRoot);
      const defaultPlatform = config.platform;

      const answer = await inquirer.prompt([{
        type: 'list',
        name: 'platform',
        message: 'Where does this project deploy?',
        choices: PLATFORMS,
        default: defaultPlatform,
      }]);
      const platform = answer.platform;
      if (platform !== config.platform) {
        config.platform = platform;
        writeConfig(projectRoot, config);
      }

      const platformLabel = PLATFORMS.find(p => p.value === platform)?.name || platform!;

      // Step 2: Generate credentials
      const spinner = ora('Generating deploy credentials...').start();

      // Resolve project key from keyring
      const pkHex = resolveProjectKey(orgId, projectId, userId);
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

      // Encrypt all env vars into a single blob using PK
      const encryptedVars = encryptEnvBlob(plaintextEnv, pk);

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
      const html = generateDeployHtml(secretsBlob, projectKey, platformLabel, markdown);

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
          const url = `http://localhost:${addr.port}`;
          console.log(`\n  Deploy page opened at ${url}`);
          console.log('  Press Ctrl+C to close.\n');

          const open = (await import('open')).default;
          open(url).catch(() => {});
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
      console.log(`  Run ${B('capy deploy list')} to see active tokens, ${B('capy deploy revoke')} to kill old ones.`);
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
      const authResult = await authService.authenticate(orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }
      const token = authService.getToken();
      if (token) serviceClient.setToken(token);

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
      const authResult = await authService.authenticate(orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }
      const token = authService.getToken();
      if (token) serviceClient.setToken(token);

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

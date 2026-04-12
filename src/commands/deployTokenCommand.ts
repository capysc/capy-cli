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

const CAPY_LOGO_SVG = `<svg width="40" height="40" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M50 0L93.3013 25V75L50 100L6.69873 75V25L50 0Z" fill="url(#d0)"/><path d="M50 49.5V100L93.5 75V25L50 49.5Z" fill="black"/><path d="M74.5044 54V64.8832L81 67.8489L80.5617 68.8437L74.1859 65.9328L68.9222 75L68 74.4451L73.4332 65.0866V54.5453L74.5044 54Z" fill="white" stroke="white" stroke-width="2"/><path d="M29.375 53.5L10.875 33.4862L10.875 48.5L29.375 59L29.375 53.5Z" fill="black"/><defs><linearGradient id="d0" x1="50" y1="0" x2="50" y2="100" gradientUnits="userSpaceOnUse"><stop stop-opacity="0.15"/><stop offset="1" stop-opacity="0.5"/></linearGradient></defs></svg>`;

function generateDeployHtml(
  secretsBlob: string,
  projectKey: string,
  platformName: string,
  instructionMarkdown: string,
): string {
  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Convert markdown to Tailwind-styled HTML
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
          out.push('<pre class="bg-neutral-100 dark:bg-neutral-800 p-3 rounded-md overflow-x-auto my-2 text-sm"><code class="font-mono">');
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        out.push(escHtml(line));
        continue;
      }
      if (line.startsWith('## ')) {
        out.push(`<h2 class="text-lg font-semibold mt-6 mb-3 dark:text-white">${escHtml(line.slice(3))}</h2>`);
      } else if (/^\d+\.\s/.test(line)) {
        const content = line.replace(/^\d+\.\s/, '');
        out.push(`<p class="ml-4 my-1 text-neutral-700 dark:text-neutral-300">${content.replace(/`([^`]+)`/g, '<code class="bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded text-sm font-mono">$1</code>')}</p>`);
      } else if (line.trim() === '') {
        out.push('<div class="h-2"></div>');
      } else {
        out.push(`<p class="my-1 text-neutral-700 dark:text-neutral-300">${line.replace(/`([^`]+)`/g, '<code class="bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded text-sm font-mono">$1</code>')}</p>`);
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
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
  <script>
    tailwind.config = {
      darkMode: 'media',
      theme: { extend: { fontFamily: { geist: ['Geist', 'system-ui', 'sans-serif'] } } }
    }
  </script>
</head>
<body class="min-h-screen bg-white dark:bg-neutral-950 font-geist text-neutral-900 dark:text-white">
  <div class="max-w-2xl mx-auto px-5 py-12">

    <div class="flex items-center gap-3 mb-8">
      <div class="dark:invert">${CAPY_LOGO_SVG}</div>
      <h1 class="text-xl font-semibold">Deploy</h1>
    </div>

    <div class="space-y-4 mb-8">
      <div class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4">
        <label class="block text-sm font-medium mb-2 text-neutral-600 dark:text-neutral-400">SECRETS_BLOB</label>
        <div class="flex gap-2">
          <textarea id="secrets-blob" readonly rows="3" class="flex-1 font-mono text-xs p-2.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 resize-y">${escHtml(secretsBlob)}</textarea>
          <button onclick="copyValue('secrets-blob', this)" class="self-start px-3 py-2 text-sm font-medium rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors">Copy</button>
        </div>
      </div>

      <div class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4">
        <label class="block text-sm font-medium mb-2 text-neutral-600 dark:text-neutral-400">PROJECT_KEY</label>
        <div class="flex gap-2">
          <textarea id="project-key" readonly rows="1" class="flex-1 font-mono text-xs p-2.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 resize-y">${escHtml(projectKey)}</textarea>
          <button onclick="copyValue('project-key', this)" class="self-start px-3 py-2 text-sm font-medium rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors">Copy</button>
        </div>
      </div>
    </div>

    <div class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-6">
      ${mdToHtml(instructionMarkdown)}
    </div>

    <p class="mt-6 text-sm text-neutral-500">Run <code class="bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded text-xs font-mono">capy deploy list</code> to see active tokens, <code class="bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded text-xs font-mono">capy deploy revoke</code> to kill old ones.</p>
  </div>

  <script>
    async function copyValue(id, btn) {
      const el = document.getElementById(id);
      const original = btn.textContent;
      try {
        await navigator.clipboard.writeText(el.value);
        btn.textContent = 'Copied!';
        btn.classList.add('bg-green-600', 'dark:bg-green-500');
        btn.classList.remove('bg-neutral-900', 'dark:bg-white', 'dark:text-neutral-900');
        btn.classList.add('text-white', 'dark:text-white');
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove('bg-green-600', 'dark:bg-green-500', 'dark:text-white');
          btn.classList.add('bg-neutral-900', 'dark:bg-white', 'dark:text-neutral-900');
        }, 2000);
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

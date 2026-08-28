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
import { CapyError, ERROR_CODES } from '../types/index';
import ora from '../ui/spinner';
import inquirer from 'inquirer';
import { generateDeployHtml } from '../ui/deployPage/html';
import { formatRelativeTime } from '../ui/relativeTime';
import { emitHandoffUrlEvent } from '../ui/handoffEvent';
import {
  isReservedRuntimeVar,
  CURRENT_SECRETS_BLOB_VAR,
  CURRENT_DEPLOY_KEY_VAR,
} from '../core/reservedVars';
import { AuthResult } from '../types/index';
import { isInteractive, refuseNonInteractive } from '../ui/interactive';

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

/**
 * The same list the terminal picker offers, as rows the browser can draw.
 *
 * `hasConnector` is the fork the terminal renders as a dim ` (connector
 * available)` suffix — which is also the only warning that picking a platform
 * without one silently skips the next question. `connectorLabel` and
 * `connectorDetail` are the adapter's own `label` and `description`, carried
 * verbatim: `aws-ecs` maps to the AWS SSM Parameter Store adapter, so choosing
 * "AWS ECS" in the terminal lands you in a picker that never says ECS again.
 */
async function platformRows(): Promise<
  Array<{
    id: string;
    name: string;
    hasConnector: boolean;
    connectorId?: string;
    connectorLabel?: string;
    connectorDetail?: Array<string | { code: string }>;
  }>
> {
  const { getAdapter } = await import('../deploy/registry');
  // "Other..." last. The inquirer list renders it FIRST, which makes the
  // default landing row on a fresh project "none of these" — the one answer
  // that skips every connector Capy has.
  const ordered = [
    ...PLATFORMS.filter((p) => p.value !== 'other'),
    ...PLATFORMS.filter((p) => p.value === 'other'),
  ];
  return ordered.map((p) => {
    const connectorId = PLATFORM_TO_CONNECTOR[p.value];
    const adapter = connectorId ? getAdapter(connectorId) : null;
    return {
      id: p.value,
      name: p.name,
      hasConnector: !!connectorId,
      connectorId,
      connectorLabel: adapter?.label,
      connectorDetail: adapter ? [adapter.description] : undefined,
    };
  });
}

const BLOB_SIZE_WARN_THRESHOLD = 32 * 1024; // 32KB

/** Result of one full deploy-token mint. Shared by the token+docs flow and the
 * github-actions connector — both want the same `_CAPY_SECRETS_BLOB` /
 * `_CAPY_DEPLOY_KEY` pair, they just deliver it differently.
 *
 * `deployKey` is DT (a per-deploy derivation token), never the raw project
 * key (CAP-411). It decrypts nothing on its own: recovering the project key
 * from it requires a revocation-gated round trip to the service at `capy run`
 * time. Legacy `PROJECT_KEY`-based tokens are never minted by this build —
 * only pre-existing deploys still carry that shape. */
export interface MintedDeployToken {
  secretsBlob: string;
  deployKey: string;
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
 * `_CAPY_SECRETS_BLOB` + `_CAPY_DEPLOY_KEY` pair the deployed app feeds into
 * `capy run`.
 *
 * CAP-411: the artifact ships DT (`dt`), not the project key. `dt` is used
 * once, in-process, to inner-wrap `pk` into `innerBlob` — the value that
 * actually goes to the service for KMS-wrapping — and then it is returned as
 * the credential itself rather than discarded. Recovering `pk` from `dt`
 * requires `innerBlob` back from the service's `/deploy/:deployId/decrypt`,
 * which is revocation-gated, so a leaked artifact is inert after one
 * `capy deploy revoke` with no project-key rotation. `pk` itself never
 * appears in the returned material.
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

  // credential_generation tells the service which shape this token was
  // minted as, so `capy deploy list` can mark legacy (PROJECT_KEY-carrying)
  // tokens for customers to re-mint. This build only ever mints 'dt' — an
  // older CLI binary that hasn't upgraded never sends this field, and the
  // service defaults absent/unrecognized values to 'legacy', which is
  // correct: that is exactly what an unupgraded binary mints.
  const { outer_blob: outerBlob } = await serviceClient.createDeployToken(
    orgId,
    deployId.toString('hex'),
    projectId,
    innerBlob,
    'dt',
  );

  const rawEnv = fm.readEnvFile();
  const plaintextEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    // Never embed a reserved runtime variable in the artifact (CAP-424).
    // The previous deploy left its own SECRETS_BLOB in .env, so embedding it
    // would nest the last blob inside the next one and compound the size on
    // every deploy — into the 32 KB warning below and then real platform
    // limits.
    if (isReservedRuntimeVar(key)) continue;
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
    deployKey: dt.toString('hex'),
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
  const { openScreen } = await import('../ui/openScreen');
  // Wide, and not because of `Page`: this one is not a compiled screen but the
  // deploy instructions — fenced blocks of platform config someone is going to
  // read and copy. A 520px dialog would wrap every one of them.
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
  /**
   * Ask this run's questions in a browser instead of at the TTY.
   *
   * Changes only where a question is RENDERED. The same flags settle the same
   * steps, the same answers reach the same code, and nothing about what is
   * minted, written to `.capy/config`, or handed to the connector moves.
   */
  web?: boolean;
  /** Never prompt; resolve platform/mode from flags or fail fast (agents/CI). */
  nonTty?: boolean;
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
        // THROW, never console.error + process.exit. This guard sits inside the
        // try whose catch routes to `displayErrorAndExit`, which is what serves
        // the `command-error` page under `--web` and holds the process open
        // until the browser has fetched it. Exiting here never throws, so that
        // catch never ran and a `--web` caller — an agent, or a person on
        // another device with no terminal to read — got nothing at all.
        throw new CapyError(
          `No keep.lock file found. Run ${B('capy')} first to initialize.`,
          ERROR_CODES.PROJECT_NOT_INITIALIZED,
        );
      }

      const orgId = projectState.organizationId;
      const projectId = projectState.projectId;
      const projectRoot = process.cwd();

      // Authenticate
      const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
      const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
      serviceClient.setTokenProvider(() => authService.getValidToken());
      const resolveAuth = async (): Promise<AuthResult> => {
        const silentWithOrg = await authService.authenticateSilent(orgId);
        if (silentWithOrg.success) return silentWithOrg;
        const silentNoOrg = await authService.authenticateSilent();
        if (silentNoOrg.success) return silentNoOrg;
        const interactive = await authService.authenticate(orgId);
        if (interactive.success) return interactive;
        // THROW, never console.error + process.exit. `execute()`'s catch routes to
        // `displayErrorAndExit`, which serves the command-error page under `--web`
        // and holds the process open until the browser has fetched it. Exiting
        // here never throws, so that catch never ran.
        throw new CapyError('Authentication failed', ERROR_CODES.AUTH_FAILED);
      };
      const authResult = await resolveAuth();

      const userId = authResult.user_id!;

      // Steps 1 and 2: where this project deploys, and — for the five
      // platforms with a connector — whether Capy drives the deploy or just
      // mints credentials. Two questions in the terminal with nothing between
      // them; one route in the browser, declared before it opens.
      const config = readConfig(projectRoot);
      const defaultPlatform = config.platform;
      const flagPlatform = this.options.platform;
      const badPlatformFlag =
        flagPlatform !== undefined && !PLATFORMS.some(p => p.value === flagPlatform);

      // Under `--web` the browser is opened only when a question is actually
      // left. `--platform heroku` settles the whole route on its own — that
      // platform has no connector, so the mode question does not exist for it
      // — and opening a page with nothing to answer is a wait, not a wizard.
      const rows = this.options.web ? await platformRows() : [];
      const flagRow = flagPlatform ? rows.find(r => r.id === flagPlatform) : undefined;
      const webAsks =
        !!this.options.web &&
        (badPlatformFlag ||
          !flagRow ||
          (flagRow.hasConnector && this.options.mode === undefined));

      // A mode the browser answered, so the rail on the NEXT screen can say the
      // question happened. Undefined means nobody was asked.
      const resolvePlatformChoice = async (): Promise<{
        platform: string;
        modeAnswer?: string;
        webMode?: 'connector' | 'token' | null;
      }> => {
        if (webAsks) {
          if (badPlatformFlag) {
            // The terminal answers a bad --platform by printing all thirty-one
            // ids and exiting: six lines of machine text, and redundant with the
            // picker it refuses to show. The screen carries the refusal and asks
            // the question underneath it.
            console.error(`  --platform must be one of: ${PLATFORMS.map(p => p.value).join(', ')}`);
          }
          const { chooseDeployDestinationInBrowser } = await import('../ui/deployScreens');
          const picked = await chooseDeployDestinationInBrowser({
            platforms: rows,
            lastPlatform: defaultPlatform,
            platform: badPlatformFlag ? undefined : flagPlatform,
            mode: this.options.mode,
            rejected: badPlatformFlag
              ? {
                  argv: `--platform ${flagPlatform}`,
                  message: 'is not a platform Capy knows. Pick one below — the answer is remembered for this project.',
                }
              : undefined,
            open: !process.env.CAPY_WEB_NO_OPEN,
            authService,
          });
          if (picked.cancelled) {
            console.log('Cancelled.');
            process.exit(0);
          }
          return {
            platform: picked.platform,
            webMode: picked.mode,
            modeAnswer: picked.mode ? (picked.mode === 'connector' ? 'Connector' : 'Deploy token') : undefined,
          };
        }
        if (flagPlatform !== undefined) {
          if (badPlatformFlag) {
            // THROW, never console.error + process.exit. `execute()`'s catch routes to
            // `displayErrorAndExit`, which serves the command-error page under `--web`
            // and holds the process open until the browser has fetched it. Exiting
            // here never throws, so that catch never ran.
            throw new CapyError(
              `--platform must be one of: ${PLATFORMS.map(p => p.value).join(', ')}`,
              ERROR_CODES.INVALID_FORMAT,
            );
          }
          return { platform: flagPlatform };
        }
        // Bare `capy deploy` with no --platform: the picker below needs a
        // real prompt. Off a TTY (or with --non-tty) that prompt would EOF
        // silently and this command would exit 0 having saved nothing — so
        // refuse instead of ever reaching inquirer.
        if (!isInteractive(this.options.nonTty)) {
          refuseNonInteractive(
            'no platform specified and the picker needs a prompt',
            `Pass --platform <id> (available: ${PLATFORMS.map(p => p.value).join(', ')}).`,
          );
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
        return { platform: answer.platform };
      };
      const { platform, modeAnswer, webMode } = await resolvePlatformChoice();
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
        // connector pushes SECRETS_BLOB + PROJECT_KEY into GitHub repo or
        // environment secrets via the `gh` CLI; the workflow itself wraps
        // its deploy step with `capy run`. So the prompt copy differs and
        // dispatch goes to a dedicated connector instead of through
        // DeployAdapter.deploy().
        const isGhActions = connectorId === 'gh-actions';
        const resolveMode = async (): Promise<'connector' | 'token'> => {
          if (this.options.mode) return this.options.mode;
          // Already answered on the second stop of the destination route.
          if (webMode) return webMode;
          if (!isInteractive(this.options.nonTty)) {
            refuseNonInteractive(
              'no mode specified and the picker needs a prompt',
              `Pass --mode connector or --mode token.`,
            );
          }
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
          return r.mode;
        };
        const mode = await resolveMode();
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
            web: this.options.web,
            // The rail on the picker's screens continues the route this one
            // drew, rather than restarting it: these two stops were answered
            // here, and a second command drawing them as unasked would say the
            // user skipped a question they just answered.
            platformAnswer: PLATFORMS.find(p => p.value === platform)?.name,
            modeAnswer,
          });
          process.exit(code);
        }
        // else fall through to existing token+docs flow
      }

      const platformLabel = PLATFORMS.find(p => p.value === platform)?.name || platform!;

      // Step 2: Generate credentials
      const spinner = ora('Generating deploy credentials...').start();
      const mintOrExit = async (): Promise<MintedDeployToken> => {
        try {
          return await mintDeployToken({ serviceClient, fm, orgId, projectId, userId });
        } catch (err: any) {
          spinner.fail(err?.message ?? 'Failed to generate deploy credentials');
          process.exit(1);
        }
      };
      const minted = await mintOrExit();
      const { secretsBlob, deployKey, secretCount, blobBytes } = minted;
      if (blobBytes > BLOB_SIZE_WARN_THRESHOLD) {
        spinner.warn(`${CURRENT_SECRETS_BLOB_VAR} is ${Math.round(blobBytes / 1024)}KB — some platforms have 32-64KB env var limits. Consider splitting into multiple projects.`);
      } else {
        spinner.succeed(`Deploy credentials generated (${secretCount} secrets)`);
      }

      // Step 3: Fetch instructions and serve HTML page
      const { markdown } = await serviceClient.fetchDeployInstructions(platform!);
      const html = generateDeployHtml(secretsBlob, deployKey, platformLabel, platform!, markdown);

      // Try to serve via localhost (needed for clipboard API)
      const serveLocallyOrFallback = async (): Promise<boolean> => {
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
          emitHandoffUrlEvent(url, 'deploy-token');

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
      };
      const serverStarted = await serveLocallyOrFallback();

      if (!serverStarted) {
        // Fallback: print values to terminal
        console.log('');
        console.log(`  ${CURRENT_SECRETS_BLOB_VAR}:`);
        console.log(`  ${secretsBlob}`);
        console.log('');
        console.log(`  ${CURRENT_DEPLOY_KEY_VAR}:`);
        console.log(`  ${deployKey}`);
        console.log('');
        console.log(`  Set these as environment variables in ${platformLabel}.`);
      }

      console.log('');
    } catch (error: any) {
      if (error?.name === 'ExitPromptError') process.exit(0);
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }
}

/** One minted deploy token, as the listing and the confirm both read it. */
export interface DeployTokenListRow {
  deployId: string;
  label: string | null;
  createdAge: string;
  createdOn: string;
  createdBy?: string;
  revokedAge: string | null;
  /**
   * True when this token was minted in the legacy `SECRETS_BLOB` +
   * `PROJECT_KEY` shape — the deployed artifact carries the raw project key,
   * not a per-deploy derivation token (CAP-411). Optional so older/mocked
   * server responses that predate `credential_generation` degrade to
   * "unknown, not flagged" rather than a type error; `tokenRows` always sets
   * it for live data.
   */
  isLegacy?: boolean;
}

/**
 * Turn the service's token records into the rows the browser draws.
 *
 * Age is humanised here, once, so the listing and the confirm agree; the
 * absolute date is carried alongside because `toLocaleDateString()` renders
 * `7/27/2026` on one machine and `27/07/2026` on another for the same token.
 */
function tokenRows(
  tokens: Array<{
    deploy_id: string;
    label: string | null;
    created_by: string;
    created_at: string;
    revoked_at: string | null;
    credential_generation?: string;
  }>,
): DeployTokenListRow[] {
  return tokens.map(t => ({
    deployId: t.deploy_id,
    label: t.label,
    createdAge: formatRelativeTime(t.created_at),
    createdOn: new Date(t.created_at).toISOString().slice(0, 10),
    createdBy: t.created_by || undefined,
    revokedAge: t.revoked_at ? formatRelativeTime(t.revoked_at) : null,
    // Absent/unrecognized generation is treated as legacy, matching the
    // service's own default (CAP-411): a row minted before this column
    // existed, or by a CLI binary too old to send it, IS a legacy token.
    isLegacy: t.credential_generation !== 'dt',
  }));
}

/** What a typed prefix resolved to. A CODE, never a sentence to be parsed. */
export type TokenPrefixMatch =
  | { code: 'ok'; token: DeployTokenListRow }
  | { code: 'none' }
  | { code: 'ambiguous'; matches: DeployTokenListRow[] };

/**
 * Resolve the prefix a user typed to the ONE token it names.
 *
 * The terminal hands the prefix to the service and lets it pick; under `--web`
 * the whole list is already in hand, so an ambiguous prefix is a question that
 * can be answered honestly instead of resolved to whichever row happens to sort
 * first. Revoking is irreversible and cuts a live pipeline off, so "probably
 * this one" is not an answer.
 */
export function resolveTokenPrefix(
  rows: DeployTokenListRow[],
  prefix: string,
): TokenPrefixMatch {
  // An exact id is never ambiguous, whatever else it happens to prefix.
  const exact = rows.find(t => t.deployId === prefix);
  if (exact) return { code: 'ok', token: exact };
  const matches = rows.filter(t => t.deployId.startsWith(prefix));
  if (matches.length === 0) return { code: 'none' };
  if (matches.length > 1) return { code: 'ambiguous', matches };
  return { code: 'ok', token: matches[0] };
}

export class DeployRevokeCommand {
  private apiUrl?: string;
  private devMode: boolean;
  private web: boolean;

  constructor(apiUrl?: string, devMode: boolean = false, options: { web?: boolean } = {}) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
    this.web = !!options.web;
  }

  async execute(deployIdPrefix: string): Promise<void> {
    try {
      const pm = new ProjectManager();
      const projectState = await pm.detectProjectState();

      if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
        // THROW, never console.error + process.exit. `execute()`'s catch routes to
        // `displayErrorAndExit`, which serves the command-error page under `--web`
        // and holds the process open until the browser has fetched it. Exiting
        // here never throws, so that catch never ran.
        throw new CapyError(
          `No keep.lock file found. Run ${B('capy')} first to initialize.`,
          ERROR_CODES.PROJECT_NOT_INITIALIZED,
        );
      }

      const orgId = projectState.organizationId;
      const projectId = projectState.projectId;

      const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
      const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
      serviceClient.setTokenProvider(() => authService.getValidToken());
      const resolveAuth = async (): Promise<AuthResult> => {
        const silentWithOrg = await authService.authenticateSilent(orgId);
        if (silentWithOrg.success) return silentWithOrg;
        const silentNoOrg = await authService.authenticateSilent();
        if (silentNoOrg.success) return silentNoOrg;
        const interactive = await authService.authenticate(orgId);
        if (interactive.success) return interactive;
        // THROW, never console.error + process.exit. `execute()`'s catch routes to
        // `displayErrorAndExit`, which serves the command-error page under `--web`
        // and holds the process open until the browser has fetched it. Exiting
        // here never throws, so that catch never ran.
        throw new CapyError('Authentication failed', ERROR_CODES.AUTH_FAILED);
      };
      await resolveAuth();

      // The terminal fires the DELETE the moment you press enter, with no
      // summary of what is about to lose access — and a mistyped prefix and
      // a permission failure come back looking the same. Resolving the
      // prefix here, in both the terminal and `--web` paths, is what makes
      // the id `capy deploy list` prints the same id that revokes: handing
      // an unresolved prefix straight to the service let the wrong pipeline
      // lose access, and revoking cannot be undone.
      const { tokens } = await serviceClient.listDeployTokens(orgId, projectId);
      const rows = tokenRows(tokens);
      // Branch on the code, not on anything printed.
      const match = resolveTokenPrefix(rows, deployIdPrefix);
      if (match.code === 'none') {
        // THROW, never console.error + process.exit. `execute()`'s catch routes to
        // `displayErrorAndExit`, which serves the command-error page under `--web`
        // and holds the process open until the browser has fetched it. Exiting
        // here never throws, so that catch never ran.
        throw new CapyError(
          `No deploy token starting with ${deployIdPrefix.slice(0, 12)} in this project.`,
          ERROR_CODES.DEPLOY_TOKEN_NOT_FOUND,
        );
      }
      if (match.code === 'ambiguous') {
        console.error(
          `  ${match.matches.length} deploy tokens start with ${deployIdPrefix} — ` +
            `pass more of the id. Run ${B('capy deploy list')} to see them in full.`,
        );
        process.exit(1);
      }
      const subject = match.token;

      if (this.web) {
        const { showDeployTokensInBrowser } = await import('../ui/deployScreens');
        const picked = await showDeployTokensInBrowser({
          projectName: projectState.projectName ?? null,
          tokens: rows,
          view: 'confirm-revoke',
          subjectToken: subject.deployId,
          open: !process.env.CAPY_WEB_NO_OPEN,
          authService,
        });
        // A decline, a closed window and an unanswered page are one outcome and
        // it is not a failure: the token is still active, which is what the
        // user asked for. Said out loud, and exit 0.
        if (!picked.deployId) {
          console.log(`  Nothing revoked — ${subject.deployId.slice(0, 12)} is still active.`);
          return;
        }
        await serviceClient.revokeDeployToken(picked.deployId);
        console.log(`  Deploy token ${picked.deployId.slice(0, 12)}... revoked.`);
        return;
      }

      await serviceClient.revokeDeployToken(subject.deployId);

      console.log(`  Deploy token ${subject.deployId.slice(0, 12)}... revoked.`);
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }
}

export class DeployListCommand {
  private apiUrl?: string;
  private devMode: boolean;
  private web: boolean;

  constructor(apiUrl?: string, devMode: boolean = false, options: { web?: boolean } = {}) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
    this.web = !!options.web;
  }

  async execute(): Promise<void> {
    try {
      const pm = new ProjectManager();
      const projectState = await pm.detectProjectState();

      if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
        // THROW, never console.error + process.exit. `execute()`'s catch routes to
        // `displayErrorAndExit`, which serves the command-error page under `--web`
        // and holds the process open until the browser has fetched it. Exiting
        // here never throws, so that catch never ran.
        throw new CapyError(
          `No keep.lock file found. Run ${B('capy')} first to initialize.`,
          ERROR_CODES.PROJECT_NOT_INITIALIZED,
        );
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
        // THROW, never console.error + process.exit. `execute()`'s catch routes to
        // `displayErrorAndExit`, which serves the command-error page under `--web`
        // and holds the process open until the browser has fetched it. Exiting
        // here never throws, so that catch never ran.
        throw new CapyError('Authentication failed', ERROR_CODES.AUTH_FAILED);
      }

      const { tokens } = await serviceClient.listDeployTokens(orgId, projectId);

      if (this.web) {
        // The one command you reach for in a hurry is also the one with no
        // confirmation, so the browser listing carries the revoke rather than
        // making you copy an id into a second command that fires immediately.
        //
        // No `.catch()` swallowing the outcome here: a refusal — closed window,
        // nothing clicked — RESOLVES as `cancelled`, and a server that could
        // not listen is a real failure that belongs on the error screen.
        const { showDeployTokensInBrowser } = await import('../ui/deployScreens');
        const picked = await showDeployTokensInBrowser({
          projectName: projectState.projectName ?? null,
          tokens: tokenRows(tokens),
          open: !process.env.CAPY_WEB_NO_OPEN,
          authService,
        });
        if (picked.deployId) {
          await serviceClient.revokeDeployToken(picked.deployId);
          console.log(`  Deploy token ${picked.deployId.slice(0, 12)}... revoked.`);
        } else {
          // A listing that ends is a listing. Saying so is the difference
          // between "you read it and moved on" and "something went wrong".
          console.log('  Nothing revoked.');
        }
        return;
      }

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
        // CAP-411: a legacy token's deployed artifact carries the raw
        // project key rather than a per-deploy derivation token — flagged so
        // a customer can see which deploys to re-mint.
        const generation =
          (t as { credential_generation?: string }).credential_generation !== 'dt'
            ? '  \x1b[33mlegacy — carries a project key, re-mint with `capy deploy`\x1b[0m'
            : '';
        console.log(`  ${t.deploy_id.slice(0, 12)}...${label}  ${status}  created ${created}${generation}`);
      }
      console.log('');
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }
}

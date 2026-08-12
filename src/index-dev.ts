#!/usr/bin/env node
/**
 * Dev-only entrypoint for Capy CLI.
 * Enables mock authentication for local testing.
 * This file is NOT included in production builds or npm packages.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { Command } from 'commander';
import { CapyCommand } from './commands/capyCommand';
import { CliOptions } from './types/index';
import { version as CLI_VERSION } from '../package.json';
import { setWebMode } from './ui/webMode';
import { GRANT_DAEMON_SUBCOMMAND } from './auth/deviceKey/grantHolder';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** Commander accumulator for repeatable, comma-splittable options (e.g. --project). */
function collectProjects(val: string, acc: string[]): string[] {
  return acc.concat(val.split(',').map((s) => s.trim()).filter(Boolean));
}

// Handle Ctrl+C gracefully — exit cleanly instead of dumping a stack trace
process.on('uncaughtException', (error: any) => {
  if (error?.name === 'ExitPromptError') {
    console.log('\nCancelled.');
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});
process.on('unhandledRejection', (error: any) => {
  if (error?.name === 'ExitPromptError') {
    console.log('\nCancelled.');
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});

// Load .env from the CLI package directory (not the user's project cwd)
config({ path: resolve(__dirname, '..', '.env') });

// Isolate dev global state at `~/.capy-dev/` so dev tooling (e.g. sandbox nuke
// scripts) can never collateral-damage the user's prod `~/.capy/`, which holds
// recovery-equivalent wrapped master keys. Lazy-resolved in globalConfig.ts.
if (!process.env.CAPY_GLOBAL_DIR_NAME) {
  process.env.CAPY_GLOBAL_DIR_NAME = '.capy-dev';
}

// One verbosity switch for the whole CLI: diagnostic logs (see ui/debug.ts)
// are silent unless `-v`/`--verbose`. Set from argv here, at the head, before
// any command runs — the gated output lives in deep shared code that isn't
// threaded the parsed option.
if (process.argv.includes('-v') || process.argv.includes('--verbose')) {
  process.env.CAPY_VERBOSE = '1';
}

// Default to localhost for dev builds — but only when neither CAPY_API_URL nor
// a saved profile is present. Without this guard, the auto-set silently wins
// over `capy-dev byoc` profiles, making them functionally useless in dev.
// Resolution order in dev with this guard:
//   explicit CAPY_API_URL > saved profile in ~/.capy-dev/config.json > localhost
if (!process.env.CAPY_API_URL) {
  const { existsSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');
  const { homedir } = require('os') as typeof import('os');
  const configPath = join(homedir(), process.env.CAPY_GLOBAL_DIR_NAME, 'config.json');
  if (!existsSync(configPath)) {
    process.env.CAPY_API_URL = 'http://localhost:3000';
  }
}

const program = new Command();

program
  .name('capy-dev')
  .description('Capy CLI (DEV MODE - mock auth enabled)')
  .version(CLI_VERSION)
  .option('--env-path <path>', 'specify custom .env file location')
  .option('-v, --verbose', 'enable detailed logging')
  .option('-f, --force', 're-encrypt existing variables')
  .option('-d, --dry-run', 'preview changes without applying')
  .option('--web', 'render interactive steps (first-run setup / sync conflicts) in a local browser instead of TTY prompts')
  // Record `--web` once, before any handler runs, for the code that has no way
  // to ask. `displayErrorAndExit` is reached from eighteen catch blocks — a key
  // resolver, a service client, a crypto path — none of which is handed the
  // flag, and threading a boolean through every signature between here and
  // there would be forgotten on the nineteenth. Commands that decide their own
  // flow still read `command.optsWithGlobals().web`.
  .hook('preAction', (thisCommand) => {
    setWebMode(thisCommand.opts().web === true);
  })
  .action(async (options, cmd) => {
    if (cmd.args.length > 0) {
      console.log(`\n  Unknown command: ${cmd.args[0]}\n`);
      console.log('  Available commands:\n');
      console.log(`    ${B('capy-dev')}                        \x1b[90mSync secrets\x1b[0m`);
      console.log(`    ${B('capy-dev')} edit                   \x1b[90mInspect and edit secrets in a TUI\x1b[0m`);
      console.log(`    ${B('capy-dev')} branch                 \x1b[90mList secret branches\x1b[0m`);
      console.log(`    ${B('capy-dev')} checkout -b <branch>   \x1b[90mSwitch to a secret branch\x1b[0m`);
      console.log(`    ${B('capy-dev')} invite <email>         \x1b[90mInvite a teammate\x1b[0m`);
      console.log(`    ${B('capy-dev')} redeem <code>          \x1b[90mRedeem an invite code\x1b[0m`);
      console.log(`    ${B('capy-dev')} transport              \x1b[90mMove your account to another machine\x1b[0m`);
      console.log(`    ${B('capy-dev')} kick <email>           \x1b[90mRemove a teammate\x1b[0m`);
      console.log(`    ${B('capy-dev')} users                  \x1b[90mList organization members\x1b[0m`);
      console.log(`    ${B('capy-dev')} deploy                 \x1b[90mGenerate a deployment\x1b[0m`);
      console.log(`    ${B('capy-dev')} decrypt                \x1b[90mDecrypt secrets offline (owner only)\x1b[0m`);
      console.log(`    ${B('capy-dev')} end-recover            \x1b[90mEnd recovery session\x1b[0m`);
      console.log(`    ${B('capy-dev')} recover                \x1b[90mReconstruct master key from recovery phrase\x1b[0m`);
      console.log(`    ${B('capy-dev')} auth-decrypt           \x1b[90mDecrypt using auth (dev only)\x1b[0m`);
      console.log(`    ${B('capy-dev')} byoc [url]             \x1b[90mConnect to a self-hosted Capy (BYOC) instance\x1b[0m`);
      console.log(`    ${B('capy-dev')} use <profile>          \x1b[90mSwitch to a different profile\x1b[0m`);
      console.log(`    ${B('capy-dev')} profile list           \x1b[90mList configured profiles\x1b[0m`);
      console.log('');
      process.exit(1);
    }

    const cliOptions: CliOptions = {
      envPath: options.envPath,
      verbose: options.verbose,
      force: options.force,
      dryRun: options.dryRun,
      web: options.web
    };

    const command = new CapyCommand(cliOptions, true);
    await command.execute();
  });

program
  .command('branch')
  .description('List secret branches')
  .option('-D <name>', 'Delete a branch')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options, command) => {
    const { AuthService } = await import('./auth/authService');
    const { ServiceClient } = await import('./service/serviceClient');
    const { ProjectManager } = await import('./core/projectManager');

    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    if (!projectState.initialized) {
      console.error(`No keep.lock file found. Run ${B('capy-dev')} first to initialize.`);
      process.exit(1);
    }

    const authService = new AuthService(undefined, true, projectState.userId);
    const serviceClient = new ServiceClient(undefined, true);
    serviceClient.setTokenProvider(() => authService.getValidToken());
    const authResult = await authService.authenticate(projectState.organizationId);
    if (!authResult.success) {
      console.error('Authentication failed');
      process.exit(1);
    }

    try {

    // Delete branch
    if (options.D) {
      const deleteName = options.D;
      const branches = await serviceClient.listBranches(projectState.projectId!);
      const branch = branches.find(b => b.name === deleteName);

      if (!branch) {
        console.log(`Branch "${deleteName}" not found`);
        process.exit(1);
      }

      if (branch.name === projectState.activeBranch) {
        console.log(`Cannot delete the current branch. Switch first with: ${B('capy-dev checkout <other-branch>')}`);
        process.exit(1);
      }

      const inquirer = (await import('inquirer')).default;
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Delete branch "${deleteName}"? This will remove all its secrets.`,
        default: false,
      }]);

      if (!confirm) return;

      await serviceClient.deleteBranch(projectState.projectId!, branch.id);

      // v4: branches no longer stored in keep.lock, no cleanup needed
      const keep = pm.readKeepFile();

      console.log(`Deleted branch "${deleteName}"`);
      return;
    }

    const branches = await serviceClient.listBranches(projectState.projectId!);
    const activeBranch = projectState.activeBranch;
    const projectName = projectState.projectName || 'project';

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            projectName,
            activeBranch,
            branches: branches.map((b) => ({
              id: b.id,
              name: b.name,
              isProtected: b.is_protected,
              createdAt: b.created_at ?? null,
              isCurrent: b.name === activeBranch,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    // Tree view
    console.log('');
    console.log(`Project "${projectName}"`);
    branches.forEach((b, i) => {
      const isLast = i === branches.length - 1;
      const connector = isLast ? '└──' : '├──';
      const name = b.name;
      const prot = b.is_protected ? '  \x1b[90m(protected)\x1b[0m' : '';
      const isCurrent = b.name === activeBranch;
      const current = isCurrent ? '  \x1b[38;5;43m← current\x1b[0m' : '';
      console.log(`  ${connector} ${name}  ${prot}${current}`);
    });
    console.log('');

    // Prompt to switch
    const inquirer = (await import('inquirer')).default;
    const choices = branches
      .filter(b => b.name !== activeBranch)
      .map(b => ({ name: b.name, value: b.name }));

    if (choices.length > 0) {
      choices.push({ name: 'Stay on current branch', value: '__stay__' });
      const { selected } = await inquirer.prompt([{
        type: 'list',
        name: 'selected',
        message: 'Switch branch:',
        choices,
      }]);

      if (selected !== '__stay__') {
        const { CheckoutCommand } = await import('./commands/checkoutCommand');
        const cmd = new CheckoutCommand(true);
        await cmd.execute(selected, { web: command.optsWithGlobals().web === true });
      }
    }

    } catch (error: any) {
      const { displayErrorAndExit } = await import('./ui/errorScreen');
      await displayErrorAndExit(error, {
        projectName: projectState.projectName,
        projectId: projectState.projectId,
        branch: projectState.activeBranch ?? undefined,
      });
    }
  });

program
  .command('checkout <branch>')
  .description('Switch to a secret branch')
  .option('-b, --create', 'Create the branch if it does not exist')
  .option('--protected', 'Mark as a protected branch (invite-only)')
  .action(async (branch, options, command) => {
    const { CheckoutCommand } = await import('./commands/checkoutCommand');
    const cmd = new CheckoutCommand(true);
    await cmd.execute(branch, {
      create: options.create,
      protected: options.protected,
      web: command.optsWithGlobals().web === true,
    });
  });

program
  .command('push')
  .description('Push encrypted values to Keep')
  .action(async () => {
    const { PushCommand } = await import('./commands/pushCommand');
    const cmd = new PushCommand(true);
    await cmd.execute();
  });

program
  .command('status')
  .description('Show secret drift between local, pinned, and remote')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options, command) => {
    const { StatusCommand } = await import('./commands/statusCommand');
    const cmd = new StatusCommand(false, true);
    await cmd.execute({ json: options.json, web: command.optsWithGlobals().web === true });
  });

program
  .command('edit')
  .description('Inspect and edit secrets in an interactive TUI')
  .action(async (_options, command) => {
    const { EditCommand } = await import('./commands/editCommand');
    const cmd = new EditCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ web: command.optsWithGlobals().web === true });
  });

const deploy = program
  .command('deploy [target]')
  .description('Set up secret delivery — token + docs (existing) or connector deploy')
  .option('--target <id>', 'adapter id; requires --yes (CI mode)')
  .option('--yes', 'skip all prompts (CI)')
  .option('--dry-run', 'preflight + show plan, push nothing (connector mode)')
  .option('--edit', 're-enter the picker for an existing connector target')
  .option('--connect', 'force connector mode (skip the token+docs path)')
  .option('--platform <id>', 'skip platform picker (token+docs flow; e.g. github-actions, vercel)')
  .option('--mode <mode>', 'skip mode picker: "connector" or "token"')
  .option('--scope <scope>', 'gh-actions: "repo" or "env"')
  .option('--env-name <name>', 'gh-actions: env name when --scope env')
  .action(async (target: string | undefined, options: any, cmd: any) => {
    const merged = cmd.optsWithGlobals ? cmd.optsWithGlobals() : options;

    // CI/explicit connector path — go straight to the adapter flow (devMode).
    if (options.target || options.connect || target) {
      const { deployCommand } = await import('./commands/deployCommand');
      const code = await deployCommand(target, {
        target: options.target,
        yes: options.yes ?? merged.yes,
        dryRun: options.dryRun ?? merged.dryRun,
        // Same inherited-global rule as every other converted command: --web
        // is declared once on the root program, so it arrives in merged opts.
        web: merged.web === true,
        edit: options.edit,
        devMode: true,
      });
      process.exit(code);
    }

    // Default path: existing token+docs picker (auto-routes to connector mode
    // when the user picks a connector-enabled platform; that route is devMode).
    const { DeployCommand } = await import('./commands/deployTokenCommand');
    const c = new DeployCommand(process.env.CAPY_API_URL, true, {
      platform: options.platform,
      mode: options.mode,
      scope: options.scope,
      envName: options.envName,
      yes: !!options.yes,
    });
    await c.execute();
  });

deploy
  .command('revoke <deployId>')
  .description('Revoke a deploy token')
  .action(async (deployId: string, _options: unknown, command: any) => {
    const { DeployRevokeCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployRevokeCommand(process.env.CAPY_API_URL, true, {
      web: command.optsWithGlobals().web === true,
    });
    await cmd.execute(deployId);
  });

deploy
  .command('list')
  .description('List deploy tokens for this project')
  .action(async (_options, command) => {
    const { DeployListCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployListCommand(process.env.CAPY_API_URL, true, {
      web: command.optsWithGlobals().web === true,
    });
    await cmd.execute();
  });

// `targets` / `targets-remove` exist on the production binary and were missing
// here, so `capy-dev deploy targets` resolved `targets` as a TARGET NAME and
// failed with `No target named "targets"`. Dev is meant to be the same CLI
// against the dev backend; a subcommand present on one and not the other is
// drift, and it surfaced as an MCP tool that works in production and breaks in
// the only configuration anyone tests in.
deploy
  .command('targets')
  .description('List configured connector targets (connector mode)')
  .action(async (_options, command) => {
    const { deployList } = await import('./commands/deployCommand');
    process.exit(await deployList(process.cwd(), { web: command.optsWithGlobals().web === true }));
  });

deploy
  .command('targets-remove <name>')
  .description('Remove a configured connector target')
  .action(async (name: string, _options, command) => {
    const { deployRemove } = await import('./commands/deployCommand');
    process.exit(await deployRemove(name, process.cwd(), { web: command.optsWithGlobals().web === true }));
  });

program
  .command('invite <email>')
  .description('Invite a teammate to your organization')
  .option('--role <role>', 'invitee role: member | project-admin | admin')
  .option('--project <id|name>', 'grant project access (repeatable, comma-ok)', collectProjects, [])
  .option('--ttl <duration>', 'invite lifetime, e.g. 30m, 24h, 7d (or seconds)')
  .option('--expires <iso>', 'absolute expiry (ISO date); overrides --ttl')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--non-tty', 'never prompt; resolve from flags or fail fast (agents/CI)')
  .action(async (email, options, command) => {
    const { InviteCommand } = await import('./commands/inviteCommand');
    const cmd = new InviteCommand(process.env.CAPY_API_URL, true);
    await cmd.execute(email, {
      web: command.optsWithGlobals().web === true,
      role: options.role,
      projects: options.project,
      ttl: options.ttl,
      expires: options.expires,
      json: options.json,
      nonTty: options.nonTty,
    });
  });

program
  .command('redeem <code>')
  .description('Redeem an invite code to join an organization')
  .action(async (code) => {
    const { RedeemCommand } = await import('./commands/redeemCommand');
    const cmd = new RedeemCommand(process.env.CAPY_API_URL, true);
    await cmd.execute(code);
  });

program
  .command('transport')
  .description('Generate a redeem code to move your account to another machine')
  .action(async (_options, command) => {
    const { TransportCommand } = await import('./commands/transportCommand');
    const cmd = new TransportCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ web: command.optsWithGlobals().web === true });
  });

program
  .command('pair')
  .description('Sign this headless machine in with a code entered on another device (no browser needed here)')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--ttl-minutes <n>', 'granted device-key lifetime in minutes (default 30)', (v) => parseInt(v, 10))
  .action(async (options) => {
    const { PairCommand } = await import('./commands/pairCommand');
    const cmd = new PairCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ json: options.json, ttlMinutes: options.ttlMinutes });
  });

program
  .command('kick <email>')
  .description('Remove a teammate from this organization')
  .action(async (email, _options, command) => {
    const { KickCommand } = await import('./commands/kickCommand');
    const cmd = new KickCommand(process.env.CAPY_API_URL, true);
    await cmd.execute(email, { web: command.optsWithGlobals().web === true });
  });

program
  .command('auth-decrypt')
  .description('Decrypt .env file back to plaintext using auth (dev only)')
  .option('--env-path <path>', 'specify custom .env file location')
  .action(async (options) => {
    const { FileManager } = await import('./files/fileManager');
    const { ProjectManager } = await import('./core/projectManager');
    const { resolveProjectKey } = await import('./crypto/keyResolver');
    const { AuthService } = await import('./auth/authService');
    const { ServiceClient } = await import('./service/serviceClient');

    const fm = new FileManager();
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();

    if (!keep) {
      console.error(`No keep.lock file found. Run ${B('capy-dev')} first to initialize.`);
      process.exit(1);
    }

    // Authenticate and resolve key (requires server co-decrypt for KMS unwrap)
    let encryptionKey: string;
    try {
      const syncState = pm.readSyncState();
      const authService = new AuthService(undefined, true, syncState?.user_id);
      const serviceClient = new ServiceClient(undefined, true);
      serviceClient.setTokenProvider(() => authService.getValidToken());
      const authResult = await authService.authenticateSilent(keep.org_id);
      if (!authResult.success) {
        throw new Error(`${authResult.error || 'Not authenticated'} — run ${B('capy-dev')} first`);
      }

      const keyOps = {
        coDecrypt: (oid: string, ct: string) => serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
        wrapOuterLayer: (oid: string, pt: string) => serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
      };
      encryptionKey = await resolveProjectKey(keep.org_id, keep.project_id, authResult.user_id!, keyOps);
    } catch {
      console.error(`Cannot decrypt — server co-sign required. Run ${B('capy-dev')} first to sync.`);
      process.exit(1);
    }

    const envPath = options.envPath || '.env';

    try {
      const decrypted = fm.readEncryptedEnvFile(encryptionKey, envPath);

      if (Object.keys(decrypted).length === 0) {
        console.log('No variables found in .env');
        process.exit(0);
      }

      const { writeFileSync } = await import('fs');
      const { dotenvEscape } = await import('./commands/exportCommand');
      // Escape so multi-line secrets survive being re-read by dotenv.
      const content = Object.entries(decrypted)
        .map(([key, value]) => `${key}=${dotenvEscape(value as string)}`)
        .join('\n');

      writeFileSync(envPath, content + '\n', 'utf-8');
      console.log(`Decrypted ${Object.keys(decrypted).length} variable(s) in ${envPath}`);
    } catch (error: any) {
      const { displayErrorAndExit } = await import('./ui/errorScreen');
      await displayErrorAndExit(error, {
        projectName: keep.project_name,
        projectId: keep.project_id,
      });
    }
  });

program
  .command('logout')
  .description('End the current session')
  .action(async () => {
    const { existsSync, unlinkSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { getGlobalCapyDir } = await import('./config/globalConfig');

    const capyDir = join(process.cwd(), '.capy');
    const sessionFiles = ['token'];

    let cleared = false;
    for (const file of sessionFiles) {
      const filePath = join(capyDir, file);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        cleared = true;
      }
    }

    // Drop user_id from .capy/sync-state — see logout in src/index.ts for the
    // full reasoning. Short version: prevents the next `capy` from pinning
    // the previous user's session on shared eval machines.
    try {
      const { ProjectManager } = await import('./core/projectManager');
      if (new ProjectManager().clearSyncStateUserId()) cleared = true;
    } catch {
      // best-effort
    }

    // Clear global auth session and project key caches
    const globalCapyDir = getGlobalCapyDir();
    const authSession = join(globalCapyDir, 'auth', 'session.json');
    if (existsSync(authSession)) {
      unlinkSync(authSession);
      cleared = true;
    }

    // Clear per-user session files
    const sessionsDir = join(globalCapyDir, 'auth', 'sessions');
    if (existsSync(sessionsDir)) {
      rmSync(sessionsDir, { recursive: true, force: true });
      cleared = true;
    }

    // Clear project key caches (master keys survive logout — they require the seed phrase)
    const orgsDir = join(globalCapyDir, 'orgs');
    if (existsSync(orgsDir)) {
      const { readdirSync } = await import('fs');
      for (const orgId of readdirSync(orgsDir)) {
        const projectsDir = join(orgsDir, orgId, 'projects');
        if (existsSync(projectsDir)) {
          rmSync(projectsDir, { recursive: true, force: true });
          cleared = true;
        }
      }
    }

    // Force the next OAuth round-trip to re-prompt instead of reusing the
    // AuthKit SSO cookie — see logout in src/index.ts for full reasoning.
    try {
      const { setForceLoginMarker } = await import('./config/globalConfig');
      setForceLoginMarker();
    } catch {
      // best-effort
    }

    if (cleared) {
      console.log('Logged out. Session cleared.');
    } else {
      console.log('No active session.');
    }
  });

program
  .command('org')
  .description('Switch organization')
  .action(async (_options, command) => {
    const { OrgCommand } = await import('./commands/orgCommand');
    // OrgCommand takes it at construction — see its own note on why a
    // subcommand must read the inherited global rather than its own options.
    const cmd = new OrgCommand(process.env.CAPY_API_URL, true, {
      web: command.optsWithGlobals().web === true,
    });
    await cmd.execute();
  });

program
  .command('info')
  .description('Show current session info')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    const { InfoCommand } = await import('./commands/infoCommand');
    const cmd = new InfoCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ json: options.json });
  });

program
  .command('list')
  .description('List variable names + connector metadata for the active branch (no values)')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    const { ListCommand } = await import('./commands/listCommand');
    const cmd = new ListCommand(true);
    await cmd.execute({ json: options.json });
  });

program
  .command('users')
  .description('List organization members and their project access')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    const { UsersCommand } = await import('./commands/usersCommand');
    const cmd = new UsersCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ json: options.json });
  });

program
  .command('grant-branch <email> <project> <branch>')
  .description('Grant a member wildcard access to a protected branch')
  .action(async (email: string, project: string, branch: string) => {
    const { UsersCommand } = await import('./commands/usersCommand');
    const cmd = new UsersCommand(process.env.CAPY_API_URL, true);
    await cmd.grantBranch(email, project, branch);
  });

program
  .command('revoke-branch <email> <project> <branch>')
  .description("Revoke a member's wildcard access to a protected branch")
  .action(async (email: string, project: string, branch: string) => {
    const { UsersCommand } = await import('./commands/usersCommand');
    const cmd = new UsersCommand(process.env.CAPY_API_URL, true);
    await cmd.revokeBranch(email, project, branch);
  });

program
  .command('byoc [url]')
  .description('Connect to a self-hosted Capy (BYOC) instance')
  .action(async (url: string | undefined, _options: unknown, command: any) => {
    const { byocCommand } = await import('./commands/byocCommand');
    process.exit(await byocCommand(url, { web: command.optsWithGlobals().web === true }));
  });

program
  .command('use <profile>')
  .description('Switch to a different profile')
  .action(async (name: string) => {
    const { useCommand } = await import('./commands/profileCommand');
    process.exit(await useCommand(name));
  });

const profileCmd = program
  .command('profile')
  .description('Manage CLI profiles (cloud, BYOC, etc.)');

profileCmd
  .command('list')
  .description('List configured profiles')
  .action(async () => {
    const { profileListCommand } = await import('./commands/profileCommand');
    process.exit(await profileListCommand());
  });

profileCmd
  .command('show [name]')
  .description('Show profile details (defaults to active)')
  .action(async (name?: string) => {
    const { profileShowCommand } = await import('./commands/profileCommand');
    process.exit(await profileShowCommand(name));
  });

profileCmd
  .command('remove <name>')
  .description('Delete a profile')
  .action(async (name: string) => {
    const { profileRemoveCommand } = await import('./commands/profileCommand');
    process.exit(await profileRemoveCommand(name));
  });

program
  .command('cleanup')
  .description('Remove Capy git hooks from this repository')
  .action(async () => {
    const { execSync } = await import('child_process');
    const { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } = await import('fs');

    let gitDir: string;
    try {
      gitDir = execSync('git rev-parse --git-dir', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    } catch {
      console.log('Not a git repository.');
      return;
    }

    const hooksDir = `${gitDir}/hooks`;
    const MARKER = '# --- capy auto-sync (do not remove) ---';
    const END_MARKER = '# --- end capy ---';
    const hookNames = ['post-checkout', 'post-merge', 'pre-push'];
    let removed = false;

    for (const hookName of hookNames) {
      const hookPath = `${hooksDir}/${hookName}`;
      if (!existsSync(hookPath)) continue;

      const content = readFileSync(hookPath, 'utf-8');
      if (!content.includes(MARKER)) continue;

      const escMarker = MARKER.replace(/[()]/g, '\\$&');
      const escEnd = END_MARKER.replace(/[()]/g, '\\$&');
      const re = new RegExp(`${escMarker}[\\s\\S]*?${escEnd}\\n?`);
      const updated = content.replace(re, '').trim();

      if (!updated || /^#!.*sh$/.test(updated)) {
        unlinkSync(hookPath);
      } else {
        writeFileSync(hookPath, updated + '\n', 'utf-8');
        chmodSync(hookPath, 0o755);
      }
      removed = true;
      console.log(`Removed ${B('Capy')} hook from ${hookName}`);
    }

    if (removed) {
      console.log(`${B('Capy')} git hooks removed.`);
    } else {
      console.log(`No ${B('Capy')} hooks found.`);
    }
  });

program
  .command('decrypt')
  .description('Decrypt secrets offline using seed phrase (owner only)')
  .action(async (_options, command) => {
    const { DecryptCommand } = await import('./commands/decryptCommand');
    const cmd = new DecryptCommand();
    await cmd.execute({ web: command.optsWithGlobals().web === true });
  });

program
  .command('end-recover')
  .description('End recovery session and clean up decrypted files')
  .action(async (_options, command) => {
    const { EndRecoverCommand } = await import('./commands/endRecoverCommand');
    const cmd = new EndRecoverCommand();
    await cmd.execute({ web: command.optsWithGlobals().web === true });
  });

program
  .command('recover')
  .description('Reconstruct the wrapped master key from a 24-word recovery phrase')
  .action(async (_options, command) => {
    const { RecoverCommand } = await import('./commands/recoverCommand');
    const cmd = new RecoverCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ web: command.optsWithGlobals().web === true });
  });

const deviceKeyCmd = program
  .command('device-key')
  .description('Manage device keys (CAPY_DEVICE_KEYS=1) — passwordless onboarding for new machines');

deviceKeyCmd
  .command('enroll')
  .description('Enroll a device key for this account on this machine')
  .action(async () => {
    const { DeviceKeyEnrollCommand } = await import('./commands/deviceKeyCommand');
    const cmd = new DeviceKeyEnrollCommand(process.env.CAPY_API_URL, true);
    await cmd.execute();
  });

deviceKeyCmd
  .command('list')
  .description('List this account\'s enrolled device keys')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--include-deleted', 'include removed wrappers')
  .action(async (options) => {
    const { DeviceKeyListCommand } = await import('./commands/deviceKeyCommand');
    const cmd = new DeviceKeyListCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ json: options.json, includeDeleted: options.includeDeleted });
  });

deviceKeyCmd
  .command('remove <id>')
  .description('Remove (soft-delete) a device key wrapper by id')
  .action(async (id: string) => {
    const { DeviceKeyRemoveCommand } = await import('./commands/deviceKeyCommand');
    const cmd = new DeviceKeyRemoveCommand(process.env.CAPY_API_URL, true);
    await cmd.execute(id);
  });

deviceKeyCmd
  .command('grant')
  .description('Grant a temporary, in-memory device key to this (sandboxed) session — never written to disk')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--label <name>', 'display label the ceremony page shows (defaults to this host\'s name)')
  .option('--ttl-minutes <n>', 'grant lifetime in minutes (default 30)', (v) => parseInt(v, 10))
  .action(async (options) => {
    const { DeviceKeyGrantCommand } = await import('./commands/deviceKeyCommand');
    const cmd = new DeviceKeyGrantCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ json: options.json, label: options.label, ttlMinutes: options.ttlMinutes });
  });

// CAP-384: internal-only — see index.ts's identical registration for why.
program
  .command(GRANT_DAEMON_SUBCOMMAND, { hidden: true })
  .action(async () => {
    const { runGrantDaemonForever } = await import('./auth/deviceKey/grantHolder');
    await runGrantDaemonForever(process.stdin);
  });

program
  .command('doors')
  .description('List everything that can act as you: device keys, org key copies, sessions')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    const { DoorsCommand } = await import('./commands/doorsCommand');
    const cmd = new DoorsCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ json: options.json });
  });

program
  .command('run')
  .description('Run a command with decrypted secrets')
  .allowUnknownOption()
  .helpOption(false)
  .action(async (_opts: any, cmd: any) => {
    const { runCommand } = await import('./commands/runCommand');
    const dashIdx = process.argv.indexOf('--');
    const childArgs = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : cmd.args;
    const code = await runCommand(childArgs, true);
    process.exit(code);
  });

program
  .command('add <vars...>')
  .description('Add one or more secret values to the project (encrypts + syncs)')
  .option('--reason <text>', 'short note shown on the intake page')
  .option(
    '--help-url <NAME=URL>',
    'per-variable "where to find this" link, e.g. STRIPE_SECRET_KEY=https://dashboard.stripe.com/apikeys (repeatable)',
    (val: string, acc: string[]) => {
      acc.push(val);
      return acc;
    },
    [] as string[],
  )
  .option('--no-open', 'do not auto-open the browser; print the URL only')
  .option('--no-push', 'write to .env only; do not push to Capy')
  .option('-f, --force', 'overwrite existing values without prompting')
  .option('--non-tty', 'never prompt; resolve from flags or fail fast (agents/CI)')
  .action(async (varNames, options, command) => {
    const { AddCommand } = await import('./commands/addCommand');
    const cmd = new AddCommand(true); // devMode: dev backend + ~/.capy-dev
    const merged = command.optsWithGlobals();
    await cmd.execute(varNames, {
      web: command.optsWithGlobals().web === true,
      reason: options.reason,
      helpUrls: options.helpUrl,
      open: options.open,
      noPush: options.push === false,
      force: merged.force,
      nonTty: options.nonTty,
    });
  });

program
  .command('connect [provider]')
  .description('Link an existing .env variable to a third-party provider')
  .option('--live', 'use live mode (default: test)')
  .option('--var <name>', 'which existing env var the connection describes')
  .option('--account <id>', 'pick a specific provider account when multiple are configured')
  .option('--no-push', 'record the link locally; do not push it to Capy')
  .option('--non-tty', 'never prompt; resolve choices from flags or fail fast (agents/CI)')
  .option('--reauth', 'pair with the provider again even if a usable session exists')
  .action(async (provider, options, command) => {
    const { ConnectCommand } = await import('./commands/connectCommand');
    const cmd = new ConnectCommand(true); // devMode: hard-blocks live
    // Globals, because `--web` is declared once on the root program. Dropping
    // it here is not a no-op: `ConnectCommand` reads `opts.web` to decide
    // between the browser route and the TTY prompts, so an unpassed flag makes
    // `capy-dev connect stripe --web` silently answer in the terminal — or
    // fail as "ambiguous without a prompt" when there isn't one. That is the
    // dev binary, which is the only one the Stripe sandbox flow ever runs.
    const merged = command.optsWithGlobals();
    const web = merged.web === true;
    if (!provider) {
      await cmd.list({ web });
      return;
    }
    await cmd.execute(provider, {
      web,
      live: options.live,
      var: options.var,
      account: options.account,
      noPush: options.push === false,
      nonTty: options.nonTty,
      reauth: options.reauth === true,
    });
  });

program
  .command('rotate [var]')
  .description('Rotate a managed credential previously set up via `capy connect`')
  .option('--all', 'rotate every managed credential in this project')
  .option('--no-push', 'update .env only; do not push to Capy')
  .option('-y, --yes', 'skip prompts; run rotate + push unattended (for CI/automation)')
  .option('--skip-prompts', 'alias for --yes')
  .option('--non-tty', 'never prompt; resolve choices from flags or fail fast (agents/CI)')
  .option('--provider <name>', 'integration to promote an unmanaged var through (non-interactive)')
  .action(async (varName, options, command) => {
    const { RotateCommand } = await import('./commands/rotateCommand');
    const cmd = new RotateCommand(true); // devMode: skips live entries
    await cmd.execute(varName, {
      web: command.optsWithGlobals().web === true,
      all: options.all,
      noPush: options.push === false,
      skipPrompts: !!(options.yes || options.skipPrompts),
      nonTty: options.nonTty,
      provider: options.provider,
    });
  });

program
  .command('ui-preview <screen>')
  .description('[dev] Serve an embedded browser screen via the secure local screen server')
  .option('--data <json>', 'JSON payload to inject as window.__CAPY_DATA__')
  .option('--no-open', 'print the URL instead of opening a browser')
  .action(async (screen, options) => {
    const { ScreenServer } = await import('./ui/screens/serve');
    const { SCREEN_HTML } = await import('./ui/screens/generated');
    if (!(screen in SCREEN_HTML)) {
      console.error(`Unknown screen "${screen}". Available: ${Object.keys(SCREEN_HTML).join(', ')}`);
      process.exit(1);
    }
    const name = screen as keyof typeof SCREEN_HTML;
    const data = JSON.parse(options.data ?? '{}');
    const server = new ScreenServer(name, data, { timeoutMs: 300000 });
    const url = await server.start();
    console.log(`Serving ${B(screen)} at ${url}`);
    console.log('One-time token URL — a second request will 404. Ctrl+C to stop.');
    if (options.open !== false) {
      // The same window a real run of this screen would get, so what is being
      // previewed here is what ships.
      const { openScreen } = await import('./ui/openScreen');
      const { SCREEN_WIDE } = await import('./ui/screens/generated');
      await openScreen(url, { kind: 'dialog', wide: SCREEN_WIDE[name] });
    }
  });

program.parse(process.argv);

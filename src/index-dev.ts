#!/usr/bin/env node
/**
 * Dev-only entrypoint for Capy CLI.
 * Enables mock authentication for local testing.
 * This file is NOT included in production builds or npm packages.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { Command, Option } from 'commander';
import { CapyCommand } from './commands/capyCommand';
import { CliOptions } from './types/index';
import { version as CLI_VERSION } from '../package.json';
import { refuseWebMode } from './core/webModeRemoved';
import { ACCENT } from './ui/colors';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** Commander accumulator for repeatable options whose values are taken whole (e.g. --row, --exclude). */
function collectRepeatable(val: string, acc: string[]): string[] {
  return acc.concat(val);
}

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
  // Hidden: `--web` was removed. It still parses so the hook below can refuse it (WEB_MODE_REMOVED).
  .addOption(new Option('--web').hideHelp())
  // Root help only (Commander scopes addHelpText to the command it's called
  // on) — points an agent at `capy help --json` for the full, drift-proof
  // command reference (CAP-681).
  .addHelpText('after', '\nAgents: run `capy help --json` for a machine-readable command reference.')
  // `--web` is gone: refuse it before any handler runs, so an agent that still
  // passes it is told so instead of having the command run unattended.
  .hook('preAction', (_thisCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals();
    if (opts.web === true) refuseWebMode(opts.json === true);
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
      dryRun: options.dryRun
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
      const current = isCurrent ? `  ${ACCENT}← current\x1b[0m` : '';
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
        await cmd.execute(selected);
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
    await cmd.execute({ json: options.json });
  });

program
  .command('edit [name]')
  // COPY-FLAG — minimal-neutral; names the two modes.
  .description('Inspect and edit secrets in an interactive TUI, or set one variable from a piped value')
  .option('--no-push', 'piped value: write .env only; do not push to Capy')
  .option('--json', 'emit machine-readable JSON instead of the human UI (piped value)')
  .option('--non-tty', 'treat stdin as not a terminal; never prompt (agents/CI)')
  .option('--pr', 'create a PR with the keep.lock change (answers the prompt)') // COPY-FLAG
  .option('--no-pr', 'do not create a PR with the keep.lock change') // COPY-FLAG
  .option('--pr-base <branch>', 'base branch for the PR (answers the prompt)') // COPY-FLAG
  .addHelpText(
    'after',
    // COPY-FLAG
    '\n' +
      'With a name and a piped value, sets that one variable. The value is read from stdin only:\n' +
      '  <cmd> | capy-dev edit NAME --json\n',
  )
  .action(async (name, options, command) => {
    const { EditCommand } = await import('./commands/editCommand');
    const { prFlagsFromCommand } = await import('./commands/keepLockPr');
    const cmd = new EditCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({
      name,
      json: options.json,
      noPush: options.push === false,
      nonTty: options.nonTty,
      pr: prFlagsFromCommand(command, options.prBase),
      // The program-level `--dry-run`, wherever it was typed.
      dryRun: command.optsWithGlobals().dryRun === true,
    });
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
  // COPY-FLAG: the option descriptions of `deploy <target> --discover` are minimal and neutral.
  .option('--discover', 'dokploy: find the services that match Capy projects and print JSON (never prompts)')
  .option('--plan <file>', 'dokploy --discover: the plan file to check (see schemas.deploy_dokploy_plan in `capy help --json`)')
  .option('--confirm <plan_id>', 'dokploy --discover: write the plan that --dry-run printed (one PR per repo)')
  .option('--base-url <url>', 'dokploy --discover: the Dokploy dashboard URL (else the org system variable _CONNECTOR_DOKPLOY_BASE_URL)')
  .action(async (target: string | undefined, options: any, cmd: any) => {
    const merged = cmd.optsWithGlobals ? cmd.optsWithGlobals() : options;

    // `capy-dev deploy dokploy --discover` (CAP-703): always JSON, never prompts.
    const { routeDeployDiscover } = await import('./commands/deployDiscover/route');
    const discoverCode = await routeDeployDiscover(target, options, (options.dryRun ?? merged.dryRun) === true, true);
    if (discoverCode !== undefined) process.exit(discoverCode);

    // CI/explicit connector path — go straight to the adapter flow (devMode).
    if (options.target || options.connect || target) {
      const { deployCommand } = await import('./commands/deployCommand');
      const code = await deployCommand(target, {
        target: options.target,
        yes: options.yes ?? merged.yes,
        dryRun: options.dryRun ?? merged.dryRun,
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
    const cmd = new DeployRevokeCommand(process.env.CAPY_API_URL, true);
    await cmd.execute(deployId);
  });

deploy
  .command('list')
  .description('List deploy tokens for this project')
  .action(async (_options, command) => {
    const { DeployListCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployListCommand(process.env.CAPY_API_URL, true);
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
    process.exit(await deployList(process.cwd()));
  });

deploy
  .command('targets-remove <name>')
  .description('Remove a configured connector target')
  .action(async (name: string, _options, command) => {
    const { deployRemove } = await import('./commands/deployCommand');
    process.exit(
      await deployRemove(name, process.cwd(), { devMode: true }),
    );
  });

program
  .command('invite <email>')
  .description('Invite a teammate to your organization')
  .option('--role <role>', 'invitee role: member | project-admin | admin')
  .option('--project <id|name>', 'grant project access (repeatable, comma-ok)', collectProjects, [])
  .option('--ttl <duration>', 'invite lifetime, max 12h, e.g. 30m, 2h, 12h (or seconds)')
  .option('--expires <iso>', 'absolute expiry (ISO date); overrides --ttl')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--non-tty', 'never prompt; resolve from flags or fail fast (agents/CI)')
  .action(async (email, options, command) => {
    const { InviteCommand } = await import('./commands/inviteCommand');
    const cmd = new InviteCommand(process.env.CAPY_API_URL, true);
    await cmd.execute(email, {
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
  .description('Move your local key to another device via Keep (prints a QR code + link)')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    const { TransportCommand } = await import('./commands/transportCommand');
    const cmd = new TransportCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ json: options.json === true });
  });

program
  .command('login')
  .description('Sign in and pair this device via Keep')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    const { loginCommand } = await import('./commands/loginCommand');
    await loginCommand({ json: options.json === true, devMode: true });
  });

program
  .command('pair')
  .description('Pair this device via Keep; requires interactive confirmation of the returned account before installing any session or keys')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--force', 'overwrite a different local key already on this machine')
  .addHelpText('after', '\nAfter browser approval, type the returned account\'s local part (before @) exactly to continue.\nAgents: use an interactive terminal/PTY and have a human type that local part. Never derive, prefill, auto-submit, or pipe the answer. No upfront email is required.\n')
  .action(async (options) => {
    const { pairCommand } = await import('./commands/pairCommand');
    await pairCommand({ json: options.json === true, force: options.force === true, apiUrl: process.env.CAPY_API_URL, devMode: true });
  });

program
  .command('kick <email>')
  .description('Remove a teammate from this organization')
  .action(async (email, _options, command) => {
    const { KickCommand } = await import('./commands/kickCommand');
    const cmd = new KickCommand(process.env.CAPY_API_URL, true);
    await cmd.execute(email);
  });

const systemCmd = program
  .command('system')
  .description('Manage this org\'s system store (connector credentials, CAP-664)');

systemCmd
  .command('set <name>')
  .description('Set a connector credential (hidden prompt; owners/admins only)')
  .option('--org <id>', 'org id, if you belong to more than one')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (name: string, options: any) => {
    const { systemSetCommand } = await import('./commands/systemCommand');
    await systemSetCommand(name, { org: options.org, json: options.json, apiUrl: process.env.CAPY_API_URL, devMode: true });
  });

systemCmd
  .command('list')
  .description('List connector credential names (never values; owners/admins only)')
  .option('--org <id>', 'org id, if you belong to more than one')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options: any) => {
    const { systemListCommand } = await import('./commands/systemCommand');
    await systemListCommand({ org: options.org, json: options.json, apiUrl: process.env.CAPY_API_URL, devMode: true });
  });

systemCmd
  .command('rm <name>')
  .description('Remove a connector credential (asks for confirmation; owners/admins only)')
  .option('--org <id>', 'org id, if you belong to more than one')
  .option('--yes', 'skip the confirmation prompt')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (name: string, options: any) => {
    const { systemRmCommand } = await import('./commands/systemCommand');
    await systemRmCommand(name, { org: options.org, json: options.json, yes: options.yes, apiUrl: process.env.CAPY_API_URL, devMode: true });
  });

program
  .command('help')
  .description('Show help information')
  .option('--json', 'emit a machine-readable command reference instead of human help')
  .action(async (options) => {
    if (options.json) {
      const { buildCliHelpDoc } = await import('./core/cliHelpDoc');
      console.log(JSON.stringify(buildCliHelpDoc(program), null, 2));
      return;
    }
    program.outputHelp();
  });

program
  .command('agents')
  .description('Tell AI coding agents in this repo how to use Capy (writes AGENTS.md / CLAUDE.md)')
  .option('--print', 'print the block to stdout without writing anything')
  .option('--remove', 'remove the block from AGENTS.md / CLAUDE.md')
  .option('-y, --yes', 'skip the confirmation prompt (required non-interactively)')
  .option('--non-tty', 'never prompt; resolve from flags or fail fast (agents/CI)')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .addHelpText(
    'after',
    // COPY-FLAG — minimal-neutral; names what the block contains
    // structurally rather than any approved marketing wording.
    '\n' +
      'The block tells an AI coding agent to run `capy help --json` and branch on error codes, never on message text.\n' +
      '\n' +
      'Examples:\n' +
      '  capy agents --print\n' +
      '  capy agents --yes\n' +
      '  capy agents --remove --yes\n' +
      '  capy agents --json --yes\n' +
      '  capy agents --dry-run\n' +
      '  capy agents --remove --dry-run --json',
  )
  .action(async (options, command) => {
    const { agentsCommand } = await import('./commands/agentsCommand');
    // `--dry-run` is declared once on the root program; read it from the
    // merged globals so `capy agents --dry-run` and `capy --dry-run agents` both work.
    await agentsCommand({
      print: options.print,
      remove: options.remove,
      json: options.json,
      yes: options.yes,
      nonTty: options.nonTty,
      dryRun: command.optsWithGlobals().dryRun === true,
    });
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
    const resolveKey = async (): Promise<string | null> => {
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
      return await resolveProjectKey(keep.org_id, keep.project_id, authResult.user_id!, keyOps);
    } catch {
      return null;
    }
    };
    const encryptionKey = await resolveKey();
    if (encryptionKey === null) {
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

      const { writeFileSync, readFileSync } = await import('fs');
      const { dotenvEscape } = await import('./commands/exportCommand');
      const { upsertEnvText } = await import('./files/envUpsert');
      // Escape so multi-line secrets survive being re-read by dotenv. Values are
      // upserted in place so the file's comments, dividers and order survive.
      const entries = Object.entries(decrypted).map(([key, value]) => [key, dotenvEscape(value as string)] as const);
      const content = upsertEnvText(readFileSync(envPath, 'utf-8'), {}, entries);

      writeFileSync(envPath, content, 'utf-8');
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
    const cmd = new OrgCommand(process.env.CAPY_API_URL, true);
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
  .command('projects')
  .description('List projects in the active organization and their branches')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    const { ProjectsCommand } = await import('./commands/projectsCommand');
    const cmd = new ProjectsCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ json: options.json });
  });

const secretsCmd = program
  .command('secrets')
  .description('List every secret name across the active organization, grouped by value (read-only, never shows a value)')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--project <name>', 'only rows with a location in this project')
  .option('--branch <name>', 'only rows with a location on this branch')
  .option('--name <NAME>', 'only rows with exactly this secret name') // COPY-FLAG
  .action(async (options, command) => {
    const { SecretsCommand } = await import('./commands/secretsCommand');
    const cmd = new SecretsCommand(process.env.CAPY_API_URL, true);
    await cmd.execute({ json: options.json, project: options.project, branch: options.branch, name: options.name, dryRun: command.optsWithGlobals().dryRun === true });
  });

secretsCmd
  .command('set <name>')
  // COPY-FLAG: minimal-neutral. Agent mode: never prompts; the value is read from stdin only.
  .description('Set one secret to a new value (read from stdin) in several locations and open keep.lock PRs. Never prompts.')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  // COPY-FLAG: the option descriptions of `secrets set` are minimal and neutral.
  .option('--row <row_id>', 'change this row of that name (repeatable; ids from `capy secrets --name NAME --json`)', collectRepeatable, [])
  .option('--all-rows', 'change every row of that name')
  .option('--exclude <project:branch>', 'leave this location out (repeatable)', collectRepeatable, [])
  .addOption(new Option('--no-pr-for <owner/name>', 'do not open a PR in this repo (repeatable)').argParser(collectRepeatable).default([]))
  .option('--no-pr', 'do not open any PR')
  .option('--confirm <plan_id>', 'run the plan that --dry-run printed (required for a real run)')
  .addHelpText(
    'after',
    // COPY-FLAG
    '\n' +
      'Agents: look the rows up, show the human a table, let the human pick the row(s), dry run, get approval, then run with --confirm. Never pick a row yourself.\n' +
      '  capy secrets --name NAME --json\n' +
      '  <cmd> | capy secrets set NAME --row <row_id> --dry-run --json\n' +
      '  <cmd> | capy secrets set NAME --row <row_id> --confirm <plan_id> --json\n',
  )
  .action(async (name: string, options: any, command: any) => {
    // `--json` is also a `capy secrets` option, which Commander lets the parent claim;
    // `--dry-run` is the program-level flag. Read both from the merged options.
    const merged = command.optsWithGlobals();
    const { secretsSetCommand } = await import('./commands/secretsSetCommand');
    const code = await secretsSetCommand(
      name,
      {
        json: merged.json === true,
        dryRun: merged.dryRun === true,
        confirm: options.confirm,
        row: options.row,
        allRows: options.allRows === true,
        exclude: options.exclude,
        noPrFor: options.prFor,
        noPr: options.pr === false,
      },
      true,
    );
    process.exit(code);
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
    process.exit(await byocCommand(url));
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
    await cmd.execute();
  });

program
  .command('end-recover')
  .description('End recovery session and clean up decrypted files')
  .action(async (_options, command) => {
    const { EndRecoverCommand } = await import('./commands/endRecoverCommand');
    const cmd = new EndRecoverCommand();
    await cmd.execute();
  });

program
  .command('recover')
  .description('Reconstruct the wrapped master key from a 24-word recovery phrase')
  .action(async (_options, command) => {
    const { RecoverCommand } = await import('./commands/recoverCommand');
    const cmd = new RecoverCommand(process.env.CAPY_API_URL, true);
    await cmd.execute();
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
  .option('--no-push', 'write to .env only; do not push to Capy')
  .option('-f, --force', 'overwrite existing values without prompting')
  .option('--non-tty', 'never prompt; resolve from flags or fail fast (agents/CI)')
  .option('--json', 'emit machine-readable JSON instead of the human UI (piped value)')
  .option('--pr', 'create a PR with the keep.lock change (answers the prompt)') // COPY-FLAG
  .option('--no-pr', 'do not create a PR with the keep.lock change') // COPY-FLAG
  .option('--pr-base <branch>', 'base branch for the PR (answers the prompt)') // COPY-FLAG
  .addHelpText(
    'after',
    // COPY-FLAG
    '\n' +
      'With a value piped in and one name, adds that variable (an existing one needs --force):\n' +
      '  <cmd> | capy-dev add NAME --json\n',
  )
  .action(async (varNames, options, command) => {
    const { AddCommand } = await import('./commands/addCommand');
    const { prFlagsFromCommand } = await import('./commands/keepLockPr');
    const cmd = new AddCommand(true); // devMode: dev backend + ~/.capy-dev
    const merged = command.optsWithGlobals();
    await cmd.execute(varNames, {
      noPush: options.push === false,
      force: merged.force,
      nonTty: options.nonTty,
      json: options.json,
      pr: prFlagsFromCommand(command, options.prBase),
      dryRun: merged.dryRun === true,
    });
  });

program
  .command('remove <vars...>')
  .description('Delete one or more secret values from the active branch (encrypts + syncs)')
  .option('-y, --yes', 'skip the confirmation prompt (required non-interactively)')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--non-tty', 'never prompt; resolve from flags or fail fast (agents/CI)')
  .option('--pr', 'create a PR with the keep.lock change (answers the prompt)') // COPY-FLAG
  .option('--no-pr', 'do not create a PR with the keep.lock change') // COPY-FLAG
  .option('--pr-base <branch>', 'base branch for the PR (answers the prompt)') // COPY-FLAG
  .action(async (varNames, options, command) => {
    const { RemoveCommand } = await import('./commands/removeCommand');
    const { prFlagsFromCommand } = await import('./commands/keepLockPr');
    const cmd = new RemoveCommand(true); // devMode: dev backend + ~/.capy-dev
    await cmd.execute(varNames, {
      yes: options.yes,
      json: options.json,
      nonTty: options.nonTty,
      pr: prFlagsFromCommand(command, options.prBase),
      dryRun: command.optsWithGlobals().dryRun === true,
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
  .option('--base-url <url>', 'dokploy import: dashboard URL')
  .option('--application <id>', 'dokploy import: Application id (mutually exclusive with --compose)')
  .option('--compose <id>', 'dokploy import: Compose service id (mutually exclusive with --application)')
  .option('--token-env <name>', 'dokploy import: env var holding the API token')
  .option('--json', 'emit machine-readable JSON instead of the human UI (import connectors)')
  .option(
    '--dry-run',
    'dokploy import/discover: preview the plan only — resolve settings + read Dokploy, write/push nothing',
  )
  .option(
    '--discover',
    'dokploy: find every Dokploy service matching a repo under cwd, instead of one named --application/--compose',
  )
  .option(
    '-y, --yes',
    // COPY-FLAG: discover never prompts (it always prints JSON), so `--yes` is what lets it write.
    'dokploy import/discover: skip the confirmation prompt (import: --overwrite\'s clear/replace/import ask) — discover never prompts and needs --yes to write',
  )
  .option(
    '--overwrite',
    'dokploy import: set the branch\'s vars to EXACTLY Dokploy\'s set — clear names not in Dokploy, replace differing values, import new ones',
  )
  .option(
    '--environment <names>',
    'dokploy discover: restrict the plan to these Dokploy environment names, comma-separated (e.g. staging,preview)',
  )
  .action(async (provider, options, command) => {
    const { ConnectCommand } = await import('./commands/connectCommand');
    const cmd = new ConnectCommand(true); // devMode: hard-blocks live
    const merged = command.optsWithGlobals();
    if (!provider) {
      await cmd.list();
      return;
    }
    await cmd.execute(provider, {
      live: options.live,
      var: options.var,
      account: options.account,
      noPush: options.push === false,
      nonTty: options.nonTty,
      reauth: options.reauth === true,
      baseUrl: options.baseUrl,
      application: options.application,
      compose: options.compose,
      tokenEnv: options.tokenEnv,
      json: options.json,
      dryRun: options.dryRun ?? merged.dryRun,
      discover: options.discover === true,
      yes: options.yes === true,
      overwrite: options.overwrite === true,
      environment: options.environment,
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

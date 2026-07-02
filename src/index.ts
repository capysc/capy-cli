#!/usr/bin/env node
import { Command } from 'commander';
import { CapyCommand } from './commands/capyCommand';
import { CliOptions } from './types/index';
import { assertNotLocalOnly } from './core/localGate';
import { version as CLI_VERSION } from '../package.json';

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

// One verbosity switch for the whole CLI: diagnostic logs (see ui/debug.ts)
// are silent unless `-v`/`--verbose`. Set from argv here, at the head, before
// any command runs — the gated output lives in deep shared code that isn't
// threaded the parsed option.
if (process.argv.includes('-v') || process.argv.includes('--verbose')) {
  process.env.CAPY_VERBOSE = '1';
}

const program = new Command();

program
  // Bin name is overridable so sibling wrappers (e.g. bin/capy-staging) render
  // their own name in --help/usage instead of the hardcoded "capy".
  .name(process.env.CAPY_BIN_NAME || 'capy')
  .description('Capy CLI - SecretOps for the AI age')
  .version(CLI_VERSION)
  .option('--env-path <path>', 'specify custom .env file location')
  .option('-v, --verbose', 'enable detailed logging')
  .option('-f, --force', 're-encrypt existing variables')
  .option('-d, --dry-run', 'preview changes without applying')
  .option('--web', 'render interactive steps (first-run setup / sync conflicts) in a local browser instead of TTY prompts')
  .action(async (options, cmd) => {
    if (cmd.args.length > 0) {
      console.log(`\n  Unknown command: ${cmd.args[0]}\n`);
      console.log('  Available commands:\n');
      console.log(`    ${B('capy')}                        \x1b[90mSync secrets\x1b[0m`);
      console.log(`    ${B('capy')} run -- <cmd>           \x1b[90mRun a command with decrypted secrets\x1b[0m`);
      console.log(`    ${B('capy')} status                 \x1b[90mShow secret drift\x1b[0m`);
      console.log(`    ${B('capy')} edit                   \x1b[90mInspect and edit secrets in a TUI\x1b[0m`);
      console.log(`    ${B('capy')} push                   \x1b[90mPush encrypted values to Keep\x1b[0m`);
      console.log(`    ${B('capy')} deploy                 \x1b[90mDeploy or set up CI deploy credentials\x1b[0m`);
      console.log(`    ${B('capy')} deploy revoke <id>     \x1b[90mRevoke a deploy token\x1b[0m`);
      console.log(`    ${B('capy')} deploy list            \x1b[90mList deploy tokens\x1b[0m`);
      console.log(`    ${B('capy')} invite <email>         \x1b[90mInvite a teammate\x1b[0m`);
      console.log(`    ${B('capy')} redeem <code>          \x1b[90mRedeem an invite code\x1b[0m`);
      console.log(`    ${B('capy')} kick <email>           \x1b[90mRemove a teammate\x1b[0m`);
      console.log(`    ${B('capy')} users                  \x1b[90mList organization members\x1b[0m`);
      console.log(`    ${B('capy')} org                    \x1b[90mSwitch organization\x1b[0m`);
      console.log(`    ${B('capy')} info                   \x1b[90mShow current session info\x1b[0m`);
      console.log(`    ${B('capy')} byoc [url]             \x1b[90mConnect to a self-hosted Capy (BYOC) instance\x1b[0m`);
      console.log(`    ${B('capy')} use <profile>          \x1b[90mSwitch to a different profile\x1b[0m`);
      console.log(`    ${B('capy')} profile list           \x1b[90mList configured profiles\x1b[0m`);
      console.log(`    ${B('capy')} connect <provider>     \x1b[90mPull a credential from a provider into .env\x1b[0m`);
      console.log(`    ${B('capy')} rotate [var]           \x1b[90mRotate a credential previously set up via connect\x1b[0m`);
      console.log(`    ${B('capy')} decrypt                \x1b[90mDecrypt secrets offline (owner only)\x1b[0m`);
      console.log(`    ${B('capy')} end-recover            \x1b[90mEnd recovery session\x1b[0m`);
      console.log(`    ${B('capy')} recover                \x1b[90mReconstruct master key from recovery phrase\x1b[0m`);
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

    const command = new CapyCommand(cliOptions);
    await command.execute();
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
    const code = await runCommand(childArgs);
    process.exit(code);
  });

program
  .command('status')
  .description('Show secret drift between local, pinned, and remote')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    const { StatusCommand } = await import('./commands/statusCommand');
    const cmd = new StatusCommand();
    await cmd.execute({ json: options.json });
  });

program
  .command('edit')
  .description('Inspect and edit secrets in an interactive TUI')
  .action(async () => {
    const { EditCommand } = await import('./commands/editCommand');
    const cmd = new EditCommand();
    await cmd.execute();
  });

program
  .command('branch')
  .description('List secret branches')
  .option('-D <name>', 'Delete a branch')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    assertNotLocalOnly('branch');
    const { AuthService } = await import('./auth/authService');
    const { ServiceClient } = await import('./service/serviceClient');
    const { ProjectManager } = await import('./core/projectManager');

    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    if (!projectState.initialized) {
      console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
      process.exit(1);
    }

    const authService = new AuthService(undefined, false, projectState.userId);
    const serviceClient = new ServiceClient();
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
        console.log(`Cannot delete the current branch. Switch first with: ${B('capy checkout <other-branch>')}`);
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
    console.log(`  Project "${projectName}"`);
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
        const cmd = new CheckoutCommand();
        await cmd.execute(selected, {});
      }
    }

    } catch (error: any) {
      const { displayErrorAndExit } = await import('./ui/errorScreen');
      displayErrorAndExit(error, {
        projectName: projectState.projectName,
        projectId: projectState.projectId,
        branch: projectState.activeBranch,
      });
    }
  });

program
  .command('checkout <branch>')
  .description('Switch to a secret branch')
  .option('-b, --create', 'Create the branch if it does not exist')
  .option('--protected', 'Mark as a protected branch (invite-only)')
  .action(async (branch, options) => {
    assertNotLocalOnly('checkout');
    const { CheckoutCommand } = await import('./commands/checkoutCommand');
    const cmd = new CheckoutCommand();
    await cmd.execute(branch, { create: options.create, protected: options.protected });
  });

program
  .command('push')
  .description('Push encrypted values to Keep')
  .action(async () => {
    const { PushCommand } = await import('./commands/pushCommand');
    const cmd = new PushCommand();
    await cmd.execute();
  });

// `capy deploy` is a single picker that surfaces both:
//   • existing flow: deploy-token + docs page (works for any platform)
//   • new connector flow: real deploy via adapter (cf-worker, …)
// When the user picks a platform with a connector available, an extra prompt
// asks which mode they want; otherwise the existing token+docs flow runs.
const deploy = program
  .command('deploy [target]')
  .description('Set up secret delivery — token + docs (existing) or connector deploy')
  .option('--target <id>', 'adapter id; requires --yes (CI mode)')
  .option('--yes', 'skip all prompts (CI)')
  .option('--dry-run', 'preflight + show plan, push nothing (connector mode)')
  .option('--force', 'redeploy even when keep.lock is unchanged — bumps keep.lock to trigger CI')
  .option('--edit', 're-enter the picker for an existing connector target')
  .option('--connect', 'force connector mode (skip the token+docs path)')
  .option('--platform <id>', 'skip platform picker (token+docs flow; e.g. github-actions, vercel)')
  .option('--mode <mode>', 'skip mode picker: "connector" or "token"')
  .option('--scope <scope>', 'gh-actions: "repo" or "env"')
  .option('--env-name <name>', 'gh-actions: env name when --scope env')
  .action(async (target: string | undefined, options: any, cmd: any) => {
    assertNotLocalOnly('deploy');
    // Top-level program also defines --dry-run; merge globals so either
    // `capy --dry-run deploy ...` or `capy deploy ... --dry-run` works.
    const merged = cmd.optsWithGlobals ? cmd.optsWithGlobals() : options;

    // CI/explicit connector path — go straight to the adapter flow.
    if (options.target || options.connect || target) {
      const { deployCommand } = await import('./commands/deployCommand');
      const code = await deployCommand(target, {
        target: options.target,
        yes: options.yes ?? merged.yes,
        dryRun: options.dryRun ?? merged.dryRun,
        edit: options.edit,
        // Deploy-level flag only — the global `-f/--force` means "re-encrypt",
        // a different thing, so it must NOT be merged in here.
        force: options.force,
      });
      process.exit(code);
    }

    // Default path: existing token+docs picker. It auto-routes to the
    // connector flow when the user picks a connector-enabled platform.
    const { DeployCommand } = await import('./commands/deployTokenCommand');
    const c = new DeployCommand(undefined, false, {
      platform: options.platform,
      mode: options.mode,
      scope: options.scope,
      envName: options.envName,
      yes: !!options.yes,
      force: !!options.force,
    });
    await c.execute();
  });

deploy
  .command('revoke <deployId>')
  .description('Revoke a deploy token')
  .action(async (deployId: string) => {
    assertNotLocalOnly('deploy revoke');
    const { DeployRevokeCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployRevokeCommand();
    await cmd.execute(deployId);
  });

deploy
  .command('list')
  .description('List deploy tokens for this project')
  .action(async () => {
    assertNotLocalOnly('deploy list');
    const { DeployListCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployListCommand();
    await cmd.execute();
  });

deploy
  .command('targets')
  .description('List configured connector targets (connector mode)')
  .action(async () => {
    assertNotLocalOnly('deploy targets');
    const { deployList } = await import('./commands/deployCommand');
    process.exit(await deployList());
  });

deploy
  .command('targets-remove <name>')
  .description('Remove a configured connector target')
  .action(async (name: string) => {
    assertNotLocalOnly('deploy targets-remove');
    const { deployRemove } = await import('./commands/deployCommand');
    process.exit(await deployRemove(name));
  });

program
  .command('logout')
  .description('End the current session')
  .action(async () => {
    const { isLocalOnly } = await import('./config/profileConfig');
    if (isLocalOnly()) {
      // Local-only mode has no account/server session. Never touch the local
      // keystore here — `capy lock` is how the user locks their key.
      console.log('Local-only mode has no account to log out of. Use `capy lock` to lock your key.');
      return;
    }

    const { performLogoutCleanup } = await import('./commands/logoutCommand');
    const cleared = await performLogoutCleanup();

    if (cleared) {
      console.log('Logged out. Session cleared.');
    } else {
      console.log('No active session.');
    }
  });

program
  .command('byoc [url]')
  .description('Connect to a self-hosted Capy (BYOC) instance')
  .action(async (url: string | undefined, _options: unknown, command: Command) => {
    const { byocCommand } = await import('./commands/byocCommand');
    // `--web` is a global option on the root program, so read it via globals.
    const web = command.optsWithGlobals().web === true;
    process.exit(await byocCommand(url, { web }));
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
    const { existsSync, readFileSync, writeFileSync, unlinkSync } = await import('fs');

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
        const { chmodSync } = await import('fs');
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
  .command('help')
  .description('Show help information')
  .action(() => {
    program.outputHelp();
  });

program
  .command('invite <email>')
  .description('Invite a teammate to this organization')
  .option('--role <role>', 'invitee role: member | project-admin | admin')
  .option('--project <id|name>', 'grant project access (repeatable, comma-ok)', collectProjects, [])
  .option('--ttl <duration>', 'invite lifetime, e.g. 30m, 24h, 7d (or seconds)')
  .option('--expires <iso>', 'absolute expiry (ISO date); overrides --ttl')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--non-tty', 'never prompt; resolve from flags or fail fast (agents/CI)')
  .action(async (email, options) => {
    assertNotLocalOnly('invite');
    const { InviteCommand } = await import('./commands/inviteCommand');
    const cmd = new InviteCommand();
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
    assertNotLocalOnly('redeem');
    const { RedeemCommand } = await import('./commands/redeemCommand');
    const cmd = new RedeemCommand();
    await cmd.execute(code);
  });

program
  .command('transport')
  .description('Generate a redeem code to move your account to another machine')
  .action(async () => {
    assertNotLocalOnly('transport');
    const { TransportCommand } = await import('./commands/transportCommand');
    const cmd = new TransportCommand();
    await cmd.execute();
  });

program
  .command('kick <email>')
  .description('Remove a teammate from this organization')
  .action(async (email) => {
    assertNotLocalOnly('kick');
    const { KickCommand } = await import('./commands/kickCommand');
    const cmd = new KickCommand();
    await cmd.execute(email);
  });

program
  .command('org')
  .description('Switch organization')
  .action(async () => {
    assertNotLocalOnly('org');
    const { OrgCommand } = await import('./commands/orgCommand');
    const cmd = new OrgCommand();
    await cmd.execute();
  });

program
  .command('info')
  .description('Show current session info')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    assertNotLocalOnly('info');
    const { InfoCommand } = await import('./commands/infoCommand');
    const cmd = new InfoCommand();
    await cmd.execute({ json: options.json });
  });

program
  .command('list')
  .description('List variable names + connector metadata for the active branch (no values)')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    assertNotLocalOnly('list');
    const { ListCommand } = await import('./commands/listCommand');
    const cmd = new ListCommand();
    await cmd.execute({ json: options.json });
  });

program
  .command('users')
  .description('List organization members and their project access')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options) => {
    assertNotLocalOnly('users');
    const { UsersCommand } = await import('./commands/usersCommand');
    const cmd = new UsersCommand();
    await cmd.execute({ json: options.json });
  });

program
  .command('grant-branch <email> <project> <branch>')
  .description('Grant a member wildcard access to a protected branch')
  .action(async (email: string, project: string, branch: string) => {
    assertNotLocalOnly('grant-branch');
    const { UsersCommand } = await import('./commands/usersCommand');
    const cmd = new UsersCommand();
    await cmd.grantBranch(email, project, branch);
  });

program
  .command('revoke-branch <email> <project> <branch>')
  .description("Revoke a member's wildcard access to a protected branch")
  .action(async (email: string, project: string, branch: string) => {
    assertNotLocalOnly('revoke-branch');
    const { UsersCommand } = await import('./commands/usersCommand');
    const cmd = new UsersCommand();
    await cmd.revokeBranch(email, project, branch);
  });

program
  .command('decrypt')
  .description('Decrypt secrets offline using seed phrase (owner only)')
  .action(async () => {
    const { DecryptCommand } = await import('./commands/decryptCommand');
    const cmd = new DecryptCommand();
    await cmd.execute();
  });

program
  .command('end-recover')
  .description('End recovery session and clean up decrypted files')
  .action(async () => {
    const { EndRecoverCommand } = await import('./commands/endRecoverCommand');
    const cmd = new EndRecoverCommand();
    await cmd.execute();
  });

program
  .command('recover')
  .description('Reconstruct the wrapped master key from a 24-word recovery phrase')
  .action(async () => {
    assertNotLocalOnly('recover');
    const { RecoverCommand } = await import('./commands/recoverCommand');
    const cmd = new RecoverCommand();
    await cmd.execute();
  });

program
  .command('add <vars...>')
  .description('Add one or more secret values to the project (encrypts + syncs)')
  // NOTE: `--web` is intentionally NOT declared here. The root program already
  // defines a global `--web`, and Commander binds a doubly-declared flag to the
  // parent scope — so a local copy would silently shadow to undefined (the bug
  // that made `capy add --web` fall through to the dead TTY prompt). Like `byoc`,
  // we read the inherited global via `merged.web` below.
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
    assertNotLocalOnly('add');
    const { AddCommand } = await import('./commands/addCommand');
    const cmd = new AddCommand();
    const merged = command.optsWithGlobals();
    await cmd.execute(varNames, {
      // `--web` is defined on both the root program and this subcommand, so Commander
      // binds it to the global scope — read it from merged opts, not the local `options`.
      web: merged.web,
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
  .description('Connect a third-party provider and pull a credential into .env')
  .option('--live', 'use live mode (default: test)')
  .option('--var <name>', 'env var name to write')
  .option('--account <id>', 'pick a specific provider account when multiple are configured')
  .option('--no-push', 'write to .env only; do not push to Capy')
  .option('-f, --force', 'overwrite an existing value without prompting')
  .option('--non-tty', 'never prompt; resolve choices from flags or fail fast (agents/CI)')
  .action(async (provider, options, command) => {
    assertNotLocalOnly('connect');
    const { ConnectCommand } = await import('./commands/connectCommand');
    const cmd = new ConnectCommand();
    if (!provider) {
      await cmd.list();
      return;
    }
    // Merge globals: the top-level program also defines -f/--force, which
    // otherwise shadows this subcommand's --force (opts.force stays undefined).
    const merged = command.optsWithGlobals();
    await cmd.execute(provider, {
      live: options.live,
      var: options.var,
      account: options.account,
      noPush: options.push === false,
      force: merged.force,
      nonTty: options.nonTty,
    });
  });

program
  .command('rotate [var]')
  .description('Rotate a managed credential previously set up via `capy connect`')
  .option('--all', 'rotate every managed credential in this project')
  .option('--no-push', 'update .env only; do not push to Capy')
  .option('-y, --yes', 'skip prompts; run rotate + push + deploy unattended (for CI/automation)')
  .option('--skip-prompts', 'alias for --yes')
  .option('--non-tty', 'never prompt; resolve choices from flags or fail fast (agents/CI)')
  .option('--provider <name>', 'integration to promote an unmanaged var through (non-interactive)')
  .action(async (varName, options) => {
    assertNotLocalOnly('rotate');
    const { RotateCommand } = await import('./commands/rotateCommand');
    const cmd = new RotateCommand();
    await cmd.execute(varName, {
      all: options.all,
      noPush: options.push === false,
      skipPrompts: !!(options.yes || options.skipPrompts),
      nonTty: options.nonTty,
      provider: options.provider,
    });
  });

program
  .command('lock')
  .description('Lock the local-only key (re-prompts the passphrase next time)')
  .action(async () => {
    const { LockCommand } = await import('./commands/lockCommand');
    await new LockCommand().execute();
  });

program.parse(process.argv);

#!/usr/bin/env node
// Imported first, and applied below before any other statement: the pin has to
// land before a single Capy module reads configuration.
import { applyProdPins, formatPinNotice } from './config/prodPins';
import { Command } from 'commander';
import { CapyCommand } from './commands/capyCommand';
import { CapyError, CliOptions, ERROR_CODES } from './types/index';
import { assertNotLocalOnly } from './core/localGate';
import { version as CLI_VERSION } from '../package.json';
import { setWebMode } from './ui/webMode';
import { GRANT_DAEMON_SUBCOMMAND } from './auth/deviceKey/grantHolder';
import { createJsonLineInteraction, runWithInteraction } from './ui/interaction';

// Prod talks to api.capy.sc and ~/.capy, full stop. Strip the environment's
// attempts to move it before anything can read them — see config/prodPins.ts
// for why an ambient CAPY_API_URL is a foot-gun rather than a feature. Keep
// this the first statement in the file.
const strippedPins = applyProdPins();

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** Commander accumulator for repeatable, comma-splittable options (e.g. --project). */
function collectProjects(val: string, acc: string[]): string[] {
  return acc.concat(val.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Resolve a repeated child option after Commander's non-positional parent parse. */
function expectedUserIdFor(command: Command): string | undefined {
  const value = (command.optsWithGlobals() as Readonly<Record<string, unknown>>).expectedUserId;
  if (typeof value !== 'string') return undefined;
  if (value.trim().length === 0) throw new CapyError('Expected user ID cannot be empty.', ERROR_CODES.AUTH_FAILED);
  return value;
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

// Say so when an override was ignored. The bug this pin fixes was invisible:
// the CLI silently spoke to a URL the user never chose.
const pinNotice = formatPinNotice(strippedPins);
if (pinNotice) console.error(pinNotice);

const program = new Command();

/**
 * Same resolution as `expectedUserIdFor`, but for the non-interactive checkout
 * route specifically: an explicitly empty `--expected-user-id` has to reach
 * `checkoutJson`'s own CHECKOUT_TARGET_REQUIRED refusal, exactly like its
 * sibling `--expected-org-id` / `--expected-project-id` / `--expected-branch-id`
 * flags already do when passed empty — not crash the process with an
 * uncaught CapyError before that shared refusal path is ever reached.
 */
function expectedUserIdForCheckout(command: Command): string | undefined {
  try {
    return expectedUserIdFor(command);
  } catch (error) {
    if (error instanceof CapyError && error.code === ERROR_CODES.AUTH_FAILED) return '';
    throw error;
  }
}

program
  // Bin name is overridable so sibling wrappers (e.g. bin/capy-staging) render
  // their own name in --help/usage instead of the hardcoded "capy".
  .name(process.env.CAPY_BIN_NAME || 'capy')
  .description('Capy CLI - SecretOps for the AI age')
  .version(CLI_VERSION)
  .option('--env-path <path>', 'specify custom .env file location')
  .option('--flow', 'use encrypted Keep conversation for this command after pairing')
  .option('-v, --verbose', 'enable detailed logging')
  .option('-f, --force', 're-encrypt existing variables')
  .option('-d, --dry-run', 'preview changes without applying')
  .option('--web', 'render interactive steps (first-run setup / sync conflicts) in a browser instead of TTY prompts')
  .option('--json', 'stream structured interaction records over stdin/stdout')
  .option('--expected-user-id <id>', 'require the account bound by the hosted launcher')
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
      console.log(`    ${B('capy')}                        \x1b[90mSync secrets\x1b[0m`);
      console.log(`    ${B('capy')} setup --json           \x1b[90mPlan/apply first-run setup as JSON (no TTY)\x1b[0m`);
      console.log(`    ${B('capy')} sync --json            \x1b[90mSync an already-initialized project as JSON (no TTY)\x1b[0m`);
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
      web: options.web,
      expectedUserId: options.expectedUserId,
    };

    const command = new CapyCommand(cliOptions);
    if (options.flow === true) {
      const { runCapyFlow } = await import('./ui/capyFlow');
      await runCapyFlow(cliOptions, false);
      return;
    }
    if (options.json === true) {
      await runWithInteraction(createJsonLineInteraction(process.stdin, process.stdout), () => command.execute());
      return;
    }
    await command.execute();
  });

program
  .command('setup')
  .description('Plan/apply first-run project setup as JSON — no TTY, no browser (docs/cli-setup-json.md)')
  .option('--json', 'required today: this command has no TTY mode yet')
  .option('--confirm <hash>', 'apply the plan whose plan_hash this names; omit to only print the plan')
  .option('--org <id>', 'explicit organization attribution')
  .option('--project <id>', 'explicit existing project attribution')
  .option('--create-project <name>', 'explicitly create a project on approved apply')
  .action(async (options, command) => {
    const globalOpts = command.optsWithGlobals();
    if (!globalOpts.json) {
      console.error('');
      console.error('  capy setup currently supports --json only (it is the onboarding tool\'s entry point).');
      console.error('  A human setting up a project for the first time should just run capy.');
      console.error('');
      process.exit(1);
    }
    const { SetupCommand } = await import('./commands/setupCommand');
    const cmd = new SetupCommand({ envPath: globalOpts.envPath });
    await cmd.execute({ confirm: options.confirm, org: options.org, project: options.project, createProject: options.createProject });
  });

program
  .command('sync')
  .description('Sync an already-initialized project as JSON — no TTY, no browser (docs/cli-setup-json.md)')
  .option('--json', 'required today: this command has no TTY mode yet')
  .option('--expected-user-id <id>', 'require the account bound by the hosted MCP')
  .action(async (options, command) => {
    const globalOpts = command.optsWithGlobals();
    if (!globalOpts.json) {
      console.error('');
      console.error('  capy sync currently supports --json only (it is the onboarding tool\'s entry point).');
      console.error('  A human syncing an already-initialized project should just run capy.');
      console.error('');
      process.exit(1);
    }
    const { SyncCommand } = await import('./commands/syncCommand');
    const cmd = new SyncCommand({ envPath: globalOpts.envPath, expectedUserId: expectedUserIdFor(command) });
    await cmd.execute();
  });

program
  .command('run')
  .description('Run a command with decrypted secrets')
  .option('--expected-user-id <id>', 'run non-interactively as the hosted MCP caller')
  .allowUnknownOption()
  .helpOption(false)
  .action(async (_opts: any, cmd: any) => {
    const { runCommand } = await import('./commands/runCommand');
    const dashIdx = process.argv.indexOf('--');
    const childArgs = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : cmd.args;
    const expectedUserId = expectedUserIdFor(cmd);
    const code = expectedUserId !== undefined
      ? await (await import('./commands/runHostedCommand')).runHostedCommand(childArgs, expectedUserId)
      : await runCommand(childArgs);
    process.exit(code);
  });

program
  .command('status')
  .description('Show secret drift between local, pinned, and remote')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--expected-user-id <id>', 'require the account bound by the hosted MCP')
  .action(async (options, command) => {
    const { StatusCommand } = await import('./commands/statusCommand');
    const cmd = new StatusCommand(false, false, expectedUserIdFor(command));
    await cmd.execute({ json: options.json, web: command.optsWithGlobals().web === true });
  });

program
  .command('edit')
  .description('Inspect and edit secrets in an interactive TUI')
  .action(async (_options, command) => {
    const { EditCommand } = await import('./commands/editCommand');
    const cmd = new EditCommand();
    await cmd.execute({ web: command.optsWithGlobals().web === true, expectedUserId: expectedUserIdFor(command) });
  });

program
  .command('branch')
  .description('List secret branches')
  .option('-D <name>', 'Delete a branch')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options, command) => {
    assertNotLocalOnly('branch');
    const { AuthService } = await import('./auth/authService');
    const { ServiceClient } = await import('./service/serviceClient');
    const { ProjectManager } = await import('./core/projectManager');

    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    if (!projectState.initialized) {
      // Not inside a try here, so there is no catch to throw into — call the
      // error screen directly. `displayErrorAndExit` reads web mode itself
      // (`isWebMode()`), serves the command-error page under `--web`, holds the
      // process open until the browser has fetched it, and exits 1 either way.
      // `console.error` + `process.exit(1)` did none of that: under --web the
      // caller has no terminal, so the refusal reached nobody.
      const { displayErrorAndExit } = await import('./ui/errorScreen');
      await displayErrorAndExit(
        new CapyError(
          `No keep.lock file found. Run ${B('capy')} first to initialize.`,
          ERROR_CODES.PROJECT_NOT_INITIALIZED,
        ),
      );
      return;
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
        // `capy branch` hands its switch step to checkout, so the flag has to
        // travel with it — otherwise picking a branch here drops out of the
        // browser and into a TTY prompt halfway through the same run.
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
  .option('--refresh', 'Replace local .env and sync-state from the current keep.lock')
  .option('--protected', 'Mark as a protected branch (invite-only)')
  .option('--no-protected', 'Create it open to the project')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--non-tty', 'switch an existing branch without prompts or browser authentication')
  .option('--expected-user-id <id>', 'require the account bound by the hosted MCP')
  .option('--expected-org-id <id>', 'require the repository organization bound by the hosted MCP')
  .option('--expected-project-id <id>', 'require the repository project bound by the hosted MCP')
  .option('--expected-branch-id <id>', 'require the branch identity selected through the hosted MCP')
  .action(async (branch, options, command) => {
    assertNotLocalOnly('checkout');

    // `--json` is declared on both the root program and this subcommand, so
    // Commander binds the parsed flag to the parent scope — see 848d6a0's
    // identical fix for `pair` / `device-key grant`, which missed this
    // command. `options.json` below is always undefined; read the merged
    // globals instead.
    const json = command.optsWithGlobals().json === true;
    const mergedOptions = { ...options, json, expectedUserId: expectedUserIdForCheckout(command) };
    const hosted = mergedOptions.nonTty || [mergedOptions.expectedUserId, mergedOptions.expectedOrgId, mergedOptions.expectedProjectId, mergedOptions.expectedBranchId]
      .some(value => value !== undefined);
    if (hosted || (mergedOptions.json && !mergedOptions.create)) {
      const { runCheckoutJsonCommand } = await import('./commands/checkoutJsonCommand');
      process.exit(await runCheckoutJsonCommand(branch, { ...mergedOptions, nonTty: hosted }));
    }

    // `--json` on a create describes the route rather than travelling it: the
    // same stop array the browser screen is served, so a headless caller can
    // see which stops a flag already settled and which it would be asked
    // about. Printed before any network call, because the plan is knowable
    // without one — that is what makes it a plan.
    if (json && options.create) {
      const { branchCreatePlan, unansweredStops } = await import('./core/branchCreatePlan');
      // Commander sets `protected` to false only when `--no-protected` was
      // typed; an untouched flag leaves it undefined, which is the difference
      // between "answered open" and "not answered".
      const stops = branchCreatePlan({ branchName: branch, isProtected: options.protected });
      console.log(JSON.stringify({ stops, unanswered: unansweredStops(stops) }, null, 2));
      return;
    }

    const { CheckoutCommand } = await import('./commands/checkoutCommand');
    const cmd = new CheckoutCommand();
    await cmd.execute(branch, {
      create: options.create,
      refresh: options.refresh,
      protected: options.protected,
      web: command.optsWithGlobals().web === true,
    });
  });

program
  .command('push')
  .description('Push encrypted values to Keep')
  .option('--json', 'emit one machine-readable reviewed-push result')
  .option('--plan', 'prepare a reviewed push plan without writing')
  .option('--confirm <plan-hash>', 'apply the exact reviewed push plan')
  .option('--non-tty', 'never start an interactive sign-in')
  .option('--expected-user-id <id>', 'require this existing CLI account')
  .option('--service-origin <origin>', 'require the active CLI service environment')
  .action(async (options: Readonly<{
    json?: boolean; plan?: boolean; confirm?: string; nonTty?: boolean; expectedUserId?: string; serviceOrigin?: string;
  }>, command) => {
    const expectedUserId = expectedUserIdFor(command);
    // `--json` is declared on both the root program and this subcommand, so
    // Commander binds the parsed flag to the parent scope — see 848d6a0's
    // identical fix for `pair` / `device-key grant`, which missed this
    // command. `options.json` below is always undefined; read the merged
    // globals instead.
    const json = command.optsWithGlobals().json === true;
    if (options.plan || options.confirm) {
      const { runPushJsonCommand } = await import('./commands/pushJsonCommand');
      if (!json) {
        console.log(JSON.stringify({ ok: false, code: 'PUSH_JSON_REQUIRED' }));
        process.exit(1);
      }
      process.exit(await runPushJsonCommand({ plan: options.plan, confirm: options.confirm,
        expectedUserId, serviceOrigin: options.serviceOrigin }));
    }
    if (json) {
      console.log(JSON.stringify({ ok: false, code: 'PUSH_REVIEW_ARGUMENT_INVALID' }));
      process.exit(1);
    }
    const { PushCommand } = await import('./commands/pushCommand');
    const cmd = new PushCommand();
    await cmd.execute({ nonInteractive: options.nonTty, expectedUserId });
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
  .option('--json', 'describe the route as JSON instead of running it; no side effects (agents/CI)')
  .option('--non-tty', 'never prompt; resolve platform/mode from flags or fail fast (agents/CI)')
  .action(async (target: string | undefined, options: any, cmd: any) => {
    assertNotLocalOnly('deploy');
    // Top-level program also defines --dry-run; merge globals so either
    // `capy --dry-run deploy ...` or `capy deploy ... --dry-run` works.
    const merged = cmd.optsWithGlobals ? cmd.optsWithGlobals() : options;
    const json = options.json === true;

    // CI/explicit connector path — go straight to the adapter flow. `--json`
    // routes here too, even with no target/--connect: `describeDeployRoute()`
    // is the only place this command knows how to describe a plan without
    // running it, and a headless preflight needs that door open regardless
    // of which mode the run would otherwise pick.
    if (options.target || options.connect || target || json) {
      const { deployCommand } = await import('./commands/deployCommand');
      const code = await deployCommand(target, {
        target: options.target,
        yes: options.yes ?? merged.yes,
        dryRun: options.dryRun ?? merged.dryRun,
        // Same inherited-global rule as every other converted command: --web
        // is declared once on the root program, so it arrives in merged opts.
        web: merged.web === true,
        edit: options.edit,
        // Deploy-level flag only — the global `-f/--force` means "re-encrypt",
        // a different thing, so it must NOT be merged in here.
        force: options.force,
        json,
        nonTty: options.nonTty === true,
      });
      process.exit(code);
    }

    // Default path: existing token+docs picker. It auto-routes to the
    // connector flow when the user picks a connector-enabled platform.
    const { DeployCommand } = await import('./commands/deployTokenCommand');
    const c = new DeployCommand(undefined, false, {
      // Same inherited-global rule as the connector branch above: `--web` is
      // declared once on the root program, so it arrives in merged opts. Without
      // this the flag parsed, was accepted, and was dropped — leaving the whole
      // browser branch of a --web-aware class unreachable from argv.
      web: merged.web === true,
      platform: options.platform,
      mode: options.mode,
      scope: options.scope,
      envName: options.envName,
      yes: !!options.yes,
      force: !!options.force,
      nonTty: options.nonTty === true,
    });
    await c.execute();
  });

deploy
  .command('revoke <deployId>')
  .description('Revoke a deploy token')
  .action(async (deployId: string, _options, command) => {
    assertNotLocalOnly('deploy revoke');
    const { DeployRevokeCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployRevokeCommand(undefined, false, { web: command.optsWithGlobals().web === true });
    await cmd.execute(deployId);
  });

deploy
  .command('list')
  .description('List deploy tokens for this project')
  .action(async (_options, command) => {
    assertNotLocalOnly('deploy list');
    const { DeployListCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployListCommand(undefined, false, { web: command.optsWithGlobals().web === true });
    await cmd.execute();
  });

deploy
  .command('targets')
  .description('List configured connector targets (connector mode)')
  .action(async (_options, command) => {
    assertNotLocalOnly('deploy targets');
    const { deployList } = await import('./commands/deployCommand');
    process.exit(await deployList(process.cwd(), { web: command.optsWithGlobals().web === true }));
  });

deploy
  .command('targets-remove <name>')
  .description('Remove a configured connector target')
  .action(async (name: string, _options, command) => {
    assertNotLocalOnly('deploy targets-remove');
    const { deployRemove } = await import('./commands/deployCommand');
    process.exit(await deployRemove(name, process.cwd(), { web: command.optsWithGlobals().web === true }));
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
  .description('Remove Capy git-hook blocks, preserving other hook content')
  .option('--json', 'emit a machine-readable result')
  .option('--non-tty', 'never prompt (cleanup is always non-interactive)')
  .option('--yes', 'explicitly request removal of Capy hook blocks')
  .action(async (options: Readonly<{ json?: boolean; nonTty?: boolean; yes?: boolean }>) => {
    const { cleanupCommand } = await import('./commands/cleanupCommand');
    process.exit(cleanupCommand(options));
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
  .option('--ttl <duration>', 'invite lifetime, max 12h, e.g. 30m, 2h, 12h (or seconds)')
  .option('--expires <iso>', 'absolute expiry (ISO date); overrides --ttl')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--non-tty', 'never prompt; resolve from flags or fail fast (agents/CI)')
  .option('--v3', 'mint a short v3 (stored-blob) code instead of the v2 blob-in-code format')
  .action(async (email, options, command) => {
    assertNotLocalOnly('invite');
    const { InviteCommand } = await import('./commands/inviteCommand');
    const cmd = new InviteCommand();
    await cmd.execute(email, {
      web: command.optsWithGlobals().web === true,
      role: options.role,
      projects: options.project,
      ttl: options.ttl,
      expires: options.expires,
      json: options.json,
      nonTty: options.nonTty,
      v3: options.v3,
    });
  });

program
  .command('redeem [code]')
  .description('Redeem an invite code to join an organization, or (with no code) complete a pending Keep-pasted invite pickup')
  .action(async (code) => {
    assertNotLocalOnly('redeem');
    const { RedeemCommand } = await import('./commands/redeemCommand');
    const cmd = new RedeemCommand();
    if (code) {
      await cmd.execute(code);
    } else {
      await cmd.executePickup();
    }
  });

program
  .command('transport')
  .description('Generate a redeem code to move your account to another machine')
  .action(async (_options, command) => {
    assertNotLocalOnly('transport');
    const { TransportCommand } = await import('./commands/transportCommand');
    const cmd = new TransportCommand();
    await cmd.execute({ web: command.optsWithGlobals().web === true });
  });

program
  .command('pair')
  .description('Sign this headless machine in with a code entered on another device (no browser needed here)')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--flow-id <id>', 'Keep-owned runtime or onboarding correlation')
  .option('--authentication-flow-id <id>', 'Keep-owned authentication correlation')
  .option('--expected-user-id <id>', 'the account bound by the hosted MCP')
  .option('--service-origin <origin>', 'must match this CLI environment')
  .option('--runtime-only', 'pair outside a repository through a standalone runtime handle')
  .action(async (options, command) => {
    assertNotLocalOnly('pair');
    const expectedUserId = expectedUserIdFor(command);
    if (command.optsWithGlobals().web === true && options.flowId === undefined) {
      const { runComposedDeviceGrant } = await import('./commands/composedDeviceGrant');
      const code = await runComposedDeviceGrant(options.authenticationFlowId, expectedUserId);
      if (code !== 0) process.exit(code);
      return;
    }
    const instrumented = options.flowId !== undefined || options.authenticationFlowId !== undefined
      || expectedUserId !== undefined || options.serviceOrigin !== undefined || options.runtimeOnly === true;
    if (instrumented) {
      // `--json` is declared on both the root program and this subcommand, so Commander
      // binds the parsed flag to the parent scope — see 848d6a0's identical fix a few
      // lines below for `PairCommand.execute()`, which missed this earlier check.
      const json = options.json === true || command.optsWithGlobals().json === true;
      if (!json || !options.flowId || !options.authenticationFlowId || !expectedUserId || !options.serviceOrigin) {
        console.log(JSON.stringify({ ok: false, code: 'READINESS_ARGUMENT_INVALID' }));
        process.exit(1);
      }
      const { runFlowReadinessCommand } = await import('./commands/flowReadinessCommand');
      const code = await runFlowReadinessCommand({ flowId: options.flowId, authenticationFlowId: options.authenticationFlowId,
        expectedUserId, serviceOrigin: options.serviceOrigin,
        runtimeOnly: options.runtimeOnly === true, continuationTool: options.runtimeOnly ? 'capy_pair' : 'capy_onboard' });
      if (code !== 0) process.exit(code);
      return;
    }
    const { PairCommand } = await import('./commands/pairCommand');
    const cmd = new PairCommand();
    const exitCode = await cmd.execute({ json: options.json === true || command.optsWithGlobals().json === true });
    if (exitCode !== 0) process.exit(exitCode);
  });

program
  .command('kick <email>')
  .description('Remove a teammate from this organization')
  .action(async (email, _options, command) => {
    assertNotLocalOnly('kick');
    const { KickCommand } = await import('./commands/kickCommand');
    const cmd = new KickCommand();
    await cmd.execute(email, { web: command.optsWithGlobals().web === true });
  });

const flow = program
  .command('flow')
  .description('Flow-service instance management');

flow
  .command('setup <id>')
  .description('Execute or resume approved repository setup for a Keep-owned onboarding flow')
  .option('--expected-user-id <id>', 'the account bound by the hosted MCP')
  .requiredOption('--service-origin <origin>', 'must match this CLI environment')
  .option('--json', 'emit the public continuation and coded outcome')
  .action(async (id: string, options: import('./commands/flowSetupCommand').FlowSetupOptions, command) => {
    const expectedUserId = expectedUserIdFor(command);
    if (expectedUserId === undefined) {
      console.log(JSON.stringify({ ok: false, flow_id: id, code: 'SETUP_ARGUMENT_INVALID' }));
      process.exit(1);
    }
    assertNotLocalOnly('flow setup');
    const { runFlowSetupCommand } = await import('./commands/flowSetupCommand');
    const code = await runFlowSetupCommand(id, { ...options, expectedUserId });
    if (code !== 0) process.exit(code);
  });

flow
  .command('add <id>')
  .option('--cancel', 'Cancel this secret request before any application')
  .description('Resume a Keep-owned secure secret intake on this paired runtime')
  .option('--expected-user-id <id>', 'the account bound by the hosted MCP')
  .requiredOption('--service-origin <origin>', 'must match this CLI environment')
  .option('--json', 'emit only the public handoff and coded outcome')
  .action(async (id: string, options: import('./commands/flowAddCommand').FlowAddOptions, command) => {
    const expectedUserId = expectedUserIdFor(command);
    if (expectedUserId === undefined) {
      console.log(JSON.stringify({ ok: false, flow_id: id, code: 'INTAKE_ARGUMENT_INVALID' }));
      process.exit(1);
    }
    assertNotLocalOnly('flow add');
    const { runFlowAddCommand } = await import('./commands/flowAddCommand');
    const code = await runFlowAddCommand(id, { ...options, expectedUserId });
    if (code !== 0) process.exit(code);
  });

flow
  .command('cancel <id>')
  .description('Cancel a stuck flow (org-owner escape hatch — releases any repo lock it holds)')
  .option('--json', 'emit machine-readable JSON instead of the human UI, on success AND failure')
  .option('--yes', 'skip the confirmation prompt')
  .option('--non-tty', 'treat stdin as non-interactive even if it is a TTY (agents/CI)')
  .action(async (id: string, options: { json?: boolean; yes?: boolean; nonTty?: boolean }, command) => {
    assertNotLocalOnly('flow cancel');
    const { FlowCancelCommand } = await import('./commands/flowCancelCommand');
    const cmd = new FlowCancelCommand();
    await cmd.execute(id, {
      // `--json` is declared on both the root program and this subcommand, so
      // Commander binds the parsed flag to the parent scope — see 848d6a0's
      // identical fix for `pair` / `device-key grant`, which missed this
      // command. `options.json` is always undefined; read the merged globals.
      json: command.optsWithGlobals().json === true,
      yes: options.yes === true,
      nonTty: options.nonTty === true,
    });
  });

// Undocumented, additive: attach to a hosted-minted `checkout` flow instance
// (POST /flows/checkout, minted server-side) and drive it to completion.
// Authenticates SILENTLY only — never a ceremony, never a browser — and
// never answers the flow's own consent dialog; a human approves that in the
// hosted chat this run polls briefly for.
flow
  .command('run')
  .description('Attach to a hosted-minted checkout flow instance and drive it to completion')
  .option('--json', 'print the step-by-step outcome as JSON instead of the human UI')
  .option('--target-dir <path>', 'directory to drive the switch in (defaults to the current one)')
  .action(async (options: { json?: boolean; targetDir?: string }) => {
    assertNotLocalOnly('flow run');
    const { runFlowRunCommand } = await import('./commands/flowRunCommand');
    await runFlowRunCommand({ json: options.json === true, targetDir: options.targetDir });
  });

program
  .command('org')
  .description('Switch organization')
  .action(async (_options, command) => {
    assertNotLocalOnly('org');
    const { OrgCommand } = await import('./commands/orgCommand');
    // OrgCommand takes it at construction — see its own note on why a
    // subcommand must read the inherited global rather than its own options.
    const cmd = new OrgCommand(undefined, false, { web: command.optsWithGlobals().web === true });
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
  .command('doctor')
  .description('Report local Capy facts: binary, version, state dir, API/Keep origins, session presence (read-only, no network)')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .action(async (options, command) => {
    const { DoctorCommand } = await import('./commands/doctorCommand');
    const cmd = new DoctorCommand();
    // `--json` is also a global interaction flag. Commander assigns the
    // duplicated option to the root command, so read inherited options too.
    await cmd.execute({ json: options.json === true || command.optsWithGlobals().json === true });
  });

program
  .command('list')
  .description('List variable names + connector metadata for the active branch (no values)')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--expected-user-id <id>', 'require the account bound by the hosted MCP')
  .action(async (options, command) => {
    assertNotLocalOnly('list');
    const { ListCommand } = await import('./commands/listCommand');
    const cmd = new ListCommand();
    await cmd.execute({ json: options.json, expectedUserId: expectedUserIdFor(command) });
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
    assertNotLocalOnly('recover');
    const { RecoverCommand } = await import('./commands/recoverCommand');
    const cmd = new RecoverCommand();
    await cmd.execute({ web: command.optsWithGlobals().web === true });
  });

const deviceKeyCmd = program
  .command('device-key')
  .description('Manage device keys (CAPY_DEVICE_KEYS=1) — passwordless onboarding for new machines');

deviceKeyCmd
  .command('enroll')
  .description('Enroll a device key for this account on this machine')
  .action(async () => {
    assertNotLocalOnly('device-key enroll');
    const { DeviceKeyEnrollCommand } = await import('./commands/deviceKeyCommand');
    const cmd = new DeviceKeyEnrollCommand();
    await cmd.execute();
  });

deviceKeyCmd
  .command('list')
  .description('List this account\'s enrolled device keys')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--include-deleted', 'include removed wrappers')
  .action(async (options) => {
    assertNotLocalOnly('device-key list');
    const { DeviceKeyListCommand } = await import('./commands/deviceKeyCommand');
    const cmd = new DeviceKeyListCommand();
    await cmd.execute({ json: options.json, includeDeleted: options.includeDeleted });
  });

deviceKeyCmd
  .command('remove <id>')
  .description('Remove (soft-delete) a device key wrapper by id')
  .action(async (id: string) => {
    assertNotLocalOnly('device-key remove');
    const { DeviceKeyRemoveCommand } = await import('./commands/deviceKeyCommand');
    const cmd = new DeviceKeyRemoveCommand();
    await cmd.execute(id);
  });

deviceKeyCmd
  .command('grant')
  .description('Grant a temporary, in-memory device key to this (sandboxed) session — never written to disk')
  .option('--json', 'emit machine-readable JSON instead of the human UI')
  .option('--label <name>', 'display label the ceremony page shows (defaults to this host\'s name)')
  .option('--ttl-minutes <n>', 'grant lifetime in minutes (default 30)', (v) => parseInt(v, 10))
  .action(async (options, command) => {
    assertNotLocalOnly('device-key grant');
    const { DeviceKeyGrantCommand } = await import('./commands/deviceKeyCommand');
    const cmd = new DeviceKeyGrantCommand();
    await cmd.execute({ json: options.json === true || command.optsWithGlobals().json === true, label: options.label, ttlMinutes: options.ttlMinutes });
  });

// CAP-384: internal-only. Never invoked directly by a human — spawnGrantDaemon
// (auth/deviceKey/grantHolder.ts) re-execs this same binary with this hidden
// subcommand to start the long-lived, in-memory grant holder. Reads the key
// material from stdin (never argv/env — see grantHolder.ts's header) and
// blocks until a finite temporary grant expires or it receives a shutdown
// request. Runtime-pair custody is process-bound and has no finite TTL.
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
    assertNotLocalOnly('doors');
    const { DoorsCommand } = await import('./commands/doorsCommand');
    const cmd = new DoorsCommand();
    await cmd.execute({ json: options.json });
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
  .description('Link an existing .env variable to a third-party provider')
  .option('--live', 'use live mode (default: test)')
  .option('--var <name>', 'which existing env var the connection describes')
  .option('--account <id>', 'pick a specific provider account when multiple are configured')
  .option('--no-push', 'record the link locally; do not push it to Capy')
  .option('--non-tty', 'never prompt; resolve choices from flags or fail fast (agents/CI)')
  .option('--reauth', 'pair with the provider again even if a usable session exists')
  .action(async (provider, options, command) => {
    assertNotLocalOnly('connect');
    const { ConnectCommand } = await import('./commands/connectCommand');
    const cmd = new ConnectCommand();
    if (!provider) {
      await cmd.list({ web: command.optsWithGlobals().web === true });
      return;
    }
    // Globals, because `--web` is declared once on the root program. Dropping
    // it here is not a no-op: `ConnectCommand` reads `opts.web` to choose
    // between the browser route and the TTY prompts, so an unpassed flag makes
    // `capy connect stripe --web` answer in a terminal nobody is watching.
    await cmd.execute(provider, {
      web: command.optsWithGlobals().web === true,
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
  .option('-y, --yes', 'skip prompts; run rotate + push + deploy unattended (for CI/automation)')
  .option('--skip-prompts', 'alias for --yes')
  .option('--non-tty', 'never prompt; resolve choices from flags or fail fast (agents/CI)')
  .option('--provider <name>', 'integration to promote an unmanaged var through (non-interactive)')
  .option('--check-readiness', 'inspect target-machine prerequisites without opening a flow')
  .option('--deploy-target <name>', 'deployment target to inspect and use')
  .option('--deploy-kind <kind>', 'deployment destination to inspect before setup')
  .option('--expected-user-id <id>', 'require the requesting Capy account')
  .action(async (varName, options, command) => {
    assertNotLocalOnly('rotate');
    const globals = command.optsWithGlobals();
    const rotateOptions = {
      web: globals.web === true, all: options.all, noPush: options.push === false,
      skipPrompts: !!(options.yes || options.skipPrompts), nonTty: options.nonTty, provider: options.provider,
      deployTarget: options.deployTarget, deployKind: options.deployKind, expectedUserId: expectedUserIdFor(command),
    };
    if (options.checkReadiness) {
      const { inspectLocalRotateReadiness } = await import('./commands/rotateReadiness');
      const readiness = await inspectLocalRotateReadiness({ ...rotateOptions, devMode: false });
      console.log(JSON.stringify(readiness));
      return;
    }
    if (globals.flow) {
      const { runRotateFlow } = await import('./commands/rotateFlow');
      await runRotateFlow(varName, rotateOptions, false);
      return;
    }
    const { RotateCommand } = await import('./commands/rotateCommand');
    const execute = () => new RotateCommand(false).execute(varName, rotateOptions);
    if (globals.json) {
      const { runWithInteraction, createJsonLineInteraction } = await import('./ui/interaction');
      await runWithInteraction(createJsonLineInteraction(process.stdin, process.stdout), execute);
      return;
    }
    await execute();
  });

program
  .command('lock')
  .description('Lock the local-only key (re-prompts the passphrase next time)')
  .action(async () => {
    const { LockCommand } = await import('./commands/lockCommand');
    await new LockCommand().execute();
  });

program.parse(process.argv);

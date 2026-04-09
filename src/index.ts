#!/usr/bin/env node
import { Command } from 'commander';
import { CapyCommand } from './commands/capyCommand';
import { CliOptions } from './types/index';

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

const program = new Command();

program
  .name('capy')
  .description('Capy CLI - SecretOps for the AI age')
  .version('1.0.0')
  .option('--env-path <path>', 'specify custom .env file location')
  .option('-v, --verbose', 'enable detailed logging')
  .option('-f, --force', 're-encrypt existing variables')
  .option('-d, --dry-run', 'preview changes without applying')
  .action(async (options, cmd) => {
    if (cmd.args.length > 0) {
      console.log(`\n  Unknown command: ${cmd.args[0]}\n`);
      console.log('  Available commands:\n');
      console.log('    capy                        \x1b[90mSync secrets\x1b[0m');
      console.log('    capy status                 \x1b[90mShow secret drift\x1b[0m');
      console.log('    capy push                   \x1b[90mPush encrypted values to S3\x1b[0m');
      console.log('    capy deploy pr              \x1b[90mCreate a deployment PR\x1b[0m');
      console.log('    capy deploy setup           \x1b[90mGenerate a deploy token for CI\x1b[0m');
      console.log('    capy deploy revoke <id>     \x1b[90mRevoke a deploy token\x1b[0m');
      console.log('    capy deploy list            \x1b[90mList deploy tokens\x1b[0m');
      console.log('    capy invite <email>         \x1b[90mInvite a teammate\x1b[0m');
      console.log('    capy redeem <code>          \x1b[90mRedeem an invite code\x1b[0m');
      console.log('    capy kick <email>           \x1b[90mRemove a teammate\x1b[0m');
      console.log('    capy users                  \x1b[90mList organization members\x1b[0m');
      console.log('    capy info                   \x1b[90mShow current session info\x1b[0m');
      console.log('');
      process.exit(1);
    }

    const cliOptions: CliOptions = {
      envPath: options.envPath,
      verbose: options.verbose,
      force: options.force,
      dryRun: options.dryRun
    };

    const command = new CapyCommand(cliOptions);
    await command.execute();
  });

program
  .command('status')
  .description('Show secret drift between local, pinned, and remote')
  .action(async () => {
    const { StatusCommand } = await import('./commands/statusCommand');
    const cmd = new StatusCommand();
    await cmd.execute();
  });

program
  .command('branch')
  .description('List secret branches')
  .option('-D <name>', 'Delete a branch')
  .action(async (options) => {
    const { AuthService } = await import('./auth/authService');
    const { ServiceClient } = await import('./service/serviceClient');
    const { ProjectManager } = await import('./core/projectManager');

    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    if (!projectState.initialized) {
      console.error('No keep.lock file found. Run capy first to initialize.');
      process.exit(1);
    }

    const authService = new AuthService(undefined, false, projectState.userId);
    const serviceClient = new ServiceClient();
    const authResult = await authService.authenticate(projectState.organizationId);
    if (!authResult.success) {
      console.error('Authentication failed');
      process.exit(1);
    }
    const token = authService.getToken();
    if (token) serviceClient.setToken(token);

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

      if (branch.name === (projectState.activeBranch || '')) {
        console.log(`Cannot delete the current branch. Switch first with: capy checkout <other-branch>`);
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

    // Tree view
    console.log('');
    console.log(`  Project "${projectName}"`);
    branches.forEach((b, i) => {
      const isLast = i === branches.length - 1;
      const connector = isLast ? '└──' : '├──';
      const name = b.name || 'no branch';
      const prot = b.is_protected ? '  \x1b[90m(protected)\x1b[0m' : '';
      const isCurrent = b.name === (activeBranch || '');
      const current = isCurrent ? '  \x1b[38;5;43m← current\x1b[0m' : '';
      console.log(`  ${connector} ${name}  ${prot}${current}`);
    });
    console.log('');

    // Prompt to switch
    const inquirer = (await import('inquirer')).default;
    const choices = branches
      .filter(b => b.name !== (activeBranch || ''))
      .map(b => ({ name: b.name || 'no branch', value: b.name }));

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
    const { CheckoutCommand } = await import('./commands/checkoutCommand');
    const cmd = new CheckoutCommand();
    await cmd.execute(branch, { create: options.create, protected: options.protected });
  });

program
  .command('push')
  .description('Push encrypted values to S3')
  .action(async () => {
    const { PushCommand } = await import('./commands/pushCommand');
    const cmd = new PushCommand();
    await cmd.execute();
  });

const deploy = program
  .command('deploy')
  .description('Deploy commands: PR creation, token setup, CI decrypt');

deploy
  .command('pr')
  .description('Create a deployment PR with the keep.lock file')
  .action(async () => {
    await CapyCommand.createDeployPR();
  });

deploy
  .command('setup')
  .description('Generate a deploy token for CI/CD')
  .action(async () => {
    const { DeploySetupCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeploySetupCommand();
    await cmd.execute();
  });

deploy
  .command('revoke <deployId>')
  .description('Revoke a deploy token')
  .action(async (deployId: string) => {
    const { DeployRevokeCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployRevokeCommand();
    await cmd.execute(deployId);
  });

deploy
  .command('list')
  .description('List deploy tokens for this project')
  .action(async () => {
    const { DeployListCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployListCommand();
    await cmd.execute();
  });

program
  .command('logout')
  .description('End the current session')
  .action(async () => {
    const { existsSync, unlinkSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');

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

    // Clear global auth session and project key caches
    const globalCapyDir = join(homedir(), '.capy');
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

    if (cleared) {
      console.log('Logged out. Session cleared.');
    } else {
      console.log('No active session.');
    }
  });

program
  .command('help')
  .description('Show help information')
  .action(() => {
    program.outputHelp();
  });

program
  .command('version')
  .description('Show version information')
  .action(() => {
    console.log('Capy CLI v1.0.0');
  });


program
  .command('invite <email>')
  .description('Invite a teammate to this organization')
  .action(async (email) => {
    const { InviteCommand } = await import('./commands/inviteCommand');
    const cmd = new InviteCommand();
    await cmd.execute(email);
  });

program
  .command('redeem <code>')
  .description('Redeem an invite code to join an organization')
  .action(async (code) => {
    const { RedeemCommand } = await import('./commands/redeemCommand');
    const cmd = new RedeemCommand();
    await cmd.execute(code);
  });

program
  .command('kick <email>')
  .description('Remove a teammate from this organization')
  .action(async (email) => {
    const { KickCommand } = await import('./commands/kickCommand');
    const cmd = new KickCommand();
    await cmd.execute(email);
  });

program
  .command('info')
  .description('Show current session info')
  .action(async () => {
    const { InfoCommand } = await import('./commands/infoCommand');
    const cmd = new InfoCommand();
    await cmd.execute();
  });

program
  .command('users')
  .description('List organization members and their project access')
  .action(async () => {
    const { UsersCommand } = await import('./commands/usersCommand');
    const cmd = new UsersCommand();
    await cmd.execute();
  });

program.parse(process.argv);

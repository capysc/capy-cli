#!/usr/bin/env node
import { Command } from 'commander';
// Removed chalk for now to fix ES module issues
import { CapyCommand } from './commands/capyCommand';
import { CliOptions } from './types/index';

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
      console.log('    capy branch                 \x1b[90mList secret branches\x1b[0m');
      console.log('    capy checkout -b <branch>   \x1b[90mSwitch to a secret branch\x1b[0m');
      console.log('    capy deploy                 \x1b[90mCreate a deployment PR\x1b[0m');
      console.log('');
      process.exit(1);
    }

    const cliOptions: CliOptions = {
      envPath: options.envPath,
      verbose: options.verbose,
      force: options.force,
      dryRun: options.dryRun
    };

    console.log('\n🔐 Capy CLI\n');

    const command = new CapyCommand(cliOptions);
    await command.execute();
  });

program
  .command('branch')
  .description('List secret branches')
  .action(async () => {
    const { AuthService } = await import('./auth/authService');
    const { ServiceClient } = await import('./service/serviceClient');
    const { ProjectManager } = await import('./core/projectManager');

    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    if (!projectState.initialized) {
      console.error('No .keep file found. Run capy first to initialize.');
      process.exit(1);
    }

    const authService = new AuthService();
    const serviceClient = new ServiceClient();
    const authResult = await authService.authenticate(projectState.organizationId);
    if (!authResult.success) {
      console.error('Authentication failed');
      process.exit(1);
    }
    const token = authService.getToken();
    if (token) serviceClient.setToken(token);

    const branches = await serviceClient.listBranches(projectState.projectId!);
    const activeBranch = projectState.activeBranch;

    const maxLen = Math.max(...branches.map(b => (b.name || 'no branch').length));
    const choices = branches.map(b => {
      const name = b.name || 'no branch';
      const padded = name.padEnd(maxLen + 2);
      const isCurrent = b.name === (activeBranch || '');
      const currentLabel = isCurrent ? '\x1b[38;5;43m← current\x1b[0m' : '';
      const prodLabel = b.is_production ? '\x1b[90m(protected)\x1b[0m' : '';
      return {
        name: `${padded}${currentLabel}${prodLabel}`,
        value: b.name,
        short: name,
      };
    });

    const inquirer = (await import('inquirer')).default;
    const { selected } = await inquirer.prompt([{
      type: 'list',
      name: 'selected',
      message: 'Switch branch:',
      choices,
    }]);

    // If they picked a different branch, check it out
    if (selected !== (activeBranch || '')) {
      const { CheckoutCommand } = await import('./commands/checkoutCommand');
      const cmd = new CheckoutCommand();
      await cmd.execute(selected, {});
    }
  });

program
  .command('checkout <branch>')
  .description('Switch to a secret branch')
  .option('-b, --create', 'Create the branch if it does not exist')
  .option('--production', 'Mark as a production branch (protected, invite-only)')
  .action(async (branch, options) => {
    const { CheckoutCommand } = await import('./commands/checkoutCommand');
    const cmd = new CheckoutCommand();
    await cmd.execute(branch, { create: options.create, production: options.production });
  });

program
  .command('deploy')
  .description('Create a deployment PR with the .keep file')
  .action(async () => {
    await CapyCommand.createDeployPR();
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

program.parse(process.argv);

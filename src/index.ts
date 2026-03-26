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
      console.log('    capy                        Sync secrets');
      console.log('    capy checkout -b <branch>   Switch to a secret branch');
      console.log('    capy deploy                 Create a deployment PR');
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

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
  .action(async (options) => {
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

// Parse command line arguments
program.parse(process.argv);

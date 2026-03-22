#!/usr/bin/env node
/**
 * Dev-only entrypoint for Capy CLI.
 * Enables mock authentication for local testing.
 * This file is NOT included in production builds or npm packages.
 */
import { Command } from 'commander';
import { CapyCommand } from './commands/capyCommand';
import { CliOptions } from './types/index';

const program = new Command();

program
  .name('capy-dev')
  .description('Capy CLI (DEV MODE - mock auth enabled)')
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

    console.log('\n🔐 Capy CLI (DEV MODE)\n');

    const command = new CapyCommand(cliOptions, true);
    await command.execute();
  });

program.parse(process.argv);

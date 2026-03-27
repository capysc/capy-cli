#!/usr/bin/env node
/**
 * Dev-only entrypoint for Capy CLI.
 * Enables mock authentication for local testing.
 * This file is NOT included in production builds or npm packages.
 */
import { Command } from 'commander';
import { CapyCommand } from './commands/capyCommand';
import { CliOptions } from './types/index';

// Default to localhost for dev builds
if (!process.env.CAPY_API_URL) {
  process.env.CAPY_API_URL = 'http://localhost:3000';
}

const program = new Command();

program
  .name('capy-dev')
  .description('Capy CLI (DEV MODE - mock auth enabled)')
  .version('1.0.0')
  .option('--env-path <path>', 'specify custom .env file location')
  .option('-v, --verbose', 'enable detailed logging')
  .option('-f, --force', 're-encrypt existing variables')
  .option('-d, --dry-run', 'preview changes without applying')
  .action(async (options, cmd) => {
    if (cmd.args.length > 0) {
      console.log(`\n  Unknown command: ${cmd.args[0]}\n`);
      console.log('  Available commands:\n');
      console.log('    capy-dev                        \x1b[90mSync secrets\x1b[0m');
      console.log('    capy-dev branch                 \x1b[90mList secret branches\x1b[0m');
      console.log('    capy-dev checkout -b <branch>   \x1b[90mSwitch to a secret branch\x1b[0m');
      console.log('    capy-dev deploy                 \x1b[90mCreate a deployment PR\x1b[0m');
      console.log('');
      process.exit(1);
    }

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
      console.error('No .keep file found. Run capy-dev first to initialize.');
      process.exit(1);
    }

    const authService = new AuthService(undefined, true);
    const serviceClient = new ServiceClient(undefined, true);
    const authResult = await authService.authenticate(projectState.organizationId);
    if (!authResult.success) {
      console.error('Authentication failed');
      process.exit(1);
    }
    const token = authService.getToken();
    if (token) serviceClient.setToken(token);

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
      const prot = b.is_production ? '\x1b[90m(protected)\x1b[0m' : '\x1b[90m(unprotected)\x1b[0m';
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
        const cmd = new CheckoutCommand(true);
        await cmd.execute(selected, {});
      }
    }
  });

program
  .command('checkout <branch>')
  .description('Switch to a secret branch')
  .option('-b, --create', 'Create the branch if it does not exist')
  .option('--production', 'Mark as a production branch (protected, invite-only)')
  .action(async (branch, options) => {
    const { CheckoutCommand } = await import('./commands/checkoutCommand');
    const cmd = new CheckoutCommand(true);
    await cmd.execute(branch, { create: options.create, production: options.production });
  });

program
  .command('deploy')
  .description('Create a deployment PR with the .keep file')
  .action(async () => {
    const { CapyCommand } = await import('./commands/capyCommand');
    await CapyCommand.createDeployPR();
  });

program
  .command('decrypt')
  .description('Decrypt .env file back to plaintext (dev only)')
  .option('--env-path <path>', 'specify custom .env file location')
  .action(async (options) => {
    const { FileManager } = await import('./files/fileManager');
    const { ProjectManager } = await import('./core/projectManager');

    const fm = new FileManager();
    const pm = new ProjectManager();
    const decryptKey = pm.readDecryptKey();

    if (!decryptKey) {
      console.error('❌ No .decrypt key found. Run capy-dev first to initialize.');
      process.exit(1);
    }

    const envPath = options.envPath || '.env';
    const decrypted = fm.readEncryptedEnvFile(decryptKey.decryption_key, envPath);

    if (Object.keys(decrypted).length === 0) {
      console.log('No variables found in .env');
      process.exit(0);
    }

    const { writeFileSync } = await import('fs');
    const content = Object.entries(decrypted)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    writeFileSync(envPath, content + '\n', 'utf-8');
    console.log(`✓ Decrypted ${Object.keys(decrypted).length} variable(s) in ${envPath}`);
  });

program.parse(process.argv);

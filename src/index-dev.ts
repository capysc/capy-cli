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
      console.log('    capy-dev invite <email>         \x1b[90mInvite a teammate\x1b[0m');
      console.log('    capy-dev redeem <code>          \x1b[90mRedeem an invite code\x1b[0m');
      console.log('    capy-dev kick <email>           \x1b[90mRemove a teammate\x1b[0m');
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

    const command = new CapyCommand(cliOptions, true);
    await command.execute();
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
      console.error('No .keep file found. Run capy-dev first to initialize.');
      process.exit(1);
    }

    const authService = new AuthService(undefined, true);
    const serviceClient = new ServiceClient(undefined, true);
    serviceClient.setTokenRefresher(async () => {
      const refreshed = await authService.refreshToken();
      return refreshed ? authService.getToken() : null;
    });
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
        console.log(`Cannot delete the current branch. Switch first with: capy-dev checkout <other-branch>`);
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

      // Remove branch entries from .keep
      const keep = pm.readKeepFile();
      if (keep) {
        const { FileManager } = await import('./files/fileManager');
        const fm = new FileManager();
        for (const [varName, entries] of Object.entries(keep.variables)) {
          keep.variables[varName] = entries.filter(e => e.branch !== deleteName);
        }
        fm.writeKeepFile(keep);
      }

      console.log(`Deleted branch "${deleteName}"`);
      return;
    }

    const branches = await serviceClient.listBranches(projectState.projectId!);
    const activeBranch = projectState.activeBranch;
    const projectName = projectState.projectName || 'project';

    // Tree view
    console.log('');
    console.log(`Project "${projectName}"`);
    branches.forEach((b, i) => {
      const isLast = i === branches.length - 1;
      const connector = isLast ? '└──' : '├──';
      const name = b.name || 'no branch';
      const prot = b.is_production ? '  \x1b[90m(protected)\x1b[0m' : '';
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
  .command('invite <email>')
  .description('Invite a teammate to your organization')
  .action(async (email) => {
    const { InviteCommand } = await import('./commands/inviteCommand');
    const cmd = new InviteCommand(process.env.CAPY_API_URL);
    await cmd.execute(email);
  });

program
  .command('redeem <code>')
  .description('Redeem an invite code to join an organization')
  .action(async (code) => {
    const { RedeemCommand } = await import('./commands/redeemCommand');
    const cmd = new RedeemCommand(process.env.CAPY_API_URL);
    await cmd.execute(code);
  });

program
  .command('kick <email>')
  .description('Remove a teammate from this organization')
  .action(async (email) => {
    const { KickCommand } = await import('./commands/kickCommand');
    const cmd = new KickCommand(process.env.CAPY_API_URL);
    await cmd.execute(email);
  });

program
  .command('decrypt')
  .description('Decrypt .env file back to plaintext (dev only)')
  .option('--env-path <path>', 'specify custom .env file location')
  .action(async (options) => {
    const { FileManager } = await import('./files/fileManager');
    const { ProjectManager } = await import('./core/projectManager');
    const { resolveProjectKey } = await import('./crypto/keyResolver');

    const fm = new FileManager();
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();

if (!keep) {
      console.error('No .keep file found. Run capy-dev first to initialize.');
      process.exit(1);
    }

    // Resolve key from global keyring (requires prior auth)
    let encryptionKey: string;
    try {
      // Use a placeholder userId — resolveProjectKey only needs it for wrapping key derivation,
      // and the project key cache should already exist from the init/sync flow
      encryptionKey = resolveProjectKey(keep.org_id, keep.project_id, '');
    } catch {
      console.error('No encryption key found. Run capy-dev first to sync.');
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
      const content = Object.entries(decrypted)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

      writeFileSync(envPath, content + '\n', 'utf-8');
      console.log(`Decrypted ${Object.keys(decrypted).length} variable(s) in ${envPath}`);
    } catch (error: any) {
      const { displayErrorAndExit } = await import('./ui/errorScreen');
      displayErrorAndExit(error, {
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

program.parse(process.argv);

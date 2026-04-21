#!/usr/bin/env node
/**
 * Dev-only entrypoint for Capy CLI.
 * Enables mock authentication for local testing.
 * This file is NOT included in production builds or npm packages.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { Command } from 'commander';
import { CapyCommand } from './commands/capyCommand';
import { CliOptions } from './types/index';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

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
      console.log(`    ${B('capy-dev')}                        \x1b[90mSync secrets\x1b[0m`);
      console.log(`    ${B('capy-dev')} branch                 \x1b[90mList secret branches\x1b[0m`);
      console.log(`    ${B('capy-dev')} checkout -b <branch>   \x1b[90mSwitch to a secret branch\x1b[0m`);
      console.log(`    ${B('capy-dev')} invite <email>         \x1b[90mInvite a teammate\x1b[0m`);
      console.log(`    ${B('capy-dev')} redeem <code>          \x1b[90mRedeem an invite code\x1b[0m`);
      console.log(`    ${B('capy-dev')} kick <email>           \x1b[90mRemove a teammate\x1b[0m`);
      console.log(`    ${B('capy-dev')} users                  \x1b[90mList organization members\x1b[0m`);
      console.log(`    ${B('capy-dev')} deploy                 \x1b[90mGenerate a deployment\x1b[0m`);
      console.log(`    ${B('capy-dev')} decrypt                \x1b[90mDecrypt secrets offline (owner only)\x1b[0m`);
      console.log(`    ${B('capy-dev')} end-recover            \x1b[90mEnd recovery session\x1b[0m`);
      console.log(`    ${B('capy-dev')} auth-decrypt           \x1b[90mDecrypt using auth (dev only)\x1b[0m`);
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
      console.error(`No keep.lock file found. Run ${B('capy-dev')} first to initialize.`);
      process.exit(1);
    }

    const authService = new AuthService(undefined, true, projectState.userId);
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

    // Tree view
    console.log('');
    console.log(`Project "${projectName}"`);
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
  .option('--protected', 'Mark as a protected branch (invite-only)')
  .action(async (branch, options) => {
    const { CheckoutCommand } = await import('./commands/checkoutCommand');
    const cmd = new CheckoutCommand(true);
    await cmd.execute(branch, { create: options.create, protected: options.protected });
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
  .action(async () => {
    const { StatusCommand } = await import('./commands/statusCommand');
    const cmd = new StatusCommand(false, true);
    await cmd.execute();
  });

const deploy = program
  .command('deploy')
  .description('Set up secret delivery to a deployment platform')
  .action(async () => {
    const { DeployCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployCommand(process.env.CAPY_API_URL, true);
    await cmd.execute();
  });

deploy
  .command('revoke <deployId>')
  .description('Revoke a deploy token')
  .action(async (deployId: string) => {
    const { DeployRevokeCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployRevokeCommand(process.env.CAPY_API_URL, true);
    await cmd.execute(deployId);
  });

deploy
  .command('list')
  .description('List deploy tokens for this project')
  .action(async () => {
    const { DeployListCommand } = await import('./commands/deployTokenCommand');
    const cmd = new DeployListCommand(process.env.CAPY_API_URL, true);
    await cmd.execute();
  });

program
  .command('invite <email>')
  .description('Invite a teammate to your organization')
  .action(async (email) => {
    const { InviteCommand } = await import('./commands/inviteCommand');
    const cmd = new InviteCommand(process.env.CAPY_API_URL, true);
    await cmd.execute(email);
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
  .command('kick <email>')
  .description('Remove a teammate from this organization')
  .action(async (email) => {
    const { KickCommand } = await import('./commands/kickCommand');
    const cmd = new KickCommand(process.env.CAPY_API_URL, true);
    await cmd.execute(email);
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
    let encryptionKey: string;
    try {
      const syncState = pm.readSyncState();
      const authService = new AuthService(undefined, true, syncState?.user_id);
      const serviceClient = new ServiceClient(undefined, true);
      const authResult = await authService.authenticateSilent(keep.org_id);
      if (!authResult.success) throw new Error('auth failed — run capy-dev first');
      const token = authService.getToken();
      if (token) serviceClient.setToken(token);

      const keyOps = {
        coDecrypt: (oid: string, ct: string) => serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
        wrapOuterLayer: (oid: string, pt: string) => serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
      };
      encryptionKey = await resolveProjectKey(keep.org_id, keep.project_id, authResult.user_id!, keyOps);
    } catch {
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
  .command('org')
  .description('Switch organization')
  .action(async () => {
    const { OrgCommand } = await import('./commands/orgCommand');
    const cmd = new OrgCommand(process.env.CAPY_API_URL, true);
    await cmd.execute();
  });

program
  .command('info')
  .description('Show current session info')
  .action(async () => {
    const { InfoCommand } = await import('./commands/infoCommand');
    const cmd = new InfoCommand(process.env.CAPY_API_URL, true);
    await cmd.execute();
  });

program
  .command('users')
  .description('List organization members and their project access')
  .action(async () => {
    const { UsersCommand } = await import('./commands/usersCommand');
    const cmd = new UsersCommand(process.env.CAPY_API_URL, true);
    await cmd.execute();
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

program.parse(process.argv);

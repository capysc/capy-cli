import inquirer from 'inquirer';
import ora from '../ui/spinner';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { Organization } from '../types/index';
import {
  generateSeedPhrase,
  seedPhraseToMasterKey,
} from '../crypto/keyManager';
import { wrapAndSaveMasterKey, KeyServiceOps } from '../crypto/keyResolver';

const warn = (s: string) => `\x1b[38;2;235;90;120m${s}\x1b[0m`;

function keyServiceOpsFromClient(serviceClient: ServiceClient): KeyServiceOps {
  return {
    coDecrypt: (orgId, ciphertext) => serviceClient.coDecrypt(orgId, ciphertext).then(r => r.plaintext),
    wrapOuterLayer: (orgId, plaintext) => serviceClient.wrapOuterLayer(orgId, plaintext).then(r => r.ciphertext),
  };
}

export async function promptForAvailableOrgName(
  authService: AuthService,
  promptMessage = 'Organization name:',
): Promise<string> {
  const { orgName } = await inquirer.prompt([{
    type: 'input',
    name: 'orgName',
    message: promptMessage,
    validate: async (input: string) => {
      const trimmed = input.trim();
      if (trimmed.length === 0) return 'Organization name cannot be empty';
      if (trimmed.length > 100) return 'Organization name must be 100 characters or fewer';
      try {
        const { available } = await authService.checkOrgName(trimmed);
        if (!available) {
          return `"${trimmed}" is already taken. Org names must be unique to prevent impersonation — try a variant (e.g. "${trimmed} HQ", "${trimmed} Labs").`;
        }
        return true;
      } catch {
        return true;
      }
    },
  }]);
  return orgName.trim();
}

export async function createNewOrganization(
  authService: AuthService,
  serviceClient: ServiceClient,
  refreshToken: string,
  userId: string,
): Promise<Organization> {
  let orgName = await promptForAvailableOrgName(authService);

  const seedPhrase = generateSeedPhrase();

  const boxLines = [
    'This recovery phrase generates the master key for',
    'all projects in this organization.',
    '',
    '1) As its owner, only you have it',
    '2) It only exists here and now, and cannot be',
    '   retrieved when lost',
    '',
    'Capy is a ZERO TRUST secrets platform, which means',
    'we do not store and cannot decode your secrets for',
    'you. IF YOU LOSE THIS PHRASE WE CANNOT HELP YOU!',
    '',
    'To learn more about zero-trust:',
    'https://capy.sc/zero-trust',
  ];

  const maxLen = Math.max(50, ...boxLines.map(l => l.length + 2));
  const title = '!!!IMPORTANT!!! - SAVE THIS RECOVERY PHRASE';
  const titlePad = Math.max(0, maxLen - title.length);
  const titleLeft = Math.floor(titlePad / 2);
  const titleRight = titlePad - titleLeft;

  console.log('');
  console.log(warn('─'.repeat(maxLen + 2)));
  console.log(warn(' '.repeat(titleLeft + 1) + title + ' '.repeat(titleRight + 1)));
  console.log(warn('─'.repeat(maxLen + 2)));
  console.log('');
  console.log('');
  console.log('');
  console.log(seedPhrase);
  console.log('');
  console.log('');
  console.log('');

  console.log(warn('┌' + '─'.repeat(maxLen) + '┐'));
  for (const line of boxLines) {
    const pad = maxLen - line.length - 1;
    console.log(`${warn('│')} ${warn(line)}${' '.repeat(Math.max(0, pad))}${warn('│')}`);
  }
  console.log(warn('└' + '─'.repeat(maxLen) + '┘'));
  console.log('');

  const { promptCopyToClipboard } = await import('../ui/clipboard');
  await promptCopyToClipboard(seedPhrase, '');
  console.log('');

  while (true) {
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: 'I have saved my recovery phrase',
      default: false,
    }]);
    if (confirmed) break;
    console.log(warn('⚠ The recovery phrase cannot be recovered if lost. Scroll up to review, then confirm.'));
    console.log('');
  }

  while (true) {
    const orgSpinner = ora('Creating organization...').start();
    try {
      const org = await authService.createOrganization(orgName, refreshToken, userId);
      orgSpinner.succeed(`Organization "${org.name}" created`);

      const masterKey = seedPhraseToMasterKey(seedPhrase);
      await wrapAndSaveMasterKey(masterKey, org.id, userId, keyServiceOpsFromClient(serviceClient));

      return org;
    } catch (err: any) {
      orgSpinner.fail('Failed to create organization');
      if (err && err.status === 409) {
        console.log('');
        orgName = await promptForAvailableOrgName(authService, 'That name was claimed while you were setting up. Pick another:');
        continue;
      }
      throw err;
    }
  }
}

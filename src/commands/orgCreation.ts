import inquirer from 'inquirer';
import ora from '../ui/spinner';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { Organization } from '../types/index';
import {
  generateSeedPhrase,
  seedPhraseToMasterKey,
  CURRENT_KDF_VERSION,
} from '../crypto/keyManager';
import { wrapAndSaveMasterKey, KeyServiceOps } from '../crypto/keyResolver';
import { displayAndConfirmRecoveryPhrase } from '../ui/recoveryPhrase';

// (recovery-phrase display + confirm lives in ../ui/recoveryPhrase)

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

  await displayAndConfirmRecoveryPhrase(seedPhrase, boxLines);

  while (true) {
    const orgSpinner = ora('Creating organization...').start();
    try {
      const org = await authService.createOrganization(orgName, refreshToken, userId);
      orgSpinner.succeed(`Organization "${org.name}" created`);

      // New orgs derive M under the current (strongest) KDF version. This is
      // what binds the org to v2; legacy orgs created before this stay on v1 and
      // are detected by trial decryption at the phrase→M boundaries.
      const masterKey = seedPhraseToMasterKey(seedPhrase, CURRENT_KDF_VERSION);
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

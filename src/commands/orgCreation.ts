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

/** Shared name check, used by both the TTY prompt and the browser screen. */
async function validateOrgName(authService: AuthService, input: string): Promise<true | string> {
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
}

export async function promptForAvailableOrgName(
  authService: AuthService,
  promptMessage = 'Organization name:',
  web = false,
): Promise<string> {
  if (web) {
    // No TTY under --web: an inquirer prompt here hangs forever with nothing on
    // screen and no URL to hand the user — the org step is where init stalls.
    const { promptTextInBrowser } = await import('../ui/selectWeb');
    const entered = await promptTextInBrowser({
      title: 'Name your organization',
      intro: promptMessage,
      label: 'Organization name',
      validate: (input: string) => validateOrgName(authService, input),
    }, { open: !process.env.CAPY_WEB_NO_OPEN });
    if (entered === null) throw new Error('Organization naming cancelled');
    return entered;
  }
  const { orgName } = await inquirer.prompt([{
    type: 'input',
    name: 'orgName',
    message: promptMessage,
    validate: (input: string) => validateOrgName(authService, input),
  }]);
  return orgName.trim();
}

export async function createNewOrganization(
  authService: AuthService,
  serviceClient: ServiceClient,
  refreshToken: string,
  userId: string,
  web = false,
): Promise<Organization> {
  let orgName = await promptForAvailableOrgName(authService, undefined, web);

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

  if (web) {
    // SECURITY: under --web the phrase must render in the browser only. The TTY
    // path prints all 24 words to stdout, which an MCP-driven run captures — so
    // the agent would see a recovery-equivalent secret. Show + confirm in the
    // loopback page instead; the phrase stays in this process's memory.
    const { showRecoveryPhraseInBrowser } = await import('../ui/onboardingWeb');
    const acknowledged = await showRecoveryPhraseInBrowser(
      seedPhrase,
      boxLines,
      { open: !process.env.CAPY_WEB_NO_OPEN },
    );
    if (!acknowledged) throw new Error('Recovery phrase not confirmed — organization not created');
  } else {
    await displayAndConfirmRecoveryPhrase(seedPhrase, boxLines);
  }

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
        orgName = await promptForAvailableOrgName(authService, 'That name was claimed while you were setting up. Pick another:', web);
        continue;
      }
      throw err;
    }
  }
}

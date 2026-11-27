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
/** The CLI's cap. */
export const MAX_ORG_NAME_LENGTH = 100;

// (recovery-phrase display + confirm lives in ../ui/recoveryPhrase)

function keyServiceOpsFromClient(serviceClient: ServiceClient): KeyServiceOps {
  return {
    coDecrypt: (orgId, ciphertext) => serviceClient.coDecrypt(orgId, ciphertext).then(r => r.plaintext),
    wrapOuterLayer: (orgId, plaintext) => serviceClient.wrapOuterLayer(orgId, plaintext).then(r => r.ciphertext),
  };
}

// Shared name check, used by the TTY prompt. No "is this name taken" pre-check here (CAP-924): the service answers that
// only for a signed-in user, and this prompt runs before the CLI holds an
// access token. A taken name comes back as a 409 from create-org, which asks
// for another name and keeps the same recovery phrase.
function validateOrgName(input: string): true | string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return 'Organization name cannot be empty';
  if (trimmed.length > MAX_ORG_NAME_LENGTH) {
    return `Organization name must be ${MAX_ORG_NAME_LENGTH} characters or fewer`;
  }
  return true;
}

export async function promptForOrgName(
  promptMessage = 'Organization name:',
): Promise<string> {
  const { orgName } = await inquirer.prompt([{
    type: 'input',
    name: 'orgName',
    message: promptMessage,
    validate: (input: string) => validateOrgName(input),
  }]);
  return orgName.trim();
}

/** The zero-trust warning the CLI prints beside the phrase. */
export const ZERO_TRUST_URL = 'https://capy.sc/zero-trust';

export const ORG_PHRASE_NOTES = [
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
];

const ORG_PHRASE_BOX = [...ORG_PHRASE_NOTES, '', 'To learn more about zero-trust:', ZERO_TRUST_URL];

export async function createNewOrganization(
  authService: AuthService,
  serviceClient: ServiceClient,
  refreshToken: string,
  userId: string,
): Promise<Organization> {
  // ONE phrase for the whole run, generated before the first question. A 409
  // sends the name step round again and the same words have to key whatever
  // name is picked next — regenerating would hand the user a second phrase
  // after they had already written the first one down.
  const seedPhrase = generateSeedPhrase();

  const orgName = await promptForOrgName();
  await displayAndConfirmRecoveryPhrase(seedPhrase, ORG_PHRASE_BOX);

  return createOrganizationNamed({ authService, serviceClient, refreshToken, userId, seedPhrase }, orgName);
}

/** Creates the org; on a 409 asks for another name and goes round again with the same phrase. */
async function createOrganizationNamed(
  ctx: {
    authService: AuthService;
    serviceClient: ServiceClient;
    refreshToken: string;
    userId: string;
    seedPhrase: string;
  },
  orgName: string,
): Promise<Organization> {
  const { authService, serviceClient, refreshToken, userId, seedPhrase } = ctx;
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
      const nextName = await promptForOrgName(
        'That organization name is already taken. Pick another:',
      );
      return createOrganizationNamed(ctx, nextName);
    }
    throw err;
  }
}

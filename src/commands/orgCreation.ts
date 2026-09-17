import { CapyError } from '../types';
import { keepOrigin } from '../ui/screens/keepScreens';
import inquirer from 'inquirer';
import ora from '../ui/spinner';
import { AuthService, type InstalledInitRunOrganization } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import {
  generateSeedPhrase,
  seedPhraseToMasterKey,
  CURRENT_KDF_VERSION,
} from '../crypto/keyManager';
import { wrapAndSaveMasterKey, KeyServiceOps } from '../crypto/keyResolver';
import { displayAndConfirmRecoveryPhrase } from '../ui/recoveryPhrase';
import { attemptCaseAEnrollment, DeviceKeyWiringContext } from '../auth/deviceKey/wiring';
// Type-only: erased at compile time, so the TTY path does not pull the browser
// wizard into its module graph just to name an organization.
import type { OrgNameVerdict } from '../ui/onboardingWeb';
import { INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH } from '../auth/initRunOrganizationInstaller';

/** The CLI's cap. One definition; the browser screen is handed this value. */
export const MAX_ORG_NAME_LENGTH = 100;

// (recovery-phrase display + confirm lives in ../ui/recoveryPhrase; the browser
// half of both questions lives in ../ui/onboardingWeb)

/** Adapts a `ServiceClient` into the two-op interface `wrapAndSaveMasterKey` needs. */
export function keyServiceOpsFromClient(serviceClient: ServiceClient): KeyServiceOps {
  return {
    coDecrypt: (orgId, ciphertext) => serviceClient.coDecrypt(orgId, ciphertext).then(r => r.plaintext),
    wrapOuterLayer: (orgId, plaintext) => serviceClient.wrapOuterLayer(orgId, plaintext).then(r => r.ciphertext),
  };
}

/**
 * Is this name free?
 *
 * A verdict rather than a sentence, so nothing downstream decides anything by
 * reading prose. `unreachable` is its own answer because the CLI swallows a
 * failed check and carries on as though the name were free — which is a real
 * behaviour with a real consequence (the collision reappears as a 409 after
 * the recovery phrase has been shown), not a silence.
 */
async function checkOrgNameAvailable(
  authService: AuthService,
  name: string,
): Promise<OrgNameVerdict> {
  try {
    const { available } = await authService.checkOrgName(name);
    return available ? 'available' : 'taken';
  } catch {
    return 'unreachable';
  }
}

/** Shared name check, used by the TTY prompt. */
async function validateOrgName(authService: AuthService, input: string): Promise<true | string> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return 'Organization name cannot be empty';
  if (trimmed.length > MAX_ORG_NAME_LENGTH) {
    return `Organization name must be ${MAX_ORG_NAME_LENGTH} characters or fewer`;
  }
  if ((await checkOrgNameAvailable(authService, trimmed)) === 'taken') {
    return `"${trimmed}" is already taken. Org names must be unique to prevent impersonation — try a variant (e.g. "${trimmed} HQ", "${trimmed} Labs").`;
  }
  return true;
}

export async function promptForAvailableOrgName(
  authService: AuthService,
  promptMessage = 'Organization name:',
): Promise<string> {
  const { orgName } = await inquirer.prompt([{
    type: 'input',
    name: 'orgName',
    message: promptMessage,
    validate: (input: string) => validateOrgName(authService, input),
  }]);
  return orgName.trim();
}

/**
 * The zero-trust warning the CLI prints beside the phrase.
 *
 * Split rather than one array so the browser can turn the last two lines into
 * the anchor the screen renders ("Learn more about zero-trust") instead of
 * leaving a bare URL at the foot of the most security-sensitive page in the
 * product. The terminal still gets the block it always printed, byte for byte —
 * built by concatenation here rather than recovered by matching prose, because
 * a sentence is not a place to keep a structural fact.
 */
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

/**
 * CAP-382: when supplied (i.e. CAPY_DEVICE_KEYS=1 and the exchange captured
 * a Wave-B org-less token), the just-created org's master key is also
 * offered to the device-key enrollment ceremony — Case A, run exactly where
 * CAP-380 designed it to be called (right after the existing
 * wrapAndSaveMasterKey write, below). Absent, this function's behavior is
 * byte-identical to before CAP-382 existed.
 */
export interface DeviceKeyEnrollmentOptions {
  readonly ctx: DeviceKeyWiringContext;
  readonly orglessToken: string | null | undefined;
}

export type CreatedOrganizationContext = InstalledInitRunOrganization & Readonly<{
  serviceClient: ServiceClient;
}>;

export async function createNewOrganization(
  authService: AuthService,
  serviceClientFor: (authService: AuthService) => ServiceClient,
  refreshToken: string,
  userId: string,
  web = false,
  deviceKeyEnrollment?: DeviceKeyEnrollmentOptions,
): Promise<CreatedOrganizationContext> {
  const url = new URL('/signup', keepOrigin());
  const keepUrl = `${url.href}?intent=create-org`;
  throw new CapyError(
    `Organization creation is handled in Keep. Continue at ${keepUrl}`,
    'KEEP_ONBOARDING_REQUIRED',
    { keep_url: keepUrl },
  );
}

/**
 * The browser half: name the organization and write down its recovery phrase,
 * in one wizard with one rail.
 *
 * `raced` is the name the server just refused with a 409, so the retry opens on
 * the name step with that name in the field and the reason attached — the same
 * phrase, already written down, carries over untouched.
 */
async function nameAndConfirmInBrowser(
  authService: AuthService,
  seedPhrase: string,
  raced?: string,
): Promise<string> {
  const { createOrganizationInBrowser } = await import('../ui/onboardingWeb');
  const result = await createOrganizationInBrowser({
    phrase: seedPhrase,
    bodyLines: ORG_PHRASE_NOTES,
    learnMoreUrl: ZERO_TRUST_URL,
    name: raced,
    nameError: raced ? 'RACE_409' : undefined,
    // A retry asks for the name and nothing else. The phrase is unchanged and
    // already written down; showing it again would make "this is the only time
    // it is shown" false the first time anybody read it.
    nameOnly: raced !== undefined,
    maxNameLength: MAX_ORG_NAME_LENGTH,
    checkName: (name: string) => checkOrgNameAvailable(authService, name),
    open: !process.env.CAPY_WEB_NO_OPEN,
  });
  if (result.cancelled) {
    throw new Error(
      raced
        ? 'Naming cancelled — organization not created'
        : 'Recovery phrase not confirmed — organization not created',
    );
  }
  return result.name;
}

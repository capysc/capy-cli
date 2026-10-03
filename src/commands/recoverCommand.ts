import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import {
  hasOrgKey,
  wrapAndSaveMasterKey,
  resolveProjectKeyByTrial,
} from '../crypto/keyResolver';
import {
  validateSeedPhrase,
  seedPhraseToMasterKey,
  CURRENT_KDF_VERSION,
} from '../crypto/keyManager';
import { excludeSystemProject } from '../system/reservedProjectName';

/** A piece of this org's ciphertext, and a way to test a key against it. */
interface CiphertextOracle {
  projectId: string;
  verify: (projectKey: string) => boolean;
}

/**
 * Why no oracle could be found.
 *
 * Four distinct conditions that this function used to collapse into one `null`.
 * They are not the same answer: an org with nothing stored is safe to write a
 * key for, while a `listProjects` that 403'd or a fetch that failed means the
 * check DID NOT RUN, which is not the same as passing. `other-branch` is the
 * one that is easiest to miss — `getDecryptData` is called without a branch,
 * so it only ever sees each project's default branch, and an org whose secrets
 * all live elsewhere looks identical to an empty one from here.
 *
 * A code, minted where the condition is first known, so nothing downstream has
 * to read prose to tell the four apart.
 */
export type OracleGapCode = 'no-secrets' | 'list-failed' | 'fetch-failed' | 'other-branch';

/**
 * Finds a piece of this org's ciphertext to use as a KDF-version oracle.
 *
 * The org's KDF version isn't recorded anywhere, so to recover the correct M we
 * need a known ciphertext to test candidate keys against. Scans the org's
 * projects for any genuinely-encrypted value and returns a verifier bound to
 * that project. Returns a `gap` code when there is nothing to verify against.
 */
/** `null` on failure — kept out of `findOrgCiphertextOracle`'s body so that function needs no `let`. */
async function tryListProjects(serviceClient: ServiceClient): Promise<Array<{ id: string; organization_id: string; name: string }> | null> {
  try {
    return await serviceClient.listProjects();
  } catch {
    return null;
  }
}

/** `null` when the project's decrypt data could not be read. */
async function tryEnvContent(serviceClient: ServiceClient, projectId: string): Promise<string | null> {
  try {
    return (await serviceClient.getDecryptData(projectId)).env_content || '';
  } catch {
    return null;
  }
}

/** The first genuinely-encrypted value in `envContent`, as an oracle bound to `projectId`. */
function firstOracleIn(envContent: string, projectId: string, fm: FileManager): CiphertextOracle | undefined {
  // Only genuinely-encrypted values work as oracles: capy:{id}:{payload}.
  // Tombstones (capy:deleted) and plaintext decrypt as no-ops under any key.
  const [value] = envContent.split('\n').flatMap(line => {
    const eq = line.indexOf('=');
    if (eq < 0) return [];
    const candidate = line.slice(eq + 1).trim();
    return candidate.startsWith('capy:') && candidate.split(':').length >= 3 ? [candidate] : [];
  });
  if (value === undefined) return undefined;
  return {
    projectId,
    verify: (projectKey: string) => {
      try {
        fm.decryptValue(value, projectKey);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Walks the projects in order. `anyRead` is whether at least one project's
 * data was read, so the gap code can tell "nothing was looked at" from "it was
 * looked at and held no encrypted default-branch value".
 */
async function scanProjects(
  serviceClient: ServiceClient,
  fm: FileManager,
  projects: ReadonlyArray<{ id: string }>,
  anyRead: boolean,
): Promise<{ oracle: CiphertextOracle } | { gap: OracleGapCode }> {
  // The projects exist and were read, and none of their DEFAULT branches held
  // an encrypted value. Reporting that rather than "no secrets" is the honest
  // statement of what was looked at.
  if (projects.length === 0) return { gap: anyRead ? 'other-branch' : 'fetch-failed' };
  const [proj, ...rest] = projects;
  const envContent = await tryEnvContent(serviceClient, proj.id);
  if (envContent === null) return scanProjects(serviceClient, fm, rest, anyRead);
  const oracle = firstOracleIn(envContent, proj.id, fm);
  return oracle ? { oracle } : scanProjects(serviceClient, fm, rest, true);
}

async function findOrgCiphertextOracle(
  serviceClient: ServiceClient,
  orgId: string,
  fm: FileManager,
): Promise<{ oracle: CiphertextOracle } | { gap: OracleGapCode }> {
  const rawProjects = await tryListProjects(serviceClient);
  if (rawProjects === null) return { gap: 'list-failed' };
  // Belt-and-braces (CAP-664): the service already hides the org's `_system`
  // project from this listing. Recovery must never scan it as an oracle.
  const projects = excludeSystemProject(rawProjects);

  const mine = projects.filter(p => p.organization_id === orgId);
  if (mine.length === 0) return { gap: 'no-secrets' };

  return scanProjects(serviceClient, fm, mine, false);
}

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;

/**
 * The master key for the phrase. The org's KDF version isn't recorded, so it is
 * detected by trial against a piece of the org's own ciphertext. This also
 * validates the phrase up front — a phrase that matches nothing in the org is
 * rejected before anything is written. With no ciphertext to verify against,
 * the current KDF version is used (what a new org would use).
 */
function resolveMasterKey(
  found: { oracle: CiphertextOracle } | { gap: OracleGapCode },
  phrase: string,
  orgId: string,
  orgName: string,
): Buffer {
  if ('oracle' in found) {
    const { oracle } = found;
    const trial = resolveProjectKeyByTrial(phrase, orgId, oracle.projectId, oracle.verify);
    if (!trial) {
      console.error(`\n  That recovery phrase does not match any secrets in ${B(orgName)}.`);
      console.error('  Double-check the phrase, and that you selected the right organization.');
      console.error('  No changes were written.\n');
      process.exit(1);
    }
    return trial.masterKey;
  }
  // No stored secrets in this org — nothing to verify against. With no
  // ciphertext there is nothing to mis-key; the first push defines the key tree.
  console.log('');
  console.log(Y('  ⚠ This org has no stored secrets yet, so the recovery phrase could not'));
  console.log(Y('    be verified. Writing a key under the current KDF version — run capy in'));
  console.log(Y('    a project for this org to confirm it decrypts.'));
  return seedPhraseToMasterKey(phrase, CURRENT_KDF_VERSION);
}

/**
 * `capy recover` — reconstruct the wrapped master key for an org from its
 * 24-word BIP-39 seed phrase.
 *
 * Use case: the local key.enc file was lost (machine wipe, fresh install,
 * accidental rm) but the user still has the seed phrase printed at org
 * creation time. The seed phrase deterministically derives M, which is then
 * double-wrapped (inner local key + outer KMS layer) and written to
 * `~/.capy/orgs/<orgId>/users/<userId>/key.enc` — exactly the same on-disk
 * shape produced by `orgCreation` or `redeem`. Subsequent `capy` runs work
 * normally.
 *
 * Org selection is ALWAYS prompted, even when a keep.lock or scoped session
 * is present. The whole point of recover is that local state may be wrong,
 * stale, or pointing at a different org than the seed phrase was issued for —
 * silently inheriting keep.lock's org would happily wrap the wrong M for the
 * wrong org and create a confusing failure later.
 *
 * The seed phrase is NOT validated against any server-side fingerprint of M
 * (the server never sees M). A wrong seed will write a key.enc that decrypts
 * to garbage — the failure surfaces the next time the user opens any
 * encrypted secret. The wrap step itself succeeding is not a correctness
 * proof; it just proves you're a member of the org.
 */
export class RecoverCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  /** Silent first; interactive OAuth when there is no usable session. */
  private async signIn(authService: AuthService) {
    const silent = await authService.authenticateSilent();
    if (silent.success) return silent;
    console.log(`\n  No active session. Launching browser to sign in...\n`);
    return authService.authenticate();
  }

  async execute(): Promise<void> {
    const inquirer = (await import('inquirer')).default;

    // 1. Authenticate. Try silent first; if there's no usable session (e.g.
    //    fresh machine, or local state was wiped) fall through to interactive
    //    OAuth. Recovery is inherently interactive — the user is about to type
    //    a 24-word seed phrase — so launching a browser here is not a surprise.
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);

    const authResult = await this.signIn(authService);
    if (!authResult.success) {
      console.error(`\n  Sign-in failed: ${authResult.error || 'unknown error'}. Re-run ${B('capy recover')} after authenticating.\n`);
      process.exit(1);
    }

    const userId = authResult.user_id!;
    const orgs = authResult.organizations || [];
    if (orgs.length === 0) {
      console.error(`\n  No organizations found for ${B(authResult.user_email || 'this user')}.\n`);
      process.exit(1);
    }

    // 2. ALWAYS prompt for which org to recover. Never inherit keep.lock —
    //    that's the bug that wrapped the wrong M for the wrong org.
    console.log('');
    console.log(`  Signed in as ${B(authResult.user_email || userId)}.`);
    console.log('');
    const { orgId } = await inquirer.prompt([{
      type: 'list',
      name: 'orgId',
      message: 'Which organization is this recovery phrase for?',
      choices: orgs.map(o => ({ name: o.name, value: o.id })),
    }]);
    const selectedOrg = orgs.find(o => o.id === orgId)!;

    // 3. Re-scope the session to the chosen org so the KMS wrap-outer call
    //    on this org's endpoint succeeds with the right token.
    const scoped = await authService.authenticateSilent(orgId);
    if (!scoped.success) {
      // "select this org and retry" is the right advice for an ended session
      // and the wrong advice for an unreachable service, so the cause leads
      // and the org-specific step follows only when it would help.
      console.error(`\n  Failed to scope session to ${B(selectedOrg.name)}: ${scoped.error}.`);
      console.error(
        scoped.error_code === 'network' || scoped.error_code === 'server_error'
          ? `  Check your connection and re-run ${B('capy recover')}.\n`
          : `  Run ${B('capy')}, select this org, then re-run ${B('capy recover')}.\n`,
      );
      process.exit(1);
    }
    const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());

    // 4. Overwrite gate.
    if (hasOrgKey(orgId, userId)) {
      console.log('');
      console.log(Y(`  ⚠ A wrapped master key already exists on this device for ${B(selectedOrg.name)}.`));
      console.log('');
      console.log('  Continuing will OVERWRITE it. If your current key still works, you do');
      console.log('  not need to recover — `capy decrypt` is the offline-only flow.');
      console.log('');
      const { proceed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'proceed',
        message: `Overwrite the existing key for ${selectedOrg.name}?`,
        default: false,
      }]);
      if (!proceed) {
        console.log('  Aborted. No changes made.');
        return;
      }
    }

    // 5. Seed phrase prompt.
    console.log('');
    console.log(`  Paste the 24-word recovery phrase printed when ${B(selectedOrg.name)} was created.`);
    console.log('  The input is masked. Words are space-separated.');
    console.log('');

    const { seedPhrase } = await inquirer.prompt([{
      type: 'password',
      name: 'seedPhrase',
      message: 'Recovery phrase:',
      mask: '*',
    }]);

    const phrase = (seedPhrase || '').trim();
    if (!phrase) {
      console.error('\n  No recovery phrase entered. Aborted.\n');
      process.exit(1);
    }

    if (!validateSeedPhrase(phrase)) {
      console.error('\n  Invalid recovery phrase.');
      console.error('  Expected exactly 24 words from the BIP-39 wordlist with a valid checksum.\n');
      process.exit(1);
    }

    // Determine M (see `resolveMasterKey`).
    const fm = new FileManager();
    const found = await findOrgCiphertextOracle(serviceClient, orgId, fm);

    const masterKey = resolveMasterKey(found, phrase, orgId, selectedOrg.name);

    const keyOps = {
      coDecrypt: (oid: string, ct: string) =>
        serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
      wrapOuterLayer: (oid: string, pt: string) =>
        serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
    };

    try {
      await wrapAndSaveMasterKey(masterKey, orgId, userId, keyOps);
    } catch (err: any) {
      console.error(`\n  Failed to wrap and save the master key: ${err?.message || err}`);
      console.error('  No changes were written. Re-authenticate and try again.\n');
      process.exit(1);
    }

    console.log('');
    console.log(G(`  ✓ Recovered master key for ${B(selectedOrg.name)}.`));
    console.log('');
    console.log(`  Wrapped key written to ${B(`~/.capy/orgs/${orgId}/users/${userId}/key.enc`)}.`);
    console.log(`  Verify by running ${B('capy')} in a project for this org — a wrong recovery`);
    console.log(`  phrase will surface as a decryption failure on the first encrypted variable.`);
    console.log('');
  }
}

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

/**
 * Finds a piece of this org's ciphertext to use as a KDF-version oracle.
 *
 * The org's KDF version isn't recorded anywhere, so to recover the correct M we
 * need a known ciphertext to test candidate keys against. Scans the org's
 * projects for any genuinely-encrypted value and returns a verifier bound to
 * that project. Returns null if the org has no stored secrets (nothing to
 * verify against).
 */
async function findOrgCiphertextOracle(
  serviceClient: ServiceClient,
  orgId: string,
  fm: FileManager,
): Promise<{ projectId: string; verify: (projectKey: string) => boolean } | null> {
  let projects: Array<{ id: string; organization_id: string }>;
  try {
    projects = await serviceClient.listProjects();
  } catch {
    return null;
  }

  for (const proj of projects.filter(p => p.organization_id === orgId)) {
    let envContent = '';
    try {
      envContent = (await serviceClient.getDecryptData(proj.id)).env_content || '';
    } catch {
      continue;
    }
    for (const line of envContent.split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const value = line.slice(eq + 1).trim();
      // Only genuinely-encrypted values work as oracles: capy:{id}:{payload}.
      // Tombstones (capy:deleted) and plaintext decrypt as no-ops under any key.
      if (!value.startsWith('capy:') || value.split(':').length < 3) continue;
      return {
        projectId: proj.id,
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
  }
  return null;
}

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;

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

  async execute(): Promise<void> {
    const inquirer = (await import('inquirer')).default;

    // 1. Authenticate. Try silent first; if there's no usable session (e.g.
    //    fresh machine, or local state was wiped) fall through to interactive
    //    OAuth. Recovery is inherently interactive — the user is about to type
    //    a 24-word seed phrase — so launching a browser here is not a surprise.
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);

    let authResult = await authService.authenticateSilent();
    if (!authResult.success) {
      console.log(`\n  No active session. Launching browser to sign in...\n`);
      authResult = await authService.authenticate();
    }
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
    let scoped = await authService.authenticateSilent(orgId);
    if (!scoped.success) {
      console.error(`\n  Failed to scope session to ${B(selectedOrg.name)}. Run ${B('capy')} and select this org, then retry.\n`);
      process.exit(1);
    }
    authResult = scoped;

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

    // Determine M. The KDF version that created this org isn't recorded, so we
    // detect it by trial against a piece of the org's own ciphertext. This also
    // validates the phrase up front — recover used to write a key.enc for a
    // wrong phrase and only fail later (see class doc); now a phrase that
    // matches nothing in the org is rejected before anything is written.
    const fm = new FileManager();
    const oracle = await findOrgCiphertextOracle(serviceClient, orgId, fm);

    let masterKey: Buffer;
    if (oracle) {
      const trial = resolveProjectKeyByTrial(phrase, orgId, oracle.projectId, oracle.verify);
      if (!trial) {
        console.error(`\n  That recovery phrase does not match any secrets in ${B(selectedOrg.name)}.`);
        console.error('  Double-check the phrase, and that you selected the right organization.');
        console.error('  No changes were written.\n');
        process.exit(1);
      }
      masterKey = trial.masterKey;
    } else {
      // No stored secrets in this org — nothing to verify against. Use the
      // current KDF version (what a new org would use). With no ciphertext there
      // is nothing to mis-key; the first push defines the key tree.
      console.log('');
      console.log(Y('  ⚠ This org has no stored secrets yet, so the recovery phrase could not'));
      console.log(Y('    be verified. Writing a key under the current KDF version — run capy in'));
      console.log(Y('    a project for this org to confirm it decrypts.'));
      masterKey = seedPhraseToMasterKey(phrase, CURRENT_KDF_VERSION);
    }

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

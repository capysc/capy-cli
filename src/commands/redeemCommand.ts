import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import inquirer from 'inquirer';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { parseRedeemCode } from '../crypto/inviteCrypto';
import { wrapAndSaveMasterKey, hasOrgKey } from '../crypto/keyResolver';
import { FileManager } from '../files/fileManager';
import { isMembershipRevokedError } from '../errors/membershipRevoked';
import { cleanupOrgData } from '../cleanup/orgCleanup';
import { isInteractive } from '../ui/interactive';
import { deviceKeysEnabled } from '../auth/deviceKey/flag';
import {
  runDeviceKeyEnrollment,
  reportEnrollmentOutcome,
  syncOrgOntoDeviceKeyIfEnrolled,
  DeviceKeyWiringContext,
} from '../auth/deviceKey/wiring';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class RedeemCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(code: string): Promise<void> {
    // 1. Parse redeem code → T + target org + double-wrapped ciphertext + expiry
    let token: Buffer;
    let ciphertext: string;
    let targetOrgId: string;
    let notAfter: number;
    try {
      ({ token, orgId: targetOrgId, ciphertext, notAfter } = parseRedeemCode(code));
    } catch (err: any) {
      console.error(`Invalid redeem code: ${err.message}`);
      process.exit(1);
    }

    // Pre-flight expiry check so we don't bother the user with a sign-in
    // ceremony just to fail at co-decrypt. Server enforces this independently.
    if (notAfter <= Date.now()) {
      console.error(`\n  This invite expired ${new Date(notAfter).toISOString()}.`);
      console.error('  Ask the inviter for a fresh code.\n');
      process.exit(1);
    }

    // 2. Authenticate — try silent refresh first (no browser popup),
    //    fall back to full OAuth only if no session exists.
    //    The crypto layer (HKDF with email binding) is the real identity proof,
    //    not the OAuth ceremony.
    const authService = new AuthService(this.apiUrl, this.devMode);
    let authResult = await authService.authenticateSilent(targetOrgId);
    if (!authResult.success) {
      // No cached session — need interactive auth
      authResult = await authService.authenticate(targetOrgId);
      if (!authResult.success) {
        console.error(`Authentication failed. You need a ${B('Capy')} account to redeem an invite.`);
        process.exit(1);
      }
    }

    let userId = authResult.user_id!;
    let orgId = authResult.organization_id!;

    // 3. If we got a session for a different org (or no org), refresh into the target org.
    //    Multi-org sessions let both orgs coexist — no save/restore needed.
    if (orgId !== targetOrgId) {
      const switched = await authService.authenticateSilent(targetOrgId);
      if (!switched.success) {
        // Silent refresh failed — try full OAuth scoped to the target org
        const oauthResult = await authService.authenticate(targetOrgId);
        if (!oauthResult.success) {
          console.error('Failed to authenticate for the invited organization. You may not have access.');
          process.exit(1);
        }
        orgId = oauthResult.organization_id!;
        userId = oauthResult.user_id!;
      } else {
        orgId = targetOrgId;
        userId = switched.user_id!;
      }
    }

    // Explicit membership guard: tryPasswordAuth / OAuth may succeed but
    // return a token scoped to a DIFFERENT org the user already belongs to
    // (e.g., a kicked user re-authing with a valid password lands on their
    // own org, not the one the invite was issued for). Without this check,
    // a downstream co-decrypt hits that OTHER org's endpoint — which passes
    // membership but shouldn't, because the invite's ciphertext was never
    // intended for it. Fail closed if we didn't actually land on targetOrgId.
    if (orgId !== targetOrgId) {
      // Auth landed on a different org than the invite targets. This is NOT
      // a kick signal — it can happen when a user with multiple memberships
      // re-auths to their primary org. Surface the error and exit; never
      // touch local keys based on a redeem-flow assumption.
      console.error(`\n  You are not a member of the invited organization.`);
      console.error(`  The invite may have been revoked, or you were removed.\n`);
      process.exit(1);
    }

    // 4. Regardless of whether crypto setup is needed, always update local
    //    state so the next `capy` run targets the redeemed org.
    const orgName = authResult.organizations?.find(o => o.id === orgId)?.name || orgId;
    this.switchLocalContext(orgId, userId, orgName);

    const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());

    // 5. Always verify membership via co-decrypt, even if local key exists.
    //    A kicked user still has the local org key — co-decrypt is the
    //    server-side gate that proves current membership.
    let innerBlob: string;
    try {
      const result = await serviceClient.coDecrypt(orgId, ciphertext, notAfter);
      innerBlob = result.plaintext;
    } catch (err: any) {
      // Co-decrypt can fail for many reasons — expired invite, tampered
      // code, network blip, KMS hiccup. Only when the server explicitly
      // tags the failure with code=MEMBERSHIP_REVOKED do we clean up the
      // local wrapped M for this user in this org. Every other failure
      // leaves local state intact so the user can retry.
      if (isMembershipRevokedError(err)) {
        cleanupOrgData(orgId, userId);
      }
      console.error(`\nCo-decryption failed: ${err.message}`);
      console.error('You may not be a member of this organization, or the invite has been revoked.');
      process.exit(1);
    }

    // 6. If user already has the master key and co-decrypt passed, they're good
    if (hasOrgKey(orgId, userId)) {
      console.log('');
      console.log(`  \x1b[32mYou're all set — your encryption keys are configured for ${B(orgName)}.\x1b[0m`);
      console.log(`  Run ${B('capy')} to sync secrets.`);
      console.log('');
      return;
    }

    // 7. Strip inner layer with T → recover M
    //    The HKDF salt includes the recipient's email, so this fails
    //    cryptographically if the wrong user tries to unwrap.
    const userEmail = authResult.user_email || '';
    let masterKey: Buffer;
    try {
      const { innerUnwrap } = await import('../crypto/inviteCrypto');
      masterKey = innerUnwrap(innerBlob, token, orgId, userEmail);
    } catch {
      console.error(`Failed to unwrap invite. You're signed in as ${B(userEmail)} — this invite may be for a different account.`);
      process.exit(1);
    }

    // 8. Double-wrap M (inner local key + outer KMS) and store locally
    const keyOps = {
      coDecrypt: (oid: string, ct: string) => serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
      wrapOuterLayer: (oid: string, pt: string) => serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
    };
    await wrapAndSaveMasterKey(masterKey, orgId, userId, keyOps);

    console.log('');
    console.log('  \x1b[32mInvite redeemed successfully!\x1b[0m');
    console.log('');
    console.log(`  You now have access to ${B(orgName)}.`);
    console.log(`  Run ${B('capy')} to sync secrets.`);
    console.log('');

    // CAP-382: two distinct device-key follow-ups, only on THIS branch — the
    // early "you're all set" return above (step 6) never wrote anything this
    // run, so there is nothing new to sync or nudge about there.
    if (deviceKeysEnabled()) {
      const ctx: DeviceKeyWiringContext = {
        authService,
        serviceClient,
        devMode: this.devMode,
        userId,
        userEmail,
        organizations: authResult.organizations || [],
        activeOrgId: orgId,
      };

      // (a) The CAP-380 known gap: this org may have joined AFTER the
      // account already enrolled a device key elsewhere — silently unify
      // its fresh root onto the canonical one (maintenance, no prompt;
      // nothing new is being decided). `alreadyEnrolled` also gates the
      // nudge below — a user who already has a device key should never be
      // asked to "set one up".
      const sync = await syncOrgOntoDeviceKeyIfEnrolled(ctx, orgId);
      if (!sync.alreadyEnrolled) {
        // (b) Nothing enrolled yet anywhere — offer to set one up.
        await this.maybeOfferDeviceKeyEnrollment(ctx, orgName);
      }
    }
  }

  /**
   * Declinable, flag-gated. Declining, a non-interactive run, or any
   * ceremony failure all leave the tree exactly as redeem already left it —
   * nothing here writes anything except through the enrollment engine
   * itself, which has its own byte-identical-on-refusal contract.
   */
  private async maybeOfferDeviceKeyEnrollment(ctx: DeviceKeyWiringContext, orgName: string): Promise<void> {
    if (!isInteractive()) return;

    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: 'Set up a device key so your other machines onboard with Face ID/Touch ID instead of codes?',
      default: false,
    }]);
    if (!confirmed) return;

    const outcome = await runDeviceKeyEnrollment(ctx);
    switch (outcome.kind) {
      case 'enrolled':
        reportEnrollmentOutcome(outcome.result, orgName);
        break;
      case 'declined':
        console.log('  No problem — enroll a device key any time with `capy device-key enroll`.');
        console.log('');
        break;
      case 'already_enrolled':
        console.log('  This account already has a device key enrolled.');
        console.log('');
        break;
      case 'not_ready':
        // Detection disagreeing with "redeem just wrote local.key" should
        // not happen; nothing to do but leave redeem's own result standing.
        break;
    }
  }

  /**
   * Update sync-state to point to the redeemed org, and delete keep.lock
   * if it points to a different org. This ensures the next `capy` run goes
   * through init for the correct org instead of syncing a stale project.
   */
  private switchLocalContext(orgId: string, userId: string, orgName: string): void {
    const fileManager = new FileManager();
    fileManager.writeSyncState({
      last_sync: '',
      synced_variables: [],
      user_id: userId,
      org_id: orgId,
    });
    console.log(`  Sync state updated → ${B(orgName)}`);

    const keepPath = join(process.cwd(), 'keep.lock');
    if (existsSync(keepPath)) {
      try {
        const keepContent = JSON.parse(readFileSync(keepPath, 'utf-8'));
        if (keepContent.org_id !== orgId) {
          unlinkSync(keepPath);
          console.log('  Removed stale keep.lock (different org)');
        }
      } catch {
        unlinkSync(keepPath);
        console.log('  Removed invalid keep.lock');
      }
    }
  }
}

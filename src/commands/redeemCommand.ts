import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { parseRedeemCode } from '../crypto/inviteCrypto';
import { wrapAndSaveMasterKey, hasOrgKey } from '../crypto/keyResolver';
import { FileManager } from '../files/fileManager';
import { isMembershipRevokedError } from '../errors/membershipRevoked';
import { cleanupOrgData } from '../cleanup/orgCleanup';
import { AuthResult } from '../types/index';
import { redeemRepoOrgRefusal, exitWithRepoOrgRefusal, readTrackedRepoOrgId } from '../core/repoOrgGuard';

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
    const { token, orgId: targetOrgId, ciphertext, notAfter } = this.parseCodeOrExit(code);

    // A git repo belongs to one organization (the tracked keep.lock's org_id). Refuse to redeem another
    // organization into it, before anything else: no sign-in, no network call, no key save, no file write.
    const repoRefusal = redeemRepoOrgRefusal(process.cwd(), targetOrgId);
    if (repoRefusal) exitWithRepoOrgRefusal(repoRefusal);

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
    const authResult = await this.authenticateOrExit(authService, targetOrgId);

    // 3. If we got a session for a different org (or no org), refresh into the target org.
    //    Multi-org sessions let both orgs coexist — no save/restore needed.
    const { orgId, userId } = await this.landOnTargetOrg(authService, authResult, targetOrgId);

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
    //    The guard above proved orgId === targetOrgId, so the display name is
    //    looked up by the invite's own org id, not by a value from the sign-in result.
    const orgName = authResult.organizations?.find(o => o.id === targetOrgId)?.name || targetOrgId;
    this.switchLocalContext(orgId, userId, orgName);

    const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
    serviceClient.setTokenProvider(() => authService.getValidToken());

    // 5. Always verify membership via co-decrypt, even if local key exists.
    //    A kicked user still has the local org key — co-decrypt is the
    //    server-side gate that proves current membership.
    const innerBlob = await this.coDecryptOrExit(serviceClient, orgId, userId, ciphertext, notAfter);

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
    const masterKey = await this.unwrapOrExit(innerBlob, token, orgId, userEmail);

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
  }

  private parseCodeOrExit(code: string): ReturnType<typeof parseRedeemCode> {
    try {
      return parseRedeemCode(code);
    } catch (err: any) {
      console.error(`Invalid redeem code: ${err.message}`);
      return process.exit(1);
    }
  }

  private async authenticateOrExit(authService: AuthService, targetOrgId: string): Promise<AuthResult> {
    const silent = await authService.authenticateSilent(targetOrgId);
    if (silent.success) return silent;
    // No cached session — need interactive auth
    const interactive = await authService.authenticate(targetOrgId);
    if (!interactive.success) {
      console.error(`Authentication failed. You need a ${B('Capy')} account to redeem an invite.`);
      return process.exit(1);
    }
    return interactive;
  }

  private async landOnTargetOrg(
    authService: AuthService,
    authResult: AuthResult,
    targetOrgId: string,
  ): Promise<{ orgId: string; userId: string }> {
    const orgId = authResult.organization_id!;
    const userId = authResult.user_id!;
    if (orgId === targetOrgId) return { orgId, userId };
    const switched = await authService.authenticateSilent(targetOrgId);
    if (switched.success) return { orgId: targetOrgId, userId: switched.user_id! };
    // Silent refresh failed — try full OAuth scoped to the target org
    const oauthResult = await authService.authenticate(targetOrgId);
    if (!oauthResult.success) {
      console.error('Failed to authenticate for the invited organization. You may not have access.');
      return process.exit(1);
    }
    return { orgId: oauthResult.organization_id!, userId: oauthResult.user_id! };
  }

  private async coDecryptOrExit(
    serviceClient: ServiceClient,
    orgId: string,
    userId: string,
    ciphertext: string,
    notAfter: number,
  ): Promise<string> {
    try {
      const result = await serviceClient.coDecrypt(orgId, ciphertext, notAfter);
      return result.plaintext;
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
      return process.exit(1);
    }
  }

  private async unwrapOrExit(innerBlob: string, token: Buffer, orgId: string, userEmail: string): Promise<Buffer> {
    try {
      const { innerUnwrap } = await import('../crypto/inviteCrypto');
      return innerUnwrap(innerBlob, token, orgId, userEmail);
    } catch {
      console.error(`Failed to unwrap invite. You're signed in as ${B(userEmail)} — this invite may be for a different account.`);
      return process.exit(1);
    }
  }

  /**
   * Update sync-state to point to the redeemed org. A keep.lock for a different org never reaches here: `execute`
   * refuses that before anything is written (a git repo belongs to one organization). A keep.lock that is unparseable
   * or names no organization is still removed, so the next `capy` run goes through init instead of failing on it.
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
    // capy's own untracked working copy (see FileManager.writeKeepFile) — a
    // stale copy left behind here would make readKeepFile() keep preferring
    // it over the freshly re-initialized tracked file.
    const workingKeepPath = join(process.cwd(), '.capy', 'keep.lock');
    // Unparseable, or parseable but naming no organization (no non-empty string org_id): neither can be a repo's
    // identity, so both copies go and the next `capy` run goes through init.
    if (existsSync(keepPath) && readTrackedRepoOrgId(process.cwd()) === undefined) {
      unlinkSync(keepPath);
      if (existsSync(workingKeepPath)) unlinkSync(workingKeepPath);
      console.log('  Removed invalid keep.lock');
    }
  }
}

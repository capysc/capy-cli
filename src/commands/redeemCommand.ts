import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { parseRedeemCode } from '../crypto/inviteCrypto';
import { wrapAndSaveMasterKey, hasOrgKey } from '../crypto/keyResolver';
import { FileManager } from '../files/fileManager';
import { isMembershipRevokedError } from '../errors/membershipRevoked';
import { cleanupOrgData } from '../cleanup/orgCleanup';
import { dryRunOk, dryRunExitCode, printDryRunResultHuman, type DryRunChange, type DryRunUnanswered } from '../core/dryRun';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export interface RedeemOpts {
  /** CAP-659: preview only — parse the code, check expiry, resolve the target org via a SILENT session only; never co-decrypt, never consume the code, never write keys. */
  dryRun?: boolean;
}

export class RedeemCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(code: string, opts: RedeemOpts = {}): Promise<void> {
    if (opts.dryRun) {
      await this.previewRedeem(code);
      return;
    }

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
  }

  /**
   * CAP-659 preview: parses the code and checks expiry exactly like the real
   * run (same refusal codes), resolves the target org from a SILENT session
   * only — never the interactive OAuth fallback, which would open a browser
   * — and reports what WOULD change. Never calls co-decrypt (would consume
   * the code's one server-side check) and never writes a key.
   */
  private async previewRedeem(code: string): Promise<void> {
    const parsed = this.parseCodeOrExit(code);
    const { orgId: targetOrgId, notAfter } = parsed;

    if (notAfter <= Date.now()) {
      console.error(`\n  This invite expired ${new Date(notAfter).toISOString()}.`);
      console.error('  Ask the inviter for a fresh code.\n');
      process.exit(1);
    }

    const authService = new AuthService(this.apiUrl, this.devMode);
    const forTarget = await authService.authenticateSilent(targetOrgId);
    const session = forTarget.success ? forTarget : await authService.authenticateSilent();
    const landedOnTarget = session.success && session.organization_id === targetOrgId;

    // Signing in for real (the interactive fallback the real run uses) is
    // the one thing a dry run must never do — no browser, no new session —
    // so an unresolved org is reported as a stop a flag can't answer either;
    // rerunning `capy` once interactively settles it for every later run.
    const unanswered: DryRunUnanswered[] = landedOnTarget
      ? []
      : [{ id: 'sign-in', flag: '(run `capy` once interactively first, then retry)' }];

    const changes: DryRunChange[] = [
      { where: 'local_file', action: 'update sync state to point at this org', target: targetOrgId, reversible: true },
      ...(this.wouldDeleteStaleKeepLock(targetOrgId)
        ? [{ where: 'local_file' as const, action: 'delete stale keep.lock', target: 'keep.lock', reversible: true }]
        : []),
      { where: 'capy_service', action: 'verify current membership (co-decrypt)', target: `org ${targetOrgId}`, reversible: true },
      ...(landedOnTarget && session.user_id && !hasOrgKey(targetOrgId, session.user_id)
        ? [
            {
              where: 'capy_service' as const,
              action: "unwrap and store this org's master key locally",
              target: `org ${targetOrgId}`,
              reversible: true,
            },
          ]
        : []),
    ];

    const result = dryRunOk('redeem', changes, unanswered);
    printDryRunResultHuman(result);
    process.exit(dryRunExitCode(result));
  }

  /** Same parse + exit-1-on-failure the real run does, wrapped so a preview can call it without duplicating the try/catch. */
  private parseCodeOrExit(code: string): ReturnType<typeof parseRedeemCode> {
    try {
      return parseRedeemCode(code);
    } catch (err: any) {
      console.error(`Invalid redeem code: ${err.message}`);
      process.exit(1);
    }
  }

  /** Read-only: whether a keep.lock in cwd points at a different org than `targetOrgId` — same check `switchLocalContext` deletes on. */
  private wouldDeleteStaleKeepLock(targetOrgId: string): boolean {
    const keepPath = join(process.cwd(), 'keep.lock');
    if (!existsSync(keepPath)) return false;
    try {
      const keepContent = JSON.parse(readFileSync(keepPath, 'utf-8'));
      return keepContent.org_id !== targetOrgId;
    } catch {
      return true; // invalid JSON — the real run deletes it too
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
    // capy's own untracked working copy (see FileManager.writeKeepFile) — a
    // stale copy left behind here would make readKeepFile() keep preferring
    // it over the freshly re-initialized tracked file.
    const workingKeepPath = join(process.cwd(), '.capy', 'keep.lock');
    if (existsSync(keepPath)) {
      try {
        const keepContent = JSON.parse(readFileSync(keepPath, 'utf-8'));
        if (keepContent.org_id !== orgId) {
          unlinkSync(keepPath);
          if (existsSync(workingKeepPath)) unlinkSync(workingKeepPath);
          console.log('  Removed stale keep.lock (different org)');
        }
      } catch {
        unlinkSync(keepPath);
        if (existsSync(workingKeepPath)) unlinkSync(workingKeepPath);
        console.log('  Removed invalid keep.lock');
      }
    }
  }
}

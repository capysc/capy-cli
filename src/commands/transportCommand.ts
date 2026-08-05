import { resolveOrgContext } from '../core/orgContext';
import type { AuthService } from '../auth/authService';
import { hasOrgKey } from '../config/globalConfig';
import { unwrapMasterKey } from '../crypto/keyResolver';
import {
  generateInviteToken,
  innerWrap,
  buildRedeemCode,
  resolveInviteTtlMs,
} from '../crypto/inviteCrypto';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export interface TransportOptions {
  /**
   * Show the redeem code in a browser instead of printing it.
   *
   * Not a cosmetic move. The code is a wrapped copy of this account's org
   * master key — a bearer credential that hands over everything the caller can
   * decrypt — and the terminal form writes it to stdout with no `--json` and
   * no suppression. Anything reading that terminal captures it, which for an
   * agent-driven run is the AI. Under `--web` the code goes into the loopback
   * page and nowhere else: it is not printed, not logged, and cannot travel
   * back over the loopback either.
   */
  web?: boolean;
}

export class TransportCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(options: TransportOptions = {}): Promise<void> {
    try {
      const { orgId, userId, userEmail, authService, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);

      if (!userEmail) {
        console.error('Could not determine your email address. Re-authenticate and try again.');
        process.exit(1);
      }

      if (!hasOrgKey(orgId, userId)) {
        console.error('No master key found for this organization on this machine.');
        process.exit(1);
      }

      // Unwrap M (double-wrapped: KMS outer + K_local inner). unwrapMasterKey
      // handles legacy blobs and transparently re-wraps them.
      let masterKey: Buffer;
      try {
        const keyOps = {
          coDecrypt: (oid: string, ct: string) => serviceClient.coDecrypt(oid, ct).then(r => r.plaintext),
          wrapOuterLayer: (oid: string, pt: string) => serviceClient.wrapOuterLayer(oid, pt).then(r => r.ciphertext),
        };
        masterKey = await unwrapMasterKey(orgId, userId, keyOps);
      } catch {
        console.error('Failed to unwrap master key. Re-authenticate and try again.');
        process.exit(1);
      }

      // Bind the inner key to the user's own email so only the same WorkOS
      // identity can unwrap on the destination machine.
      const transportToken = generateInviteToken();
      const innerBlob = innerWrap(masterKey, transportToken, orgId, userEmail);

      // Bind notAfter into the KMS EncryptionContext so a tampered redeem
      // code fails the AEAD unwrap (defence in depth on top of the explicit
      // server-side timestamp check). Same TTL policy as invites.
      const notAfter = Date.now() + resolveInviteTtlMs();
      const { ciphertext: outerBlob } = await serviceClient.wrapOuterLayer(
        orgId,
        innerBlob,
        notAfter,
      );

      const redeemCode = buildRedeemCode(transportToken, outerBlob, orgId, notAfter);
      const redeemCommand = `capy redeem ${redeemCode}`;

      if (options.web) {
        await this.showInBrowser({
          authService,
          orgId,
          userEmail,
          notAfter,
          redeemCommand,
        });
        return;
      }

      console.log('');
      console.log(`  Transport code created for ${B(userEmail)}`);
      console.log('');
      console.log('  On the destination machine, sign in to Capy and run:');
      console.log('');
      console.log(`    ${B('capy')} redeem ${redeemCode}`);
      console.log('');
      console.log(`  \x1b[90mOnly ${userEmail} can redeem this code — the inner key is bound to your email.\x1b[0m`);
      console.log('  \x1b[90mService co-decryption verifies you are still a member at redeem time.\x1b[0m');
      console.log(`  \x1b[90mExpires ${new Date(notAfter).toISOString()}.\x1b[0m`);
      console.log('');

      const { promptCopyToClipboard } = await import('../ui/clipboard');
      await promptCopyToClipboard(redeemCommand);
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }

  /**
   * Hand the code over in the browser, and to nothing else.
   *
   * Deliberately not a rendering swap of the block above. The terminal form
   * prints the code, then offers to put it on the system clipboard behind a
   * keypress; neither happens here. The page shows it blurred with its own
   * reveal and copy controls, and this method never sees it again — the only
   * thing that comes back over the loopback is whether the user closed it out.
   *
   * `capy transport` mints the code BEFORE any of this, so it exists whether
   * or not the page was acknowledged. Both endings say so rather than implying
   * that cancelling un-minted anything.
   */
  private async showInBrowser(p: {
    authService: AuthService;
    orgId: string;
    userEmail: string;
    notAfter: number;
    redeemCommand: string;
  }): Promise<void> {
    // `resolveOrgContext` returns the id, and the page names the organization
    // the key belongs to. The session cache already holds the name, so this is
    // a file read rather than a round trip — and the id is the fallback when
    // it does not.
    let orgName = p.orgId;
    try {
      const scoped = await p.authService.authenticateSilent(p.orgId);
      orgName =
        scoped.organization_name ||
        scoped.organizations?.find(o => o.id === p.orgId)?.name ||
        p.orgId;
    } catch {
      /* the id is the honest fallback */
    }

    const { showTransportInBrowser } = await import('../ui/recoveryScreens');

    /**
     * The one ending, printed however this run got here.
     *
     * `capy transport` mints the code BEFORE the page opens, so a live bearer
     * credential for this account exists whether the page was closed out,
     * cancelled, or never answered at all. That sentence is the only thing
     * standing between the user and a credential they do not know is out
     * there, which is why it is not on the success path.
     */
    const report = (took: 'closed-out' | 'refused' | 'unanswered'): void => {
      console.log('');
      console.log(`  Transport code created for ${B(p.userEmail)}`);
      if (took === 'closed-out') {
        console.log('  It was shown in your browser and not printed here.');
      } else if (took === 'refused') {
        console.log('  You cancelled without taking it. It was not printed here.');
      } else {
        console.log('  The page was never answered. It was not printed here.');
      }
      console.log(`  \x1b[90mThe code was minted before the page opened, so it is live either way.\x1b[0m`);
      console.log(`  \x1b[90mExpires ${new Date(p.notAfter).toISOString()}.\x1b[0m`);
      console.log('');
    };

    let out;
    try {
      out = await showTransportInBrowser({
        orgName,
        boundEmail: p.userEmail,
        expiresAtIso: new Date(p.notAfter).toISOString(),
        redeemCommand: p.redeemCommand,
        // Open the user's browser by default; CAPY_WEB_NO_OPEN lets CI and
        // headless verification drive the loopback without hijacking a real one.
        open: !process.env.CAPY_WEB_NO_OPEN,
      });
    } catch (err) {
      // Closing the window is a refusal the server cannot see, so the wizard
      // ends by timing out. That used to surface as the error screen alone —
      // an exit code over a page that had just been handed a live key, with
      // nothing anywhere saying the key existed.
      report('unanswered');
      throw err;
    }

    report(out.acknowledged ? 'closed-out' : 'refused');
  }
}

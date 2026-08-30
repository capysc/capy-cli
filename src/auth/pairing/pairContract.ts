/**
 * `capy pair`'s session/key-material SHAPES.
 *
 * Pre-CAP-566 (#328) this file was the wire contract for a sealed answer an
 * approving browser encrypted to this process's ephemeral connection keypair
 * over an anonymous CAP-403 bootstrap connection — `parsePairPayload` framed
 * and validated that envelope. `capy pair` no longer works that way: the
 * machine authenticates ITSELF via WorkOS's device-authorization grant
 * (`../deviceAuth.ts`), so there is no sealed envelope left to parse, and
 * that CAP-403 framing/validation machinery (the old `PAIR_PURPOSE`/
 * `PAIR_FLOW`/`PAIR_CEREMONY` constants and `parsePairPayload`) was removed
 * as dead code once nothing produced or consumed it anymore.
 *
 * What's left are the plain data shapes those two designs share:
 * `PairMachineAnswerSession` is what `deviceAuth.ts`'s device-grant poll
 * hands to `installPairedSession.ts` — the CLI's one session writer.
 * `PairMachineAnswer`/`PairMachineAnswerKeyMaterial` remain solely because
 * `pairKeyMaterial.ts` (superseded by `pairDeviceGrant.ts`'s CAP-384 grant
 * ceremony, but not yet deleted) still imports them — see that file's own
 * header for why it is currently unreachable from `pairCommand.ts`.
 */

export interface PairMachineAnswerUser {
  id: string;
  email: string;
  [k: string]: unknown;
}

export interface PairMachineAnswerOrg {
  id: string;
  name: string;
  [k: string]: unknown;
}

export interface PairMachineAnswerOrgSession {
  access_token: string;
  expires_at: number;
}

export interface PairMachineAnswerSession {
  user: PairMachineAnswerUser;
  refresh_token: string;
  organizations: PairMachineAnswerOrg[];
  sessions?: Record<string, PairMachineAnswerOrgSession>;
}

export interface PairMachineAnswerKeyMaterial {
  orgId: string;
  /** base64, 32 bytes — the raw PRF evaluation for the door (credential)
   *  that answered. NEVER logged. This is the only secret in the payload;
   *  K_local itself never appears here (see this file's header). The CLI
   *  fetches that door's own prf_salt/kdf_version fresh from its wrapper
   *  record rather than trusting an echoed copy on the wire. */
  prfOutput: string;
  /** Which door (WebAuthn credential) the browser's ceremony used — the
   *  ONLY wrapper the CLI may fetch, never "any live door" of its own
   *  choosing (the browser already made that selection). */
  credentialId: string;
}

export interface PairMachineAnswer {
  v: 1;
  flow: 'pair';
  ceremony: 'machine-pair';
  session: PairMachineAnswerSession;
  keyMaterial: PairMachineAnswerKeyMaterial;
}

/**
 * CAP-409 — `capy pair`'s wire contract for the sealed answer.
 *
 * This is the FIXED CONTRACT three worktrees (service+packages/ui, keep-app,
 * capy-cli) are all coding to independently — see the CAP-409 task brief.
 * `PairMachineAnswer` is what the approving device (keep-app's
 * `/pair` screen) seals to this process's ephemeral connection keypair once
 * a human confirms; a `{ok:false, code}` CeremonyFailure-shaped payload rides
 * the same envelope on decline/cancel/error. Nothing here reaches the
 * network or disk — this module only parses and validates.
 *
 * SECURITY CONTRACT (CAP-372, restored — see the pair-hardening task brief):
 * the approving page never unwraps K_local and never sends it. The ONLY
 * secret that crosses this seam is the raw PRF output, exactly like every
 * other ceremony (see `../deviceKey/ceremonyTransport.ts`'s own header).
 * `PairMachineAnswerKeyMaterial` carries `prfOutput`, never a `kLocal`
 * field — `isValidKeyMaterial` below REJECTS any payload that carries one,
 * so a rolled-back or compromised page cannot quietly resume shipping raw
 * key material. Deliberately no `prfSalt`/`kdfVersion` echo on the wire
 * either: those aren't secrets, but the CLI doesn't need the approving page
 * to relay them — it fetches this account's own wrapped_k_local wrapper
 * record directly (which already carries its own prf_salt/kdf_version)
 * over the authenticated API (using the session this same answer just
 * installed) and unwraps locally — the identical KEK-derivation/unwrap
 * step CAP-384's grant ceremony already runs (`../deviceKey/grant.ts`'s
 * `runGrantCeremony`). Keeping the wire payload minimal also keeps it
 * byte-for-byte identical to what keep-app's `/pair` screen actually seals
 * (`PairKeyMaterial` in keep-app's `src/lib/flow/pairWire.ts`).
 *
 * Purpose slug for the anonymous bootstrap connection: `machine-pair`.
 */
import type { CeremonyFailureCode } from '../deviceKey/ceremonyTransport';

/** Broker `purpose` for the anonymous CAP-403 bootstrap connection this ceremony rides. */
export const PAIR_PURPOSE = 'machine-pair';
/** The sealed payload's `flow` field. */
export const PAIR_FLOW = 'pair';
/** The sealed payload's `ceremony` field — deliberately the same literal as
 *  the broker purpose (both name the same real-world thing), kept as two
 *  constants because they are two different wire fields with independent
 *  contracts (one validated by the broker as a purpose slug, one validated
 *  here as envelope framing) that happen to share a value today. */
export const PAIR_CEREMONY = 'machine-pair';

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

const CEREMONY_FAILURE_CODES: readonly CeremonyFailureCode[] = [
  'cancelled',
  'no_credential',
  'prf_unsupported',
  'webauthn_unavailable',
  'transport_error',
];

function isCeremonyFailureCode(value: unknown): value is CeremonyFailureCode {
  return typeof value === 'string' && (CEREMONY_FAILURE_CODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidUser(value: unknown): value is PairMachineAnswerUser {
  return isRecord(value) && typeof value.id === 'string' && typeof value.email === 'string';
}

function isValidOrg(value: unknown): value is PairMachineAnswerOrg {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string';
}

function isValidOrgSession(value: unknown): value is PairMachineAnswerOrgSession {
  return isRecord(value) && typeof value.access_token === 'string' && typeof value.expires_at === 'number';
}

function isValidSession(value: unknown): value is PairMachineAnswerSession {
  if (!isRecord(value)) return false;
  if (!isValidUser(value.user)) return false;
  if (typeof value.refresh_token !== 'string') return false;
  if (!Array.isArray(value.organizations) || !value.organizations.every(isValidOrg)) return false;
  if (value.sessions !== undefined) {
    if (!isRecord(value.sessions)) return false;
    for (const orgSession of Object.values(value.sessions)) {
      if (!isValidOrgSession(orgSession)) return false;
    }
  }
  return true;
}

function isValidKeyMaterial(value: unknown): value is PairMachineAnswerKeyMaterial {
  return (
    isRecord(value) &&
    typeof value.orgId === 'string' &&
    typeof value.prfOutput === 'string' &&
    typeof value.credentialId === 'string' &&
    // Fail CLOSED on a `kLocal` field, rather than silently ignoring it: a
    // rolled-back or compromised page that resumes shipping raw key
    // material must never be quietly accepted as a valid answer. See this
    // file's header (SECURITY CONTRACT) and pairContract.test.ts's
    // falsification test.
    !('kLocal' in value)
  );
}

export type ParsedPairPayload =
  | { kind: 'answer'; answer: PairMachineAnswer }
  | { kind: 'failure'; code: CeremonyFailureCode }
  /** Foreign/garbage/wrong-shape plaintext. Callers must treat this as a
   *  transport failure, never as a partial or best-effort result — an
   *  attacker who cannot forge the AEAD open can still try to get a
   *  malformed-but-decryptable-looking payload accepted; this is the second
   *  gate after AEAD open that must also fail closed. */
  | { kind: 'malformed' };

/** Parse + validate the {v, flow, ceremony} framing BEFORE trusting the rest
 *  — same discipline as brokerCeremonyTransport.ts's own `run()`. */
export function parsePairPayload(plaintext: string): ParsedPairPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { kind: 'malformed' };
  }
  if (!isRecord(parsed)) return { kind: 'malformed' };
  if (parsed.v !== 1 || parsed.flow !== PAIR_FLOW || parsed.ceremony !== PAIR_CEREMONY) {
    return { kind: 'malformed' };
  }

  if (parsed.ok === false) {
    return isCeremonyFailureCode(parsed.code) ? { kind: 'failure', code: parsed.code } : { kind: 'malformed' };
  }

  if (!isValidSession(parsed.session) || !isValidKeyMaterial(parsed.keyMaterial)) {
    return { kind: 'malformed' };
  }
  return {
    kind: 'answer',
    answer: {
      v: 1,
      flow: 'pair',
      ceremony: 'machine-pair',
      session: parsed.session,
      keyMaterial: parsed.keyMaterial,
    },
  };
}

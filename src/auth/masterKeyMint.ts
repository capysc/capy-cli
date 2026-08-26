/**
 * First-mint of an org's master key M, for auto-provisioned personal orgs
 * (created server-side at first sign-in with no key at all — see
 * `orgCreation.ts`'s docblock). Before this module existed, "org exists but I
 * hold no key" only ever meant "recover your key" (`KEY_NOT_ON_DEVICE`,
 * `detect.ts` Case B′) — a dead end for these orgs, since nobody ever minted
 * M in the first place. The server now arbitrates first-mint via a claimable
 * lease (`key_state`, `POST /orgs/:orgId/key-mint/{claim,finalize}`); this
 * module is the CLI half of that ceremony.
 *
 * Sequence, and why the order is load-bearing:
 *   1. claim   — establishes this device owns the mint lease BEFORE the
 *      phrase is shown. A claim failure (already minted, or another device
 *      mid-mint) means nothing has been shown yet, so nothing needs undoing.
 *   2. ceremony — generate + show + confirm the phrase, TTY only (see below).
 *   3. local save — `seedPhraseToMasterKey` + `wrapAndSaveMasterKey`, THE
 *      SAME crypto calls `orgCreation.ts` makes post-create. M exists on this
 *      device the instant this step returns, lease or no lease.
 *   4. finalize — tells the server this device is done. Best-effort: a
 *      failure here does not unwind step 3 (the key is real and on disk
 *      regardless), it just leaves the lease outstanding for a retry.
 *
 * SECURITY (CAP-402, unchanged posture): the phrase is a master-key-
 * equivalent secret and is rendered on the SAME two sanctioned surfaces
 * `orgCreation.ts` uses — real TTY (`displayAndConfirmRecoveryPhrase`) or
 * `--web` (the browser rail), and nowhere else. The web rail for org
 * creation is a multi-step name+phrase wizard (`onboardingWeb.ts`'s
 * `createOrganizationInBrowser` / `buildCreateOrganizationData`) that does
 * not factor into a phrase-only step without reshaping that wizard's state
 * machine — out of scope here. So today this module is TTY-only: a `--web`
 * or otherwise non-interactive caller gets the same coded
 * `RECOVERY_PHRASE_UNSAFE_SURFACE` refusal `displayAndConfirmRecoveryPhrase`
 * already throws, never a weakened surface. Follow-up: factor the phrase
 * step out of the org-creation wizard so `--web` can mint too.
 */
import type { ServiceClient } from '../service/serviceClient';
import { CapyError, ERROR_CODES, OrgKeyState } from '../types/index';
import {
  generateSeedPhrase,
  seedPhraseToMasterKey,
  CURRENT_KDF_VERSION,
} from '../crypto/keyManager';
import { wrapAndSaveMasterKey, KeyServiceOps } from '../crypto/keyResolver';
import { displayAndConfirmRecoveryPhrase } from '../ui/recoveryPhrase';
import { getOrgKeyPath } from '../config/globalConfig';
import { rmSync } from 'fs';
import { isInteractive } from '../ui/interactive';

/** Same zero-trust box `orgCreation.ts` shows — this is the same secret, minted late instead of at org-create time. */
const MINT_PHRASE_NOTES = [
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

export interface MintMasterKeyForOrgOptions {
  orgId: string;
  userId: string;
  serviceClient: ServiceClient;
  keyServiceOps: KeyServiceOps;
  /**
   * `true` under `--web`. Per this module's docblock, the web rail does not
   * exist yet — passing `true` here still refuses (via
   * `displayAndConfirmRecoveryPhrase`'s own TTY gate), but keeps the call
   * sites future-proof: the day the rail factors out, only this function's
   * body changes.
   */
  web?: boolean;
}

/**
 * Claim → ceremony → local save → finalize.
 *
 * Throws:
 *  - the original `KEY_ALREADY_MINTED` / `KEY_MINT_IN_PROGRESS` CapyError
 *    from the claim, unmodified — callers fall back to the existing no-key
 *    remedy (recovery/transport for ALREADY_MINTED; "try again shortly" is
 *    the message text for IN_PROGRESS, both coded, per Rule 4).
 *  - `RECOVERY_PHRASE_UNSAFE_SURFACE` (from `displayAndConfirmRecoveryPhrase`)
 *    when there is no real TTY — this module does not weaken that gate.
 *  - whatever `claimKeyMint`/`wrapAndSaveMasterKey` throw for anything else
 *    (network errors, etc).
 *
 * Does NOT throw on a finalize failure after the local save succeeded — see
 * the function body for why.
 */
export async function mintMasterKeyForOrg(opts: MintMasterKeyForOrgOptions): Promise<void> {
  // Step 1: claim BEFORE anything is shown. A 409 here means either the key
  // already exists somewhere (ALREADY_MINTED) or another device is mid-mint
  // (IN_PROGRESS) — in both cases nothing has been generated yet, so there is
  // nothing to unwind.
  await opts.serviceClient.claimKeyMint(opts.orgId);

  // Step 2: generate + show + confirm. TTY only — see docblock. `opts.web` is
  // accepted (future-proofing the call sites) but not yet a second rail;
  // displayAndConfirmRecoveryPhrase itself refuses off a real TTY.
  const seedPhrase = generateSeedPhrase();
  await displayAndConfirmRecoveryPhrase(seedPhrase, MINT_PHRASE_NOTES);

  // Step 2b: re-claim — extending our own lease — AFTER the human-speed
  // confirm and immediately BEFORE anything is written to disk. The phrase
  // display waits on a human and can outlast the 15-minute lease; if another
  // device claimed (or finished) the mint in the meantime, aborting HERE
  // means nothing has been saved yet. The phrase the user just recorded must
  // be discarded — said out loud before surfacing the coded refusal, because
  // the refusal's own remedy text can't know a phrase was ever shown.
  try {
    await opts.serviceClient.claimKeyMint(opts.orgId);
  } catch (err) {
    console.error(
      'The recovery phrase you just saved was NOT used — another device completed (or is ' +
      "completing) this organization's setup first. Discard that phrase.",
    );
    throw err;
  }

  // Step 3: same KDF/wrap tail orgCreation.ts uses post-create. M exists on
  // disk the instant this call returns.
  const masterKey = seedPhraseToMasterKey(seedPhrase, CURRENT_KDF_VERSION);
  await wrapAndSaveMasterKey(masterKey, opts.orgId, opts.userId, opts.keyServiceOps);

  // Step 3b→4 window is now milliseconds (no human step remains), so a lost
  // lease at finalize is a genuine sub-second race — handled below by
  // DISCARDING this device's key material rather than pretending it's fine.

  // Step 4: best-effort, retried once on a network error. A failure here is
  // NOT fatal to this session — the key is real and already on disk; the
  // lease will simply need this same user to re-finalize (the server's lease
  // TTL, or a future run of this same command, covers the retry).
  await finalizeWithOneRetry(opts.serviceClient, opts.orgId, opts.userId);
}

async function finalizeWithOneRetry(
  serviceClient: ServiceClient,
  orgId: string,
  userId: string,
): Promise<void> {
  try {
    await serviceClient.finalizeKeyMint(orgId);
  } catch (err) {
    // Lost the lease to another device in the sub-second window between the
    // local save and this call (the pre-save re-claim closed the human-speed
    // window). The key this device just wrote is on the LOSING side of the
    // race: keeping it would poison every later decrypt — and worse, every
    // later ENCRYPT — with a master key the org will never converge on.
    // Discard it and abort loudly; the phrase the user recorded is void.
    if (err instanceof CapyError && err.code === ERROR_CODES.KEY_MINT_NOT_CLAIMED) {
      try {
        rmSync(getOrgKeyPath(orgId, userId), { force: true });
      } catch {
        // Removal is best-effort; the thrown error below still stops the run.
      }
      throw new CapyError(
        "Another device completed this organization's setup first. The recovery phrase you " +
        'just saved was NOT used — discard it, and use the device that finished setup (or its ' +
        'recovery phrase) instead.',
        ERROR_CODES.KEY_MINT_NOT_CLAIMED,
      );
    }
    if (!(err instanceof CapyError) || err.code !== ERROR_CODES.NETWORK_ERROR) {
      warnFinalizeFailed(orgId);
      return;
    }
    try {
      await serviceClient.finalizeKeyMint(orgId);
    } catch {
      warnFinalizeFailed(orgId);
    }
  }
}

function warnFinalizeFailed(orgId: string): void {
  console.error(
    'Your recovery phrase and local key are saved, but capy could not confirm the mint with ' +
    'the server. Your access is not affected — re-run any capy command to retry the confirmation ' +
    `(org ${orgId}).`,
  );
}

/**
 * `unwrapMasterKey`/`resolveProjectKey` (keyResolver.ts) signal "no key for
 * this org on this device" as `PERMISSION_DENIED` with no `details.status` —
 * a client-local decision, never a re-thrown server 403 (which always
 * carries `status`). This is the SAME structural signal
 * `runCommand.ts`'s BLOCKER-1(c) device-key fallback already keys off
 * (`isMissingKey`) — reused here rather than re-derived, and reused rather
 * than message-matched per Rule 4. `capyCommand.ts`'s own explicit
 * `hasOrgKey` check throws the distinct `KEY_NOT_ON_DEVICE` code for the
 * same underlying fact; both are treated as the same signal here.
 */
export function isNoKeyOnDeviceError(err: unknown): boolean {
  if (!(err instanceof CapyError)) return false;
  if (err.code === ERROR_CODES.KEY_NOT_ON_DEVICE) return true;
  return err.code === ERROR_CODES.PERMISSION_DENIED && err.details?.status === undefined;
}

export interface MintOnNoKeyOptions {
  orgId: string;
  userId: string;
  serviceClient: ServiceClient;
  keyServiceOps: KeyServiceOps;
  /**
   * key_state for this org, when the caller already has it in hand from the
   * auth-response org list. `undefined` when not available — the claim call
   * itself is then the probe (its own 409 codes tell us whether minting
   * makes sense). Present-and-`'minted'` skips the attempt entirely: the key
   * exists somewhere, so there is nothing to claim and the original error's
   * existing remedy (recovery/transport) is already correct.
   */
  orgKeyState?: OrgKeyState;
  /** See `MintMasterKeyForOrgOptions.web`. */
  web?: boolean;
}

/**
 * The shared gate: is this even worth trying?
 *
 * `false` when the org is known-already-minted (nothing to claim — the
 * existing recovery/transport remedy is already the right one) or when
 * there is no surface to safely show a phrase on.
 *
 * `web` is accepted (not `_web`) to keep every call site's argument list
 * future-proof for the day the browser phrase rail exists, but it is NOT
 * currently honored as a bypass of `isInteractive()`: per this module's own
 * docblock, the web rail hasn't been factored out of the org-creation
 * wizard yet, so `mintMasterKeyForOrg` refuses off a real TTY regardless of
 * `web` (via `displayAndConfirmRecoveryPhrase`'s own gate). Treating
 * `web === true` as sufficient here — before that rail exists — would let a
 * non-interactive `--web`/broker-ceremony caller pass this gate, make a
 * REAL `claimKeyMint` call (a genuine side effect: a 15-minute lease that
 * blocks every other device from claiming), and only then fail at the
 * phrase-display step. "Non-interactive surfaces get no claim call at all"
 * requires gating on `isInteractive()` alone until the rail is real.
 *
 * Exported so `capyCommand.ts`'s proactive `hasOrgKey` check — a boolean,
 * not a caught error — can apply the identical gate without duplicating it.
 */
export function shouldAttemptMint(orgKeyState: OrgKeyState | undefined, web: boolean | undefined): boolean {
  void web; // see docblock — reserved for the day the web rail is wired.
  if (orgKeyState === 'minted') return false;
  return isInteractive();
}

/**
 * The chokepoint every interactive "no key on this device" call site shares.
 *
 * `originalErr` must already be known to be a "no key" error (checked with
 * `isNoKeyOnDeviceError` by the caller). On any refusal to mint — already
 * minted, mid-mint elsewhere, non-interactive, or an unsafe surface — this
 * rethrows `originalErr` UNMODIFIED, so today's remedy text (invite code /
 * seed-phrase recovery) is untouched. Never swallows a genuinely new error
 * from the RETRY: if the mint succeeds but resolution still fails
 * afterward, that failure is a new fact worth surfacing, not the stale
 * "no key" message.
 */
export async function mintThenRetryOnNoKey<T>(
  originalErr: unknown,
  opts: MintOnNoKeyOptions,
  retry: () => Promise<T>,
): Promise<T> {
  if (!shouldAttemptMint(opts.orgKeyState, opts.web)) throw originalErr;

  try {
    await mintMasterKeyForOrg({
      orgId: opts.orgId,
      userId: opts.userId,
      serviceClient: opts.serviceClient,
      keyServiceOps: opts.keyServiceOps,
      web: opts.web,
    });
  } catch {
    // KEY_ALREADY_MINTED, KEY_MINT_IN_PROGRESS, RECOVERY_PHRASE_UNSAFE_SURFACE,
    // or anything else the ceremony throws — the original no-key error and
    // its existing remedy stand.
    throw originalErr;
  }

  return retry();
}

export interface ResolveProjectKeyWithMintOptions {
  orgId: string;
  projectId: string;
  userId: string;
  serviceClient: ServiceClient;
  keyServiceOps: KeyServiceOps;
  orgKeyState?: OrgKeyState;
  web?: boolean;
}

/**
 * `resolveProjectKey` (keyResolver.ts), with the mint chokepoint folded in.
 *
 * The one function every interactive resolveProjectKey call site should call
 * instead of `resolveProjectKey` directly —
 * `src/commands/connectors/shared.ts`'s `resolveContext` (both lock-full and
 * lock-less paths) and `editCommand.ts`'s lock-full path all use this. Each
 * keeps its own existing try/catch → `displayErrorAndExit` wrapper
 * byte-identical; only the call inside it changes.
 */
export async function resolveProjectKeyWithMintFallback(
  opts: ResolveProjectKeyWithMintOptions,
): Promise<string> {
  const { resolveProjectKey } = await import('../crypto/keyResolver');
  try {
    return await resolveProjectKey(opts.orgId, opts.projectId, opts.userId, opts.keyServiceOps);
  } catch (err) {
    if (!isNoKeyOnDeviceError(err)) throw err;
    return mintThenRetryOnNoKey(err, opts, () =>
      resolveProjectKey(opts.orgId, opts.projectId, opts.userId, opts.keyServiceOps),
    );
  }
}

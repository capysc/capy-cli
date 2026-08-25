/**
 * Production wiring (CAP-382): builds `OnboardingDeps` from the
 * session-holding singletons (`AuthService`, `ServiceClient`) plus the
 * broker-backed ceremony transport, and provides the small command-facing
 * helpers the real `capy` init / `capy redeem` / `capy recover` / `capy
 * device-key` call sites use.
 *
 * Every helper here is safe to call from a hot path behind
 * `CAPY_DEVICE_KEYS`: none of them throws outward on a ceremony
 * decline/failure or a missing token — those degrade to a debug log and a
 * "not done" outcome, never a blocked command. Only genuine programming
 * errors (bad deps shape) propagate. This mirrors CAP-380's own design
 * ("A ceremony refusal leaves the machine byte-identical to today's
 * non-passkey flow") extended to the wiring layer.
 */
import { hostname } from 'os';
import inquirer from 'inquirer';
import type { AuthService } from '../authService';
import type { ServiceClient } from '../../service/serviceClient';
import { Organization, ERROR_CODES } from '../../types/index';
import { debug } from '../../ui/debug';
import { isInteractive } from '../../ui/interactive';
import { resolveActiveUrl } from '../../config/profileConfig';
import { createDeviceKeyServiceOps } from './serviceOps';
import { BrokerCeremonyTransport } from './brokerCeremonyTransport';
import {
  listOrgsWithLocalRoot,
  readLocalRoot,
  markKeyEncSyncPending,
  hasDeclinedDeviceKeyNudge,
  setDeviceKeyNudgeDeclined,
} from '../../config/globalConfig';
import {
  OnboardingDeps,
  detectOnboardingCase,
  runNewUserEnrollment,
  runFirstEnrollment,
  runUnlock,
  runPendingSync,
  EnrollmentSummary,
  CeremonyAborted,
  EphemeralEnrollmentIncomplete,
} from './onboarding';
import type { CeremonyFailureCode, CeremonyTransport } from './ceremonyTransport';

export interface DeviceKeyWiringContext {
  authService: AuthService;
  serviceClient: ServiceClient;
  devMode: boolean;
  userId: string;
  userEmail?: string;
  organizations: Organization[];
  activeOrgId?: string | null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** The current org-scoped access token, refreshing if needed — same primitive ServiceClient itself pulls per request. */
function currentOrgToken(ctx: DeviceKeyWiringContext): () => Promise<string | null> {
  return async () => {
    const token = await ctx.authService.getValidToken();
    return token?.access_token ?? null;
  };
}

/**
 * Build the engine's full dependency set. `getConnectionToken` decides which
 * token authenticates the BROKER CONNECTION specifically (org-scoped or the
 * Wave-B org-less token) — independent of `opsForOrg`'s own per-org pinning,
 * which always re-authenticates via `authenticateSilent(orgId)` regardless
 * of what token created the connection.
 */
export function buildOnboardingDeps(
  ctx: DeviceKeyWiringContext,
  getConnectionToken: () => string | null | Promise<string | null>,
): OnboardingDeps {
  const { ops, opsForOrg } = createDeviceKeyServiceOps(ctx.serviceClient, ctx.authService);
  const ceremony: CeremonyTransport = new BrokerCeremonyTransport({
    serviceUrl: resolveActiveUrl(ctx.devMode),
    getToken: getConnectionToken,
    machineName: hostname(),
  });
  return {
    userId: ctx.userId,
    userEmail: ctx.userEmail,
    organizations: ctx.organizations,
    activeOrgId: ctx.activeOrgId ?? null,
    ceremony,
    ops,
    opsForOrg,
  };
}

function reportEnrollmentOutcome(
  result: EnrollmentSummary | CeremonyAborted | EphemeralEnrollmentIncomplete,
  orgName: string,
): void {
  if (result.ok) {
    console.log('');
    console.log(
      `  Device key enrolled — this machine can unlock ${orgName} (and any other organization ` +
        'this account belongs to) on new devices with a touch.',
    );
    if (!result.backupEligible) {
      console.log('  This device key is device-locked (no platform backup/sync).');
      console.log('  Keep your recovery phrase somewhere safe — it is still the only backup for this key.');
    }
    console.log('');
    return;
  }

  if (result.code === ERROR_CODES.DEVICE_KEY_EPHEMERAL_MINT_INCOMPLETE) {
    // CAP-402: this is not a quiet "ceremony declined, try later" — the
    // rollback already deleted the K_local/key.enc this call minted, and on
    // an ephemeral box the seed phrase shown earlier (if it was safe to
    // show at all) is now the only way back into this org. Worth a visible
    // line, not just a debug log.
    console.log('');
    console.log(`  Could not finish setting up a device key for ${orgName} on this machine.`);
    console.log('  This looks like an ephemeral environment, so nothing was left half set up here —');
    console.log('  your recovery phrase is the only way back into this organization from elsewhere.');
    console.log('  Finish device-key setup later from a machine with a human at the keyboard:');
    console.log('  `capy device-key enroll`.');
    console.log('');
    return;
  }

  debug(`[device-key] enrollment ceremony not completed (${result.ceremonyCode})`);
}

/**
 * Case A: invoked right after org creation has minted seed→M and settled
 * files (CAP-380 decision 4 — ceremony after writes). Deliberately
 * authenticates the broker connection with the Wave-B org-less token
 * captured at exchange time rather than the org-scoped token the new org's
 * session now also has: a device key is a user-level credential (CAP-380
 * decision 3, "one K_local per user"), not an org-scoped one. Never throws —
 * a declined ceremony, or the absence of a captured org-less token, leaves
 * org creation exactly as it behaves with the flag off.
 */
export async function attemptCaseAEnrollment(opts: {
  ctx: DeviceKeyWiringContext;
  orgId: string;
  orgName: string;
  masterKey: Buffer;
  orglessToken: string | null | undefined;
}): Promise<void> {
  if (!opts.orglessToken) {
    debug('[device-key] Case A skipped: no org-less token captured at exchange time');
    return;
  }
  try {
    const deps = buildOnboardingDeps(opts.ctx, () => opts.orglessToken ?? null);
    const result = await runNewUserEnrollment(deps, { orgId: opts.orgId, masterKey: opts.masterKey });
    reportEnrollmentOutcome(result, opts.orgName);
  } catch (err) {
    debug(`[device-key] Case A enrollment skipped: ${describeError(err)}`);
  }
}

/**
 * Case C / C′: this machine has no local key material for the current org,
 * but the account has live device-key doors server-side. Attempts the
 * unlock ceremony and installs every reachable org's key.enc. Returns
 * `installedCurrentOrg: true` only when the caller's `ctx.activeOrgId` ended
 * up provisioned — the caller re-checks `hasOrgKey` itself rather than
 * trusting this alone, since installOrgFromServer's per-org outcome is the
 * source of truth.
 */
export async function attemptCaseCUnlock(
  ctx: DeviceKeyWiringContext,
): Promise<{ ok: boolean; installedCurrentOrg: boolean }> {
  try {
    const deps = buildOnboardingDeps(ctx, currentOrgToken(ctx));
    const detection = await detectOnboardingCase(deps);
    if (detection.kind !== 'unlock') return { ok: false, installedCurrentOrg: false };

    const result = await runUnlock(deps, detection.inventory);
    if (!result.ok) {
      debug(`[device-key] Case C ceremony not completed (${result.ceremonyCode})`);
      return { ok: false, installedCurrentOrg: false };
    }

    const installedCurrentOrg =
      !!ctx.activeOrgId &&
      result.orgs.some(
        (o) => o.orgId === ctx.activeOrgId && (o.status === 'installed' || o.status === 'already_provisioned'),
      );
    console.log('');
    console.log('  Device key recognized — this machine is unlocked.');
    console.log('');
    return { ok: true, installedCurrentOrg };
  } catch (err) {
    debug(`[device-key] Case C unlock skipped: ${describeError(err)}`);
    return { ok: false, installedCurrentOrg: false };
  }
}

/**
 * A brand-new invitee who already completed the Keep-page pickup
 * paste (docs/invite-pickup-flow.md §4 step 3) — this machine has no local
 * key material and no live doors, but there IS a pending pickup row server
 * side. Consumes it automatically so a fresh `capy` run completes the key
 * handoff silently, riding the same passkey ceremony a brand-new user owes
 * regardless (docs/invite-pickup-flow.md §4 is explicit that "silently"
 * means no re-entered code and no terminal ceremony, not that the passkey
 * touch itself is skipped — it still happens).
 *
 * Mirrors `attemptCaseCUnlock` exactly in shape: never throws outward — any
 * ceremony decline, missing pickup, or server failure degrades to
 * `{ ok: false }` and a debug log, leaving the caller's fallback (today's
 * `KEY_NOT_ON_DEVICE` message) completely unchanged. `ctx.activeOrgId` is
 * NOT consulted for which org to act on — the pending pickup row names its
 * own organization_id, exactly like `GET /invites/pending` is not org-scoped
 * (see auth/invitePickup/serviceOps.ts's docblock) — so this call is safe to
 * make even when the caller's active org differs from the invite's org; the
 * caller re-checks `hasOrgKey(activeOrgId, ...)` itself afterward, same
 * pattern as Case C.
 */
export async function attemptPickupConsumption(
  ctx: DeviceKeyWiringContext,
): Promise<{ ok: boolean }> {
  try {
    const { consumeInvitePickup } = await import('../invitePickup/consume');
    const { createInvitePickupOps } = await import('../invitePickup/serviceOps');
    const ops = createInvitePickupOps(ctx.serviceClient, ctx.authService);
    const ceremony: CeremonyTransport = new BrokerCeremonyTransport({
      serviceUrl: resolveActiveUrl(ctx.devMode),
      getToken: currentOrgToken(ctx),
      machineName: hostname(),
    });
    const result = await consumeInvitePickup(ctx.userId, ceremony, ops);
    if ('noPendingPickup' in result) return { ok: false };
    console.log('');
    console.log('  Invite pickup completed — this machine now holds the organization key.');
    console.log('');
    return { ok: true };
  } catch (err) {
    debug(`[invite-pickup] consumption skipped: ${describeError(err)}`);
    return { ok: false };
  }
}

export type EnrollmentAttemptOutcome =
  | { kind: 'enrolled'; result: EnrollmentSummary }
  | { kind: 'declined'; ceremonyCode: CeremonyFailureCode }
  | { kind: 'already_enrolled' }
  | { kind: 'not_ready'; verdictKind: 'recovery_or_transport' | 'brand_new' };

/**
 * Case B on demand: `capy device-key enroll` and the post-redeem nudge both
 * want "enroll this machine's existing local.key now" — detects first so a
 * caller who is already enrolled, or who has nothing enrollable yet (no
 * local.key / no orgs), gets an honest coded outcome instead of a ceremony
 * that could never succeed.
 */
export async function runDeviceKeyEnrollment(ctx: DeviceKeyWiringContext): Promise<EnrollmentAttemptOutcome> {
  const deps = buildOnboardingDeps(ctx, currentOrgToken(ctx));
  const detection = await detectOnboardingCase(deps);
  if (detection.kind === 'unlock') return { kind: 'already_enrolled' };
  if (detection.kind === 'brand_new' || detection.kind === 'recovery_or_transport') {
    return { kind: 'not_ready', verdictKind: detection.kind };
  }

  const result = await runFirstEnrollment(deps);
  if (!result.ok) {
    if ('kind' in result) return { kind: 'not_ready', verdictKind: 'recovery_or_transport' };
    return { kind: 'declined', ceremonyCode: result.ceremonyCode };
  }
  return { kind: 'enrolled', result };
}

/**
 * Final-gate MAJOR-5 — the ordinary `capy` run's own on-ramp into device-key
 * enrollment.
 *
 * The final-gate review's biggest adoption risk: enrollment previously only
 * happened via `capy device-key enroll`, the post-redeem nudge, or the
 * post-recovery nudge — never during the everyday flow, so a user who never
 * hits any of those three never finds out the feature exists, and
 * every new machine keeps using transport codes. This closes
 * that gap the same way `capy redeem`'s own nudge (`redeemCommand.ts`) does:
 * a declinable inquirer confirm, `isInteractive()`-gated so CI, agents and
 * `--web` runs (no TTY) never see a prompt they cannot answer.
 *
 * Detects Case B (`enroll_existing` — a local root already exists, but the
 * account holds zero live doors) itself, rather than firing the prompt and
 * letting `runDeviceKeyEnrollment` sort it out afterward: that function goes
 * straight to the WebAuthn ceremony with no confirmation of its own, so the
 * eligibility check has to happen BEFORE the question is asked, not after.
 *
 * Declining persists `globalConfig`'s device-key-nudge-declined marker so
 * this asks AT MOST ONCE per machine; an `enrolled` outcome needs no marker
 * (detection itself stops being `enroll_existing` the moment a door exists).
 * Never throws outward — matches every other helper in this file.
 */
export async function maybeNudgeDeviceKeyEnrollment(ctx: DeviceKeyWiringContext, orgName: string): Promise<void> {
  if (!isInteractive()) return;
  if (hasDeclinedDeviceKeyNudge()) return;

  try {
    const deps = buildOnboardingDeps(ctx, currentOrgToken(ctx));
    const detection = await detectOnboardingCase(deps);
    if (detection.kind !== 'enroll_existing') return;

    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: 'Set up a device key so your other machines can unlock with Face ID/Touch ID instead of transport codes?',
      default: false,
    }]);
    if (!confirmed) {
      setDeviceKeyNudgeDeclined();
      console.log('  No problem — enroll a device key any time with `capy device-key enroll`.');
      console.log('');
      return;
    }

    const outcome = await runDeviceKeyEnrollment(ctx);
    switch (outcome.kind) {
      case 'enrolled':
        reportEnrollmentOutcome(outcome.result, orgName);
        break;
      case 'declined':
        setDeviceKeyNudgeDeclined();
        console.log('  No problem — enroll a device key any time with `capy device-key enroll`.');
        console.log('');
        break;
      case 'already_enrolled':
      case 'not_ready':
        // Detection said 'enroll_existing' a moment ago; either changed
        // underneath us (another process just enrolled) or nothing to do.
        // Leave the marker unset either way — this was not a decline.
        break;
    }
  } catch (err) {
    debug(`[device-key] enrollment nudge skipped: ${describeError(err)}`);
  }
}

/**
 * The CAP-380 "known gap," now closed (grounding doc: "CAP-382 must handle
 * orgs joined after enrollment"). An org joined AFTER this account already
 * enrolled a device key (e.g. a teammate invite redeemed on an
 * already-enrolled machine) mints its OWN fresh per-org root — it is not yet
 * portable via the device key until something re-keys it onto the canonical
 * root and uploads a key_enc row for it. `capy redeem`'s post-success hook
 * calls this for exactly that org, silently (no prompt: nothing new is being
 * decided, this is maintenance, same standing as `runPendingSyncBestEffort`).
 *
 * Returns `alreadyEnrolled: true` whenever the account has ANY live door,
 * regardless of whether this specific org's sync succeeded — callers use it
 * to skip the "set up a device key" nudge (asking a user who already has one
 * to set up another is the wrong prompt; `synced: false` with
 * `alreadyEnrolled: true` means this machine holds no canonical root yet to
 * unify onto, which `capy device-key list`/a future unlock resolves, not a
 * repeat of this nudge).
 */
export async function syncOrgOntoDeviceKeyIfEnrolled(
  ctx: DeviceKeyWiringContext,
  orgId: string,
): Promise<{ alreadyEnrolled: boolean; synced: boolean }> {
  try {
    const deps = buildOnboardingDeps(ctx, currentOrgToken(ctx));
    const detection = await detectOnboardingCase(deps);
    if (detection.kind !== 'unlock') return { alreadyEnrolled: false, synced: false };

    // A canonical root this machine already resolved from some OTHER org —
    // Case B/C already unified this machine onto one root (CAP-380
    // decision 3, "one K_local per user"); reuse it rather than guessing.
    const canonicalCandidates = listOrgsWithLocalRoot(ctx.userId).filter((id) => id !== orgId);
    if (canonicalCandidates.length === 0) {
      debug(`[device-key] org ${orgId} joined post-enrollment, but this machine holds no canonical root yet`);
      return { alreadyEnrolled: true, synced: false };
    }
    const canonicalOrgId =
      ctx.activeOrgId && canonicalCandidates.includes(ctx.activeOrgId) ? ctx.activeOrgId : canonicalCandidates[0];
    const canonicalRoot = readLocalRoot(canonicalOrgId, ctx.userId);
    if (!canonicalRoot) return { alreadyEnrolled: true, synced: false };

    // Mark + reuse the tested runPendingSync path (resolveCanonicalForPendingOrg
    // + syncOrgKeyEnc) instead of duplicating its re-key/upload/rewrite logic.
    markKeyEncSyncPending(orgId, ctx.userId, canonicalOrgId, canonicalRoot);
    const outcomes = await runPendingSync(deps);
    const mine = outcomes.find((o) => o.orgId === orgId);
    debug(`[device-key] newly-joined org sync: ${orgId} → ${mine?.status ?? 'unknown'}`);
    return { alreadyEnrolled: true, synced: mine?.status === 'uploaded' || mine?.status === 'rekeyed_and_uploaded' };
  } catch (err) {
    debug(`[device-key] newly-joined org sync skipped: ${describeError(err)}`);
    return { alreadyEnrolled: true, synced: false };
  }
}

/**
 * Retry every owed key.enc upload for this account. Best-effort maintenance,
 * meant to ride along wherever enrollment-aware ops are already wired (the
 * CAP-380 report's open question) — never blocks or throws.
 */
export async function runPendingSyncBestEffort(ctx: DeviceKeyWiringContext): Promise<void> {
  try {
    const deps = buildOnboardingDeps(ctx, currentOrgToken(ctx));
    const outcomes = await runPendingSync(deps);
    if (outcomes.length > 0) {
      debug(`[device-key] pending sync: ${outcomes.map((o) => `${o.orgId}:${o.status}`).join(', ')}`);
    }
  } catch (err) {
    debug(`[device-key] pending sync skipped: ${describeError(err)}`);
  }
}

export { reportEnrollmentOutcome };

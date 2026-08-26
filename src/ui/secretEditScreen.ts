/**
 * `capy edit --web`'s keep-hosted transport (CAP-540 S4'), additive beside
 * the untouched alternate-screen TUI and the untouched loopback `--web`
 * screen (`secretTableScreen.ts`). Built against CAP-540's FROZEN
 * session-envelope contract (see `secretEditWire.ts`).
 *
 * §0 restated for this file: the CLI holds ALL org-custody material and
 * does ALL org-key work. The only thing this module ever receives FROM the
 * page is a raw PRF output (or its passphrase-derived equivalent) — a KDF
 * input, identical trust to what `/pair` already couriers
 * (`pairKeyMaterial.ts`). Before that value is used to derive a session key
 * or seal a single byte of plaintext, it is VERIFIED against the person's
 * own enrolled wrapper using the EXISTING CLI-only KEK-derivation + AEAD
 * unwrap path (`auth/deviceKey/crypto.ts`'s `deriveDeviceKeyKek`/
 * `unwrapKLocal` — the same primitives `auth/deviceKey/grant.ts`'s grant
 * ceremony already uses for `/pair`). A courier that fails that check never
 * reaches a session-key derivation, and never causes a real value to be
 * sealed.
 *
 * THREE CHAINED BROKER CONNECTIONS: `unlock` (edit_request / prf_courier or
 * error), `values` (sealed_values / save or error), `result` (the CLI's
 * final save verdict). See secretEditWire.ts's module doc for why a single
 * connection cannot carry this exchange.
 *
 * SCOPE (v1 of this dispatch): exactly one unlock and one save round trip
 * per invocation. The wire contract's `next_values_connection_id`/
 * `next_result_connection_id` fields exist for a future multi-save session
 * but this module never populates them — a person who saves once, keeps
 * editing, and clicks Save again sees the coded `bad_session` on that
 * SECOND save (the screen's own generic failure copy + badge, not a crash).
 * Flagged here rather than silently claimed as full support.
 */
import { hostname } from 'os';
import {
  deriveDeviceKeyKek,
  deviceKeyWrapAAD,
  unwrapKLocal,
} from '../auth/deviceKey/crypto';
import type { KeyWrapperMetadata, KeyWrapperPayload } from '../service/serviceClient';
import { BrokerClient, type BrokerConnection } from '../service/brokerClient';
import { deriveEditSessionKey, openEditValue, sealEditValue } from '../service/editSessionCrypto';
import { keepFlowUrl } from './screens/keepScreens';
import { relayUrl } from '../auth/deviceKey/brokerCeremonyTransport';
import { debug } from './debug';
import {
  isSecretEditPrfCourier,
  isSecretEditSave,
  type SecretEditError,
  type SecretEditErrorCode,
  type SecretEditPrfCandidate,
  type SecretEditRequest,
  type SecretEditSaveResult,
  type SecretEditSealedValues,
  SECRET_EDIT_SCREEN,
} from './secretEditWire';

/** The passphrase-door sentinel credential id (keep-app's
 *  `webauthn/passphraseDoorId.ts`) — opaque here, exactly like every other
 *  credential id the CLI already handles uniformly (`grant.ts`). */
export const PASSPHRASE_CREDENTIAL_ID = 'capy:passphrase';

const isLiveDoor = (w: KeyWrapperMetadata): boolean =>
  w.type === 'wrapped_k_local' && !w.deleted_at;

export interface EditSessionOps {
  listWrappers(): Promise<KeyWrapperMetadata[]>;
  fetchWrapper(wrapperId: string): Promise<KeyWrapperPayload>;
}

export interface SecretEditKeepParams {
  serviceApiUrl: string;
  getToken: () => string | null | Promise<string | null>;
  userId: string;
  projectName: string;
  branchName: string;
  machineName?: string;
  /** Current plaintext, in-process only — never logged, never printed. */
  vars: Array<{ name: string; value: string }>;
  /** CAS baseline this request was built against. */
  keepHash: string;
  ops: EditSessionOps;
  /**
   * CAS-checked write + push. Called with ONLY the changed name->value
   * pairs; the caller re-verifies `expectedKeepHash` against the current
   * on-disk state immediately before writing (CAP-540's CAS requirement —
   * `stale_version` on a mismatch, no write attempted).
   */
  applyEdits(
    edits: Record<string, string>,
    expectedKeepHash: string,
  ): Promise<{ ok: true; keepHash: string } | { ok: false; code: 'stale_version' }>;
  /** Independently applied to each connection's own wait — see
   *  `brokerClient.ts`'s ceremony guidance. Generous default: a person may
   *  take a while to unlock and edit. */
  deadlineMs?: number;
}

export type SecretEditKeepOutcome =
  /** The broker itself could not be reached, or no candidate wrapper
   *  exists at all — nothing to unlock with. */
  | { kind: 'unavailable' }
  /** A connection was created and a URL printed, but the ceremony did not
   *  reach a successful save (page never attached, unlock failed, save
   *  never arrived, CAS conflict, etc). */
  | { kind: 'declined'; code: string }
  /** A save was CAS-verified, written, and pushed. */
  | { kind: 'saved' };

const DEFAULT_DEADLINE_MS = 900_000; // 15 minutes — a ceremony a human deliberates over.

function verifyPrfAgainstWrapper(opts: {
  userId: string;
  credentialId: string;
  prfOutputB64: string;
  wrapper: KeyWrapperPayload;
}): boolean {
  const { wrapper } = opts;
  if (!wrapper.wrapped_k_local || !wrapper.iv || !wrapper.prf_salt) return false;
  try {
    const kek = deriveDeviceKeyKek(
      Buffer.from(opts.prfOutputB64, 'base64'),
      Buffer.from(wrapper.prf_salt, 'base64'),
      wrapper.kdf_version,
    );
    unwrapKLocal(
      wrapper.wrapped_k_local,
      wrapper.iv,
      kek,
      deviceKeyWrapAAD(opts.userId, opts.credentialId),
    );
    return true;
  } catch {
    return false;
  }
}

/** Pick the one candidate this request offers — see secretEditScreen's own
 *  header on FROZEN's singular `prf` field (a single-door-at-a-time model,
 *  not a simultaneous multi-door offer): prefer a live passkey door, fall
 *  back to a live passphrase door, else nothing to unlock with. */
async function pickCandidate(
  ops: EditSessionOps,
): Promise<{ candidate: SecretEditPrfCandidate; wrapper: KeyWrapperPayload } | null> {
  const rows = await ops.listWrappers();
  const doors = rows.filter(isLiveDoor);
  const passkeyDoor = doors.find((d) => d.credential_id && d.credential_id !== PASSPHRASE_CREDENTIAL_ID);
  const passphraseDoor = doors.find((d) => d.credential_id === PASSPHRASE_CREDENTIAL_ID);
  const chosen = passkeyDoor ?? passphraseDoor;
  if (!chosen?.credential_id) return null;

  const wrapper = await ops.fetchWrapper(chosen.id);
  if (!wrapper.credential_id || !wrapper.prf_salt) return null;
  return {
    candidate: { credential_id: wrapper.credential_id, prf_salt: wrapper.prf_salt },
    wrapper,
  };
}

function errorPayload(code: SecretEditErrorCode, detail?: string): SecretEditError {
  return detail ? { kind: 'error', v: 1, code, detail } : { kind: 'error', v: 1, code };
}

/** Best-effort cleanup; never lets a cancel failure change the outcome. */
async function cancelQuietly(broker: BrokerClient, connectionId: string): Promise<void> {
  try {
    await broker.cancel(connectionId);
  } catch {
    /* best-effort by contract */
  }
}

export async function runSecretEditViaKeep(
  params: SecretEditKeepParams,
): Promise<SecretEditKeepOutcome> {
  const picked = await pickCandidate(params.ops).catch(() => null);
  if (!picked) return { kind: 'unavailable' };

  const broker = new BrokerClient(params.serviceApiUrl, params.getToken);
  const deadlineMs = params.deadlineMs ?? DEFAULT_DEADLINE_MS;

  let unlockConn: BrokerConnection;
  let valuesConn: BrokerConnection;
  let resultConn: BrokerConnection;
  try {
    [unlockConn, valuesConn, resultConn] = await Promise.all([
      broker.createConnection({ purpose: SECRET_EDIT_SCREEN, machineName: params.machineName ?? hostname(), ttlSeconds: 900 }),
      broker.createConnection({ purpose: SECRET_EDIT_SCREEN, machineName: params.machineName ?? hostname(), ttlSeconds: 900 }),
      broker.createConnection({ purpose: SECRET_EDIT_SCREEN, machineName: params.machineName ?? hostname(), ttlSeconds: 900 }),
    ]);
  } catch {
    debug('[keep-screens] secret-edit: broker unavailable, falling back to loopback');
    return { kind: 'unavailable' };
  }

  const url = keepFlowUrl(SECRET_EDIT_SCREEN, unlockConn.connectionId);
  relayUrl('Edit secrets in your browser (values never touch this terminal or the AI):', url, 'edit');

  const request: SecretEditRequest = {
    kind: 'edit_request',
    v: 1,
    project_name: params.projectName,
    branch_name: params.branchName,
    machine: params.machineName ?? hostname(),
    vars: params.vars.map((v) => ({ name: v.name, state: 'locked' })),
    keep_hash: params.keepHash,
    prf: picked.candidate,
    unlock_kinds: [picked.candidate.credential_id === PASSPHRASE_CREDENTIAL_ID ? 'passphrase' : 'passkey'],
    values_connection_id: valuesConn.connectionId,
    result_connection_id: resultConn.connectionId,
  };

  // --- unlock leg ---
  const unlockPageKey = await broker.awaitPagePubkey(unlockConn, { deadlineMs });
  if (unlockPageKey.kind !== 'ready') {
    debug(`[keep-screens] secret-edit: page never attached (${unlockPageKey.kind})`);
    await Promise.all([
      cancelQuietly(broker, unlockConn.connectionId),
      cancelQuietly(broker, valuesConn.connectionId),
      cancelQuietly(broker, resultConn.connectionId),
    ]);
    return { kind: 'declined', code: 'transport_unavailable' };
  }

  const sentRequest = await broker.sendRequest(unlockConn, unlockPageKey.pagePubkeyB64, JSON.stringify(request));
  if (sentRequest.kind !== 'sent') {
    debug(`[keep-screens] secret-edit: request send failed (${sentRequest.kind})`);
    await cancelQuietly(broker, unlockConn.connectionId);
    return { kind: 'declined', code: 'transport_unavailable' };
  }

  const unlockAnswer = await broker.awaitAnswer(unlockConn, { deadlineMs });
  if (unlockAnswer.kind !== 'answered') {
    debug(`[keep-screens] secret-edit: no unlock answer (${unlockAnswer.kind})`);
    return { kind: 'declined', code: unlockAnswer.kind };
  }

  let courierPayload: unknown;
  try {
    courierPayload = JSON.parse(unlockAnswer.plaintext);
  } catch {
    return { kind: 'declined', code: 'invalid_message' };
  }
  if (!isSecretEditPrfCourier(courierPayload)) {
    // A page-side cancellation/failure sends the `error` kind instead —
    // either way there is nothing further this leg can do.
    return { kind: 'declined', code: 'cancelled' };
  }

  const verified = verifyPrfAgainstWrapper({
    userId: params.userId,
    credentialId: courierPayload.credential_id,
    prfOutputB64: courierPayload.prf_output,
    wrapper: picked.wrapper,
  });

  // --- values leg ---
  const valuesPageKey = await broker.awaitPagePubkey(valuesConn, { deadlineMs });
  if (valuesPageKey.kind !== 'ready') {
    debug(`[keep-screens] secret-edit: values page never attached (${valuesPageKey.kind})`);
    await cancelQuietly(broker, resultConn.connectionId);
    return { kind: 'declined', code: valuesPageKey.kind };
  }

  if (!verified) {
    await broker.sendRequest(valuesConn, valuesPageKey.pagePubkeyB64, JSON.stringify(errorPayload('wrong_passphrase')));
    await cancelQuietly(broker, resultConn.connectionId);
    return { kind: 'declined', code: 'wrong_passphrase' };
  }

  const sessionKey = deriveEditSessionKey(
    Buffer.from(courierPayload.prf_output, 'base64'),
    unlockConn.connectionId,
  );

  const sealedValues: SecretEditSealedValues = {
    kind: 'sealed_values',
    v: 1,
    values: params.vars.map((v) => {
      const sealed = sealEditValue(sessionKey, v.value);
      return { name: v.name, iv: sealed.iv, ct: sealed.ct };
    }),
  };
  const sentValues = await broker.sendRequest(valuesConn, valuesPageKey.pagePubkeyB64, JSON.stringify(sealedValues));
  if (sentValues.kind !== 'sent') {
    await cancelQuietly(broker, resultConn.connectionId);
    return { kind: 'declined', code: sentValues.kind };
  }

  const saveAnswer = await broker.awaitAnswer(valuesConn, { deadlineMs });
  if (saveAnswer.kind !== 'answered') {
    debug(`[keep-screens] secret-edit: no save answer (${saveAnswer.kind})`);
    await cancelQuietly(broker, resultConn.connectionId);
    return { kind: 'declined', code: saveAnswer.kind };
  }

  let savePayload: unknown;
  try {
    savePayload = JSON.parse(saveAnswer.plaintext);
  } catch {
    await cancelQuietly(broker, resultConn.connectionId);
    return { kind: 'declined', code: 'invalid_message' };
  }
  if (!isSecretEditSave(savePayload)) {
    await cancelQuietly(broker, resultConn.connectionId);
    return { kind: 'declined', code: 'cancelled' };
  }

  const knownNames = new Set(params.vars.map((v) => v.name));
  const edits: Record<string, string> = {};
  let sessionBroken = false;
  for (const sealed of savePayload.edits) {
    if (!knownNames.has(sealed.name) || sealed.name in edits) {
      sessionBroken = true;
      break;
    }
    const opened = openEditValue(sessionKey, { iv: sealed.iv, ct: sealed.ct });
    if (opened === null) {
      sessionBroken = true;
      break;
    }
    edits[sealed.name] = opened;
  }

  // --- result leg ---
  const resultPageKey = await broker.awaitPagePubkey(resultConn, { deadlineMs });
  if (resultPageKey.kind !== 'ready') {
    debug(`[keep-screens] secret-edit: result page never attached (${resultPageKey.kind})`);
    return { kind: 'declined', code: resultPageKey.kind };
  }

  if (sessionBroken || Object.keys(edits).length === 0) {
    await broker.sendRequest(resultConn, resultPageKey.pagePubkeyB64, JSON.stringify(errorPayload('bad_session')));
    return { kind: 'declined', code: 'bad_session' };
  }

  const applied = await params.applyEdits(edits, savePayload.keep_hash);
  if (!applied.ok) {
    await broker.sendRequest(resultConn, resultPageKey.pagePubkeyB64, JSON.stringify(errorPayload('stale_version')));
    return { kind: 'declined', code: 'stale_version' };
  }

  const result: SecretEditSaveResult = {
    kind: 'save',
    v: 1,
    ok: true,
    keep_hash: applied.keepHash,
  };
  await broker.sendRequest(resultConn, resultPageKey.pagePubkeyB64, JSON.stringify(result));

  return { kind: 'saved' };
}

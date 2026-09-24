/** Keep-hosted secret editing, with values sealed under this CLI's K_local. */
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { readLocalRoot } from '../config/globalConfig';
import { BrokerClient, type BrokerConnection } from '../service/brokerClient';
import { deriveEditSessionKey, openEditValue, sealEditValue } from '../service/editSessionCrypto';
import { relayUrl } from '../auth/deviceKey/brokerCeremonyTransport';
import { keepFlowUrl } from './screens/keepScreens';
import { debug } from './debug';
import {
  isSecretEditSave,
  type SecretEditError,
  type SecretEditErrorCode,
  type SecretEditRequest,
  type SecretEditSaveResult,
  type SecretEditSealedValue,
  SECRET_EDIT_SCREEN,
} from './secretEditWire';

export interface SecretEditKeepParams {
  readonly serviceApiUrl: string;
  readonly getToken: () => string | null | Promise<string | null>;
  readonly userId: string;
  readonly orgId: string;
  readonly projectName: string;
  readonly branchName: string;
  readonly machineName?: string;
  /** Current plaintext, in-process only — never logged or printed. */
  readonly vars: readonly { readonly name: string; readonly value: string }[];
  /** CAS baseline this request was built against. */
  readonly keepHash: string;
  readonly applyEdits: (
    edits: Record<string, string>,
    expectedKeepHash: string,
  ) => Promise<{ readonly ok: true; readonly keepHash: string } | { readonly ok: false; readonly code: 'stale_version' }>;
  readonly deadlineMs?: number;
}

export type SecretEditKeepOutcome =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'declined'; readonly code: string }
  | { readonly kind: 'saved' };

const DEFAULT_DEADLINE_MS = 900_000;

const errorPayload = (code: SecretEditErrorCode, detail?: string): SecretEditError =>
  detail === undefined ? { kind: 'error', v: 1, code } : { kind: 'error', v: 1, code, detail };

const valueAAD = (
  flowId: string,
  userId: string,
  orgId: string,
  direction: 'cli-to-browser' | 'browser-to-cli',
  name: string,
  keepHash: string,
): string => JSON.stringify(['capy/secret-edit', flowId, userId, orgId, direction, name, keepHash]);

async function cancelQuietly(broker: BrokerClient, connectionId: string): Promise<void> {
  try {
    await broker.cancel(connectionId);
  } catch {
    // Best effort: cancellation cannot alter the user-visible outcome.
  }
}

interface EditConnections {
  readonly unlock: BrokerConnection;
  readonly values: BrokerConnection;
  readonly result: BrokerConnection;
}

async function createEditConnections(broker: BrokerClient, machineName: string): Promise<EditConnections | null> {
  try {
    const [unlock, values, result] = await Promise.all([
      broker.createConnection({ purpose: SECRET_EDIT_SCREEN, machineName, ttlSeconds: 900 }),
      broker.createConnection({ purpose: SECRET_EDIT_SCREEN, machineName, ttlSeconds: 900 }),
      broker.createConnection({ purpose: SECRET_EDIT_SCREEN, machineName, ttlSeconds: 900 }),
    ]);
    return { unlock, values, result };
  } catch {
    return null;
  }
}

function parseJsonSafe(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function openEdits(
  sessionKey: Buffer,
  sealedEdits: readonly SecretEditSealedValue[],
  knownNames: ReadonlySet<string>,
  flowId: string,
  userId: string,
  orgId: string,
  keepHash: string,
): Record<string, string> | null {
  const names = sealedEdits.map((sealed) => sealed.name);
  if (names.some((name, index) => !knownNames.has(name) || names.indexOf(name) !== index)) return null;
  const opened = sealedEdits.map((sealed) => [
    sealed.name,
    openEditValue(
      sessionKey,
      sealed,
      valueAAD(flowId, userId, orgId, 'browser-to-cli', sealed.name, keepHash),
    ),
  ] as const);
  return opened.some(([, value]) => value === null)
    ? null
    : Object.fromEntries(opened as readonly (readonly [string, string])[]);
}

export async function runSecretEditViaKeep(params: SecretEditKeepParams): Promise<SecretEditKeepOutcome> {
  // This path must use the established root for this exact account and org.
  // It deliberately never calls a minting helper: a missing root must not
  // create a value the browser cannot recover.
  const kLocal = readLocalRoot(params.orgId, params.userId);
  if (!kLocal) return { kind: 'declined', code: 'missing_local_root' };

  const broker = new BrokerClient(params.serviceApiUrl, params.getToken);
  const deadlineMs = params.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const machineName = params.machineName ?? hostname();
  const conns = await createEditConnections(broker, machineName);
  if (!conns) {
    debug('[keep-screens] secret-edit: broker unavailable, falling back to loopback');
    return { kind: 'unavailable' };
  }

  const { unlock: unlockConn, values: valuesConn, result: resultConn } = conns;
  const flowId = unlockConn.connectionId;
  const flowSecret = randomBytes(32).toString('base64');
  const sessionKey = deriveEditSessionKey(kLocal, flowSecret);
  const request: SecretEditRequest = {
    kind: 'edit_request',
    v: 1,
    flow_id: flowId,
    user_id: params.userId,
    org_id: params.orgId,
    flow_secret: flowSecret,
    project_name: params.projectName,
    branch_name: params.branchName,
    machine: machineName,
    vars: params.vars.map(({ name }) => ({ name, state: 'locked' })),
    values: params.vars.map(({ name, value }) => {
      const aad = valueAAD(flowId, params.userId, params.orgId, 'cli-to-browser', name, params.keepHash);
      return { name, ...sealEditValue(sessionKey, value, aad) };
    }),
    keep_hash: params.keepHash,
    values_connection_id: valuesConn.connectionId,
    result_connection_id: resultConn.connectionId,
  };

  const url = keepFlowUrl(SECRET_EDIT_SCREEN, flowId);
  relayUrl('Edit secrets in your browser (values never touch this terminal or the AI):', url, 'edit');

  const unlockPageKey = await broker.awaitPagePubkey(unlockConn, { deadlineMs });
  if (unlockPageKey.kind !== 'ready') {
    await Promise.all([
      cancelQuietly(broker, unlockConn.connectionId),
      cancelQuietly(broker, valuesConn.connectionId),
      cancelQuietly(broker, resultConn.connectionId),
    ]);
    return { kind: 'declined', code: 'transport_unavailable' };
  }
  const sentRequest = await broker.sendRequest(unlockConn, unlockPageKey.pagePubkeyB64, JSON.stringify(request));
  if (sentRequest.kind !== 'sent') {
    await Promise.all([
      cancelQuietly(broker, unlockConn.connectionId),
      cancelQuietly(broker, valuesConn.connectionId),
      cancelQuietly(broker, resultConn.connectionId),
    ]);
    return { kind: 'declined', code: 'transport_unavailable' };
  }

  // The page attaches the values connection when Save is clicked and posts
  // its one answer there. No unlock answer and no PRF/key courier exists.
  const saveAnswer = await broker.awaitAnswer(valuesConn, { deadlineMs });
  if (saveAnswer.kind !== 'answered') {
    await Promise.all([
      cancelQuietly(broker, unlockConn.connectionId),
      cancelQuietly(broker, resultConn.connectionId),
    ]);
    return { kind: 'declined', code: saveAnswer.kind };
  }
  // Keep the encrypted request readable until expiry so the browser can reload.
  const savePayload = parseJsonSafe(saveAnswer.plaintext);
  const resultPageKey = await broker.awaitPagePubkey(resultConn, { deadlineMs });
  if (resultPageKey.kind !== 'ready') return { kind: 'declined', code: resultPageKey.kind };
  const sendResult = (payload: SecretEditError | SecretEditSaveResult) =>
    broker.sendRequest(resultConn, resultPageKey.pagePubkeyB64, JSON.stringify(payload));

  if (savePayload === null || !isSecretEditSave(savePayload)) {
    await sendResult(errorPayload('bad_session'));
    return { kind: 'declined', code: savePayload === null ? 'invalid_message' : 'cancelled' };
  }
  if (savePayload.keep_hash !== params.keepHash) {
    await sendResult(errorPayload('stale_version'));
    return { kind: 'declined', code: 'stale_version' };
  }

  const edits = openEdits(
    sessionKey,
    savePayload.edits,
    new Set(params.vars.map(({ name }) => name)),
    flowId,
    params.userId,
    params.orgId,
    params.keepHash,
  );
  if (edits === null || Object.keys(edits).length === 0) {
    await sendResult(errorPayload('bad_session'));
    return { kind: 'declined', code: 'bad_session' };
  }
  const applied = await params.applyEdits(edits, params.keepHash);
  if (!applied.ok) {
    await sendResult(errorPayload('stale_version'));
    return { kind: 'declined', code: 'stale_version' };
  }
  await sendResult({ kind: 'save', v: 1, ok: true, keep_hash: applied.keepHash });
  return { kind: 'saved' };
}

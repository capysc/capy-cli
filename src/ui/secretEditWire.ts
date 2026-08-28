/**
 * CAP-540 wire contract — CLI side. The exact mirror of keep-app's
 * `src/lib/flow/secretEditWire.ts`; both sides must agree byte-for-byte.
 * See that file's module doc for why this flow chains THREE broker
 * connections (`unlock`/`values`/`result`) rather than the single request/
 * answer round trip `payload-both` screens like secret-intake use — the
 * broker is single-send/single-answer per connection by contract
 * (`BrokerClient.sendRequest`'s `already_sent`, `awaitAnswer`'s terminal
 * `answered` -> `delivered`), and this flow needs five messages across two
 * directions.
 */

export const SECRET_EDIT_SCREEN = 'secret-edit';

export interface SecretEditRequestVar {
  name: string;
  state: 'locked';
}

export interface SecretEditPrfCandidate {
  credential_id: string;
  prf_salt: string;
}

/** Message 1 — CLI -> page, sent once as the `unlock` connection's request. */
export interface SecretEditRequest {
  kind: 'edit_request';
  v: 1;
  project_name: string;
  branch_name: string;
  machine: string | null;
  vars: SecretEditRequestVar[];
  keep_hash: string;
  prf: SecretEditPrfCandidate | null;
  unlock_kinds: Array<'passkey' | 'passphrase'>;
  /** Necessary transport addition — see module doc. */
  values_connection_id: string;
  result_connection_id: string;
}

/** Message 2 — page -> CLI, the `unlock` connection's answer on success. */
export interface SecretEditPrfCourier {
  kind: 'prf_courier';
  v: 1;
  prf_output: string;
  credential_id: string;
}

export interface SecretEditSealedValue {
  name: string;
  iv: string;
  ct: string;
}

/** Message 3 — CLI -> page, the `values` connection's request. */
export interface SecretEditSealedValues {
  kind: 'sealed_values';
  v: 1;
  values: SecretEditSealedValue[];
}

/** Message 4 — page -> CLI, the `values` connection's answer. */
export interface SecretEditSave {
  kind: 'save';
  v: 1;
  edits: SecretEditSealedValue[];
  keep_hash: string;
}

/** The `result` connection's request — see keep-app's identical type doc
 *  ("MULTIPLE SAVES") for `next_values_connection_id`/
 *  `next_result_connection_id`. */
export interface SecretEditSaveResult {
  kind: 'save';
  v: 1;
  ok: true;
  keep_hash: string;
  next_values_connection_id?: string;
  next_result_connection_id?: string;
}

/** Message 5 — either direction. */
export type SecretEditErrorCode =
  | 'cancelled'
  | 'no_credential'
  | 'wrong_passphrase'
  | 'network'
  | 'bad_session'
  | 'stale_version'
  | 'expired';

export interface SecretEditError {
  kind: 'error';
  v: 1;
  code: SecretEditErrorCode;
  detail?: string;
}

export function isSecretEditPrfCourier(value: unknown): value is SecretEditPrfCourier {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'prf_courier' &&
    (value as { v?: unknown }).v === 1 &&
    typeof (value as { prf_output?: unknown }).prf_output === 'string' &&
    typeof (value as { credential_id?: unknown }).credential_id === 'string'
  );
}

export function isSecretEditSave(value: unknown): value is SecretEditSave {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'save' &&
    (value as { v?: unknown }).v === 1 &&
    Array.isArray((value as { edits?: unknown }).edits) &&
    typeof (value as { keep_hash?: unknown }).keep_hash === 'string'
  );
}

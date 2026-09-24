/** The CLI half of Keep's three-connection secret-edit protocol. */
export const SECRET_EDIT_SCREEN = 'secret-edit';

export interface SecretEditRequestVar {
  readonly name: string;
  readonly state: 'locked';
}

export interface SecretEditSealedValue {
  readonly name: string;
  readonly iv: string;
  readonly ct: string;
}

/** CLI -> page on the URL (flow) connection. */
export interface SecretEditRequest {
  readonly kind: 'edit_request';
  readonly v: 1;
  readonly flow_id: string;
  readonly user_id: string;
  readonly org_id: string;
  /** Random 32-byte base64 HKDF salt. It is not K_local. */
  readonly flow_secret: string;
  readonly project_name: string;
  readonly branch_name: string;
  readonly machine: string | null;
  readonly vars: readonly SecretEditRequestVar[];
  readonly values: readonly SecretEditSealedValue[];
  readonly keep_hash: string;
  readonly values_connection_id: string;
  readonly result_connection_id: string;
}

/** Page -> CLI on the values connection. */
export interface SecretEditSave {
  readonly kind: 'save';
  readonly v: 1;
  readonly edits: readonly SecretEditSealedValue[];
  readonly keep_hash: string;
}

/** CLI -> page on the result connection. */
export interface SecretEditSaveResult {
  readonly kind: 'save';
  readonly v: 1;
  readonly ok: true;
  readonly keep_hash: string;
  readonly next_values_connection_id?: string;
  readonly next_result_connection_id?: string;
}

export type SecretEditErrorCode =
  | 'cancelled'
  | 'network'
  | 'bad_session'
  | 'stale_version'
  | 'expired';

export interface SecretEditError {
  readonly kind: 'error';
  readonly v: 1;
  readonly code: SecretEditErrorCode;
  readonly detail?: string;
}

export function isSecretEditSave(value: unknown): value is SecretEditSave {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { readonly kind?: unknown }).kind === 'save'
    && (value as { readonly v?: unknown }).v === 1
    && Array.isArray((value as { readonly edits?: unknown }).edits)
    && typeof (value as { readonly keep_hash?: unknown }).keep_hash === 'string'
  );
}

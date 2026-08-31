/**
 * Direction policy for the canonical sync corpus.
 *
 * This module deliberately does no I/O, encryption, or manifest merging. It
 * is the seam between billing-authoritative mode resolution and the existing
 * sync machinery. In particular, absence of `keep.lock` is never accepted as
 * evidence that an account is free: callers must supply a mode that the
 * service resolved from billing state.
 *
 * Paid mode is an explicit delegation result. That keeps the established
 * local-manifest/conflict corpus authoritative instead of accidentally
 * routing it through the simpler free policy.
 */

export type BillingResolvedSyncMode =
  | {
      readonly source: 'billing';
      readonly mode: 'free';
      readonly orgId: string;
      readonly projectId: string;
      readonly projectName: 'default';
      readonly branch: 'development';
    }
  | {
      readonly source: 'billing';
      readonly mode: 'paid';
      readonly orgId: string;
      readonly projectId: string;
      readonly branch: string;
    };

export interface CanonicalSyncFacts {
  readonly authority: BillingResolvedSyncMode;
  /** Exact repository-root `.env`; `.env.*` discovery is intentionally out of scope. */
  readonly rootEnv: {
    readonly exists: boolean;
    readonly variableNames: readonly string[];
  };
  /** Presence means the service returned the authoritative remote keep marker. */
  readonly remote: {
    readonly keepMarkerExists: boolean;
    readonly variableNames: readonly string[];
  };
}

export type CanonicalSyncDecision =
  | {
      readonly mode: 'paid';
      readonly action: 'delegate_paid_manifest';
      readonly localKeepLock: 'paid_manifest_authority';
    }
  | {
      readonly mode: 'free';
      readonly action: 'fetch_remote';
      readonly localKeepLock: 'forbidden';
      readonly localEnv: 'replace_from_remote';
      readonly remoteVariableNames: readonly string[];
    }
  | {
      readonly mode: 'free';
      readonly action: 'push_root_env';
      readonly localKeepLock: 'forbidden';
      readonly localEnv: 'encrypt_after_push';
      readonly localVariableNames: readonly string[];
    }
  | {
      readonly mode: 'free';
      readonly action: 'create_empty_remote_marker';
      readonly localKeepLock: 'forbidden';
      readonly localEnv: 'leave_absent';
      readonly message: 'No .env found';
    };

/**
 * Select the one allowed canonical-sync direction from already-observed
 * facts. The executor that consumes this decision must use the existing
 * SyncEngine/service primitives; this is policy, not another sync engine.
 */
export function planCanonicalSync(facts: CanonicalSyncFacts): CanonicalSyncDecision {
  if (facts.authority.mode === 'paid') {
    return {
      mode: 'paid',
      action: 'delegate_paid_manifest',
      localKeepLock: 'paid_manifest_authority',
    };
  }

  if (facts.remote.keepMarkerExists) {
    return {
      mode: 'free',
      action: 'fetch_remote',
      localKeepLock: 'forbidden',
      localEnv: 'replace_from_remote',
      remoteVariableNames: [...facts.remote.variableNames],
    };
  }

  if (facts.rootEnv.exists) {
    return {
      mode: 'free',
      action: 'push_root_env',
      localKeepLock: 'forbidden',
      localEnv: 'encrypt_after_push',
      localVariableNames: [...facts.rootEnv.variableNames],
    };
  }

  return {
    mode: 'free',
    action: 'create_empty_remote_marker',
    localKeepLock: 'forbidden',
    localEnv: 'leave_absent',
    message: 'No .env found',
  };
}

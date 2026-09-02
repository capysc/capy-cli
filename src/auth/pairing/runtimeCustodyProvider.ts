/**
 * CAP-628 — secure-provider boundary for reboot-durable runtime pairing.
 *
 * This module is intentionally provider-agnostic. It does not make the
 * current grant daemon reboot-durable by itself, and nothing here persists
 * K_local. A provider is eligible for production wiring only after it passes
 * the custody conformance corpus and the standalone-binary packaging check.
 */
import { CapyError, ERROR_CODES } from '../../types/index';

export type RuntimeCustodyEnvironment = 'development' | 'staging' | 'production';

export type RuntimeCustodyProviderKind = 'os-secure-store' | 'orchestrator-secret-store';

export interface RuntimeCustodyProvider {
  readonly kind: RuntimeCustodyProviderKind;
  /**
   * Seal is same-user idempotent for one environment: repeated calls return
   * the same stable opaque handle and replace no independently owned entry.
   */
  seal(input: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
    readonly kLocal: Uint8Array;
  }): Promise<{ readonly opaqueHandle: string }>;
  unseal(input: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
    readonly opaqueHandle: string;
  }): Promise<Uint8Array>;
  /** Deletion is idempotent, including after an earlier delete or provider wipe. */
  delete(input: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
    readonly opaqueHandle: string;
  }): Promise<void>;
}

/** Resolve only an explicitly recorded provider kind; never infer one from a path or hostname. */
export type RuntimeCustodyProviderResolver = (
  kind: RuntimeCustodyProviderKind,
) => RuntimeCustodyProvider | null;

/**
 * The only provider-derived value that may enter runtime-pair metadata.
 * Environment and identity are duplicated outside the opaque handle so the
 * CLI can fail closed before asking a provider to unseal a tampered record.
 */
export interface RuntimeCustodyBinding {
  readonly providerKind: RuntimeCustodyProviderKind;
  readonly environment: RuntimeCustodyEnvironment;
  readonly userId: string;
  readonly opaqueHandle: string;
}

const K_LOCAL_BYTES = 32;

function custodyRefusal(message: string): CapyError {
  return new CapyError(message, ERROR_CODES.PERMISSION_DENIED);
}

function assertOpaqueHandle(opaqueHandle: string): void {
  if (opaqueHandle.length === 0) {
    throw custodyRefusal('The runtime custody provider returned an empty handle.');
  }
}

function assertBinding(
  provider: RuntimeCustodyProvider,
  binding: RuntimeCustodyBinding,
  expected: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
  },
): void {
  if (
    provider.kind !== binding.providerKind
    || binding.environment !== expected.environment
    || binding.userId !== expected.userId
  ) {
    throw custodyRefusal('The runtime custody binding does not match this environment and account.');
  }
  assertOpaqueHandle(binding.opaqueHandle);
}

/** Seal K_local and return metadata safe to persist in an ordinary file. */
export async function sealRuntimeCustody(
  provider: RuntimeCustodyProvider,
  input: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
    readonly kLocal: Uint8Array;
  },
): Promise<RuntimeCustodyBinding> {
  if (input.kLocal.byteLength !== K_LOCAL_BYTES) {
    throw custodyRefusal('Runtime custody requires exactly 32 bytes of key material.');
  }
  const sealed = await provider.seal({
    environment: input.environment,
    userId: input.userId,
    kLocal: Uint8Array.from(input.kLocal),
  });
  assertOpaqueHandle(sealed.opaqueHandle);
  return {
    providerKind: provider.kind,
    environment: input.environment,
    userId: input.userId,
    opaqueHandle: sealed.opaqueHandle,
  };
}

/**
 * Restore K_local through the selected provider. The provider still owns the
 * authoritative user/environment binding; these checks are defense in depth
 * for ordinary metadata tampering.
 */
export async function unsealRuntimeCustody(
  provider: RuntimeCustodyProvider,
  binding: RuntimeCustodyBinding,
  expected: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
  },
): Promise<Uint8Array> {
  assertBinding(provider, binding, expected);
  const kLocal = await provider.unseal({
    environment: expected.environment,
    userId: expected.userId,
    opaqueHandle: binding.opaqueHandle,
  });
  if (kLocal.byteLength !== K_LOCAL_BYTES) {
    throw custodyRefusal('The runtime custody provider returned invalid key material.');
  }
  return Uint8Array.from(kLocal);
}

/** Delete the provider entry after validating the ordinary metadata binding. */
export async function deleteRuntimeCustody(
  provider: RuntimeCustodyProvider,
  binding: RuntimeCustodyBinding,
  expected: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
  },
): Promise<void> {
  assertBinding(provider, binding, expected);
  await provider.delete({
    environment: expected.environment,
    userId: expected.userId,
    opaqueHandle: binding.opaqueHandle,
  });
}

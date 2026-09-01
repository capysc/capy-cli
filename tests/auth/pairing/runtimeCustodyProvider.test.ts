/**
 * CAP-628 provider-seam tests. This fake is deliberately process-memory-only:
 * it proves the binding contract, not reboot durability. A real provider must
 * run this behavior across a fresh packaged CLI process before it is wired.
 */
import { describe, expect, test } from 'bun:test';
import {
  deleteRuntimeCustody,
  sealRuntimeCustody,
  unsealRuntimeCustody,
  type RuntimeCustodyEnvironment,
  type RuntimeCustodyProvider,
} from '../../../src/auth/pairing/runtimeCustodyProvider';
import { ERROR_CODES } from '../../../src/types/index';

const USER_ID = 'user_runtime_custody';
const OTHER_USER_ID = 'user_runtime_custody_other';
const ENVIRONMENT: RuntimeCustodyEnvironment = 'development';
const OPAQUE_HANDLE = 'provider-entry-4d1349bd641b4ee59c44bdc52fc0b2e4';
const keyMaterial = (): Uint8Array => Uint8Array.from({ length: 32 }, () => 0x4d);

function createProvider(): RuntimeCustodyProvider {
  const lifecycle = new AbortController();
  const stored = keyMaterial();
  const assertRequest = (input: {
    readonly environment: RuntimeCustodyEnvironment;
    readonly userId: string;
    readonly opaqueHandle?: string;
  }): void => {
    if (
      lifecycle.signal.aborted
      || input.environment !== ENVIRONMENT
      || input.userId !== USER_ID
      || (input.opaqueHandle !== undefined && input.opaqueHandle !== OPAQUE_HANDLE)
    ) {
      throw Object.assign(new Error('custody binding refused'), { code: ERROR_CODES.PERMISSION_DENIED });
    }
  };
  return {
    kind: 'orchestrator-secret-store',
    async seal(input) {
      assertRequest(input);
      expect(input.kLocal).toEqual(stored);
      return { opaqueHandle: OPAQUE_HANDLE };
    },
    async unseal(input) {
      assertRequest(input);
      return Uint8Array.from(stored);
    },
    async delete(input) {
      assertRequest(input);
      lifecycle.abort();
    },
  };
}

describe('runtime custody provider boundary', () => {
  test('round trips only an opaque, identity-bound metadata handle', async () => {
    const provider = createProvider();
    const material = keyMaterial();
    const binding = await sealRuntimeCustody(provider, {
      environment: ENVIRONMENT,
      userId: USER_ID,
      kLocal: material,
    });

    expect(binding).toEqual({
      providerKind: 'orchestrator-secret-store',
      environment: ENVIRONMENT,
      userId: USER_ID,
      opaqueHandle: OPAQUE_HANDLE,
    });
    expect(JSON.stringify(binding)).not.toContain(Buffer.from(material).toString('base64'));
    expect(await unsealRuntimeCustody(provider, binding, {
      environment: ENVIRONMENT,
      userId: USER_ID,
    })).toEqual(material);
  });

  test('fails closed before provider unseal for wrong user, environment, or provider kind', async () => {
    const provider = createProvider();
    const binding = await sealRuntimeCustody(provider, {
      environment: ENVIRONMENT,
      userId: USER_ID,
      kLocal: keyMaterial(),
    });
    const wrongProvider: RuntimeCustodyProvider = { ...provider, kind: 'os-secure-store' };

    await expect(unsealRuntimeCustody(provider, binding, {
      environment: ENVIRONMENT,
      userId: OTHER_USER_ID,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    await expect(unsealRuntimeCustody(provider, binding, {
      environment: 'staging',
      userId: USER_ID,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    await expect(unsealRuntimeCustody(wrongProvider, binding, {
      environment: ENVIRONMENT,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
  });

  test('provider refuses a tampered handle and a deleted entry', async () => {
    const provider = createProvider();
    const binding = await sealRuntimeCustody(provider, {
      environment: ENVIRONMENT,
      userId: USER_ID,
      kLocal: keyMaterial(),
    });

    await expect(unsealRuntimeCustody(provider, {
      ...binding,
      opaqueHandle: `${binding.opaqueHandle}-tampered`,
    }, {
      environment: ENVIRONMENT,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });

    await deleteRuntimeCustody(provider, binding, {
      environment: ENVIRONMENT,
      userId: USER_ID,
    });
    await expect(unsealRuntimeCustody(provider, binding, {
      environment: ENVIRONMENT,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
  });

  test('rejects malformed provider output and invalid K_local length', async () => {
    const provider = createProvider();
    await expect(sealRuntimeCustody(provider, {
      environment: ENVIRONMENT,
      userId: USER_ID,
      kLocal: Uint8Array.from([1, 2, 3]),
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });

    const emptyHandleProvider: RuntimeCustodyProvider = {
      ...provider,
      async seal() {
        return { opaqueHandle: '' };
      },
    };
    await expect(sealRuntimeCustody(emptyHandleProvider, {
      environment: ENVIRONMENT,
      userId: USER_ID,
      kLocal: keyMaterial(),
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });

    const shortMaterialProvider: RuntimeCustodyProvider = {
      ...provider,
      async unseal() {
        return Uint8Array.from([1, 2, 3]);
      },
    };
    const binding = await sealRuntimeCustody(shortMaterialProvider, {
      environment: ENVIRONMENT,
      userId: USER_ID,
      kLocal: keyMaterial(),
    });
    await expect(unsealRuntimeCustody(shortMaterialProvider, binding, {
      environment: ENVIRONMENT,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
  });
});

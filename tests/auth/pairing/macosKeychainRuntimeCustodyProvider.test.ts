import { describe, expect, mock, test } from 'bun:test';
import {
  MACOS_SECURITY_EXECUTABLE,
  MACOS_SECURITY_INTERACTIVE_ARGV,
  MACOS_SECURITY_INTERACTIVE_MAX_STDIN_BYTES,
  createDevelopmentMacOSKeychainRuntimeCustodyProvider,
  type MacOSSecurityExecutor,
  type MacOSSecurityExecutorRequest,
  type MacOSSecurityExecutorResult,
} from '../../../src/auth/pairing/macosKeychainRuntimeCustodyProvider';
import { ERROR_CODES } from '../../../src/types/index';

const USER_ID = 'user_development_keychain';
const OTHER_USER_ID = 'user_development_keychain_other';
const HANDLE = 'stable_development_handle_4f7b95f0';
const WINNER_HANDLE = 'concurrent_winner_handle_883b91ac';
const KEYCHAIN_PATH = '/Users/test user/Library/Keychains/login.keychain-db';
const SHADOW_KEYCHAIN_PATH = '/Users/test/Library/Keychains/shadow.keychain-db';
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, index) => 0xff - index);
const NOT_FOUND: MacOSSecurityExecutorResult = {
  exitCode: 44,
  stdout: '',
  stderr: 'item not found',
};
const SUCCESS: MacOSSecurityExecutorResult = { exitCode: 0, stdout: '', stderr: '' };

type SecurityMock = ReturnType<typeof mock<MacOSSecurityExecutor>>;

interface FakeExecutorOptions {
  readonly initialItem?: string;
  readonly initialItems?: Readonly<Record<string, string>>;
  readonly duplicateItem?: string;
  readonly searchOrders?: ReadonlyArray<ReadonlyArray<string>>;
  readonly override?: (
    request: MacOSSecurityExecutorRequest,
    item: string | null,
  ) => MacOSSecurityExecutorResult | null;
}

function commandName(request: MacOSSecurityExecutorRequest): string {
  return request.stdin.trim().split(/\s+/)[0] ?? '';
}

function commandValue(request: MacOSSecurityExecutorRequest, option: string): string | null {
  const words = request.stdin.trim().split(/\s+/);
  const index = words.indexOf(option);
  return index === -1 ? null : words[index + 1] ?? null;
}

function explicitCommandKeychain(request: MacOSSecurityExecutorRequest): string | null {
  const match = request.stdin.trim().match(/("(?:\\.|[^"\\])*")$/);
  if (!match?.[1]) return null;
  return (() => {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  })();
}

function searchOrderAt(options: FakeExecutorOptions, callIndex: number): ReadonlyArray<string> {
  const orders = options.searchOrders ?? [[KEYCHAIN_PATH]];
  return orders[Math.min(callIndex, orders.length - 1)] ?? [KEYCHAIN_PATH];
}

function selectedKeychain(
  request: MacOSSecurityExecutorRequest,
  options: FakeExecutorOptions,
  callIndex: number,
): string | null {
  return explicitCommandKeychain(request) ?? searchOrderAt(options, callIndex)[0] ?? null;
}

function initialKeychainItems(options: FakeExecutorOptions): Readonly<Record<string, string>> {
  return {
    ...(options.initialItems ?? {}),
    ...(options.initialItem === undefined ? {} : { [KEYCHAIN_PATH]: options.initialItem }),
  };
}

function itemsBeforeCall(
  executor: SecurityMock,
  options: FakeExecutorOptions,
): Readonly<Record<string, string>> {
  return executor.mock.calls.slice(0, -1).reduce<Readonly<Record<string, string>>>(
    (items, [request], callIndex) => {
      const command = commandName(request);
      const keychain = selectedKeychain(request, options, callIndex);
      if (keychain === null) return items;
      if (command === 'add-generic-password' && items[keychain] === undefined) {
        const value = options.duplicateItem ?? commandValue(request, '-w');
        return value === null ? items : { ...items, [keychain]: value };
      }
      if (command === 'delete-generic-password' && items[keychain] !== undefined) {
        return Object.fromEntries(
          Object.entries(items).filter(([entryKeychain]) => entryKeychain !== keychain),
        );
      }
      return items;
    },
    initialKeychainItems(options),
  );
}

function itemForRequest(
  request: MacOSSecurityExecutorRequest,
  executor: SecurityMock,
  options: FakeExecutorOptions,
): string | null {
  const items = itemsBeforeCall(executor, options);
  const explicit = explicitCommandKeychain(request);
  if (explicit !== null) return items[explicit] ?? null;
  return searchOrderAt(options, executor.mock.calls.length - 1)
    .map((keychain) => items[keychain])
    .find((item) => item !== undefined) ?? null;
}

function createFakeExecutor(options: FakeExecutorOptions = {}): SecurityMock {
  const executor: SecurityMock = mock(async (request) => {
    const item = itemForRequest(request, executor, options);
    const overridden = options.override?.(request, item) ?? null;
    if (overridden !== null) return overridden;
    const command = commandName(request);
    if (command === 'find-generic-password') {
      return item === null ? NOT_FOUND : { ...SUCCESS, stdout: `${item}\n` };
    }
    if (command === 'add-generic-password') {
      return item === null && options.duplicateItem === undefined
        ? SUCCESS
        : { exitCode: 45, stdout: '', stderr: 'duplicate item' };
    }
    if (command === 'delete-generic-password') return item === null ? NOT_FOUND : SUCCESS;
    return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
  });
  return executor;
}

function createProvider(executor: MacOSSecurityExecutor) {
  return createDevelopmentMacOSKeychainRuntimeCustodyProvider({
    executor,
    keychainPath: KEYCHAIN_PATH,
    platform: 'darwin',
    randomHandle: () => HANDLE,
  });
}

function decodeStoredEnvelope(executor: SecurityMock): Readonly<Record<string, unknown>> {
  const addRequest = executor.mock.calls
    .map(([request]) => request)
    .find((request) => commandName(request) === 'add-generic-password');
  const encoded = addRequest ? commandValue(addRequest, '-w') : null;
  if (!encoded) throw new Error('expected one add command with an envelope');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Readonly<Record<string, unknown>>;
}

function encodedEnvelope(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('Development macOS Keychain runtime custody provider', () => {
  test('uses exact non-secret argv and transports the envelope only through bounded stdin', async () => {
    const executor = createFakeExecutor();
    const provider = createProvider(executor);

    expect(await provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY }))
      .toEqual({ opaqueHandle: HANDLE });

    const secretB64 = Buffer.from(KEY).toString('base64url');
    expect(executor).toHaveBeenCalledTimes(2);
    for (const [request] of executor.mock.calls) {
      expect(request.executable).toBe(MACOS_SECURITY_EXECUTABLE);
      expect(request.argv).toEqual(MACOS_SECURITY_INTERACTIVE_ARGV);
      expect(request.argv.join(' ')).not.toContain(secretB64);
      expect(Object.hasOwn(request, 'env')).toBe(false);
      expect(request.timeoutMs).toBe(5_000);
      expect(request.maxOutputBytes).toBe(8 * 1024);
      expect(request.stdin.endsWith('\n')).toBe(true);
    }
    const envelope = decodeStoredEnvelope(executor);
    expect(envelope).toEqual({
      version: 1,
      environment: 'development',
      userId: USER_ID,
      opaqueHandle: HANDLE,
      kLocalB64: secretB64,
    });
    expect(JSON.stringify(executor.mock.calls.map(([request]) => ({
      executable: request.executable,
      argv: request.argv,
    })))).not.toContain(secretB64);
  });

  test('round trips and returns one stable handle for same-user same-key seals', async () => {
    const executor = createFakeExecutor();
    const provider = createProvider(executor);
    const first = await provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY });
    const second = await provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY });

    expect(first).toEqual({ opaqueHandle: HANDLE });
    expect(second).toEqual(first);
    expect(await provider.unseal({
      environment: 'development',
      userId: USER_ID,
      opaqueHandle: HANDLE,
    })).toEqual(KEY);
    expect(executor.mock.calls.filter(([request]) => commandName(request) === 'add-generic-password'))
      .toHaveLength(1);
  });

  test('adopts an identical concurrent winner after an add reports a duplicate', async () => {
    const duplicateItem = encodedEnvelope({
      version: 1,
      environment: 'development',
      userId: USER_ID,
      opaqueHandle: WINNER_HANDLE,
      kLocalB64: Buffer.from(KEY).toString('base64url'),
    });
    const winnerExecutor = createFakeExecutor({ duplicateItem });
    const provider = createProvider(winnerExecutor);

    await expect(provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY }))
      .resolves.toEqual({ opaqueHandle: WINNER_HANDLE });
  });

  test('refuses a concurrent winner holding different key material', async () => {
    const duplicateItem = encodedEnvelope({
      version: 1,
      environment: 'development',
      userId: USER_ID,
      opaqueHandle: WINNER_HANDLE,
      kLocalB64: Buffer.from(OTHER_KEY).toString('base64url'),
    });
    const provider = createProvider(createFakeExecutor({ duplicateItem }));

    await expect(provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY }))
      .rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
  });

  test('refuses changed-key and different-user seals without adding or deleting anything', async () => {
    const executor = createFakeExecutor();
    const provider = createProvider(executor);
    await provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY });

    await expect(provider.seal({ environment: 'development', userId: USER_ID, kLocal: OTHER_KEY }))
      .rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    await expect(provider.seal({ environment: 'development', userId: OTHER_USER_ID, kLocal: KEY }))
      .rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(executor.mock.calls.filter(([request]) => commandName(request) === 'add-generic-password'))
      .toHaveLength(1);
    expect(executor.mock.calls.filter(([request]) => commandName(request) === 'delete-generic-password'))
      .toHaveLength(0);
  });

  test('refuses wrong environment and handle before revealing key material', async () => {
    const executor = createFakeExecutor();
    const provider = createProvider(executor);
    await provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY });
    const callCount = executor.mock.calls.length;

    await expect(provider.unseal({ environment: 'staging', userId: USER_ID, opaqueHandle: HANDLE }))
      .rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(executor.mock.calls).toHaveLength(callCount);
    await expect(provider.unseal({
      environment: 'development',
      userId: USER_ID,
      opaqueHandle: `${HANDLE}_tampered`,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    await expect(provider.unseal({
      environment: 'development',
      userId: OTHER_USER_ID,
      opaqueHandle: HANDLE,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    await expect(provider.delete({ environment: 'production', userId: USER_ID, opaqueHandle: HANDLE }))
      .rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
  });

  test('rejects invalid seal input before executor I/O', async () => {
    const executor = createFakeExecutor();
    const provider = createProvider(executor);

    await expect(provider.seal({
      environment: 'development',
      userId: '',
      kLocal: KEY,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    await expect(provider.seal({
      environment: 'development',
      userId: USER_ID,
      kLocal: Uint8Array.from([1, 2, 3]),
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    await expect(provider.seal({
      environment: 'development',
      userId: 'u'.repeat(513),
      kLocal: KEY,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(executor).not.toHaveBeenCalled();
  });

  test('refuses malformed, tampered, and non-32-byte stored envelopes', async () => {
    const cases = [
      'not_base64url!',
      encodedEnvelope({
        version: 2,
        environment: 'development',
        userId: USER_ID,
        opaqueHandle: HANDLE,
        kLocalB64: Buffer.from(KEY).toString('base64url'),
      }),
      encodedEnvelope({
        version: 1,
        environment: 'development',
        userId: USER_ID,
        opaqueHandle: HANDLE,
        kLocalB64: Buffer.from([1, 2, 3]).toString('base64url'),
      }),
      encodedEnvelope({
        version: 1,
        environment: 'development',
        userId: USER_ID,
        opaqueHandle: HANDLE,
        kLocalB64: Buffer.from(KEY).toString('base64url'),
        injected: true,
      }),
    ] as const;

    await Promise.all(cases.map(async (initialItem) => {
      const provider = createProvider(createFakeExecutor({ initialItem }));
      await expect(provider.unseal({
        environment: 'development',
        userId: USER_ID,
        opaqueHandle: HANDLE,
      })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    }));
  });

  test('delete is idempotent after deletion or provider wipe', async () => {
    const executor = createFakeExecutor();
    const provider = createProvider(executor);
    await provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY });
    const request = { environment: 'development' as const, userId: USER_ID, opaqueHandle: HANDLE };

    await provider.delete(request);
    await provider.delete(request);
    const deleteRequests = executor.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => commandName(entry) === 'delete-generic-password');
    expect(deleteRequests).toHaveLength(1);
    expect(deleteRequests[0]?.stdin).toBe(
      `delete-generic-password -a runtime-pair-v1 -s sc.capy.runtime-custody.v1.development "${KEYCHAIN_PATH}"\n`,
    );
    expect(deleteRequests[0]?.stdin).not.toContain(HANDLE);
    expect(deleteRequests[0]?.stdin).not.toContain(Buffer.from(KEY).toString('base64url'));
    await expect(provider.unseal(request)).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
  });

  test('wrong-binding delete refuses and preserves the exact singleton item', async () => {
    const executor = createFakeExecutor();
    const provider = createProvider(executor);
    await provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY });

    await expect(provider.delete({
      environment: 'development',
      userId: OTHER_USER_ID,
      opaqueHandle: HANDLE,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    await expect(provider.delete({
      environment: 'development',
      userId: USER_ID,
      opaqueHandle: `${HANDLE}_wrong`,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(executor.mock.calls.filter(([request]) => commandName(request) === 'delete-generic-password'))
      .toHaveLength(0);
    expect(await provider.unseal({
      environment: 'development',
      userId: USER_ID,
      opaqueHandle: HANDLE,
    })).toEqual(KEY);
  });

  test('pins every item operation to one explicit Keychain despite shadow items and search-order changes', async () => {
    const shadowItem = encodedEnvelope({
      version: 1,
      environment: 'development',
      userId: OTHER_USER_ID,
      opaqueHandle: WINNER_HANDLE,
      kLocalB64: Buffer.from(OTHER_KEY).toString('base64url'),
    });
    const executor = createFakeExecutor({
      initialItems: { [SHADOW_KEYCHAIN_PATH]: shadowItem },
      searchOrders: [
        [SHADOW_KEYCHAIN_PATH, KEYCHAIN_PATH],
        [KEYCHAIN_PATH, SHADOW_KEYCHAIN_PATH],
        [SHADOW_KEYCHAIN_PATH, KEYCHAIN_PATH],
      ],
    });
    const provider = createProvider(executor);

    expect(await provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY }))
      .toEqual({ opaqueHandle: HANDLE });
    expect(await provider.unseal({
      environment: 'development',
      userId: USER_ID,
      opaqueHandle: HANDLE,
    })).toEqual(KEY);
    expect(executor.mock.calls.map(([request]) => explicitCommandKeychain(request)))
      .toEqual(executor.mock.calls.map(() => KEYCHAIN_PATH));
    expect(executor.mock.calls.some(([request]) => request.stdin.includes(SHADOW_KEYCHAIN_PATH)))
      .toBe(false);
  });

  test('refuses a worst-case JSON-escaped envelope before crossing the interactive parser limit', async () => {
    const executor = createFakeExecutor();
    const provider = createProvider(executor);
    const worstCaseJsonEscapingUserId = '\u0000'.repeat(512);

    await expect(provider.seal({
      environment: 'development',
      userId: worstCaseJsonEscapingUserId,
      kLocal: KEY,
    })).rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(Buffer.byteLength(worstCaseJsonEscapingUserId, 'utf8')).toBe(512);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls.every(([request]) => (
      Buffer.byteLength(request.stdin, 'utf8') <= MACOS_SECURITY_INTERACTIVE_MAX_STDIN_BYTES
    ))).toBe(true);
    expect(executor.mock.calls.some(([request]) => request.stdin.includes(worstCaseJsonEscapingUserId)))
      .toBe(false);
  });

  test('refuses an invalid explicit Keychain path before executor I/O', async () => {
    const executor = createFakeExecutor();

    expect(() => createDevelopmentMacOSKeychainRuntimeCustodyProvider({
      executor,
      keychainPath: 'relative/login.keychain-db',
      platform: 'darwin',
      randomHandle: () => HANDLE,
    })).toThrow();
    expect(executor).not.toHaveBeenCalled();
  });

  test('derives one explicit login-Keychain path without touching Keychain at construction', async () => {
    const executor = createFakeExecutor();
    const provider = createDevelopmentMacOSKeychainRuntimeCustodyProvider({
      executor,
      platform: 'darwin',
      randomHandle: () => HANDLE,
    });

    expect(executor).not.toHaveBeenCalled();
    await provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY });
    const paths = executor.mock.calls.map(([request]) => explicitCommandKeychain(request));
    expect(paths.every((path) => path?.endsWith('/Library/Keychains/login.keychain-db') === true))
      .toBe(true);
    expect(new Set(paths).size).toBe(1);
  });

  test('executor failure, timeout, and oversized output stay generic and secret-free', async () => {
    const secretB64 = Buffer.from(KEY).toString('base64url');
    const failures = [
      createFakeExecutor({ override: () => ({ exitCode: null, stdout: '', stderr: secretB64, failure: 'timeout' }) }),
      createFakeExecutor({ override: (request) => ({
        exitCode: 0,
        stdout: 'x'.repeat(request.maxOutputBytes + 1),
        stderr: '',
      }) }),
      mock<MacOSSecurityExecutor>(async () => {
        throw new Error(secretB64);
      }),
    ] as const;

    await Promise.all(failures.map(async (executor) => {
      const provider = createProvider(executor);
      const error = await provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY })
        .then(() => null, (caught: unknown) => caught);
      expect(error).toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
      expect(String(error)).not.toContain(secretB64);
    }));
  });

  test('non-macOS construction stays inert and every operation fails before executor I/O', async () => {
    const executor = createFakeExecutor();
    const provider = createDevelopmentMacOSKeychainRuntimeCustodyProvider({
      executor,
      platform: 'linux',
      randomHandle: () => HANDLE,
    });

    expect(executor).not.toHaveBeenCalled();
    await expect(provider.seal({ environment: 'development', userId: USER_ID, kLocal: KEY }))
      .rejects.toMatchObject({ code: ERROR_CODES.PERMISSION_DENIED });
    expect(executor).not.toHaveBeenCalled();
  });
});

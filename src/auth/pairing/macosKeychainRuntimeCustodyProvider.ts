/**
 * Development-only macOS runtime custody backed by one default-user-Keychain item.
 *
 * The system `security` tool's direct process-argv `-w <secret>` form puts the
 * secret in argv, so this adapter never passes it there. Every invocation has
 * the same fixed, non-secret argv and receives one command through interactive
 * stdin. Key material can therefore cross only the child pipe, never argv,
 * environment, logs, errors, or ordinary Capy/workspace storage.
 *
 * This module is deliberately not a composition root. Merely importing it
 * does not start `security` or touch Keychain, and the provider remains inert
 * until a Development caller explicitly supplies it to runtime pairing.
 */
import { execFile } from 'child_process';
import { randomBytes, timingSafeEqual } from 'crypto';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { CapyError, ERROR_CODES } from '../../types/index';
import type {
  RuntimeCustodyEnvironment,
  RuntimeCustodyProvider,
} from './runtimeCustodyProvider';

export const MACOS_SECURITY_EXECUTABLE = '/usr/bin/security';
export const MACOS_SECURITY_INTERACTIVE_ARGV = ['-i', '-q', '-p', ''] as const;
/** Includes the terminating newline and stays strictly below 4096 bytes. */
export const MACOS_SECURITY_INTERACTIVE_MAX_STDIN_BYTES = 4_095;

const DEVELOPMENT_SERVICE = 'sc.capy.runtime-custody.v1.development';
const DEVELOPMENT_ACCOUNT = 'runtime-pair-v1';
const DEVELOPMENT_ITEM_KIND = 'capy-runtime-custody-v1';
const DEVELOPMENT_ITEM_LABEL = 'capy-development-runtime-pair';
const K_LOCAL_BYTES = 32;
const MAX_USER_ID_BYTES = 512;
const MAX_KEYCHAIN_PATH_BYTES = 1_024;
const PROVIDER_TIMEOUT_MS = 5_000;
const PROVIDER_MAX_OUTPUT_BYTES = 8 * 1024;
const ITEM_NOT_FOUND_EXIT_CODE = 44;
const DUPLICATE_ITEM_EXIT_CODE = 45;
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;

export interface MacOSSecurityExecutorRequest {
  readonly executable: typeof MACOS_SECURITY_EXECUTABLE;
  readonly argv: typeof MACOS_SECURITY_INTERACTIVE_ARGV;
  /** One command terminated by one newline. May contain the sealed envelope. */
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type MacOSSecurityExecutorFailure = 'spawn' | 'timeout' | 'output_limit';

export interface MacOSSecurityExecutorResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure?: MacOSSecurityExecutorFailure;
}

export type MacOSSecurityExecutor = (
  request: MacOSSecurityExecutorRequest,
) => Promise<MacOSSecurityExecutorResult>;

interface DevelopmentKeychainEnvelope {
  readonly version: 1;
  readonly environment: 'development';
  readonly userId: string;
  readonly opaqueHandle: string;
  readonly kLocalB64: string;
}

interface ProviderDependencies {
  readonly executor?: MacOSSecurityExecutor;
  readonly keychainPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly randomHandle?: () => string;
}

type ReadItemOutcome =
  | { readonly kind: 'missing' }
  | { readonly kind: 'found'; readonly envelope: DevelopmentKeychainEnvelope };

function providerRefusal(message: string): CapyError {
  return new CapyError(message, ERROR_CODES.PERMISSION_DENIED);
}

function genericProviderFailure(): CapyError {
  return providerRefusal('The macOS runtime custody provider was unavailable or refused the request.');
}

function failureKind(error: Error & { readonly code?: string | number; readonly killed?: boolean }):
  MacOSSecurityExecutorFailure | undefined {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output_limit';
  if (error.killed) return 'timeout';
  return typeof error.code === 'number' ? undefined : 'spawn';
}

/** Default runner. It is exported only so packaging tests can exercise it. */
export const executeMacOSSecurityCommand: MacOSSecurityExecutor = (request) => new Promise((resolve) => {
  const child = execFile(
    request.executable,
    [...request.argv],
    {
      encoding: 'utf8',
      timeout: request.timeoutMs,
      maxBuffer: request.maxOutputBytes,
      killSignal: 'SIGKILL',
      env: {
        HOME: homedir(),
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
      },
    },
    (error, stdout, stderr) => {
      const normalized = error as (Error & {
        readonly code?: string | number;
        readonly killed?: boolean;
      }) | null;
      resolve({
        exitCode: normalized === null
          ? 0
          : typeof normalized.code === 'number'
            ? normalized.code
            : null,
        stdout,
        stderr,
        ...(normalized === null || failureKind(normalized) === undefined
          ? {}
          : { failure: failureKind(normalized) }),
      });
    },
  );
  child.stdin?.once('error', () => undefined);
  child.stdin?.end(request.stdin);
});

function assertDevelopmentEnvironment(environment: RuntimeCustodyEnvironment): asserts environment is 'development' {
  if (environment !== 'development') {
    throw providerRefusal('The macOS Development custody provider cannot access another Capy environment.');
  }
}

function assertProviderPlatform(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') throw genericProviderFailure();
}

function byteLengthWithinLimit(value: string, limit: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= limit;
}

function validUserId(value: string): boolean {
  return value.length > 0 && byteLengthWithinLimit(value, MAX_USER_ID_BYTES);
}

function isMissingItem(result: MacOSSecurityExecutorResult): boolean {
  return result.failure === undefined && result.exitCode === ITEM_NOT_FOUND_EXIT_CODE;
}

function isDuplicateItem(result: MacOSSecurityExecutorResult): boolean {
  return result.failure === undefined && result.exitCode === DUPLICATE_ITEM_EXIT_CODE;
}

function assertBoundedResult(result: MacOSSecurityExecutorResult): void {
  if (
    result.failure !== undefined
    || !byteLengthWithinLimit(result.stdout, PROVIDER_MAX_OUTPUT_BYTES)
    || !byteLengthWithinLimit(result.stderr, PROVIDER_MAX_OUTPUT_BYTES)
  ) {
    throw genericProviderFailure();
  }
}

async function runSecurity(
  executor: MacOSSecurityExecutor,
  command: string,
): Promise<MacOSSecurityExecutorResult> {
  const stdin = `${command}\n`;
  if (!byteLengthWithinLimit(stdin, MACOS_SECURITY_INTERACTIVE_MAX_STDIN_BYTES)) {
    throw genericProviderFailure();
  }
  const outcome = await executor({
    executable: MACOS_SECURITY_EXECUTABLE,
    argv: MACOS_SECURITY_INTERACTIVE_ARGV,
    stdin,
    timeoutMs: PROVIDER_TIMEOUT_MS,
    maxOutputBytes: PROVIDER_MAX_OUTPUT_BYTES,
  }).then(
    (result) => ({ ok: true as const, result }),
    () => ({ ok: false as const }),
  );
  if (!outcome.ok) throw genericProviderFailure();
  assertBoundedResult(outcome.result);
  return outcome.result;
}

function decodeBase64Url(value: string): Buffer {
  if (!SAFE_TOKEN.test(value)) throw providerRefusal('The macOS runtime custody item was malformed.');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw providerRefusal('The macOS runtime custody item was malformed.');
  }
  return decoded;
}

function parseEnvelope(value: string): DevelopmentKeychainEnvelope {
  const parsed = (() => {
    try {
      return JSON.parse(decodeBase64Url(value).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof CapyError) throw error;
      throw providerRefusal('The macOS runtime custody item was malformed.');
    }
  })();
  if (typeof parsed !== 'object' || parsed === null) {
    throw providerRefusal('The macOS runtime custody item was malformed.');
  }
  const candidate = parsed as Readonly<Record<string, unknown>>;
  const expectedKeys = ['environment', 'kLocalB64', 'opaqueHandle', 'userId', 'version'] as const;
  const hasExactKeys = Object.keys(candidate).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(candidate, key));
  if (
    !hasExactKeys
    || candidate.version !== 1
    || candidate.environment !== 'development'
    || typeof candidate.userId !== 'string'
    || !validUserId(candidate.userId)
    || typeof candidate.opaqueHandle !== 'string'
    || !SAFE_TOKEN.test(candidate.opaqueHandle)
    || typeof candidate.kLocalB64 !== 'string'
  ) {
    throw providerRefusal('The macOS runtime custody item was malformed.');
  }
  const kLocal = decodeBase64Url(candidate.kLocalB64);
  if (kLocal.byteLength !== K_LOCAL_BYTES) {
    throw providerRefusal('The macOS runtime custody item was malformed.');
  }
  return {
    version: 1,
    environment: 'development',
    userId: candidate.userId,
    opaqueHandle: candidate.opaqueHandle,
    kLocalB64: candidate.kLocalB64,
  };
}

function encodeEnvelope(envelope: DevelopmentKeychainEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

function parseFindOutput(stdout: string): DevelopmentKeychainEnvelope {
  if (!/^[A-Za-z0-9_-]+\r?\n?$/.test(stdout)) {
    throw providerRefusal('The macOS runtime custody item was malformed.');
  }
  return parseEnvelope(stdout.replace(/\r?\n$/, ''));
}

function defaultDevelopmentKeychainPath(): string {
  return join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
}

function validatedKeychainPath(value: string): string {
  if (
    !isAbsolute(value)
    || /[\u0000-\u001f\u007f]/.test(value)
    || !byteLengthWithinLimit(value, MAX_KEYCHAIN_PATH_BYTES)
  ) {
    throw providerRefusal('The macOS runtime custody Keychain path was invalid.');
  }
  return resolve(value);
}

function keychainArgument(keychainPath: string): string {
  return JSON.stringify(keychainPath);
}

function findCommand(keychainPath: string): string {
  return [
    'find-generic-password',
    `-a ${DEVELOPMENT_ACCOUNT}`,
    `-s ${DEVELOPMENT_SERVICE}`,
    '-w',
    keychainArgument(keychainPath),
  ].join(' ');
}

function addCommand(envelope: DevelopmentKeychainEnvelope, keychainPath: string): string {
  return [
    'add-generic-password',
    `-a ${DEVELOPMENT_ACCOUNT}`,
    `-s ${DEVELOPMENT_SERVICE}`,
    `-D ${DEVELOPMENT_ITEM_KIND}`,
    `-l ${DEVELOPMENT_ITEM_LABEL}`,
    `-G ${envelope.opaqueHandle}`,
    `-T ${MACOS_SECURITY_EXECUTABLE}`,
    `-w ${encodeEnvelope(envelope)}`,
    keychainArgument(keychainPath),
  ].join(' ');
}

function deleteCommand(keychainPath: string): string {
  return [
    'delete-generic-password',
    `-a ${DEVELOPMENT_ACCOUNT}`,
    `-s ${DEVELOPMENT_SERVICE}`,
    keychainArgument(keychainPath),
  ].join(' ');
}

async function readItem(
  executor: MacOSSecurityExecutor,
  keychainPath: string,
): Promise<ReadItemOutcome> {
  const result = await runSecurity(executor, findCommand(keychainPath));
  if (isMissingItem(result)) return { kind: 'missing' };
  if (result.exitCode !== 0) throw genericProviderFailure();
  return { kind: 'found', envelope: parseFindOutput(result.stdout) };
}

function keyBytes(envelope: DevelopmentKeychainEnvelope): Buffer {
  return decodeBase64Url(envelope.kLocalB64);
}

function bindingMatches(
  envelope: DevelopmentKeychainEnvelope,
  expected: {
    readonly environment: 'development';
    readonly userId: string;
    readonly opaqueHandle?: string;
  },
): boolean {
  return envelope.environment === expected.environment
    && envelope.userId === expected.userId
    && (expected.opaqueHandle === undefined || envelope.opaqueHandle === expected.opaqueHandle);
}

function assertExistingSeal(
  envelope: DevelopmentKeychainEnvelope,
  userId: string,
  kLocal: Uint8Array,
): string {
  const expected = Buffer.from(kLocal);
  if (
    !bindingMatches(envelope, { environment: 'development', userId })
    || !timingSafeEqual(keyBytes(envelope), expected)
  ) {
    throw providerRefusal('The macOS runtime custody item belongs to another account or key.');
  }
  return envelope.opaqueHandle;
}

async function addOrAdoptItem(
  executor: MacOSSecurityExecutor,
  envelope: DevelopmentKeychainEnvelope,
  kLocal: Uint8Array,
  keychainPath: string,
): Promise<string> {
  const result = await runSecurity(executor, addCommand(envelope, keychainPath));
  if (result.exitCode === 0) return envelope.opaqueHandle;
  if (!isDuplicateItem(result)) throw genericProviderFailure();
  const winner = await readItem(executor, keychainPath);
  if (winner.kind === 'missing') throw genericProviderFailure();
  return assertExistingSeal(winner.envelope, envelope.userId, kLocal);
}

/**
 * Construct the inert Development provider. Tests inject a fake executor;
 * production wiring must explicitly select this only for a macOS Development
 * runtime. The default executor is never invoked by construction alone.
 */
export function createDevelopmentMacOSKeychainRuntimeCustodyProvider(
  dependencies: ProviderDependencies = {},
): RuntimeCustodyProvider {
  const executor = dependencies.executor ?? executeMacOSSecurityCommand;
  const keychainPath = validatedKeychainPath(
    dependencies.keychainPath ?? defaultDevelopmentKeychainPath(),
  );
  const platform = dependencies.platform ?? process.platform;
  const randomHandle = dependencies.randomHandle
    ?? (() => randomBytes(32).toString('base64url'));

  return {
    kind: 'os-secure-store',
    async seal(input) {
      assertProviderPlatform(platform);
      assertDevelopmentEnvironment(input.environment);
      if (!validUserId(input.userId) || input.kLocal.byteLength !== K_LOCAL_BYTES) {
        throw providerRefusal('The macOS runtime custody request was invalid.');
      }
      const existing = await readItem(executor, keychainPath);
      if (existing.kind === 'found') {
        return { opaqueHandle: assertExistingSeal(existing.envelope, input.userId, input.kLocal) };
      }
      const opaqueHandle = randomHandle();
      if (!SAFE_TOKEN.test(opaqueHandle)) {
        throw providerRefusal('The macOS runtime custody provider generated an invalid handle.');
      }
      const envelope: DevelopmentKeychainEnvelope = {
        version: 1,
        environment: 'development',
        userId: input.userId,
        opaqueHandle,
        kLocalB64: Buffer.from(input.kLocal).toString('base64url'),
      };
      return { opaqueHandle: await addOrAdoptItem(executor, envelope, input.kLocal, keychainPath) };
    },
    async unseal(input) {
      assertProviderPlatform(platform);
      assertDevelopmentEnvironment(input.environment);
      const existing = await readItem(executor, keychainPath);
      if (
        existing.kind === 'missing'
        || !bindingMatches(existing.envelope, {
          environment: 'development',
          userId: input.userId,
          opaqueHandle: input.opaqueHandle,
        })
      ) {
        throw providerRefusal('The macOS runtime custody binding was unavailable or did not match.');
      }
      return Uint8Array.from(keyBytes(existing.envelope));
    },
    async delete(input) {
      assertProviderPlatform(platform);
      assertDevelopmentEnvironment(input.environment);
      const existing = await readItem(executor, keychainPath);
      if (existing.kind === 'missing') return;
      if (!bindingMatches(existing.envelope, {
        environment: 'development',
        userId: input.userId,
        opaqueHandle: input.opaqueHandle,
      })) {
        throw providerRefusal('The macOS runtime custody binding did not match; the item was preserved.');
      }
      // account + service uniquely identify this singleton item. The opaque
      // handle was already validated from the sealed envelope; filtering the
      // delete by mutable Keychain metadata could falsely report success while
      // leaving an orphaned item if that metadata was tampered independently.
      const result = await runSecurity(executor, deleteCommand(keychainPath));
      if (result.exitCode !== 0 && !isMissingItem(result)) throw genericProviderFailure();
    },
  };
}

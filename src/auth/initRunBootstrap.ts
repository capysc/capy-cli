import { createHash } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import { AuthService, silentAuthFailureMessage } from './authService';
import {
  isInitRunOrigin,
  normalizeRepositoryFingerprint,
  parseInitRunAuthResult,
  parseInitRunContinueResponse,
  parseInitRunCreateResponse,
  parseInitRunExchangeResponse,
  sameInitRunBinding,
  type InitRunBinding,
  type InitRunCreateResponse,
  type InitRunStatusResponse,
  type InitRunTerminalReceipt,
} from './initRunContract';
import {
  initRunCliKeyFingerprint,
  mintInitRunDeliveryKeypair,
  openInitRunAuthResult,
  type InitRunDeliveryKeypair,
} from './initRunEnvelope';
import { generatePKCE, type PkcePair } from './pkce';
import { AuthResult, CapyError, ERROR_CODES } from '../types/index';

const MAX_RESPONSE_BYTES = 300 * 1024;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_EXCHANGE_NETWORK_FAILURES = 5;
const EXCHANGE_RETRY_AFTER_MS = 1000;
const MAX_RATE_LIMIT_RETRY_SECONDS = 60;

class InitRunRateLimitError extends CapyError {
  constructor(readonly retryAfterMs: number) {
    super('Hosted init request was rate limited', 'INIT_RUN_RATE_LIMITED');
  }
}

export interface InitRunBootstrapRequest {
  readonly serviceOrigin: string;
  readonly keepOrigin: string;
  readonly runtimeId: string;
  readonly repositoryFingerprint: string;
  readonly machineName: string;
  readonly expectedUserId: string | null;
}

export interface InitRunBootstrapHandoff {
  readonly runId: string;
  readonly entryUrl: string;
  readonly claimCode: string;
  readonly expiresAt: string;
}

export interface InitRunBootstrap {
  readonly request: Readonly<{
    serviceOrigin: string;
    keepOrigin: string;
    runtimeId: string;
    repositoryFingerprint: string;
    machineName: string;
    expectedUserId: string | null;
  }>;
  readonly response: InitRunCreateResponse;
  readonly handoff: InitRunBootstrapHandoff;
  readonly pkce: PkcePair;
  readonly deliveryKeypair: InitRunDeliveryKeypair;
  readonly cliKeyFingerprint: string;
}

export interface InitRunAuthorizedContext {
  readonly auth: AuthResult;
  readonly authService: AuthService;
  readonly binding: InitRunBinding;
  readonly authEpoch: number;
  readonly credentialReceipt: string;
  readonly brokerAccessToken: string;
  readonly runSecret: string;
  readonly expiresAt: string;
}

export interface InitRunBootstrapTransport {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly requestTimeoutMs?: number;
}

/**
 * Keep the exchange token only until the hosted workflow selects an
 * organization. From that point on the installed AuthService's current,
 * already-refreshed session is authoritative; broker delivery never starts
 * its own refresh and never falls back to the now-stale exchange token.
 */
export async function resolveInitRunBrokerAccessToken(
  authorized: InitRunAuthorizedContext,
  now: () => number = Date.now,
): Promise<string> {
  const organizationId = (() => {
    try {
      return authorized.authService.getOrganizationId();
    } catch {
      throw initRunFailure('INIT_DELIVERY_INDETERMINATE');
    }
  })();
  try {
    authorized.authService.assertRefreshAuthorityAvailable?.();
  } catch {
    throw initRunFailure('INIT_DELIVERY_INDETERMINATE');
  }
  const tokenExpiry = (value: string): number | null => {
    try {
      const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64').toString()) as Readonly<Record<string, unknown>>;
      return Number.isFinite(payload.exp) ? Number(payload.exp) * 1000 : null;
    } catch {
      return null;
    }
  };
  if (organizationId === null) {
    const expiry = tokenExpiry(authorized.brokerAccessToken);
    if (expiry !== null && expiry > now()) return authorized.brokerAccessToken;
  }
  const token = (() => {
    try {
      return authorized.authService.getToken();
    } catch {
      return null;
    }
  })();
  if (organizationId !== null && token
    && token.user_id === authorized.binding.subject_user_id
    && token.organization_id === organizationId
    && token.access_token.length > 0
    && Number.isFinite(token.expires_at)
    && token.expires_at > now()) {
    return token.access_token;
  }
  if (organizationId !== null) {
    const refreshed = await Promise.resolve().then(() => authorized.authService.refreshToken()).catch(() => false);
    const replacement = refreshed ? authorized.authService.getToken() : null;
    if (!replacement || replacement.user_id !== authorized.binding.subject_user_id
      || replacement.organization_id !== organizationId
      || !Number.isFinite(replacement.expires_at) || replacement.expires_at <= now()) {
      throw initRunFailure('INIT_DELIVERY_INDETERMINATE');
    }
    return replacement.access_token;
  }
  const renewed = await authorized.authService.renewInitRunIdentity({
    userId: authorized.binding.subject_user_id,
    deadline: Date.parse(authorized.expiresAt),
  }).catch(() => null);
  if (!renewed || renewed.auth.user_id !== authorized.binding.subject_user_id
    || renewed.authService.getOrganizationId() !== null
    || tokenExpiry(renewed.accessToken) === null
    || Number(tokenExpiry(renewed.accessToken)) <= now()) throw initRunFailure('INIT_DELIVERY_INDETERMINATE');
  return renewed.accessToken;
}

const defaultTransport: InitRunBootstrapTransport = {
  fetch,
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function initRunFailure(code: string): CapyError {
  return new CapyError('Hosted init authentication failed', code);
}

function exactJson(value: string): unknown {
  if (Buffer.byteLength(value, 'utf8') > MAX_RESPONSE_BYTES) {
    throw initRunFailure('INIT_RUN_INVALID');
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw initRunFailure('INIT_RUN_INVALID');
  }
}

function responseErrorCode(value: unknown): string {
  if (!value || typeof value !== 'object') return ERROR_CODES.SERVICE_ERROR;
  const code = (value as Readonly<Record<string, unknown>>).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code)
    ? code
    : ERROR_CODES.SERVICE_ERROR;
}

function isConfiguredInitRunOrigin(value: unknown): value is string {
  if (!isInitRunOrigin(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:'
    || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}

async function withRequestDeadline<T>(
  transport: InitRunBootstrapTransport,
  operationDeadline: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const requestDeadline = Math.min(
    operationDeadline,
    transport.now() + (transport.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
  );
  const remaining = requestDeadline - transport.now();
  if (remaining <= 0) throw initRunFailure(ERROR_CODES.NETWORK_ERROR);
  const operationAbort = new AbortController();
  const timerAbort = new AbortController();
  const timeout = delay(remaining, undefined, { signal: timerAbort.signal }).then(() => {
    operationAbort.abort();
    throw initRunFailure(ERROR_CODES.NETWORK_ERROR);
  });
  try {
    return await Promise.race([operation(operationAbort.signal), timeout]);
  } finally {
    timerAbort.abort();
  }
}

async function post(
  transport: InitRunBootstrapTransport,
  url: string,
  body: Readonly<Record<string, unknown>>,
  bearer?: string,
  operationDeadline = transport.now() + (transport.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
): Promise<unknown> {
  return withRequestDeadline(transport, operationDeadline, async (signal) => {
    const response = await transport.fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }).catch(() => {
      throw initRunFailure(ERROR_CODES.NETWORK_ERROR);
    });
    const text = await response.text().catch(() => {
      throw initRunFailure(ERROR_CODES.NETWORK_ERROR);
    });
    const parsed = exactJson(text);
    if (!response.ok) {
      const code = responseErrorCode(parsed);
      const retryAfter = response.headers.get('Retry-After');
      if (response.status === 429 && code === 'INIT_RUN_RATE_LIMITED'
        && retryAfter !== null && /^[1-9][0-9]{0,2}$/u.test(retryAfter)
        && Number(retryAfter) <= MAX_RATE_LIMIT_RETRY_SECONDS) {
        throw new InitRunRateLimitError(Number(retryAfter) * 1000);
      }
      throw initRunFailure(code);
    }
    return parsed;
  });
}

/** Only repeat-safe exchange/continuation calls opt into pre-handler throttling. */
async function postAfterRateLimit(
  transport: InitRunBootstrapTransport,
  url: string,
  body: Readonly<Record<string, unknown>>,
  bearer: string | undefined | (() => Promise<string>),
  operationDeadline: number,
): Promise<unknown> {
  if (transport.now() >= operationDeadline) throw initRunFailure('INIT_RUN_EXPIRED');
  const accessToken = typeof bearer === 'function' ? await bearer() : bearer;
  const attempt = await post(transport, url, body, accessToken, operationDeadline)
    .then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => {
      if (!(error instanceof InitRunRateLimitError)) throw error;
      return { ok: false as const, retryAfterMs: error.retryAfterMs };
    });
  if (attempt.ok) return attempt.value;
  const remaining = operationDeadline - transport.now();
  if (remaining <= 0) throw initRunFailure('INIT_RUN_EXPIRED');
  await transport.sleep(Math.min(attempt.retryAfterMs, remaining));
  return postAfterRateLimit(transport, url, body, bearer, operationDeadline);
}

function validateOrigins(input: InitRunBootstrapRequest): Readonly<{
  serviceOrigin: string;
  keepOrigin: string;
}> {
  if (!isConfiguredInitRunOrigin(input.serviceOrigin) || !isConfiguredInitRunOrigin(input.keepOrigin)) {
    throw initRunFailure('INIT_RUN_CONFIGURATION');
  }
  return { serviceOrigin: input.serviceOrigin, keepOrigin: input.keepOrigin };
}

export async function createInitRunBootstrap(
  input: InitRunBootstrapRequest,
  transport: InitRunBootstrapTransport = defaultTransport,
): Promise<InitRunBootstrap> {
  const origins = validateOrigins(input);
  const repositoryFingerprint = normalizeRepositoryFingerprint(input.repositoryFingerprint);
  if (!repositoryFingerprint) throw initRunFailure('INIT_RUN_INVALID');
  const pkce = generatePKCE();
  const deliveryKeypair = mintInitRunDeliveryKeypair();
  const cliKeyFingerprint = initRunCliKeyFingerprint(deliveryKeypair.publicKeyB64);
  if (!cliKeyFingerprint) throw initRunFailure('INIT_RUN_INVALID');
  const parsed = parseInitRunCreateResponse(await post(
    transport,
    `${origins.serviceOrigin}/init-runs`,
    {
      v: 1,
      pkce_method: 'S256',
      pkce_challenge: pkce.codeChallenge,
      cli_pubkey: deliveryKeypair.publicKeyB64,
      expected_user_id: input.expectedUserId,
      service_origin: origins.serviceOrigin,
      runtime_id: input.runtimeId,
      repository_fingerprint: repositoryFingerprint,
      machine_name: input.machineName,
    },
  ));
  if (!parsed || new URL(parsed.entry_url).origin !== origins.keepOrigin || Date.parse(parsed.expires_at) <= transport.now()) {
    throw initRunFailure('INIT_RUN_INVALID');
  }
  return {
    request: {
      serviceOrigin: origins.serviceOrigin,
      keepOrigin: origins.keepOrigin,
      runtimeId: input.runtimeId,
      repositoryFingerprint,
      machineName: input.machineName,
      expectedUserId: input.expectedUserId,
    },
    response: parsed,
    handoff: {
      runId: parsed.run_id,
      entryUrl: parsed.entry_url,
      claimCode: parsed.claim_code,
      expiresAt: parsed.expires_at,
    },
    pkce,
    deliveryKeypair,
    cliKeyFingerprint,
  };
}

function validateExchangeBinding(bootstrap: InitRunBootstrap, binding: InitRunBinding): void {
  const expectedSubjectMatches = bootstrap.request.expectedUserId === null
    || bootstrap.request.expectedUserId === binding.subject_user_id;
  if (
    binding.run_id !== bootstrap.response.run_id
    || binding.service_origin !== bootstrap.request.serviceOrigin
    || binding.runtime_id !== bootstrap.request.runtimeId
    || binding.repository_fingerprint !== bootstrap.request.repositoryFingerprint
    || binding.cli_key_fingerprint !== bootstrap.cliKeyFingerprint
    || !expectedSubjectMatches
  ) {
    throw initRunFailure('INIT_BINDING_MISMATCH');
  }
}

function credentialReceipt(sealedAuthResult: string): string {
  return `sha256:${createHash('sha256').update(sealedAuthResult, 'utf8').digest('hex')}`;
}

async function awaitExchange(
  bootstrap: InitRunBootstrap,
  transport: InitRunBootstrapTransport,
  networkFailures = 0,
): Promise<Exclude<ReturnType<typeof parseInitRunExchangeResponse>, null> & { readonly status: 'complete' }> {
  const expiresAt = Date.parse(bootstrap.response.expires_at);
  if (transport.now() >= expiresAt) {
    throw initRunFailure('INIT_RUN_EXPIRED');
  }
  const attempt = await (async () => {
    try {
      return {
        ok: true as const,
        value: await postAfterRateLimit(
          transport,
          `${bootstrap.request.serviceOrigin}/init-runs/${bootstrap.response.run_id}/exchange`,
          {
            v: 1,
            run_secret: bootstrap.response.run_secret,
            pkce_verifier: bootstrap.pkce.codeVerifier,
          },
          undefined,
          expiresAt,
        ),
      };
    } catch (error) {
      if (error instanceof CapyError && error.code === ERROR_CODES.NETWORK_ERROR) {
        return { ok: false as const, error };
      }
      throw error;
    }
  })();
  if (!attempt.ok) {
    if (networkFailures + 1 >= MAX_EXCHANGE_NETWORK_FAILURES) throw attempt.error;
    const remaining = expiresAt - transport.now();
    if (remaining <= 0) throw initRunFailure('INIT_RUN_EXPIRED');
    await transport.sleep(Math.min(EXCHANGE_RETRY_AFTER_MS, remaining));
    return awaitExchange(bootstrap, transport, networkFailures + 1);
  }
  const parsed = parseInitRunExchangeResponse(attempt.value);
  if (!parsed) throw initRunFailure('INIT_RUN_INVALID');
  if (parsed.status === 'pending') {
    const remaining = expiresAt - transport.now();
    if (remaining <= 0) throw initRunFailure('INIT_RUN_EXPIRED');
    await transport.sleep(Math.min(parsed.retry_after_ms, remaining));
    return awaitExchange(bootstrap, transport, 0);
  }
  return parsed;
}

function isAcknowledgedBinding(
  bootstrap: InitRunBootstrap,
  binding: InitRunBinding,
  authEpoch: number,
  status: Exclude<ReturnType<typeof parseInitRunContinueResponse>, null>,
  now: number,
): boolean {
  return status.status === 'authorized'
    && status.run_id === binding.run_id
    && status.expected_user_id === bootstrap.request.expectedUserId
    && status.subject_user_id === binding.subject_user_id
    && status.service_origin === binding.service_origin
    && status.runtime_id === binding.runtime_id
    && status.repository_fingerprint === binding.repository_fingerprint
    && status.cli_key_fingerprint === binding.cli_key_fingerprint
    && status.machine_name === bootstrap.request.machineName
    && status.entry_url === bootstrap.response.entry_url
    && status.auth_epoch === authEpoch
    && Date.parse(status.expires_at) > now
    && status.first_connection_id === null
    && status.terminal_receipt === null;
}

function sameRunProjection(
  bootstrap: InitRunBootstrap,
  authorized: InitRunAuthorizedContext,
  status: InitRunStatusResponse,
): boolean {
  return status.run_id === authorized.binding.run_id
    && status.expected_user_id === bootstrap.request.expectedUserId
    && status.subject_user_id === authorized.binding.subject_user_id
    && status.service_origin === authorized.binding.service_origin
    && status.runtime_id === authorized.binding.runtime_id
    && status.repository_fingerprint === authorized.binding.repository_fingerprint
    && status.cli_key_fingerprint === authorized.binding.cli_key_fingerprint
    && status.machine_name === bootstrap.request.machineName
    && status.entry_url === bootstrap.response.entry_url
    && status.auth_epoch === authorized.authEpoch;
}

function sameTerminalReceipt(
  left: InitRunTerminalReceipt | null,
  right: InitRunTerminalReceipt,
): boolean {
  return left !== null
    && left.v === right.v
    && left.run_id === right.run_id
    && left.receipt_id === right.receipt_id
    && left.status === right.status
    && left.code === right.code
    && left.repository_verified === right.repository_verified
    && left.custody_verified === right.custody_verified
    && left.effects === right.effects
    && left.completed_at === right.completed_at;
}

async function continueInitRun(
  bootstrap: InitRunBootstrap,
  authorized: InitRunAuthorizedContext,
  body: Readonly<Record<string, unknown>>,
  transport: InitRunBootstrapTransport,
  networkFailures = 0,
): Promise<InitRunStatusResponse> {
  const deadline = Date.parse(authorized.expiresAt);
  const attempt = await (async () => {
    try {
      return {
        ok: true as const,
        response: await postAfterRateLimit(
          transport,
          `${bootstrap.request.serviceOrigin}/init-runs/${bootstrap.response.run_id}/continue`,
          body,
          () => resolveInitRunBrokerAccessToken(authorized, transport.now),
          deadline,
        ),
      };
    } catch (error) {
      if (!(error instanceof CapyError) || error.code !== ERROR_CODES.NETWORK_ERROR) throw error;
      return { ok: false as const };
    }
  })();
  if (!attempt.ok) {
    if (networkFailures + 1 >= MAX_EXCHANGE_NETWORK_FAILURES || transport.now() >= deadline) {
      throw initRunFailure('INIT_DELIVERY_INDETERMINATE');
    }
    await transport.sleep(Math.min(EXCHANGE_RETRY_AFTER_MS, deadline - transport.now()));
    return continueInitRun(bootstrap, authorized, body, transport, networkFailures + 1);
  }
  const parsed = parseInitRunContinueResponse(attempt.response);
  if (!parsed || !sameRunProjection(bootstrap, authorized, parsed)) {
    throw initRunFailure('INIT_DELIVERY_INDETERMINATE');
  }
  return parsed;
}

/** Publish C0 only after it is owned by the authenticated run subject. */
export async function publishInitRunConnection(input: Readonly<{
  bootstrap: InitRunBootstrap;
  authorized: InitRunAuthorizedContext;
  firstConnectionId: string;
  transport?: InitRunBootstrapTransport;
}>): Promise<InitRunStatusResponse> {
  const status = await continueInitRun(input.bootstrap, input.authorized, {
    v: 1,
    action: 'publish',
    run_secret: input.authorized.runSecret,
    binding: input.authorized.binding,
    first_connection_id: input.firstConnectionId,
  }, input.transport ?? defaultTransport);
  if (status.status !== 'running' || status.first_connection_id !== input.firstConnectionId
    || status.terminal_receipt !== null) {
    throw initRunFailure('INIT_DELIVERY_INDETERMINATE');
  }
  return status;
}

/** Persist the authoritative receipt before attempting final browser delivery. */
export async function recordInitRunTerminal(input: Readonly<{
  bootstrap: InitRunBootstrap;
  authorized: InitRunAuthorizedContext;
  receipt: InitRunTerminalReceipt;
  transport?: InitRunBootstrapTransport;
}>): Promise<InitRunStatusResponse> {
  if (input.receipt.run_id !== input.authorized.binding.run_id) {
    throw initRunFailure('INIT_BINDING_MISMATCH');
  }
  const status = await continueInitRun(input.bootstrap, input.authorized, {
    v: 1,
    action: 'terminal',
    run_secret: input.authorized.runSecret,
    binding: input.authorized.binding,
    terminal_receipt: input.receipt,
  }, input.transport ?? defaultTransport);
  if (status.status !== 'terminal' || !sameTerminalReceipt(status.terminal_receipt, input.receipt)) {
    throw initRunFailure('INIT_DELIVERY_INDETERMINATE');
  }
  return status;
}

export async function completeInitRunAuthentication(
  input: Readonly<{
    bootstrap: InitRunBootstrap;
    authService: AuthService;
    transport?: InitRunBootstrapTransport;
  }>,
): Promise<InitRunAuthorizedContext> {
  const transport = input.transport ?? defaultTransport;
  const exchange = await awaitExchange(input.bootstrap, transport);
  if (transport.now() >= Date.parse(input.bootstrap.response.expires_at)) {
    throw initRunFailure('INIT_RUN_EXPIRED');
  }
  validateExchangeBinding(input.bootstrap, exchange.binding);
  if (credentialReceipt(exchange.sealed_auth_result) !== exchange.credential_receipt) {
    throw initRunFailure('INIT_BINDING_MISMATCH');
  }
  const opened = openInitRunAuthResult({
    sealedAuthResult: exchange.sealed_auth_result,
    binding: exchange.binding,
    keypair: input.bootstrap.deliveryKeypair,
  });
  if (!opened.ok) throw initRunFailure('INIT_BINDING_MISMATCH');
  const plaintext = (() => {
    try {
      return parseInitRunAuthResult(JSON.parse(opened.plaintext) as unknown);
    } catch {
      return null;
    }
  })();
  if (
    !plaintext
    || exchange.auth_epoch !== plaintext.auth_epoch
    || !sameInitRunBinding(exchange.binding, plaintext.binding)
    || plaintext.response.user.id !== exchange.binding.subject_user_id
  ) {
    throw initRunFailure('INIT_BINDING_MISMATCH');
  }
  const installed = await input.authService.installExchangeResponse(
    plaintext.response,
    { userId: exchange.binding.subject_user_id },
  );
  const auth = installed.auth;
  if (!auth.success || auth.user_id !== exchange.binding.subject_user_id) {
    throw initRunFailure(ERROR_CODES.AUTH_FAILED);
  }
  const acknowledged = await (async () => {
    try {
      return parseInitRunContinueResponse(await postAfterRateLimit(
        transport,
        `${input.bootstrap.request.serviceOrigin}/init-runs/${input.bootstrap.response.run_id}/continue`,
        {
          v: 1,
          action: 'acknowledge',
          run_secret: input.bootstrap.response.run_secret,
          binding: exchange.binding,
          credential_receipt: exchange.credential_receipt,
        },
        plaintext.broker_access_token,
        Date.parse(input.bootstrap.response.expires_at),
      ));
    } catch {
      throw initRunFailure('INIT_DELIVERY_INDETERMINATE');
    }
  })();
  if (!acknowledged || !isAcknowledgedBinding(
    input.bootstrap,
    exchange.binding,
    exchange.auth_epoch,
    acknowledged,
    transport.now(),
  )) {
    throw initRunFailure('INIT_DELIVERY_INDETERMINATE');
  }
  return {
    auth,
    authService: installed.authService,
    binding: exchange.binding,
    authEpoch: exchange.auth_epoch,
    credentialReceipt: exchange.credential_receipt,
    brokerAccessToken: plaintext.broker_access_token,
    runSecret: input.bootstrap.response.run_secret,
    expiresAt: acknowledged.expires_at,
  };
}

/** Use the installed CLI grant, with no second OAuth exchange or browser claim. */
export async function continueInitRunFromDeviceGrant(
  bootstrap: InitRunBootstrap,
  continuation: import('../commands/composedDeviceGrant').ComposedAuthenticatedContinuation,
): Promise<InitRunAuthorizedContext> {
  if (continuation.serviceOrigin !== bootstrap.request.serviceOrigin) throw initRunFailure('INIT_BINDING_MISMATCH');
  const authService = new AuthService(bootstrap.request.serviceOrigin, false, continuation.userId);
  const auth = await authService.authenticateSilent();
  const token = await authService.getValidToken();
  if (!auth.success || !token || auth.user_id !== continuation.userId || token.user_id !== continuation.userId) {
    console.error(`init-run: ${silentAuthFailureMessage(auth)}`);
    throw initRunFailure('INIT_BINDING_MISMATCH');
  }
  const status = parseInitRunContinueResponse(await post(defaultTransport,
    `${bootstrap.request.serviceOrigin}/init-runs/${bootstrap.response.run_id}/device-grant`,
    { run_secret: bootstrap.response.run_secret, authentication_flow_id: continuation.flowId }, token.access_token));
  const binding: InitRunBinding = {
    run_id: bootstrap.response.run_id, subject_user_id: continuation.userId,
    service_origin: bootstrap.request.serviceOrigin, runtime_id: bootstrap.request.runtimeId,
    repository_fingerprint: bootstrap.request.repositoryFingerprint, cli_key_fingerprint: bootstrap.cliKeyFingerprint,
  };
  validateExchangeBinding(bootstrap, binding);
  if (!status || !isAcknowledgedBinding(bootstrap, binding, status.auth_epoch, status, Date.now()))
    throw initRunFailure('INIT_BINDING_MISMATCH');
  return { auth, authService, binding, authEpoch: status.auth_epoch, credentialReceipt: '',
    brokerAccessToken: token.access_token, runSecret: bootstrap.response.run_secret, expiresAt: status.expires_at };
}

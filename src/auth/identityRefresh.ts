import { AuthResult, CapyError, SessionStore } from '../types/index';
import { createHash } from 'crypto';
import { decodeJwtPayload, resolveExpiresAt } from './session/lifecycle';

export const IDENTITY_REFRESH_INDETERMINATE = 'INIT_DELIVERY_INDETERMINATE';
export type IdentityRefreshResponse = Readonly<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: Readonly<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
  }>;
}>;

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
};
const token = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 262_144 && /^\S+$/u.test(value);
const text = (value: unknown, maximum: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= maximum;
const nullableText = (value: unknown): value is string | null => value === null || text(value, 255);

export function parseIdentityRefreshResponse(value: unknown): IdentityRefreshResponse | null {
  if (!record(value) || !exactKeys(value, ['access_token', 'refresh_token', 'expires_in', 'user'])
    || !token(value.access_token) || !token(value.refresh_token)
    || !Number.isSafeInteger(value.expires_in) || Number(value.expires_in) <= 0
    || !record(value.user) || !exactKeys(value.user, ['id', 'email', 'first_name', 'last_name'])
    || !text(value.user.id, 255) || !text(value.user.email, 320)
    || !nullableText(value.user.first_name) || !nullableText(value.user.last_name)) return null;
  return value as IdentityRefreshResponse;
}

const claims = (accessToken: string): Readonly<{ sub: string; orgId: string | null; exp: number }> | null => {
  try {
    const payload = decodeJwtPayload(accessToken) as Readonly<Record<string, unknown>>;
    const orgId = payload.org_id === undefined || payload.org_id === null
      ? null
      : text(payload.org_id, 255) ? payload.org_id : undefined;
    return text(payload.sub, 255) && typeof payload.exp === 'number'
      && Number.isSafeInteger(payload.exp) && payload.exp > 0 && orgId !== undefined
      ? { sub: payload.sub, orgId, exp: payload.exp }
      : null;
  } catch {
    return null;
  }
};

export type PreparedIdentityRefresh = Readonly<{
  session: SessionStore;
  auth: AuthResult;
  currentOrgId: string | null;
  accessToken: string;
}>;

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_MILLISECONDS = 15_000;
const MAX_CLEANUP_MILLISECONDS = 100;

type Captured<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; cause: unknown }>;
const capture = async <T>(run: () => Promise<T>): Promise<Captured<T>> => Promise.resolve().then(run)
  .then((value) => ({ ok: true, value }) as const)
  .catch((cause: unknown) => ({ ok: false, cause }) as const);

const indeterminate = (): CapyError => new CapyError(
  'Identity refresh response was not confirmed',
  IDENTITY_REFRESH_INDETERMINATE,
);

const scheduleBoundedCleanup = (run: () => Promise<unknown>, release?: () => void): void => {
  const settled = capture(run).then(() => undefined);
  const capped = Promise.withResolvers<void>();
  const timer = setTimeout(capped.resolve, MAX_CLEANUP_MILLISECONDS);
  void Promise.race([settled, capped.promise])
    .finally(() => {
      clearTimeout(timer);
      try { release?.(); } catch { /* best-effort release after bounded cancellation */ }
    })
    .catch(() => undefined);
};

const scheduleResponseCleanup = (response: Response): void => {
  const body = response.body;
  if (body) scheduleBoundedCleanup(() => body.cancel());
};

const readBody = async (
  response: Response,
  expired: Promise<never>,
  signal: AbortSignal,
): Promise<string> => {
  const body = response.body;
  if (!body) return '';
  const readerAttempt = await capture(() => Promise.resolve().then(() => body.getReader()));
  if (!readerAttempt.ok) {
    scheduleBoundedCleanup(() => body.cancel());
    throw readerAttempt.cause;
  }
  const reader = readerAttempt.value;
  const read = async (chunks: readonly Uint8Array[], size: number): Promise<readonly Uint8Array[]> => {
    const next = await Promise.race([Promise.resolve().then(() => reader.read()), expired]);
    if (next.done) return chunks;
    if (size + next.value.byteLength > MAX_RESPONSE_BYTES) {
      throw indeterminate();
    }
    return read([...chunks, next.value], size + next.value.byteLength);
  };
  const outcome = await capture(() => read([], 0));
  if (!outcome.ok) {
    scheduleBoundedCleanup(() => reader.cancel(), () => reader.releaseLock());
    throw outcome.cause;
  }
  try { reader.releaseLock(); } catch { /* the completed reader no longer gates response validation */ }
  if (signal.aborted) throw indeterminate();
  return Buffer.concat(outcome.value.map((chunk) => Buffer.from(chunk))).toString('utf8');
};

export async function requestIdentityRefresh(input: Readonly<{
  serviceOrigin: string;
  refreshToken: string;
  deadline: number;
  now?: () => number;
  fetch?: typeof fetch;
}>): Promise<IdentityRefreshResponse> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const remaining = input.deadline - startedAt;
  if (!Number.isFinite(input.deadline) || !Number.isFinite(startedAt)
    || !Number.isFinite(remaining) || remaining <= 0) {
    throw new CapyError('Hosted initialization expired', 'INIT_RUN_EXPIRED');
  }
  const controller = new AbortController();
  const expiry = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    controller.abort();
    expiry.reject(indeterminate());
  }, Math.max(1, Math.min(MAX_REQUEST_MILLISECONDS, remaining)));
  const attempted = await capture(async () => {
    const responseAttempt = Promise.resolve().then(() => (input.fetch ?? fetch)(
      `${input.serviceOrigin}/auth/refresh`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'identity', refresh_token: input.refreshToken }),
        signal: controller.signal,
      },
    )).then((response) => {
      if (controller.signal.aborted) {
        scheduleResponseCleanup(response);
        throw indeterminate();
      }
      return response;
    });
    const response = await Promise.race([responseAttempt, expiry.promise]);
    const body = await readBody(response, expiry.promise, controller.signal);
    const value = (() => { try { return JSON.parse(body) as unknown; } catch { return null; } })();
    if (!response.ok) {
      throw new CapyError('Identity refresh was refused', IDENTITY_REFRESH_INDETERMINATE);
    }
    const parsed = parseIdentityRefreshResponse(value);
    if (!parsed || controller.signal.aborted || now() >= input.deadline) throw indeterminate();
    return parsed;
  });
  clearTimeout(timer);
  if (!attempted.ok) throw indeterminate();
  return attempted.value;
}

export function currentIdentityAccessToken(
  session: SessionStore,
  expectedUserId: string,
  now: number,
): string | null {
  const identity = session.identity_session;
  if (!identity || identity.expires_at <= now) return null;
  const tokenClaims = claims(identity.access_token);
  return tokenClaims?.sub === expectedUserId && tokenClaims.exp * 1000 > now
    ? identity.access_token
    : null;
}

export function prepareIdentityRefresh(input: Readonly<{
  response: IdentityRefreshResponse;
  previous: SessionStore;
  currentOrgId: string | null;
  expectedUserId: string;
  now: number;
}>): PreparedIdentityRefresh {
  const tokenClaims = claims(input.response.access_token);
  const expiresAt = resolveExpiresAt(input.response.expires_in);
  const selected = input.currentOrgId === null
    ? null
    : input.previous.organizations.find((organization) => organization.id === input.currentOrgId) ?? null;
  if (input.previous.user_id !== input.expectedUserId
    || input.response.user.id !== input.expectedUserId
    || input.response.refresh_token === input.previous.refresh_token
    || !tokenClaims || tokenClaims.sub !== input.expectedUserId
    || tokenClaims.exp * 1000 <= input.now || !Number.isSafeInteger(expiresAt) || expiresAt <= input.now
    || (selected === null && input.currentOrgId !== null)
    || (selected !== null && tokenClaims.orgId !== null && tokenClaims.orgId !== selected.workos_org_id)) {
    throw new CapyError('Identity refresh authority was not confirmed', IDENTITY_REFRESH_INDETERMINATE);
  }
  const sessions = selected && tokenClaims.orgId === selected.workos_org_id
    ? {
      ...input.previous.sessions,
      [selected.id]: { access_token: input.response.access_token, expires_at: expiresAt },
    }
    : input.previous.sessions;
  const session: SessionStore = {
    ...input.previous,
    user_id: input.response.user.id,
    user_email: input.response.user.email,
    user_first_name: input.response.user.first_name,
    user_last_name: input.response.user.last_name,
    refresh_token: input.response.refresh_token,
    sessions,
    identity_session: {
      access_token: input.response.access_token,
      expires_at: expiresAt,
      root_authority_sha256: input.previous.identity_session?.root_authority_sha256
        ?? createHash('sha256').update(input.previous.refresh_token).digest('hex'),
    },
  };
  const auth: AuthResult = {
    success: true,
    organization_id: selected?.id ?? '',
    organization_name: selected?.name,
    user_id: input.response.user.id,
    user_email: input.response.user.email,
    user_first_name: input.response.user.first_name,
    user_last_name: input.response.user.last_name,
    organizations: input.previous.organizations,
    ...(selected ? {} : {
      _refresh_token: input.response.refresh_token,
      _orgless_access_token: input.response.access_token,
    }),
  };
  return { session, auth, currentOrgId: selected?.id ?? null, accessToken: input.response.access_token };
}

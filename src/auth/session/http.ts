import { beginRefreshRotationIfPresent } from './refreshContext';

/**
 * Auth-service HTTP transport helpers, shared by the interactive flows in
 * AuthService and the refresh path in SessionLifecycle. Moved verbatim from
 * authService.ts; authService re-exports HttpStatusError so `instanceof`
 * checks and existing imports keep working unchanged.
 */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly body: any;
  constructor(message: string, status: number, body?: any) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
    this.body = body;
  }
}

const authErrorMessages: Readonly<Record<string, string>> = {
  AUTH_ORGANIZATION_ACCESS_DENIED: 'You are unable to access the credentials linked to this organization. Please ask the organization administrator for access.',
  AUTH_REFRESH_RETRY: 'Capy could not confirm your session refresh. Please retry shortly. If this continues, ask your agent to investigate the authentication service.',
  AUTH_IDENTITY_REFRESH_UNAVAILABLE: 'Capy could not refresh your sign-in because the authentication provider is temporarily unavailable. Please retry shortly.',
  AUTH_REFRESH_AUTHORITY_INDETERMINATE: 'Capy could not confirm that your refreshed session was saved. Ask your agent to recover your sign-in before retrying.',
};
export const authResponseErrorMessage = (data: unknown, status: number): string => {
  const payload = data !== null && typeof data === 'object' ? data as Readonly<Record<string, unknown>> : {};
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  const nested = payload.error !== null && typeof payload.error === 'object'
    ? payload.error as Readonly<Record<string, unknown>> : {};
  const returned = [payload.error, payload.message, nested.message].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  const message = returned ?? (code ? authErrorMessages[code] : undefined)
    ?? (status >= 500 ? 'The authentication service could not complete this request. Please retry shortly.' : 'Authentication could not be completed.');
  return `${message} (${code ?? `HTTP ${status}`})`;
};

export async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  beginRefreshRotationIfPresent();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = authResponseErrorMessage(data, res.status);
    throw new HttpStatusError(message, res.status, data);
  }
  return res.json() as Promise<T>;
}

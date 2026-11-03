import type { DeviceTokenExchange } from './deviceGrant';

type GrantToken = Readonly<DeviceTokenExchange['token']>;

/** Timing metadata only; the Service still verifies the JWT before authorizing use. */
const jwtDeadline = (accessToken: string | null): number | null => {
  if (!accessToken) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    const exp = payload !== null && typeof payload === 'object' && 'exp' in payload ? payload.exp : null;
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch { return null; }
};

/** Human confirmation consumes token lifetime; installation must never restart that clock. */
export const deviceGrantTokenAfterConfirmation = (
  token: GrantToken,
  receivedAt: number,
  now = Date.now(),
): GrantToken => {
  const lifetime = Number.isFinite(token.expires_in) && token.expires_in > 0 ? token.expires_in * 1000 : 0;
  const advertisedDeadline = Math.min(receivedAt, now) + lifetime;
  const deadline = Math.min(advertisedDeadline, jwtDeadline(token.access_token) ?? advertisedDeadline);
  return { ...token, expires_in: Math.max(0, Math.floor((deadline - now) / 1000)) };
};

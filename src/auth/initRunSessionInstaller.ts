import { createHash } from 'crypto';
import { AuthResult, CapyError, ERROR_CODES, Organization, SessionStore } from '../types/index';
import { decodeJwtPayload, resolveExpiresAt } from './session/lifecycle';
import type { AuthResponseWire } from './initRunContract';

export interface PreparedInitRunSessionInstallation {
  readonly session: SessionStore;
  readonly currentOrgId: string | null;
  readonly auth: AuthResult;
}

function accessTokenOrganizationId(
  accessToken: string,
  organizations: readonly Organization[],
): string | null {
  const workosOrgId = (() => {
    try {
      const payload = decodeJwtPayload(accessToken) as Readonly<Record<string, unknown>>;
      return typeof payload.org_id === 'string' ? payload.org_id : null;
    } catch {
      return null;
    }
  })();
  return workosOrgId
    ? organizations.find((organization) => organization.workos_org_id === workosOrgId)?.id ?? null
    : null;
}

function resolveOrganizationId(
  accessToken: string,
  organizations: readonly Organization[],
): string {
  const tokenOrganizationId = accessTokenOrganizationId(accessToken, organizations);
  return tokenOrganizationId
    ?? (organizations.length === 1 ? organizations[0].id : '');
}

export function prepareInitRunSessionInstallation(
  response: AuthResponseWire,
  expected: Readonly<{ userId: string }>,
): PreparedInitRunSessionInstallation {
  if (response.user.id !== expected.userId) {
    throw new CapyError('Authenticated user does not match the init run', ERROR_CODES.AUTH_FAILED);
  }
  const organizations = response.organizations.map((organization): Organization => {
    if (!['unminted', 'minting', 'minted'].includes(organization.key_state)) {
      throw new CapyError('Authenticated organization has an invalid key state', ERROR_CODES.AUTH_FAILED);
    }
    return {
      ...organization,
      key_state: organization.key_state as Organization['key_state'],
    };
  });
  const user = {
    ...response.user,
    first_name: response.user.first_name ?? null,
    last_name: response.user.last_name ?? null,
  };
  const resolvedOrgId = response.token.access_token
    ? resolveOrganizationId(response.token.access_token, organizations)
    : '';
  const sessions = response.token.access_token && resolvedOrgId
    ? {
      [resolvedOrgId]: {
        access_token: response.token.access_token,
        expires_at: resolveExpiresAt(response.token.expires_in),
      },
    }
    : {};
  const session: SessionStore = {
    version: 2,
    user_id: user.id,
    user_email: user.email,
    user_first_name: user.first_name,
    user_last_name: user.last_name,
    refresh_token: response.token.refresh_token,
    organizations,
    sessions,
  };
  const resolvedOrg = organizations.find((organization) => organization.id === resolvedOrgId);
  const orglessToken = response.token.access_token && !resolvedOrgId && organizations.length === 0
    ? response.token.access_token
    : undefined;
  const auth: AuthResult = response.token.access_token
    ? {
      success: true,
      organization_id: resolvedOrgId,
      organization_name: resolvedOrg?.name || organizations[0]?.name,
      user_id: user.id,
      user_email: user.email,
      user_first_name: user.first_name,
      user_last_name: user.last_name,
      organizations,
      ...(!resolvedOrgId ? { _refresh_token: response.token.refresh_token } : {}),
      ...(orglessToken ? { _orgless_access_token: orglessToken } : {}),
    }
    : {
      success: true,
      organization_id: '',
      user_id: user.id,
      user_email: user.email,
      user_first_name: user.first_name,
      user_last_name: user.last_name,
      organizations,
      _refresh_token: response.token.refresh_token,
    };
  return { session, currentOrgId: resolvedOrgId || null, auth };
}

export function initRunSessionAuthorityDigest(session: SessionStore | null): string | null {
  if (!session) return null;
  const authority = {
    version: session.version,
    user_id: session.user_id,
    user_email: session.user_email,
    user_first_name: session.user_first_name,
    user_last_name: session.user_last_name,
    refresh_token: session.refresh_token,
    organizations: session.organizations,
    sessions: Object.fromEntries(Object.entries(session.sessions).map(([organizationId, value]) => [
      organizationId,
      { access_token: value.access_token },
    ])),
    identity_session: session.identity_session ?? null,
  };
  return createHash('sha256').update(JSON.stringify(authority)).digest('hex');
}

export function refreshTokenAuthorityDigest(session: SessionStore | null): string | null {
  return session?.refresh_token
    ? createHash('sha256').update(session.refresh_token).digest('hex')
    : null;
}

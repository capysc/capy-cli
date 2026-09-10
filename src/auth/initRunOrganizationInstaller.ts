import { CapyError, Organization, SessionStore, type AuthResult } from '../types/index';
import { decodeJwtPayload } from './session/lifecycle';

export const INIT_RUN_ORG_NAME_TAKEN_PRE_REFRESH = 'AUTH_ORG_NAME_TAKEN_PRE_REFRESH';
export const INIT_RUN_ORGANIZATION_INDETERMINATE = 'INIT_DELIVERY_INDETERMINATE';

export type InitRunCreatedOrganizationResponse = Readonly<{
  id: string;
  workos_org_id: string;
  name: string;
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

export type PreparedInitRunOrganizationInstallation = Readonly<{
  organization: Organization;
  session: SessionStore;
  currentOrgId: string;
  auth: AuthResult;
}>;

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
};

const text = (value: unknown, maximum = 262_144): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const nullableText = (value: unknown): value is string | null => value === null || text(value, 255);
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const tokenText = (value: unknown): value is string => text(value) && /^\S+$/u.test(value);

export function parseInitRunCreatedOrganizationResponse(value: unknown): InitRunCreatedOrganizationResponse | null {
  if (!record(value) || !exactKeys(value, [
    'id', 'workos_org_id', 'name', 'access_token', 'refresh_token', 'expires_in', 'user',
  ])) return null;
  if (!uuid(value.id) || !tokenText(value.workos_org_id) || value.workos_org_id.length > 255 || !text(value.name, 100)
    || !tokenText(value.access_token) || !tokenText(value.refresh_token)
    || !Number.isInteger(value.expires_in) || Number(value.expires_in) <= 0
    || !record(value.user) || !exactKeys(value.user, ['id', 'email', 'first_name', 'last_name'])
    || !text(value.user.id, 255) || !text(value.user.email, 320)
    || !nullableText(value.user.first_name) || !nullableText(value.user.last_name)) return null;
  return value as InitRunCreatedOrganizationResponse;
}

const tokenClaims = (accessToken: string): Readonly<{ sub: string; orgId: string }> | null => {
  try {
    const payload = decodeJwtPayload(accessToken) as Readonly<Record<string, unknown>>;
    return text(payload.sub, 255) && text(payload.org_id, 255)
      ? { sub: payload.sub, orgId: payload.org_id }
      : null;
  } catch {
    return null;
  }
};

const indeterminate = (message: string): CapyError =>
  new CapyError(message, INIT_RUN_ORGANIZATION_INDETERMINATE);

export function prepareInitRunCreatedOrganizationInstallation(input: Readonly<{
  response: InitRunCreatedOrganizationResponse;
  expectedUserId: string;
  requestedName: string;
  previousSession: SessionStore;
  expiresAt: number;
  now: number;
}>): PreparedInitRunOrganizationInstallation {
  const requestedName = input.requestedName.trim();
  const response = input.response;
  const claims = tokenClaims(response.access_token);
  if (!tokenText(input.expectedUserId) || input.expectedUserId.length > 255
    || requestedName.length === 0 || requestedName.length > 100
    || response.name !== requestedName
    || input.previousSession.user_id !== input.expectedUserId
    || response.user.id !== input.expectedUserId
    || response.refresh_token === input.previousSession.refresh_token
    || !claims || claims.sub !== input.expectedUserId || claims.orgId !== response.workos_org_id
    || !Number.isFinite(input.expiresAt) || input.expiresAt <= input.now) {
    throw indeterminate('The created organization response did not match the hosted identity');
  }
  const duplicate = input.previousSession.organizations.some((organization) =>
    organization.id === response.id
    || organization.workos_org_id === response.workos_org_id
    || organization.name.toLowerCase() === response.name.toLowerCase());
  if (duplicate) throw indeterminate('The created organization was not unique');
  const organization: Organization = {
    id: response.id,
    workos_org_id: response.workos_org_id,
    name: response.name,
  };
  const organizations = [...input.previousSession.organizations, organization];
  const session: SessionStore = {
    version: 2,
    user_id: response.user.id,
    user_email: response.user.email,
    user_first_name: response.user.first_name,
    user_last_name: response.user.last_name,
    refresh_token: response.refresh_token,
    organizations,
    sessions: {
      ...input.previousSession.sessions,
      [organization.id]: { access_token: response.access_token, expires_at: input.expiresAt },
    },
  };
  const auth: AuthResult = {
    success: true,
    organization_id: organization.id,
    organization_name: organization.name,
    user_id: response.user.id,
    user_email: response.user.email,
    user_first_name: response.user.first_name,
    user_last_name: response.user.last_name,
    organizations,
  };
  return { organization, session, currentOrgId: organization.id, auth };
}

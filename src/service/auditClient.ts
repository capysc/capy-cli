import { CapyError, ERROR_CODES, ServiceToken } from '../types';
import { resolveActiveUrl } from '../config/profileConfig';
import { installProfileTlsTrust } from '../config/tlsBootstrap';

export const AUDIT_FILTERS = ['actor', 'actor_id', 'actor_name', 'actor_type', 'action', 'target', 'target_id', 'target_name', 'target_type'] as const;
export const AUDIT_SORTS = ['occurred_at', 'actor_id', 'actor_name', 'actor_type', 'action', 'target_id', 'target_name', 'target_type'] as const;
export type AuditSearch = Readonly<Partial<Record<typeof AUDIT_FILTERS[number], string>> & {
  sort?: typeof AUDIT_SORTS[number];
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
}>;

export interface AuditEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly actorName: string | null;
  readonly actorType: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string | null;
  readonly targetType: string;
  readonly metadata: unknown;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}
export interface AuditPage {
  readonly entries: readonly AuditEvent[];
  readonly next_cursor: string | null;
}

/** Bound to one organization for its entire lifetime; every request refreshes credentials. */
export function createAuditClient(
  organizationId: string,
  tokenProvider: () => Promise<ServiceToken | null>,
  apiUrl = resolveActiveUrl(false),
  fetchFn: typeof fetch = fetch,
): (search: AuditSearch, signal?: AbortSignal) => Promise<AuditPage> {
  installProfileTlsTrust();
  return async (search, signal) => {
    const token = await tokenProvider();
    if (!token) throw new CapyError('Sign in to view the audit log.', ERROR_CODES.AUTH_FAILED);
    const params = new URLSearchParams(Object.entries(search)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]): [string, string] => [key, String(value)]));
    const response = await fetchFn(`${apiUrl}/orgs/${encodeURIComponent(organizationId)}/audit?${params}`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    const body = await response.json() as AuditPage & { readonly error?: string };
    if (!response.ok) {
      throw new CapyError(body.error ?? 'Audit search failed',
        response.status === 403 ? ERROR_CODES.PERMISSION_DENIED
          : response.status === 401 ? ERROR_CODES.AUTH_FAILED : ERROR_CODES.SERVICE_ERROR);
    }
    return body;
  };
}

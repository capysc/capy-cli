/**
 * CAP-383 — a real (loopback) HTTP stub of the CAP-379 wrapper-storage
 * surface (`/wrappers*`) plus the org-scoped KMS routes (`/orgs/:orgId/wrap`,
 * `/orgs/:orgId/co-decrypt`), for regression tests that want to exercise the
 * REAL `ServiceClient` + `src/auth/deviceKey/serviceOps.ts` over the network
 * boundary — not the in-memory `FakeWrapperServer` CAP-380's own unit tests
 * use. Same spirit as `tests/auth/deviceKey/brokerCeremonyTransport.test.ts`
 * (Bun.serve, no mock.module, every request recorded).
 *
 * Enforces the same two server-side invariants CAP-379 documents so a
 * client-side conflict-rotation path (`uploadKeyEncRotating`) has something
 * real to rotate against:
 *   - at most one LIVE `wrapped_k_local` row per credential_id (409 WRAPPER_CONFLICT)
 *   - at most one LIVE `key_enc` row per org (409 WRAPPER_CONFLICT)
 * Deletion does NOT enforce the ≥1-verified-door invariant (CAP-379's own
 * job, proven against real Postgres in `integration-capy`'s store.pg.test.ts)
 * — this stub is honest about being a client-side regression fixture, not a
 * reimplementation of the server's transactional guarantees.
 *
 * KMS mock: deterministic reversible prefix scheme (same contract
 * `tests/auth/deviceKeyOnboarding.test.ts` pins), so a test can wrap in one
 * call and assert the exact ciphertext shape without a real KMS.
 *
 * Also implements the CAP-375 connection-broker surface (`POST /connections`,
 * `GET /connections/:id/result`, `DELETE /connections/:id`) so
 * `src/auth/deviceKey/brokerCeremonyTransport.ts` — CAP-382's real transport
 * — can run against this same fake service unmodified; pair with
 * `tests/helpers/fakeCeremonyPage.ts` to answer as a real page would (real
 * envelope crypto, via `tests/helpers/sealEnvelope.ts`).
 */
import { randomUUID } from 'crypto';

export interface WrapperRow {
  id: string;
  type: 'wrapped_k_local' | 'key_enc';
  credential_id: string | null;
  kdf_version: number;
  is_seed: boolean;
  verified_at: string | null;
  organization_id: string | null;
  created_at: string;
  deleted_at: string | null;
  mirror_state: 'pending' | 'mirrored' | 'diverged';
  wrapped_k_local?: string;
  iv?: string;
  prf_salt?: string;
  key_enc?: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

interface FailureInjection {
  matcher: (method: string, path: string) => boolean;
  status: number;
  body: unknown;
  remaining: number;
}

export const KMS_PREFIX = 'KMS1.';
export const kmsWrap = (plaintext: string) => KMS_PREFIX + plaintext;
export const kmsStrip = (ciphertext: string) => {
  if (!ciphertext.startsWith(KMS_PREFIX)) throw new Error('not KMS-wrapped');
  return ciphertext.slice(KMS_PREFIX.length);
};

/** Decode the org id this fake service cares about from a fake bearer token (see tests/helpers/fakeSession.ts). */
function orgFromAuth(auth: string | null): string | null {
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    const token = auth.slice('Bearer '.length);
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString('utf8'));
    return typeof payload.capy_org_id === 'string' ? payload.capy_org_id : null;
  } catch {
    return null;
  }
}

export interface FakeConnection {
  id: string;
  clientPubkeyB64: string;
  purpose: string;
  /** Pushed by a test's "page" answer; drained by the next GET /result poll. */
  resultQueue: Array<{ status: number; body: unknown }>;
  cancelled: boolean;
}

export interface FakeWrapperService {
  url: string;
  requests: RecordedRequest[];
  rows: WrapperRow[];
  connections: Map<string, FakeConnection>;
  /** Reject the next N requests matching `matcher` before falling through to normal handling. */
  failNext(matcher: (method: string, path: string) => boolean, opts: { status: number; body: unknown }, times?: number): void;
  /** Require a valid Authorization header on every /wrappers* route (401 otherwise). Off by default (matches how narrowly scoped most tests are). */
  requireAuth: boolean;
  /** Reject the next N POST /connections calls (e.g. to simulate EMAIL_NOT_VERIFIED). */
  failNextConnectionCreate(status: number, body: unknown, times?: number): void;
  close(): void;
}

export function startFakeWrapperService(): FakeWrapperService {
  const rows: WrapperRow[] = [];
  const requests: RecordedRequest[] = [];
  const failures: FailureInjection[] = [];
  const connectionFailures: FailureInjection[] = [];
  const connections = new Map<string, FakeConnection>();
  let nextId = 1;
  const state = { requireAuth: false };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get('authorization');
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      requests.push({ method: req.method, path: url.pathname + url.search, auth, body });

      const injected = failures.find((f) => f.matcher(req.method, url.pathname));
      if (injected) {
        injected.remaining -= 1;
        if (injected.remaining <= 0) failures.splice(failures.indexOf(injected), 1);
        // A transient HTTP failure (503, no recognized `code`) is the honest
        // stand-in for "offline"/network flakiness here: the client's retry
        // path (syncOrgKeyEnc's catch) branches on "is this a CapyError",
        // never on which failure produced it, so a genuine ECONNREFUSED and
        // this 503 are observably identical to the code under test. A raw
        // socket-level drop can't be simulated from inside a Bun.serve
        // handler without tearing the whole server down, which would also
        // kill every OTHER route the same test still needs.
        return Response.json(injected.body as any, { status: injected.status });
      }

      if (state.requireAuth && url.pathname.startsWith('/wrappers') && !auth) {
        return Response.json({ error: 'no token', code: 'AUTH_FAILED' }, { status: 401 });
      }

      // --- /connections (CAP-375 broker surface) ---
      if (req.method === 'POST' && url.pathname === '/connections') {
        const injectedConn = connectionFailures[0];
        if (injectedConn) {
          injectedConn.remaining -= 1;
          if (injectedConn.remaining <= 0) connectionFailures.shift();
          return Response.json(injectedConn.body as any, { status: injectedConn.status });
        }
        const b = body as any;
        const id = randomUUID();
        connections.set(id, {
          id,
          clientPubkeyB64: b.client_pubkey,
          purpose: b.purpose,
          resultQueue: [],
          cancelled: false,
        });
        return Response.json(
          { connection_id: id, status: 'pending', expires_at: new Date(Date.now() + (b.ttl_seconds ?? 600) * 1000).toISOString() },
          { status: 201 },
        );
      }
      const connResultMatch = url.pathname.match(/^\/connections\/([^/]+)\/result$/);
      if (req.method === 'GET' && connResultMatch) {
        const conn = connections.get(decodeURIComponent(connResultMatch[1]));
        if (!conn) return Response.json({ error: 'not found', code: 'CONNECTION_NOT_FOUND' }, { status: 404 });
        const next = conn.resultQueue.shift() ?? { status: 200, body: { status: 'pending' } };
        return Response.json(next.body as any, { status: next.status });
      }
      const connDeleteMatch = url.pathname.match(/^\/connections\/([^/]+)$/);
      if (req.method === 'DELETE' && connDeleteMatch) {
        const conn = connections.get(decodeURIComponent(connDeleteMatch[1]));
        if (conn) conn.cancelled = true;
        return Response.json({ status: 'cancelled' });
      }

      // --- /wrappers ---
      if (req.method === 'POST' && url.pathname === '/wrappers') {
        const b = body as any;
        if (b.type === 'wrapped_k_local') {
          const conflict = rows.some(
            (r) => !r.deleted_at && r.type === 'wrapped_k_local' && r.credential_id === b.credential_id,
          );
          if (conflict) return Response.json({ error: 'conflict', code: 'WRAPPER_CONFLICT' }, { status: 409 });
          const row: WrapperRow = {
            id: `w${nextId++}`,
            type: 'wrapped_k_local',
            credential_id: b.credential_id,
            kdf_version: b.kdf_version,
            is_seed: !rows.some((r) => !r.deleted_at && r.type === 'wrapped_k_local'),
            verified_at: null,
            organization_id: null,
            created_at: new Date().toISOString(),
            deleted_at: null,
            mirror_state: 'pending',
            wrapped_k_local: b.wrapped_k_local,
            iv: b.iv,
            prf_salt: b.prf_salt,
          };
          rows.push(row);
          return Response.json({ wrapper: metaOf(row) }, { status: 201 });
        }
        if (b.type === 'key_enc') {
          const orgId = orgFromAuth(auth);
          if (!orgId) return Response.json({ error: 'no org claim', code: 'AUTH_FAILED' }, { status: 401 });
          const conflict = rows.some((r) => !r.deleted_at && r.type === 'key_enc' && r.organization_id === orgId);
          if (conflict) return Response.json({ error: 'conflict', code: 'WRAPPER_CONFLICT' }, { status: 409 });
          const row: WrapperRow = {
            id: `w${nextId++}`,
            type: 'key_enc',
            credential_id: null,
            kdf_version: b.kdf_version ?? 1,
            is_seed: false,
            verified_at: null,
            organization_id: orgId,
            created_at: new Date().toISOString(),
            deleted_at: null,
            mirror_state: 'pending',
            key_enc: b.key_enc,
          };
          rows.push(row);
          return Response.json({ wrapper: metaOf(row) }, { status: 201 });
        }
        return Response.json({ error: 'bad type', code: 'INVALID_FORMAT' }, { status: 400 });
      }

      if (req.method === 'GET' && url.pathname === '/wrappers') {
        const includeDeleted = url.searchParams.get('include_deleted') === 'true';
        const visible = includeDeleted ? rows : rows.filter((r) => !r.deleted_at);
        return Response.json({ wrappers: visible.map(metaOf) });
      }

      const wrapperIdMatch = url.pathname.match(/^\/wrappers\/([^/]+)(\/verify)?$/);
      if (wrapperIdMatch) {
        const id = decodeURIComponent(wrapperIdMatch[1]);
        const isVerify = !!wrapperIdMatch[2];
        const row = rows.find((r) => r.id === id && !r.deleted_at);
        if (!row) return Response.json({ error: 'not found', code: 'WRAPPER_NOT_FOUND' }, { status: 404 });

        if (req.method === 'GET' && !isVerify) return Response.json({ wrapper: row });
        if (req.method === 'POST' && isVerify) {
          row.verified_at = new Date().toISOString();
          return Response.json({ wrapper: metaOf(row) });
        }
        if (req.method === 'DELETE' && !isVerify) {
          row.deleted_at = new Date().toISOString();
          return Response.json({ wrapper: metaOf(row) });
        }
      }

      // --- KMS mock: /orgs/:orgId/wrap, /orgs/:orgId/co-decrypt ---
      const wrapMatch = url.pathname.match(/^\/orgs\/([^/]+)\/wrap$/);
      if (req.method === 'POST' && wrapMatch) {
        const b = body as any;
        return Response.json({ ciphertext: kmsWrap(b.plaintext) });
      }
      const codecryptMatch = url.pathname.match(/^\/orgs\/([^/]+)\/co-decrypt$/);
      if (req.method === 'POST' && codecryptMatch) {
        const b = body as any;
        try {
          return Response.json({ plaintext: kmsStrip(b.ciphertext) });
        } catch {
          return Response.json({ error: 'bad ciphertext', code: 'INVALID_FORMAT' }, { status: 400 });
        }
      }

      return Response.json({ error: 'no route', code: 'NOT_FOUND' }, { status: 404 });
    },
  });

  function metaOf(row: WrapperRow): Record<string, unknown> {
    const { wrapped_k_local, iv, prf_salt, key_enc, ...meta } = row;
    return meta;
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    rows,
    connections,
    get requireAuth() {
      return state.requireAuth;
    },
    set requireAuth(v: boolean) {
      state.requireAuth = v;
    },
    failNext(matcher, opts, times = 1) {
      failures.push({ matcher, status: opts.status, body: opts.body, remaining: times });
    },
    failNextConnectionCreate(status, body, times = 1) {
      connectionFailures.push({ matcher: () => true, status, body, remaining: times });
    },
    close: () => server.stop(true),
  };
}

export { randomUUID };

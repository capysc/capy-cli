/**
 * CAP-566 — a real (loopback) HTTP stub of exactly the surface `capy pair`'s
 * e2e test needs, now that #328 rebuilt `capy pair` on the RFC 8628 device
 * grant instead of the CAP-403 anonymous bootstrap/poll ceremony:
 *
 *   - `POST /auth/device/authorize` / `POST /auth/device/token` — the two
 *     legs `src/auth/pairing/deviceAuth.ts` drives to authenticate the
 *     MACHINE itself. See that file's header for the exact wire shapes;
 *     `toAnswerSession()` there is the authoritative parser this stub's
 *     completion bodies must satisfy.
 *   - The AUTHENTICATED, owned connection-broker surface (`POST
 *     /connections`, `GET /connections/:id/result`, `DELETE
 *     /connections/:id`) that `src/auth/deviceKey/brokerCeremonyTransport.ts`
 *     drives for the CAP-384 grant ceremony `pairDeviceGrant.ts` now runs
 *     over the machine's own just-installed session. Handlers mirrored from
 *     `tests/helpers/fakeWrapperService.ts` (copied, not imported — see that
 *     file's own header on why this repo keeps two independent stubs rather
 *     than widening one every other fixture already depends on staying
 *     stable) — same server contract, same shape.
 *   - The minimal `wrapped_k_local` door + `key_enc` wrapper + KMS co-decrypt
 *     surface the ceremony's key-material half needs: `runGrantCeremony`
 *     (`src/auth/deviceKey/grant.ts`) lists/fetches doors over `/wrappers*`
 *     using the session `capy pair` just installed, and a later `capy run`
 *     calls `/wrappers*` + `/orgs/:id/co-decrypt` again to resolve a project
 *     key from the granted K_local.
 *
 * The OLD anonymous CAP-403 bootstrap surface (`/connections/bootstrap`,
 * secret-gated result/cancel) is gone from this stub: nothing in `capy pair`
 * calls it any more (deviceAuth.ts + pairDeviceGrant.ts replaced both halves
 * of the old ceremony — see those files' headers), and its connection-id
 * paths would otherwise collide with the AUTHENTICATED broker surface this
 * file now serves at the same routes.
 *
 * Doors (`wrapped_k_local`) are org-less and per-credential server-side (see
 * `serviceClient.ts`'s own comment) — this stub's `GET /wrappers` therefore
 * returns every door regardless of the caller's org claim, exactly like the
 * real service does, while `key_enc` rows stay org-filtered.
 *
 * KMS mock: same deterministic reversible prefix scheme
 * `fakeWrapperService.ts` uses, so the two fixtures could seed
 * interchangeable `key_enc` blobs if a future test ever wanted to run both
 * flows against the same org.
 */
import { randomUUID } from 'crypto';

/** One in-flight RFC 8628 device authorization. `completionQueue` is drained
 *  oldest-first by `POST /auth/device/token`; an empty queue is the RFC's own
 *  default ("still waiting") rather than an error. */
export interface FakeDeviceAuthRow {
  deviceCode: string;
  userCode: string;
  completionQueue: Array<{ status: number; body: unknown }>;
}

/** An AUTHENTICATED, owned connection-broker row (CAP-375), used by the
 *  CAP-384 grant ceremony `capy pair` now runs over the machine's session —
 *  mirrors `fakeWrapperService.ts`'s `FakeConnection` field-for-field. */
export interface FakeBrokerConnection {
  id: string;
  clientPubkeyB64: string;
  purpose: string;
  resultQueue: Array<{ status: number; body: unknown }>;
  cancelled: boolean;
}

export interface FakeKeyEncRow {
  organizationId: string;
  keyEnc: string;
}

/** A pre-enrolled `wrapped_k_local` door row — the account's own device-key
 *  wrapper the grant ceremony fetches over the authenticated `/wrappers`
 *  surface after the machine's own session is installed. */
export interface FakeDoorRow {
  credentialId: string;
  wrappedKLocal: string;
  iv: string;
  prfSalt: string;
  kdfVersion: number;
}

export interface FakePairingService {
  url: string;
  /** Device-authorization rows minted by `POST /auth/device/authorize`. */
  devices: Map<string, FakeDeviceAuthRow>;
  findDeviceByUserCode(userCode: string): FakeDeviceAuthRow | undefined;
  /** Broker connections minted by the AUTHENTICATED `POST /connections` — the
   *  grant ceremony's transport, not the dead anonymous bootstrap. */
  connections: Map<string, FakeBrokerConnection>;
  keyEncRows: FakeKeyEncRow[];
  doorRows: FakeDoorRow[];
  close(): void;
}

const KMS_PREFIX = 'KMS1.';
export const kmsWrap = (plaintext: string) => KMS_PREFIX + plaintext;
export const kmsStrip = (ciphertext: string) => {
  if (!ciphertext.startsWith(KMS_PREFIX)) throw new Error('not KMS-wrapped');
  return ciphertext.slice(KMS_PREFIX.length);
};

/** Decode the org id a fake bearer token claims (see tests/helpers/fakeSession.ts's `capy_org_id`). */
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

/** A short human-typed code, `TEST-XXXX`. Random rather than counter-derived
 *  — no module-level mutable state needed for uniqueness across a single
 *  test process. */
function mintUserCode(): string {
  return `TEST-${randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase()}`;
}

export function startFakePairingService(): FakePairingService {
  const devices = new Map<string, FakeDeviceAuthRow>();
  const connections = new Map<string, FakeBrokerConnection>();
  const keyEncRows: FakeKeyEncRow[] = [];
  const doorRows: FakeDoorRow[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get('authorization');

      // --- RFC 8628 device authorization (CAP-566) ---
      if (req.method === 'POST' && url.pathname === '/auth/device/authorize') {
        const deviceCode = randomUUID();
        const row: FakeDeviceAuthRow = {
          deviceCode,
          userCode: mintUserCode(),
          completionQueue: [],
        };
        devices.set(deviceCode, row);
        return Response.json(
          {
            device_code: deviceCode,
            user_code: row.userCode,
            verification_uri: 'https://verify.example.invalid/device',
            verification_uri_complete: `https://verify.example.invalid/device?user_code=${row.userCode}`,
            expires_in: 300,
            // Fast poll loop — the test drives completion directly rather
            // than waiting out a realistic interval.
            interval: 0,
          },
          { status: 200 },
        );
      }

      if (req.method === 'POST' && url.pathname === '/auth/device/token') {
        const body = (await req.json().catch(() => ({}))) as { device_code?: string };
        const device = body.device_code ? devices.get(body.device_code) : undefined;
        if (!device) {
          return Response.json({ error: 'expired_token' }, { status: 400 });
        }
        const next = device.completionQueue.shift() ?? { status: 400, body: { error: 'authorization_pending' } };
        return Response.json(next.body as any, { status: next.status });
      }

      // --- AUTHENTICATED owned connection broker (CAP-375), for the CAP-384
      // grant ceremony pairDeviceGrant.ts now runs over the machine's own
      // session. Mirrors fakeWrapperService.ts's handlers (see this file's
      // header) — copied, not imported.
      if (req.method === 'POST' && url.pathname === '/connections') {
        const b = (await req.json().catch(() => ({}))) as any;
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

      // --- wrapped_k_local doors + key_enc wrapper + KMS surface ---
      // (grant.ts's runGrantCeremony via serviceOps.ts). Doors are org-less:
      // listed/fetched regardless of the caller's org claim, matching the
      // real service (see this file's header). key_enc rows stay
      // org-filtered, as before.
      if (req.method === 'GET' && url.pathname === '/wrappers') {
        const orgId = orgFromAuth(auth);
        const doorMeta = doorRows.map((row, i) => ({
          id: `door-${i}`,
          type: 'wrapped_k_local',
          credential_id: row.credentialId,
          kdf_version: row.kdfVersion,
          is_seed: true,
          verified_at: new Date().toISOString(),
          organization_id: null,
          created_at: new Date().toISOString(),
          deleted_at: null,
          mirror_state: 'mirrored',
        }));
        const keyEncMeta = keyEncRows
          .map((row, i) => ({ row, id: `keyenc-${i}` }))
          .filter(({ row }) => row.organizationId === orgId)
          .map(({ id, row }) => ({ id, type: 'key_enc', organization_id: row.organizationId, deleted_at: null }));
        return Response.json({ wrappers: [...doorMeta, ...keyEncMeta] });
      }
      const wrapperIdMatch = url.pathname.match(/^\/wrappers\/([^/]+)$/);
      if (req.method === 'GET' && wrapperIdMatch) {
        const rawId = wrapperIdMatch[1];
        if (rawId.startsWith('door-')) {
          const row = doorRows[Number(rawId.replace('door-', ''))];
          if (!row) return Response.json({ error: 'not found', code: 'WRAPPER_NOT_FOUND' }, { status: 404 });
          return Response.json({
            wrapper: {
              id: rawId,
              type: 'wrapped_k_local',
              credential_id: row.credentialId,
              kdf_version: row.kdfVersion,
              is_seed: true,
              verified_at: new Date().toISOString(),
              organization_id: null,
              created_at: new Date().toISOString(),
              deleted_at: null,
              mirror_state: 'mirrored',
              wrapped_k_local: row.wrappedKLocal,
              iv: row.iv,
              prf_salt: row.prfSalt,
            },
          });
        }
        const idx = Number(rawId.replace('keyenc-', ''));
        const row = keyEncRows[idx];
        if (!row) return Response.json({ error: 'not found', code: 'WRAPPER_NOT_FOUND' }, { status: 404 });
        return Response.json({
          wrapper: { id: rawId, type: 'key_enc', organization_id: row.organizationId, key_enc: row.keyEnc },
        });
      }
      const codecryptMatch = url.pathname.match(/^\/orgs\/([^/]+)\/co-decrypt$/);
      if (req.method === 'POST' && codecryptMatch) {
        const body = (await req.json()) as any;
        try {
          return Response.json({ plaintext: kmsStrip(body.ciphertext) });
        } catch {
          return Response.json({ error: 'bad ciphertext', code: 'INVALID_FORMAT' }, { status: 400 });
        }
      }

      return Response.json({ error: 'no route', code: 'NOT_FOUND' }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    devices,
    findDeviceByUserCode: (userCode) => [...devices.values()].find((d) => d.userCode === userCode),
    connections,
    keyEncRows,
    doorRows,
    close: () => server.stop(true),
  };
}

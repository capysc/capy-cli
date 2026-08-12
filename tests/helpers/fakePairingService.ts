/**
 * CAP-409 — a real (loopback) HTTP stub of exactly the surface `capy pair`'s
 * e2e test needs: the CAP-403 anonymous bootstrap/poll/cancel verbs
 * (`POST /connections/bootstrap`, `GET /connections/:id/result` gated by
 * `X-Connection-Secret`, `DELETE /connections/:id`), plus the minimal
 * `key_enc` wrapper + KMS co-decrypt surface `grantResolver.ts`'s production
 * ops factory (`createGrantResolutionOps`) calls when a later `capy run`
 * resolves a project key from the granted K_local.
 *
 * Deliberately NOT an extension of `fakeWrapperService.ts` (which implements
 * the AUTHENTICATED `POST /connections` create — a different, owned-
 * connection surface this ticket's anonymous bootstrap is not) — a fresh,
 * narrow fixture keeps this file's contract legible and avoids widening a
 * fixture many other test files already depend on staying stable.
 *
 * KMS mock: same deterministic reversible prefix scheme
 * `fakeWrapperService.ts` uses, so the two fixtures could seed
 * interchangeable `key_enc` blobs if a future test ever wanted to run both
 * flows against the same org.
 */
import { randomUUID } from 'crypto';

export interface FakePairingConnection {
  id: string;
  userCode: string;
  clientPubkeyB64: string;
  pollSecret: string;
  expiresAtMs: number;
  resultQueue: Array<{ status: number; body: unknown }>;
  cancelled: boolean;
}

export interface FakeKeyEncRow {
  organizationId: string;
  keyEnc: string;
}

export interface FakePairingService {
  url: string;
  connections: Map<string, FakePairingConnection>;
  findByUserCode(userCode: string): FakePairingConnection | undefined;
  keyEncRows: FakeKeyEncRow[];
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

let userCodeCounter = 1000;
function mintUserCode(): string {
  const n = (userCodeCounter++).toString().padStart(4, '0');
  return `TEST-${n}`;
}

export function startFakePairingService(): FakePairingService {
  const connections = new Map<string, FakePairingConnection>();
  const keyEncRows: FakeKeyEncRow[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get('authorization');

      // --- anonymous bootstrap (CAP-403) ---
      if (req.method === 'POST' && url.pathname === '/connections/bootstrap') {
        const body = (await req.json()) as any;
        const id = randomUUID();
        const conn: FakePairingConnection = {
          id,
          userCode: mintUserCode(),
          clientPubkeyB64: body.client_pubkey,
          pollSecret: randomUUID(),
          expiresAtMs: Date.now() + (body.ttl_seconds ?? 900) * 1000,
          resultQueue: [],
          cancelled: false,
        };
        connections.set(id, conn);
        return Response.json(
          {
            connection_id: id,
            status: 'pending',
            expires_at: new Date(conn.expiresAtMs).toISOString(),
            poll_secret: conn.pollSecret,
            user_code: conn.userCode,
          },
          { status: 201 },
        );
      }

      const resultMatch = url.pathname.match(/^\/connections\/([^/]+)\/result$/);
      if (req.method === 'GET' && resultMatch) {
        const conn = connections.get(decodeURIComponent(resultMatch[1]));
        const secret = req.headers.get('x-connection-secret');
        if (!conn || conn.pollSecret !== secret) {
          return Response.json({ error: 'not found', code: 'CONNECTION_NOT_FOUND' }, { status: 404 });
        }
        const next = conn.resultQueue.shift() ?? { status: 200, body: { status: 'pending' } };
        return Response.json(next.body as any, { status: next.status });
      }

      const cancelMatch = url.pathname.match(/^\/connections\/([^/]+)$/);
      if (req.method === 'DELETE' && cancelMatch) {
        const conn = connections.get(decodeURIComponent(cancelMatch[1]));
        const secret = req.headers.get('x-connection-secret');
        if (conn && conn.pollSecret === secret) conn.cancelled = true;
        return Response.json({ status: 'cancelled' });
      }

      // --- key_enc wrapper + KMS surface (grantResolver.ts's ops) ---
      if (req.method === 'GET' && url.pathname === '/wrappers') {
        const orgId = orgFromAuth(auth);
        const rows = keyEncRows
          .map((row, i) => ({ row, id: `keyenc-${i}` }))
          .filter(({ row }) => row.organizationId === orgId)
          .map(({ id, row }) => ({ id, type: 'key_enc', organization_id: row.organizationId, deleted_at: null }));
        return Response.json({ wrappers: rows });
      }
      const wrapperIdMatch = url.pathname.match(/^\/wrappers\/([^/]+)$/);
      if (req.method === 'GET' && wrapperIdMatch) {
        const idx = Number(wrapperIdMatch[1].replace('keyenc-', ''));
        const row = keyEncRows[idx];
        if (!row) return Response.json({ error: 'not found', code: 'WRAPPER_NOT_FOUND' }, { status: 404 });
        return Response.json({
          wrapper: { id: wrapperIdMatch[1], type: 'key_enc', organization_id: row.organizationId, key_enc: row.keyEnc },
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
    connections,
    findByUserCode: (userCode) => [...connections.values()].find((c) => c.userCode === userCode),
    keyEncRows,
    close: () => server.stop(true),
  };
}

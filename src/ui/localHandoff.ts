/**
 * Local auth + custody handoff loopback listener (docs/flows/local-handoff.md
 * §4.4). CLI-side only: this module never talks to Keep directly, and it
 * never learns anything the service or the browser didn't hand it.
 *
 * The listener answers exactly one route, `POST /v1/local-handoff`, on a
 * `127.0.0.1`-only ephemeral port, and exists to do three things:
 *
 *  1. Prove the calling page is the one this exact CLI invocation opened —
 *     via an HMAC keyed by a one-time secret this process alone holds
 *     (`H`, minted by the service at `POST /flows/local-handoff` and never
 *     forwarded anywhere past this check).
 *  2. Finish the service-side handoff (`POST /flows/local-handoff/:id/authorize`)
 *     using the conversation's own proof signer — so a second CLI, or a
 *     replayed request, cannot complete it even if it somehow learned `H`.
 *  3. Seal this machine's `k_local` to the page's ephemeral public key, so
 *     only that browser tab can ever open it.
 *
 * Every dependency that would otherwise make this untestable without a real
 * network or a real `~/.capy` — the service origin's `fetch`, the clock, the
 * `k_local` reader, the conversation proof signer, the bearer-token
 * provider, and both origins — is injected. Nothing here throws into the
 * caller: setup failures return `null`, and the flow falls back to the
 * canonical sign-in path exactly as it does today.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import { isLoopbackHost } from '../commands/intakeSecurity';
import { sealRequestEnvelope } from '../service/brokerEnvelope';

type Json = Readonly<Record<string, unknown>>;

const PROOF_PREFIX = 'capy-local-handoff-v1';

/** The exact bytes signed by the page's HMAC proof (docs §4.4). */
export const handoffProofMessage = (
  handoffId: string,
  codeChallenge: string,
  pagePubkeyB64: string,
): string => `${PROOF_PREFIX}\n${handoffId}\n${codeChallenge}\n${pagePubkeyB64}`;

/**
 * Constant-time HMAC-SHA256 verification. `secretB64url` is `H`, the
 * one-time handoff secret this process holds in memory only — it is the
 * HMAC key, never forwarded, never logged.
 */
export function verifyHandoffProof(
  secretB64url: string,
  handoffId: string,
  codeChallenge: string,
  pagePubkeyB64: string,
  proofB64url: string,
): boolean {
  const key = Buffer.from(secretB64url, 'base64url');
  const expected = createHmac('sha256', key)
    .update(handoffProofMessage(handoffId, codeChallenge, pagePubkeyB64))
    .digest();
  const provided = Buffer.from(proofB64url, 'base64url');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** The URL opened in the browser. The fragment never reaches the service or
 * any log line — only `openScreen`'s spawned browser process sees it. */
export const buildHandoffUrl = (
  keepOrigin: string,
  conversationFlowId: string,
  port: number,
  handoffId: string,
  secretB64url: string,
): string =>
  `${keepOrigin}/auth/local?f=${conversationFlowId}#v=1&port=${port}&id=${handoffId}&secret=${secretB64url}`;

export interface HandoffRequestBody {
  readonly v: 1;
  readonly handoff_id: string;
  readonly code_challenge: string;
  readonly page_pubkey: string;
  readonly proof: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const PROOF_RE = /^[A-Za-z0-9_-]{43}$/;
const PAGE_PUBKEY_B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const EXPECTED_KEYS = ['v', 'handoff_id', 'code_challenge', 'page_pubkey', 'proof'] as const;

/** Exact-shape, strict-format parse of the browser's POST body. `null` on
 * anything short of a perfect match — missing keys, extra keys, wrong
 * types, or a value that fails its own format check. */
export function parseHandoffRequest(value: unknown): HandoffRequestBody | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Json;
  const keys = Object.keys(record).toSorted();
  const wanted = [...EXPECTED_KEYS].toSorted();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) return null;

  if (record.v !== 1) return null;
  if (typeof record.handoff_id !== 'string' || !UUID_RE.test(record.handoff_id)) return null;
  if (typeof record.code_challenge !== 'string' || !CHALLENGE_RE.test(record.code_challenge)) return null;
  if (typeof record.page_pubkey !== 'string' || !PAGE_PUBKEY_B64_RE.test(record.page_pubkey)) return null;
  const pagePubkeyRaw = Buffer.from(record.page_pubkey, 'base64');
  if (pagePubkeyRaw.length !== 65 || pagePubkeyRaw[0] !== 0x04) return null;
  if (typeof record.proof !== 'string' || !PROOF_RE.test(record.proof)) return null;

  return {
    v: 1,
    handoff_id: record.handoff_id,
    code_challenge: record.code_challenge,
    page_pubkey: record.page_pubkey,
    proof: record.proof,
  };
}

const MAX_BODY_BYTES = 8 * 1024;

/** Reads the request body up to `capBytes`, purely — no `chunks.push`. Each
 * step builds a new array of the chunks seen so far; `null` means the cap
 * was exceeded and the caller should answer 413 without buffering further. */
async function readCappedBody(req: IncomingMessage, capBytes: number): Promise<Buffer | null> {
  const iterator = (req as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  const loop = async (chunks: readonly Buffer[], total: number): Promise<Buffer | null> => {
    const next = await iterator.next();
    if (next.done) return Buffer.concat([...chunks]);
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    const nextTotal = total + chunk.length;
    if (nextTotal > capBytes) return null;
    return loop([...chunks, chunk], nextTotal);
  };
  return loop([], 0);
}

function respondJson(
  res: ServerResponse,
  status: number,
  body: Json,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

const corsHeaders = (keepOrigin: string): Readonly<Record<string, string>> => ({
  'Access-Control-Allow-Origin': keepOrigin,
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Private-Network': 'true',
  Vary: 'Origin',
});

export interface LocalHandoffHandle {
  /** The full `/auth/local#...` URL to open — carries the one-time secret
   * in its fragment. Never printed to stdout/stderr; only `openScreen`'s
   * spawned browser process sees it. */
  readonly url: string;
  close(): Promise<void>;
}

export interface StartLocalHandoffOptions {
  /** Service origin, e.g. `resolveActiveUrl(devMode)`. */
  readonly origin: string;
  readonly keepOrigin: string;
  /** The conversation flow id, `F`. */
  readonly conversationFlowId: string;
  /** The conversation keypair's public half — `K_F`'s public key, already
   * registered with the service as the conversation's `client_pubkey`. */
  readonly clientPubkeyB64: string;
  readonly userId: string;
  readonly orgId: string;
  readonly bearer: () => Promise<string>;
  /** The conversation's own proof signer — `flowInteraction.ts`'s `signed`,
   * unmodified: `(method, flowId, id, body) => body-with-proof`. */
  readonly sign: (method: string, flowId: string, id: string, body: Json) => Json;
  readonly readLocalRoot: (orgId: string, userId?: string) => Buffer | null;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  readonly createTimeoutMs?: number;
  readonly authorizeTimeoutMs?: number;
}

const CREATE_TIMEOUT_MS_DEFAULT = 10_000;
const AUTHORIZE_TIMEOUT_MS_DEFAULT = 10_000;
/** Grace after a success before the listener actually closes — long enough
 * that a concurrent/racing second request still reaches the single-use
 * latch check (and is refused by it) instead of a bare connection refusal. */
const CLOSE_GRACE_MS = 250;

interface CreatedHandoff {
  readonly handoffId: string;
  readonly secretB64url: string;
  readonly expiresAtMs: number;
}

/** `POST /flows/local-handoff` — bounded timeout, no retry loop. `null` on
 * any failure (network, timeout, non-2xx, malformed response): the caller
 * falls back to the canonical URL, same as every other setup failure here. */
async function createHandoff(opts: StartLocalHandoffOptions): Promise<CreatedHandoff | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const token = await opts.bearer();
    const body = opts.sign('local-handoff-create', opts.conversationFlowId, 'local-handoff', {
      conversation_flow_id: opts.conversationFlowId,
    });
    const response = await doFetch(`${opts.origin}/flows/local-handoff`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.createTimeoutMs ?? CREATE_TIMEOUT_MS_DEFAULT),
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as Json;
    if (
      typeof parsed.handoff_id !== 'string' ||
      typeof parsed.handoff_secret !== 'string' ||
      typeof parsed.expires_at !== 'string'
    ) return null;
    const expiresAtMs = Date.parse(parsed.expires_at);
    if (!Number.isFinite(expiresAtMs)) return null;
    return { handoffId: parsed.handoff_id, secretB64url: parsed.handoff_secret, expiresAtMs };
  } catch {
    return null;
  }
}

type AuthorizeResult = { readonly ok: true; readonly grant: string } | { readonly ok: false; readonly code: string };

/** `POST /flows/local-handoff/:id/authorize`. The service never receives the
 * handoff secret `H` — only `code_challenge`, signed by `K_F`. */
async function authorizeHandoff(
  opts: StartLocalHandoffOptions,
  handoffId: string,
  codeChallenge: string,
): Promise<AuthorizeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const token = await opts.bearer();
    const body = opts.sign('local-handoff-authorize', opts.conversationFlowId, handoffId, {
      code_challenge: codeChallenge,
    });
    const response = await doFetch(`${opts.origin}/flows/local-handoff/${handoffId}/authorize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.authorizeTimeoutMs ?? AUTHORIZE_TIMEOUT_MS_DEFAULT),
    });
    const parsed = (await response.json().catch(() => null)) as Json | null;
    if (!response.ok) {
      const code = typeof parsed?.code === 'string' ? parsed.code : 'LOCAL_HANDOFF_AUTHORIZE_FAILED';
      return { ok: false, code };
    }
    if (typeof parsed?.grant !== 'string') return { ok: false, code: 'LOCAL_HANDOFF_AUTHORIZE_FAILED' };
    return { ok: true, grant: parsed.grant };
  } catch {
    return { ok: false, code: 'LOCAL_HANDOFF_AUTHORIZE_FAILED' };
  }
}

/**
 * Create the handoff and stand up its loopback listener. Returns `null` on
 * any setup failure (create call, or bind) — never throws. The returned
 * handle's `url` is the ONLY place the one-time secret appears; the caller
 * must never print it, log it, or send it anywhere but the browser it opens.
 */
export async function startLocalHandoff(opts: StartLocalHandoffOptions): Promise<LocalHandoffHandle | null> {
  const now = opts.now ?? Date.now;
  const created = await createHandoff(opts);
  if (!created) return null;
  const handoff = created;

  // Single-use latch. Taken before the authorize call so the handoff is
  // spent even when authorize itself fails — never a mutable boolean flag.
  const usedLatch = new AbortController();
  // Overall lifecycle: aborted exactly once, by whichever of
  // success / TTL / external close() gets there first.
  const lifecycle = new AbortController();

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  const listen = await new Promise<{ ok: true; port: number } | { ok: false }>((resolve) => {
    server.once('error', () => resolve({ ok: false }));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(port > 0 ? { ok: true, port } : { ok: false });
    });
  });
  if (!listen.ok) {
    try { server.close(); } catch { /* already down */ }
    return null;
  }
  const port = listen.port;

  const close = async (): Promise<void> => {
    if (lifecycle.signal.aborted) return;
    lifecycle.abort();
    clearTimeout(ttlTimer);
    try { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* best effort */ }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  // A resource-cleanup backstop only — correctness comes from the per-request
  // check below, which uses the injectable clock. This one is scheduled off
  // the real wall clock on purpose: a test's accelerated `now` must be able to
  // make a REQUEST look expired without also racing a timer that would tear
  // the listener down before the request arrives.
  const ttlTimer = setTimeout(() => void close(), Math.max(0, handoff.expiresAtMs - Date.now()));
  ttlTimer.unref?.();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    const hostOk = isLoopbackHost(req.headers.host, port);
    const originOk = req.headers.origin === opts.keepOrigin;

    if (path !== '/v1/local-handoff') { res.writeHead(404); res.end(); return; }

    if (req.method === 'OPTIONS') {
      if (!hostOk || !originOk) { res.writeHead(403); res.end(); return; }
      res.writeHead(204, corsHeaders(opts.keepOrigin));
      res.end();
      return;
    }

    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (!hostOk || !originOk) { res.writeHead(403); res.end(); return; }

    const cors = corsHeaders(opts.keepOrigin);
    const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      respondJson(res, 415, { code: 'LOCAL_HANDOFF_BAD_CONTENT_TYPE' }, cors);
      return;
    }
    const declaredLength = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      respondJson(res, 413, { code: 'LOCAL_HANDOFF_TOO_LARGE' }, cors);
      return;
    }

    const raw = await readCappedBody(req, MAX_BODY_BYTES);
    if (raw === null) {
      respondJson(res, 413, { code: 'LOCAL_HANDOFF_TOO_LARGE' }, cors);
      return;
    }
    const parsedJson = (() => {
      try { return JSON.parse(raw.toString('utf8')) as unknown; } catch { return undefined; }
    })();
    if (parsedJson === undefined) {
      respondJson(res, 400, { code: 'LOCAL_HANDOFF_INVALID_JSON' }, cors);
      return;
    }
    const body = parseHandoffRequest(parsedJson);
    if (!body) {
      respondJson(res, 400, { code: 'LOCAL_HANDOFF_INVALID' }, cors);
      return;
    }
    if (body.handoff_id !== handoff.handoffId) {
      respondJson(res, 404, { code: 'LOCAL_HANDOFF_NOT_FOUND' }, cors);
      return;
    }
    if (usedLatch.signal.aborted) {
      respondJson(res, 409, { code: 'LOCAL_HANDOFF_USED' }, cors);
      return;
    }
    if (now() >= handoff.expiresAtMs) {
      respondJson(res, 410, { code: 'LOCAL_HANDOFF_EXPIRED' }, cors);
      return;
    }
    if (!verifyHandoffProof(handoff.secretB64url, body.handoff_id, body.code_challenge, body.page_pubkey, body.proof)) {
      respondJson(res, 403, { code: 'LOCAL_HANDOFF_PROOF_INVALID' }, cors);
      return;
    }

    // Single-use from here on, whatever happens next.
    usedLatch.abort();

    const authorized = await authorizeHandoff(opts, handoff.handoffId, body.code_challenge);
    if (!authorized.ok) {
      respondJson(res, 502, { code: authorized.code }, cors);
      return;
    }

    const kLocal = opts.readLocalRoot(opts.orgId, opts.userId);
    if (!kLocal) {
      respondJson(res, 500, { code: 'LOCAL_HANDOFF_LOCAL_ROOT_MISSING' }, cors);
      return;
    }

    const payload = JSON.stringify({
      v: 1,
      handoff_id: handoff.handoffId,
      conversation_flow_id: opts.conversationFlowId,
      user_id: opts.userId,
      org_id: opts.orgId,
      k_local: kLocal.toString('base64'),
    });
    const sealed = sealRequestEnvelope({
      connectionId: `local-handoff:${handoff.handoffId}`,
      clientPubkeyB64: opts.clientPubkeyB64,
      pagePubkeyB64: body.page_pubkey,
      payload,
    });
    if (!sealed.ok) {
      respondJson(res, 500, { code: 'LOCAL_HANDOFF_SEAL_FAILED' }, cors);
      return;
    }

    respondJson(res, 200, {
      v: 1,
      grant: authorized.grant,
      custody: sealed.ciphertextB64,
      client_pubkey: opts.clientPubkeyB64,
    }, cors);
    res.on('finish', () => {
      const grace = setTimeout(() => void close(), CLOSE_GRACE_MS);
      grace.unref?.();
    });
  }

  return {
    url: buildHandoffUrl(opts.keepOrigin, opts.conversationFlowId, port, handoff.handoffId, handoff.secretB64url),
    close,
  };
}

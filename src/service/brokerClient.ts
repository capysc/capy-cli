/**
 * CLI client for the connection broker (service `/connections`, CAP-375).
 *
 * The broker replaces the loopback transport for browser screens: the CLI
 * creates a single-use connection under its org-scoped session, hands the
 * user a keep.capy.sc URL bound to it, and long-polls for the E2E-sealed
 * answer. The service relays opaque bytes; decryption happens here, with the
 * per-connection private key that never leaves this process (see
 * `brokerEnvelope.ts` for the envelope contract).
 *
 * Every outcome is a typed variant or a machine-readable code — nothing
 * downstream may branch on message text. The `CONNECTION_*` codes are the
 * broker's own wire contract (service `errorCodes.ts` / openapi).
 */
import { CapyError, ERROR_CODES } from '../types/index';
import {
  ConnectionKeypair,
  mintConnectionKeypair,
  openEnvelope,
  sealRequestEnvelope,
} from './brokerEnvelope';

/** Broker wire codes (openapi, tag Connections). Matched verbatim. */
export type BrokerErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_EXPIRED'
  | 'CONNECTION_CONSUMED'
  | 'CONNECTION_NOT_ATTACHED'
  | 'CONNECTION_ALREADY_ANSWERED'
  | 'CONNECTION_PAGE_KEY_MISSING'
  | 'CONNECTION_REQUEST_ALREADY_SENT'
  | 'INVALID_FORMAT';

export interface BrokerConnection {
  readonly connectionId: string;
  /** ISO date-time the broker will stop honoring this connection. */
  readonly expiresAt: string;
  /** Ephemeral keypair minted for exactly this connection. */
  readonly keypair: ConnectionKeypair;
}

/** One bounded read. Pending leaves the connection alive for another CLI invocation. */
export type PollAnswerResult = Exclude<AwaitAnswerResult, { kind: 'timeout' }> | { readonly kind: 'pending' };
/** Resumable payload callers checkpoint the sealed answer before opening it. */
export type PollExchangeResult = Exclude<PollAnswerResult, { kind: 'pending' | 'answered' }>
  | { readonly kind: 'pending'; readonly pagePubkeyB64?: string }
  | { readonly kind: 'answered'; readonly ciphertextB64: string; readonly pagePubkeyB64?: string };

export type AwaitAnswerResult =
  /** Sealed answer delivered and opened. */
  | { kind: 'answered'; plaintext: string }
  /** Broker reported the connection expired (410 CONNECTION_EXPIRED). */
  | { kind: 'expired' }
  /** Already delivered or cancelled (409 CONNECTION_CONSUMED). */
  | { kind: 'consumed' }
  /** Our own deadline elapsed with no answer; the connection was cancelled
   * best-effort so the page sees a dead link rather than a silent void. */
  | { kind: 'timeout' }
  /** Transport failure reaching the service. */
  | { kind: 'network'; detail?: string }
  /** The service answered outside the contract. */
  | { kind: 'service'; status: number; code?: string }
  /** Delivered bytes that could not be opened as a v1 envelope. */
  | { kind: 'bad_envelope'; code: string };

/**
 * Outcome of waiting for the page to attach and register its reverse-channel
 * key (W2-A, broker reverse channel). This is a PRE-condition for
 * {@link BrokerClient.sendRequest} — the CLI cannot seal a request until it
 * knows the page's `page_pubkey`, and the only place that value is ever
 * surfaced is this same `GET /connections/:id/result` poll (see the service
 * doc comment on `ConnectionResultResponse.page_pubkey`).
 */
export type AwaitPagePubkeyResult =
  /** The page attached and registered a key. */
  | { kind: 'ready'; pagePubkeyB64: string }
  /** Broker reported the connection expired (410 CONNECTION_EXPIRED). */
  | { kind: 'expired' }
  /** Already delivered or cancelled (409 CONNECTION_CONSUMED). */
  | { kind: 'consumed' }
  /** Our own deadline elapsed with no page_pubkey; the connection was
   * cancelled best-effort, same posture as `awaitAnswer`'s timeout. */
  | { kind: 'timeout' }
  /** Transport failure reaching the service. */
  | { kind: 'network'; detail?: string }
  /** The service answered outside the contract. */
  | { kind: 'service'; status: number; code?: string };

/** Outcome of sending one sealed CLI->page request (W2-A, broker reverse
 * channel). Every branch is a coded variant — never a thrown message. */
export type SendRequestResult =
  | { kind: 'sent' }
  /** `pagePubkeyB64` was not a well-formed key — sealing never reached the
   * wire. Should not happen if the caller passed through a value this same
   * client's own `awaitPagePubkey` returned. */
  | { kind: 'bad_page_pubkey'; code: string }
  /** Broker reported the connection expired (410 CONNECTION_EXPIRED). */
  | { kind: 'expired' }
  /** Already delivered or cancelled (409 CONNECTION_CONSUMED). */
  | { kind: 'consumed' }
  /** The page has not attached yet (409 CONNECTION_NOT_ATTACHED) — a race
   * against `awaitPagePubkey`'s own poll; retry is reasonable. */
  | { kind: 'not_attached' }
  /** Attached, but no page_pubkey registered (409 CONNECTION_PAGE_KEY_MISSING). */
  | { kind: 'no_page_key' }
  /** A request was already sent on this connection — single-send by
   * contract (409 CONNECTION_REQUEST_ALREADY_SENT). */
  | { kind: 'already_sent' }
  /** Transport failure reaching the service. */
  | { kind: 'network'; detail?: string }
  /** The service answered outside the contract. */
  | { kind: 'service'; status: number; code?: string };

// Defaults are tuned for the built no-submit auth screens (auth-success /
// auth-error): the page answers within a couple of seconds of the redirect
// landing, no human deliberation in between. A payload-bearing ceremony
// (device-key enroll/unlock, CAP-382 and beyond) is a different shape of
// wait — a passkey prompt on a *second* device, or a user re-reading a
// warning screen, routinely runs past a minute — so callers driving a
// ceremony MUST override both knobs via `createConnection({ ttlSeconds })`
// and `awaitAnswer(conn, { deadlineMs })` rather than accept these. Ceremony
// guidance (see CAP-382 brief): `ttlSeconds` >= 900 (the broker's own max),
// `deadlineMs` >= `ttlSeconds * 1000` (the client deadline must not expire
// before the broker's own TTL does, or the poll gives up on a connection
// the broker would still honor) plus auto-recreate on `CONNECTION_EXPIRED`
// and a page refresh path on expiry — auto-recreate/refresh are the
// ceremony impl's job, not this client's.
const DEFAULT_TTL_SECONDS = 600;
const DEFAULT_WAIT_SECONDS = 25; // openapi max for wait_seconds
const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_POLL_GAP_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ErrorBody {
  error?: string;
  code?: string;
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class BrokerClient {
  /**
   * @param serviceUrl service base URL (same resolution as ServiceClient)
   * @param getToken   supplies the org-scoped access token for CLI-side verbs
   */
  constructor(
    private readonly serviceUrl: string,
    private readonly getToken: () => string | null | Promise<string | null>,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) {
      throw new CapyError(
        'No session token available for the connection broker',
        ERROR_CODES.AUTH_FAILED,
      );
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }

  /**
   * Open a connection. Mints the ephemeral keypair, registers its public
   * half, and returns the handle the caller needs to build the keep URL and
   * later open the answer. Throws `CapyError` (coded) on any failure — the
   * caller's contract is "fall back to the loopback transport if this throws".
   *
   * @param opts.ttlSeconds how long the broker honors this connection.
   *   Defaults to {@link DEFAULT_TTL_SECONDS} (600s), which is fine for the
   *   no-submit auth screens. A ceremony that waits on human deliberation
   *   (a passkey touch, a phone approval) should pass 900 — see the
   *   defaults comment above `DEFAULT_TTL_SECONDS` for the full guidance.
   */
  async createConnection(opts: {
    purpose: string;
    machineName?: string;
    ttlSeconds?: number;
  }): Promise<BrokerConnection> {
    const keypair = mintConnectionKeypair();
    const headers = await this.headers();
    const res = await (async () => {
      try {
        return await fetch(`${this.serviceUrl}/connections`, {
          method: 'POST',
          signal: AbortSignal.timeout(15_000),
          headers,
          body: JSON.stringify({
            purpose: opts.purpose,
            ...(opts.machineName ? { machine_name: opts.machineName } : {}),
            client_pubkey: keypair.publicKeyB64,
            ttl_seconds: opts.ttlSeconds ?? DEFAULT_TTL_SECONDS,
          }),
        });
      } catch (error) {
        throw new CapyError(
          `Could not reach the connection broker: ${error instanceof Error ? error.message : 'network error'}`,
          ERROR_CODES.NETWORK_ERROR,
        );
      }
    })();
    if (!res.ok) {
      throw new CapyError(
        `Connection broker refused create (HTTP ${res.status})`,
        res.status === 401 ? ERROR_CODES.AUTH_FAILED : ERROR_CODES.SERVICE_ERROR,
      );
    }
    const body = await readBody(res);
    if (typeof body.connection_id !== 'string' || typeof body.expires_at !== 'string') {
      throw new CapyError(
        'Connection broker returned an unexpected create response',
        ERROR_CODES.SERVICE_ERROR,
      );
    }
    return {
      connectionId: body.connection_id,
      expiresAt: body.expires_at,
      keypair,
    };
  }

  /**
   * Return after one bounded poll without cancelling a pending request.
   * A resumable caller must persist its private connection handle before
   * handing out the URL. Delivery remains single-use: CONNECTION_CONSUMED
   * without a saved answer requires a new ceremony, not a successful retry.
   */
  async pollExchange(connection: BrokerConnection, waitSeconds: number = 20, waitFor: 'answer' | 'page_key' = 'answer'): Promise<PollExchangeResult> {
    const boundedWait = Number.isFinite(waitSeconds) ? Math.max(0, Math.min(Math.floor(waitSeconds), 25)) : 20;
    const headers = await this.headers().catch(() => null);
    if (!headers) return { kind: 'network', detail: 'no session token' };
    const response = await (async () => {
      try {
        return { ok: true as const, value: await fetch(
          `${this.serviceUrl}/connections/${connection.connectionId}/result?wait_seconds=${boundedWait}${waitFor === 'page_key' ? '&wait_for=page_key' : ''}`,
          { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout((boundedWait + 5) * 1000) },
        ) };
      } catch (error) {
        return { ok: false as const, detail: error instanceof Error ? error.message : undefined };
      }
    })();
    if (!response.ok) return { kind: 'network', detail: response.detail };
    const res = response.value;
    const body = await readBody(res);
    if (!res.ok) {
      if (res.status === 410) return { kind: 'expired' };
      if (res.status === 409) return { kind: 'consumed' };
      return { kind: 'service', status: res.status, code: typeof body.code === 'string' ? body.code : undefined };
    }
    const pageKey = typeof body.page_pubkey === 'string' ? { pagePubkeyB64: body.page_pubkey } : {};
    if (body.status === 'pending' || body.status === 'attached') return { kind: 'pending', ...pageKey };
    if (body.status !== 'answered' || typeof body.ciphertext !== 'string') return { kind: 'service', status: res.status, code: 'INVALID_FORMAT' };
    return { kind: 'answered', ciphertextB64: body.ciphertext, ...pageKey };
  }

  async pollAnswer(connection: BrokerConnection, waitSeconds: number = 20): Promise<PollAnswerResult> {
    const result = await this.pollExchange(connection, waitSeconds);
    if (result.kind === 'pending') return { kind: 'pending' };
    if (result.kind !== 'answered') return result;
    const opened = openEnvelope({ ciphertextB64: result.ciphertextB64, connectionId: connection.connectionId, keypair: connection.keypair });
    return opened.ok ? { kind: 'answered', plaintext: opened.plaintext } : { kind: 'bad_envelope', code: opened.code };
  }

  /**
   * Long-poll `GET /connections/:id/result` until the sealed answer arrives,
   * the broker reports a terminal state, or our own deadline passes. Never
   * throws — every ending is a typed variant.
   *
   * @param opts.deadlineMs how long to keep polling before giving up and
   *   best-effort cancelling. Defaults to {@link DEFAULT_DEADLINE_MS} (60s),
   *   which is fine for the no-submit auth screens. A ceremony caller should
   *   pass a deadline >= the `ttlSeconds * 1000` it created the connection
   *   with — see the defaults comment above `DEFAULT_TTL_SECONDS` for the
   *   full guidance — otherwise this client gives up on (and cancels) a
   *   connection the broker would still be honoring.
   */
  async awaitAnswer(
    connection: BrokerConnection,
    opts: { deadlineMs?: number; waitSeconds?: number; pollGapMs?: number } = {},
  ): Promise<AwaitAnswerResult> {
    const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const waitSeconds = Math.min(
      opts.waitSeconds ?? DEFAULT_WAIT_SECONDS,
      DEFAULT_WAIT_SECONDS,
    );
    const pollGapMs = opts.pollGapMs ?? DEFAULT_POLL_GAP_MS;

    while (Date.now() < deadline) {
      const answer = await this.pollAnswer(connection, waitSeconds);
      if (answer.kind !== 'pending') return answer;
      if (Date.now() < deadline) await sleep(pollGapMs);
    }

    await this.cancel(connection.connectionId);
    return { kind: 'timeout' };
  }

  /**
   * Long-poll for the page to attach and register a reverse-channel key.
   * Reuses `GET /connections/:id/result` — the CLI has no separate observe
   * verb, so the same poll `awaitAnswer` uses for the final answer is also
   * how it learns `page_pubkey` became available (see the service's
   * `ConnectionResultResponse.page_pubkey` doc comment). Never throws.
   *
   * A caller driving a payload-bearing screen calls this BEFORE
   * {@link sendRequest}, then {@link awaitAnswer} after — three legs on the
   * same connection: wait for the key, send the sealed request, wait for
   * the sealed answer.
   */
  async awaitPagePubkey(
    connection: BrokerConnection,
    opts: { deadlineMs?: number; waitSeconds?: number; pollGapMs?: number } = {},
  ): Promise<AwaitPagePubkeyResult> {
    const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const waitSeconds = Math.min(
      opts.waitSeconds ?? DEFAULT_WAIT_SECONDS,
      DEFAULT_WAIT_SECONDS,
    );
    const pollGapMs = opts.pollGapMs ?? DEFAULT_POLL_GAP_MS;

    while (Date.now() < deadline) {
      const headers = await this.headers().catch(() => null);
      if (!headers) return { kind: 'network', detail: 'no session token' };
      const response = await (async () => {
        try {
          return { ok: true as const, value: await fetch(
            `${this.serviceUrl}/connections/${connection.connectionId}/result?wait_seconds=${waitSeconds}`,
            { method: 'GET', headers },
          ) };
        } catch (error: any) {
          return { ok: false as const, detail: error?.message };
        }
      })();
      if (!response.ok) return { kind: 'network', detail: response.detail };
      const res = response.value;

      if (res.ok) {
        const body = await readBody(res);
        if (typeof body.page_pubkey === 'string' && body.page_pubkey.length > 0) {
          return { kind: 'ready', pagePubkeyB64: body.page_pubkey };
        }
        // Not attached yet, or attached without a key (a no-submit screen
        // reusing this poll would land here forever, which is why only a
        // payload-bearing screen's transport should ever call this method).
        if (Date.now() < deadline) await sleep(pollGapMs);
        continue;
      }

      const body = (await readBody(res)) as ErrorBody;
      if (res.status === 410) return { kind: 'expired' };
      if (res.status === 409) return { kind: 'consumed' };
      return { kind: 'service', status: res.status, code: body.code };
    }

    await this.cancel(connection.connectionId);
    return { kind: 'timeout' };
  }

  /**
   * Seal `payload` to the page's registered key and send it over the broker
   * reverse channel (`POST /connections/:id/request`). Single-send by
   * contract — a second call on the same connection comes back
   * `already_sent`. Never throws.
   *
   * @param pagePubkeyB64 from a prior {@link awaitPagePubkey} `ready` result.
   * @param payload UTF-8 plaintext, typically `JSON.stringify(...)` of the
   *   typed request contract the target screen expects.
   */
  async sendRequest(
    connection: BrokerConnection,
    pagePubkeyB64: string,
    payload: string,
  ): Promise<SendRequestResult> {
    const sealed = sealRequestEnvelope({
      connectionId: connection.connectionId,
      clientPubkeyB64: connection.keypair.publicKeyB64,
      pagePubkeyB64,
      payload,
    });
    if (!sealed.ok) return { kind: 'bad_page_pubkey', code: sealed.code };

    const headers = await this.headers().catch(() => null);
    if (!headers) return { kind: 'network', detail: 'no session token' };
    const response = await (async () => {
      try {
        return { ok: true as const, value: await fetch(`${this.serviceUrl}/connections/${connection.connectionId}/request`, {
          method: 'POST', headers, signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ ciphertext: sealed.ciphertextB64 }),
        }) };
      } catch (error) {
        return { ok: false as const, detail: error instanceof Error ? error.message : undefined };
      }
    })();
    if (!response.ok) return { kind: 'network', detail: response.detail };
    const res = response.value;

    if (res.ok) return { kind: 'sent' };

    const body = (await readBody(res)) as ErrorBody;
    if (res.status === 410) return { kind: 'expired' };
    if (res.status === 409) {
      // Distinguished by the service's coded `code` field, never by parsing
      // `error` prose (Rule 4).
      if (body.code === 'CONNECTION_NOT_ATTACHED') return { kind: 'not_attached' };
      if (body.code === 'CONNECTION_PAGE_KEY_MISSING') return { kind: 'no_page_key' };
      if (body.code === 'CONNECTION_REQUEST_ALREADY_SENT') return { kind: 'already_sent' };
      return { kind: 'consumed' };
    }
    return { kind: 'service', status: res.status, code: body.code };
  }

  /** Cancel + wipe. Best-effort: a failure to cancel changes nothing here. */
  async cancel(connectionId: string): Promise<void> {
    try {
      await fetch(`${this.serviceUrl}/connections/${connectionId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(2_000),
        headers: await this.headers(),
      });
    } catch {
      // Best-effort by contract; the broker sweeps expired rows itself.
    }
  }
}

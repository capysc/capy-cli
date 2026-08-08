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
} from './brokerEnvelope';

/** Broker wire codes (openapi, tag Connections). Matched verbatim. */
export type BrokerErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_EXPIRED'
  | 'CONNECTION_CONSUMED'
  | 'CONNECTION_NOT_ATTACHED'
  | 'CONNECTION_ALREADY_ANSWERED'
  | 'INVALID_FORMAT';

export interface BrokerConnection {
  connectionId: string;
  /** ISO date-time the broker will stop honoring this connection. */
  expiresAt: string;
  /** Ephemeral keypair minted for exactly this connection. */
  keypair: ConnectionKeypair;
}

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
    private serviceUrl: string,
    private getToken: () => string | null | Promise<string | null>,
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
   */
  async createConnection(opts: {
    purpose: string;
    machineName?: string;
    ttlSeconds?: number;
  }): Promise<BrokerConnection> {
    const keypair = mintConnectionKeypair();
    const headers = await this.headers();
    let res: Response;
    try {
      res = await fetch(`${this.serviceUrl}/connections`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          purpose: opts.purpose,
          ...(opts.machineName ? { machine_name: opts.machineName } : {}),
          client_pubkey: keypair.publicKeyB64,
          ttl_seconds: opts.ttlSeconds ?? DEFAULT_TTL_SECONDS,
        }),
      });
    } catch (error: any) {
      throw new CapyError(
        `Could not reach the connection broker: ${error?.message ?? 'network error'}`,
        ERROR_CODES.NETWORK_ERROR,
      );
    }
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
   * Long-poll `GET /connections/:id/result` until the sealed answer arrives,
   * the broker reports a terminal state, or our own deadline passes. Never
   * throws — every ending is a typed variant.
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
      let res: Response;
      let headers: Record<string, string>;
      try {
        headers = await this.headers();
      } catch {
        // Token became unavailable mid-flow — a session problem, not a wire
        // problem, but equally unrecoverable inside this poll loop.
        return { kind: 'network', detail: 'no session token' };
      }
      try {
        res = await fetch(
          `${this.serviceUrl}/connections/${connection.connectionId}/result?wait_seconds=${waitSeconds}`,
          { method: 'GET', headers },
        );
      } catch (error: any) {
        return { kind: 'network', detail: error?.message };
      }

      if (res.ok) {
        const body = await readBody(res);
        if (body.status === 'answered' && typeof body.ciphertext === 'string') {
          const opened = openEnvelope({
            ciphertextB64: body.ciphertext,
            connectionId: connection.connectionId,
            keypair: connection.keypair,
          });
          if (!opened.ok) return { kind: 'bad_envelope', code: opened.code };
          return { kind: 'answered', plaintext: opened.plaintext };
        }
        // pending / attached — keep polling until the deadline.
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

  /** Cancel + wipe. Best-effort: a failure to cancel changes nothing here. */
  async cancel(connectionId: string): Promise<void> {
    try {
      await fetch(`${this.serviceUrl}/connections/${connectionId}`, {
        method: 'DELETE',
        headers: await this.headers(),
      });
    } catch {
      // Best-effort by contract; the broker sweeps expired rows itself.
    }
  }
}

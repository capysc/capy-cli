/**
 * CAP-409 — anonymous CAP-403 bootstrap client for `capy pair`.
 *
 * NOT `../../service/brokerClient.ts`'s `BrokerClient` — that class requires
 * an already-authenticated org-scoped/user-scoped session token on every
 * verb (`headers()` throws with no token), because it's built for a CLI that
 * already has a session and wants to create an OWNED connection. `capy pair`
 * is the opposite: the whole point is a machine with NO session yet, so it
 * must create the connection anonymously (`POST /connections/bootstrap`) and
 * authorize its own follow-up polls with the one-time `poll_secret` the
 * bootstrap response hands back, via `X-Connection-Secret` — never a Bearer
 * token (CAP-403, W1A-broker-reverse-and-bootstrap.md).
 *
 * Reuses the SAME envelope crypto every other broker-backed ceremony uses
 * (`../../service/brokerEnvelope.ts`'s `mintConnectionKeypair`/`openEnvelope`,
 * the `ans`-tagged HKDF info string) — this file only adds the anonymous
 * transport around it, never reimplements the crypto.
 */
import { CapyError, ERROR_CODES } from '../../types/index';
import {
  ConnectionKeypair,
  mintConnectionKeypair,
  openEnvelope,
} from '../../service/brokerEnvelope';

export interface PairingBootstrap {
  connectionId: string;
  /** Epoch ms, parsed from the server's ISO `expires_at`. */
  expiresAtMs: number;
  /** High-entropy, shown once — authorizes only `result`/cancel on this one row. */
  pollSecret: string;
  /** Server-formatted `XXXX-XXXX`, shown to the human. */
  userCode: string;
  keypair: ConnectionKeypair;
}

export type PairingPollResult =
  | { kind: 'answered'; plaintext: string }
  | { kind: 'pending' }
  | { kind: 'expired' }
  | { kind: 'consumed' }
  | { kind: 'network'; detail?: string }
  | { kind: 'service'; status: number; code?: string }
  /** Delivered bytes that could not be opened as a v1 envelope — AEAD failed
   *  or the shape was wrong. Never treated as a partial success. */
  | { kind: 'bad_envelope'; code: string };

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

export class PairingBrokerClient {
  constructor(private readonly serviceUrl: string) {}

  /**
   * `POST /connections/bootstrap` — no Authorization header, ever. Mints the
   * ephemeral P-256 keypair this process will hold for the whole ceremony.
   */
  async bootstrap(opts: {
    purpose: string;
    machineName?: string;
    ttlSeconds?: number;
  }): Promise<PairingBootstrap> {
    const keypair = mintConnectionKeypair();
    let res: Response;
    try {
      res = await fetch(`${this.serviceUrl}/connections/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          purpose: opts.purpose,
          client_pubkey: keypair.publicKeyB64,
          ...(opts.machineName ? { machine_name: opts.machineName } : {}),
          ...(opts.ttlSeconds ? { ttl_seconds: opts.ttlSeconds } : {}),
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
        `Connection broker refused bootstrap (HTTP ${res.status})`,
        ERROR_CODES.SERVICE_ERROR,
      );
    }
    const body = await readBody(res);
    if (
      typeof body.connection_id !== 'string' ||
      typeof body.expires_at !== 'string' ||
      typeof body.poll_secret !== 'string' ||
      typeof body.user_code !== 'string'
    ) {
      throw new CapyError(
        'Connection broker returned an unexpected bootstrap response',
        ERROR_CODES.SERVICE_ERROR,
      );
    }
    const expiresAtMs = Date.parse(body.expires_at);
    if (!Number.isFinite(expiresAtMs)) {
      throw new CapyError(
        'Connection broker returned an unparsable expires_at',
        ERROR_CODES.SERVICE_ERROR,
      );
    }
    return {
      connectionId: body.connection_id,
      expiresAtMs,
      pollSecret: body.poll_secret,
      userCode: body.user_code,
      keypair,
    };
  }

  /**
   * One `GET /connections/:id/result?wait_seconds=N` long-poll leg,
   * authorized by `X-Connection-Secret` (never a Bearer token — this
   * connection has no owner yet). Never throws; every ending is a typed
   * variant, same discipline as `BrokerClient.awaitAnswer`.
   */
  async pollOnce(bootstrap: PairingBootstrap, waitSeconds: number): Promise<PairingPollResult> {
    let res: Response;
    try {
      res = await fetch(
        `${this.serviceUrl}/connections/${bootstrap.connectionId}/result?wait_seconds=${waitSeconds}`,
        { method: 'GET', headers: { 'X-Connection-Secret': bootstrap.pollSecret } },
      );
    } catch (error: any) {
      return { kind: 'network', detail: error?.message };
    }

    if (res.ok) {
      const body = await readBody(res);
      if (body.status === 'answered' && typeof body.ciphertext === 'string') {
        const opened = openEnvelope({
          ciphertextB64: body.ciphertext,
          connectionId: bootstrap.connectionId,
          keypair: bootstrap.keypair,
        });
        if (!opened.ok) return { kind: 'bad_envelope', code: opened.code };
        return { kind: 'answered', plaintext: opened.plaintext };
      }
      return { kind: 'pending' };
    }

    const body = (await readBody(res)) as ErrorBody;
    if (res.status === 410) return { kind: 'expired' };
    if (res.status === 409) return { kind: 'consumed' };
    return { kind: 'service', status: res.status, code: body.code };
  }

  /** Cancel + wipe. Best-effort — a failure to cancel changes nothing here. */
  async cancel(bootstrap: Pick<PairingBootstrap, 'connectionId' | 'pollSecret'>): Promise<void> {
    try {
      await fetch(`${this.serviceUrl}/connections/${bootstrap.connectionId}`, {
        method: 'DELETE',
        headers: { 'X-Connection-Secret': bootstrap.pollSecret },
      });
    } catch {
      // Best-effort by contract; the broker sweeps expired rows itself.
    }
  }
}

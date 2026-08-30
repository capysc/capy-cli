/**
 * HTTP client for the flow API.
 *
 * Thin on purpose: it carries observations up and hands step envelopes back
 * unvalidated. Validation is `validate.ts`'s job and happens in the driver, so
 * there is exactly one place where a step becomes trusted.
 *
 * Errors are surfaced with the service's machine-readable `code` preserved.
 * Nothing anywhere reads the message.
 */
import { resolveActiveUrl } from '../config/profileConfig';

/**
 * The observation bag a flow report carries. Named generically now that the
 * onboard flow (its original, and until now only, shape) is gone — every
 * field is a plain boolean per the flow contract's own `observations` schema.
 */
export type FlowObservations = Record<string, boolean>;

export interface FlowServiceError {
  status: number;
  code?: string;
}

export class FlowHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
  ) {
    super(`flow request failed with status ${status}`);
    this.name = 'FlowHttpError';
  }
}

export interface CreateFlowRequest {
  contract_version: string;
  auth_mode: 'interactive_oauth' | 'broker_ceremony';
  repo_key: string;
  plan?: unknown;
  compat?: { usesEnvVars?: boolean; framework?: string; externalSecretManager?: string };
  client_pubkey?: string;
  machine_name?: string;
  /**
   * CAP-484: the org this repo already names locally (keep.lock, or the
   * .env header), when one exists. The service forwards it to the ceremony
   * connection as its member gate, so a wrong-account sign-in on the Keep
   * page is refused WITHOUT consuming the single-use ceremony. A hint,
   * never authority — zero-trust custody is the real gate on the secrets.
   */
  local_org_hint?: string;
}

export interface CreateFlowResponse {
  flow_id: string;
  flow_type: string;
  contract_version: string;
  binding: 'anonymous' | 'identified';
  resumed?: boolean;
  flow_secret?: string;
  expires_in?: number;
  step: unknown;
}

export interface NextRequest {
  contract_version: string;
  observations: FlowObservations;
  /**
   * Sent when the client found the plan no longer matches the one the
   * instance holds (a rebuild after a PLAN_CHANGED outcome), and also once,
   * on a resumed run's first report, to give a remote-minted flow — which
   * carries no plan on its row at all until some driver reports one — its
   * plan facts for the first time. See driver.ts's `resolveNextPlan`.
   */
  plan?: unknown;
  last_step?: {
    step_id: string;
    outcome: 'ok' | 'failed';
    code?: string;
    result?: { org_id?: string; project_id?: string; branch?: string };
  };
  /**
   * Same field as `CreateFlowRequest.client_pubkey`, sent again on every
   * `next` report while this process holds a broker-ceremony keypair —
   * needed because a `--flow-id`/`--flow-secret` RESUME never calls
   * `create`, so its own mint (driver.ts's `brokerCeremonyKeypair`) would
   * otherwise never reach the service at all. Registration is one-shot and
   * idempotent server-side: the first key seen for the flow wins, resending
   * that IDENTICAL key (the ordinary create-then-next case) is a no-op
   * success, and a DIFFERENT key than the one already stored is refused with
   * a 409 (`FlowHttpError.code === 'CLIENT_PUBKEY_CONFLICT'`).
   */
  client_pubkey?: string;
}

/** What the driver needs from the service. Injectable so the driver can be tested against a fake. */
export interface FlowTransport {
  create(body: CreateFlowRequest, token?: string): Promise<CreateFlowResponse>;
  next(flowId: string, body: NextRequest, creds: FlowCreds): Promise<{ step: unknown }>;
  confirm(flowId: string, planHash: string, accepted: boolean, creds: FlowCreds): Promise<unknown>;
  cancel(flowId: string, creds: FlowCreds): Promise<void>;
}

export interface FlowCreds {
  secret?: string;
  token?: string;
}

export class FlowClient implements FlowTransport {
  private readonly apiUrl: string;

  constructor(apiUrl?: string, devMode = false) {
    this.apiUrl = apiUrl ?? resolveActiveUrl(devMode);
  }

  private headers(creds: FlowCreds = {}): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (creds.secret) headers['X-Flow-Secret'] = creds.secret;
    if (creds.token) headers.Authorization = `Bearer ${creds.token}`;
    return headers;
  }

  private async request<T>(path: string, init: RequestInit, creds: FlowCreds = {}): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, { ...init, headers: this.headers(creds) });
    if (!res.ok) {
      let code: string | undefined;
      try {
        code = ((await res.json()) as { code?: string }).code;
      } catch {
        code = undefined;
      }
      throw new FlowHttpError(res.status, code);
    }
    return (await res.json()) as T;
  }

  create(body: CreateFlowRequest, token?: string): Promise<CreateFlowResponse> {
    return this.request<CreateFlowResponse>('/flows/onboard', { method: 'POST', body: JSON.stringify(body) }, { token });
  }

  next(flowId: string, body: NextRequest, creds: FlowCreds): Promise<{ step: unknown }> {
    return this.request<{ step: unknown }>(
      `/flows/${flowId}/next`,
      { method: 'POST', body: JSON.stringify(body) },
      creds,
    );
  }

  confirm(flowId: string, planHash: string, accepted: boolean, creds: FlowCreds): Promise<unknown> {
    return this.request(
      `/flows/${flowId}/confirm`,
      { method: 'POST', body: JSON.stringify({ plan_hash: planHash, accepted }) },
      creds,
    );
  }

  async cancel(flowId: string, creds: FlowCreds): Promise<void> {
    await this.request(`/flows/${flowId}/cancel`, { method: 'POST', body: '{}' }, creds);
  }
}

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
import { OnboardObservations } from './onboard/observe';

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
  observations: OnboardObservations;
  last_step?: {
    step_id: string;
    outcome: 'ok' | 'failed';
    code?: string;
    result?: { org_id?: string; project_id?: string; branch?: string };
  };
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

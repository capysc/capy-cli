/**
 * Auth-service HTTP transport helpers, shared by the interactive flows in
 * AuthService and the refresh path in SessionLifecycle. Moved verbatim from
 * authService.ts; authService re-exports HttpStatusError so `instanceof`
 * checks and existing imports keep working unchanged.
 */
export class HttpStatusError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body?: any) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
    this.body = body;
  }
}

export async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = (data as any).error || `Request failed with status ${res.status}`;
    throw new HttpStatusError(message, res.status, data);
  }
  return res.json() as Promise<T>;
}

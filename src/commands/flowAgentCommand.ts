import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { AuthService } from '../auth/authService';
import { resolveInitRunIdentity } from '../auth/initRunIdentity';
import { resolveActiveUrl } from '../config/profileConfig';
import { ProjectManager } from '../core/projectManager';
import { flowAgentSocketPath } from '../ui/flowAgentBridge';

type Json = Readonly<Record<string, unknown>>;
const record = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const json = (output: Writable, value: Json): void => { output.write(`${JSON.stringify(value)}\n`); };
const parse = (line: string): Json | null => {
  try { return record(JSON.parse(line)); }
  catch { return null; }
};
const readResponse = async (iterator: AsyncIterator<string>): Promise<Json | null> => {
  const next = await iterator.next();
  return next.done ? null : parse(next.value);
};

/** Check the socket against the public key already authenticated by the service. */
export const verifyFlowAgentChallenge = (publicKey: string, flowId: string, nonce: string, response: Json | null): boolean => {
  if (response?.v !== 1 || response.flow_id !== flowId || response.nonce !== nonce || typeof response.signature !== 'string') return false;
  try {
    const raw = Buffer.from(publicKey, 'base64');
    if (raw.length !== 65 || raw[0] !== 4) return false;
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    return verify('sha256', Buffer.from(`capy.flow.agent.v1\n${flowId}\n${nonce}`), key, Buffer.from(response.signature, 'base64'));
  } catch { return false; }
};

const connect = async (flowId: string): Promise<ReturnType<typeof createConnection>> => new Promise((resolve, reject) => {
  const socket = createConnection(flowAgentSocketPath(flowId));
  socket.setTimeout(10_000, () => socket.destroy(new Error('FLOW_ATTACHMENT_TIMEOUT')));
  socket.once('connect', () => resolve(socket));
  socket.once('error', reject);
});

/** Attach to the authenticated live runtime; neither tokens nor private keys are printed. */
export const runFlowAgentCommand = async (
  input: Readable,
  output: Writable,
  options: Readonly<{ readonly flowId: string; readonly devMode: boolean }>,
): Promise<number> => {
  const fail = (code: string): number => { json(output, { v: 1, ok: false, flow_id: options.flowId, code }); return 1; };
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.flowId)) return fail('FLOW_AGENT_REQUEST_INVALID');
  const authorization = await (async () => {
    try {
      const project = await new ProjectManager().detectProjectState();
      const auth = new AuthService(undefined, options.devMode, project.userId);
      const identity = await auth.authenticateSilent();
      const token = await auth.getValidToken();
      if (!identity.success || !identity.user_id || !token?.access_token) return null;
      return { auth, userId: identity.user_id, accessToken: token.access_token };
    } catch { return null; }
  })();
  if (!authorization) return fail('FLOW_ATTACHMENT_AUTH_REQUIRED');
  const history = await (async () => {
    try {
      const response = await fetch(`${resolveActiveUrl(options.devMode)}/flows/${options.flowId}/messages?after=0&wait_ms=0`, {
        headers: { Authorization: `Bearer ${authorization.accessToken}` }, signal: AbortSignal.timeout(15_000),
      });
      return response.ok ? record(await response.json()) : null;
    } catch { return null; }
  })();
  if (!history || history.flow_id !== options.flowId || history.owner !== authorization.userId
    || history.repo_fingerprint !== resolveInitRunIdentity().repositoryFingerprint || typeof history.client_pubkey !== 'string') return fail('FLOW_ATTACHMENT_FORBIDDEN');
  if (history.state !== 'active') return fail('FLOW_ATTACHMENT_UNAVAILABLE');
  const socket = await connect(options.flowId).catch(() => null);
  if (!socket) return fail('FLOW_ATTACHMENT_UNAVAILABLE');
  const responseLines = createInterface({ input: socket, crlfDelay: Infinity });
  const responses = responseLines[Symbol.asyncIterator]();
  try {
    const nonce = randomUUID();
    socket.write(`${JSON.stringify({ v: 1, action: 'challenge', flow_id: options.flowId, nonce })}\n`);
    if (!verifyFlowAgentChallenge(history.client_pubkey, options.flowId, nonce, await readResponse(responses))) return fail('FLOW_ATTACHMENT_RUNTIME_MISMATCH');
    socket.setTimeout(0);
    const lines = createInterface({ input, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    const run = async (): Promise<number> => {
      const next = await iterator.next();
      if (next.done) return 0;
      const request = parse(next.value);
      if (!request || typeof request.id !== 'string' || typeof request.action !== 'string' || request.action === 'challenge') {
        json(output, { v: 1, ok: false, code: 'FLOW_AGENT_REQUEST_INVALID' });
        return run();
      }
      const token = await authorization.auth.getValidToken();
      if (!token?.access_token || token.user_id !== authorization.userId) return fail('FLOW_ATTACHMENT_AUTH_REQUIRED');
      socket.write(`${JSON.stringify({ ...request, v: 1, token: token.access_token })}\n`);
      const response = await readResponse(responses);
      if (!response || response.id !== request.id) return fail('FLOW_ATTACHMENT_DISCONNECTED');
      json(output, response);
      return response.ok === false ? 1 : run();
    };
    try { return await run(); }
    finally { lines.close(); }
  } catch { return fail('FLOW_ATTACHMENT_DISCONNECTED'); }
  finally { responseLines.close(); socket.end(); socket.destroy(); }
};

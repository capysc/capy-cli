import { AuthService } from '../auth/authService';
import { resolveInitRunIdentity } from '../auth/initRunIdentity';
import { resolveActiveUrl } from '../config/profileConfig';
import { readLocalRoot } from '../config/globalConfig';
import { ProjectManager } from '../core/projectManager';
import { keepOrigin } from './screens/keepScreens';
import { findFlowRecoveryBootstraps } from './flowRecoveryStore';

type Data = Readonly<Record<string, unknown>>;
export type OpenRecoveryFlow = Readonly<{ readonly flow_id: string; readonly url: string; readonly cli_attached: boolean }>;

/** A local record alone never authorizes resuming; the service owns open/closed state. */
export const selectOpenRecoveryFlow = (history: Data, expected: Readonly<{
  readonly flow_id: string; readonly owner_id: string; readonly runtime_id: string;
  readonly repo_fingerprint: string; readonly client_pubkey: string;
}>): OpenRecoveryFlow | null => {
  if (history.flow_id !== expected.flow_id || history.owner !== expected.owner_id
    || history.runtime_id !== expected.runtime_id || history.repo_fingerprint !== expected.repo_fingerprint
    || history.client_pubkey !== expected.client_pubkey) throw new Error('CONVERSATION_BINDING_MISMATCH');
  return history.state === 'active'
    ? { flow_id: expected.flow_id, url: `${keepOrigin()}/flow/conversation?f=${encodeURIComponent(expected.flow_id)}`, cli_attached: history.cli_attached !== false }
    : null;
};

/** Discovery is read-only: never renew a lease, change accounts, or replay a command. */
export const discoverOpenRecoveryFlows = async (devMode: boolean, expectedUserId?: string): Promise<readonly OpenRecoveryFlow[]> => {
  const project = await new ProjectManager().detectProjectState();
  if (!project.userId || !project.organizationId) return [];
  if (expectedUserId && project.userId !== expectedUserId) throw new Error('AUTH_ACCOUNT_MISMATCH');
  const root = readLocalRoot(project.organizationId, project.userId);
  if (!root) return [];
  const origin = resolveActiveUrl(devMode);
  const repoFingerprint = resolveInitRunIdentity().repositoryFingerprint;
  const records = findFlowRecoveryBootstraps(root, {
    origin, owner_id: project.userId, organization_id: project.organizationId, repo_fingerprint: repoFingerprint,
  });
  if (records.length === 0) return [];
  const auth = new AuthService(undefined, devMode, project.userId);
  const identity = await auth.authenticateSilent(project.organizationId);
  if (!identity.success || identity.user_id !== project.userId) throw new Error('FLOW_ATTACHMENT_AUTH_REQUIRED');
  const token = await auth.getValidToken();
  if (!token?.access_token || token.user_id !== project.userId) throw new Error('FLOW_ATTACHMENT_AUTH_REQUIRED');
  const collect = async (remaining: typeof records, found: readonly OpenRecoveryFlow[]): Promise<readonly OpenRecoveryFlow[]> => {
    const record = remaining[0];
    if (!record) return found;
    const response = await fetch(`${origin}/flows/${record.binding.flow_id}/messages?after=0&wait_ms=0`, {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15_000),
    }).catch(() => { throw new Error('FLOW_RECOVERY_STATUS_UNAVAILABLE'); });
    if (response.status === 404 || response.status === 410) return collect(remaining.slice(1), found);
    if (!response.ok) throw new Error('FLOW_RECOVERY_STATUS_UNAVAILABLE');
    const open = selectOpenRecoveryFlow(await response.json() as Data, record.binding);
    return collect(remaining.slice(1), open ? [...found, open] : found);
  };
  return collect(records, []);
};

export const reportOpenRecoveryFlows = (flows: readonly OpenRecoveryFlow[], devMode: boolean): void => {
  const executable = process.env.CAPY_BIN_NAME ?? (devMode ? 'capy-dev' : 'capy');
  process.stdout.write(`${JSON.stringify({
    ok: true, type: 'open_flows', command: 'capy', requires_action: true,
    flows: flows.map(flow => ({ ...flow, actions: {
      continue: { command: executable, args: ['flow', '--resume', flow.flow_id, '--json'] },
      abandon: { command: executable, args: ['flow', '--abandon', flow.flow_id, '--json'] },
    } })),
    instructions: [
      'This repository has unfinished work in Keep. Ask the user whether to continue or abandon it; do not start onboarding or report setup complete.',
      'For a live runtime, read its original process output and attach to its handoff. Do not replace it. For a disconnected runtime, use the continue command after the user chooses Continue.',
      'Abandon explicitly closes the selected flow without undoing completed work. Never choose it automatically.',
    ],
  })}\n`);
};

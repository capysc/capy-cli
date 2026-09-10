import type { InitRunTerminalReceipt } from '../auth/initRunContract';
import type { Blocked, InitEncryptFailure, InitStep } from './screens/contract';
import { InitWizardSession } from './initWizardScreen';
import type { InitQuestion, InitWizardRecord } from './initWizardQuestions';
import {
  abortHostedInitWizard,
  askHostedInitQuestion,
  blockHostedInitWizard,
  finishHostedInitWizard,
  recordHostedInitWizard,
  reportHostedEncryptFailure,
  type HostedInitWizardSession,
} from './hostedInitWizardSession';

export type InitWizardTransport =
  | Readonly<{ kind: 'local'; session: InitWizardSession }>
  | Readonly<{ kind: 'hosted'; session: HostedInitWizardSession }>;

export function recordInitWizard(
  transport: InitWizardTransport,
  patch: InitWizardRecord,
): InitWizardTransport {
  return transport.kind === 'local'
    ? { kind: 'local', session: transport.session.record(patch) }
    : { kind: 'hosted', session: recordHostedInitWizard(transport.session, patch) };
}

export async function askInitWizard<T>(
  transport: InitWizardTransport,
  question: InitQuestion<T>,
): Promise<Readonly<{ value: T | null; transport: InitWizardTransport }>> {
  const result = transport.kind === 'local'
    ? await transport.session.askQuestion(question)
    : await askHostedInitQuestion(transport.session, question);
  return {
    value: result.value,
    transport: { kind: transport.kind, session: result.session } as InitWizardTransport,
  };
}

export function blockInitWizard(
  transport: InitWizardTransport,
  step: InitStep,
  blocked: Blocked,
  extra: Readonly<{
    names?: readonly string[];
    facts?: readonly Readonly<{ label: string; value: string }>[];
  }> = {},
): InitWizardTransport {
  return transport.kind === 'local'
    ? { kind: 'local', session: transport.session.willBlock(step, blocked, extra) }
    : { kind: 'hosted', session: blockHostedInitWizard(transport.session, step, blocked, extra) };
}

export async function finishInitWizard(
  transport: InitWizardTransport,
  hostedReceipt?: InitRunTerminalReceipt,
): Promise<InitWizardTransport> {
  if (transport.kind === 'local') {
    return { kind: 'local', session: await transport.session.finish() };
  }
  if (!hostedReceipt) throw new Error('INIT_RUN_TERMINAL_RECEIPT_REQUIRED');
  return { kind: 'hosted', session: await finishHostedInitWizard(transport.session, hostedReceipt) };
}

export async function abortInitWizard(
  transport: InitWizardTransport,
  error: unknown,
  hostedReceipt?: InitRunTerminalReceipt,
): Promise<InitWizardTransport> {
  if (transport.kind === 'local') {
    return { kind: 'local', session: await transport.session.abort(error) };
  }
  if (!hostedReceipt) throw new Error('INIT_RUN_TERMINAL_RECEIPT_REQUIRED');
  return { kind: 'hosted', session: await abortHostedInitWizard(transport.session, hostedReceipt, error) };
}

export async function reportInitWizardEncryptFailure(
  transport: InitWizardTransport,
  failure: InitEncryptFailure,
  hostedReceipt?: InitRunTerminalReceipt,
): Promise<InitWizardTransport> {
  if (transport.kind === 'local') {
    return { kind: 'local', session: await transport.session.reportEncryptFailure(failure) };
  }
  if (!hostedReceipt) throw new Error('INIT_RUN_TERMINAL_RECEIPT_REQUIRED');
  return {
    kind: 'hosted',
    session: await reportHostedEncryptFailure(transport.session, hostedReceipt, failure),
  };
}

import type { InitWizardInput } from '../core/initWizardPlan';
import type { InitRunTerminalReceipt } from '../auth/initRunContract';
import type { Blocked, InitEncryptFailure, InitStep } from './screens/contract';
import { buildInitWizardData, blockedFromError, type InitWizardView } from './initWizardScreen';
import type { InitQuestion, InitWizardRecord } from './initWizardQuestions';
import {
  askHostedInitChannel,
  closeHostedInitChannel,
  finishHostedInitChannel,
  type HostedInitChannel,
} from './hostedInitChannel';

type BlockDeclaration = Readonly<{
  step: InitStep;
  view: Readonly<Omit<InitWizardView, 'input' | 'step'>>;
}>;

export interface HostedInitWizardSession {
  readonly channel: HostedInitChannel;
  readonly input: Readonly<InitWizardInput>;
  readonly step: InitStep;
  readonly block: BlockDeclaration | null;
  readonly encryptView: Readonly<Pick<InitWizardView, 'localEnv' | 'target'>> | null;
  readonly ended: boolean;
}

export function createHostedInitWizardSession(channel: HostedInitChannel): HostedInitWizardSession {
  return {
    channel,
    input: {},
    step: 'organization',
    block: null,
    encryptView: null,
    ended: false,
  };
}

export function recordHostedInitWizard(
  session: HostedInitWizardSession,
  patch: InitWizardRecord,
): HostedInitWizardSession {
  return { ...session, input: { ...session.input, ...patch } };
}

export function blockHostedInitWizard(
  session: HostedInitWizardSession,
  step: InitStep,
  blocked: Blocked,
  extra: Readonly<{
    names?: readonly string[];
    facts?: readonly Readonly<{ label: string; value: string }>[];
  }> = {},
): HostedInitWizardSession {
  return {
    ...session,
    block: {
      step,
      view: {
        blocked,
        ...(extra.names ? { blockedNames: [...extra.names] } : {}),
        ...(extra.facts ? { blockedFacts: extra.facts.map((fact) => ({ ...fact })) } : {}),
      },
    },
  };
}

export async function askHostedInitQuestion<T>(
  session: HostedInitWizardSession,
  question: InitQuestion<T>,
): Promise<Readonly<{ value: T | null; session: HostedInitWizardSession }>> {
  if (session.ended) throw new Error('INIT_WIZARD_ENDED');
  const data = buildInitWizardData({ ...question.view, input: session.input }, '');
  const result = await askHostedInitChannel<
    Readonly<{ value: T; record: InitWizardRecord }>,
    typeof data
  >({
    channel: session.channel,
    screen: 'init-wizard',
    data,
    decide: (payload) => {
      const verdict = question.decide(payload);
      return 'error' in verdict ? verdict : { value: verdict };
    },
  });
  if (result.kind === 'cancelled') {
    return {
      value: null,
      session: { ...session, channel: result.channel, step: question.view.step, ended: true },
    };
  }
  const answered = result.value;
  return {
    value: answered.value,
    session: {
      ...session,
      channel: result.channel,
      input: { ...session.input, ...answered.record },
      step: question.view.step,
      encryptView: question.view.step === 'encrypt'
        ? { localEnv: question.view.localEnv, target: question.view.target }
        : session.encryptView,
    },
  };
}

function terminalView(
  session: HostedInitWizardSession,
  kind: 'success' | 'abort' | 'encrypt-failure',
  detail?: unknown,
): Readonly<{ step: InitStep; data: ReturnType<typeof buildInitWizardData> }> {
  const declared = kind === 'abort' ? session.block : null;
  const step = kind === 'encrypt-failure' ? 'encrypt' : declared?.step ?? session.step;
  const view = kind === 'abort'
    ? declared?.view ?? { blocked: blockedFromError(detail) }
    : kind === 'encrypt-failure'
      ? { ...(session.encryptView ?? {}), encryptFailure: detail as InitEncryptFailure }
      : {};
  const input = kind === 'encrypt-failure'
    ? { ...session.input, encrypt: undefined }
    : session.input;
  return { step, data: buildInitWizardData({ ...view, step, input }, '') };
}

async function endHostedInitWizard(
  session: HostedInitWizardSession,
  receipt: InitRunTerminalReceipt,
  kind: 'success' | 'abort' | 'encrypt-failure',
  detail?: unknown,
): Promise<HostedInitWizardSession> {
  if (session.ended) return session;
  const final = terminalView(session, kind, detail);
  await finishHostedInitChannel(session.channel, {
    screen: 'init-wizard',
    data: final.data,
    receipt,
  });
  return {
    ...session,
    input: kind === 'encrypt-failure' ? { ...session.input, encrypt: undefined } : session.input,
    step: final.step,
    ended: true,
  };
}

export const finishHostedInitWizard = (
  session: HostedInitWizardSession,
  receipt: InitRunTerminalReceipt,
): Promise<HostedInitWizardSession> => endHostedInitWizard(session, receipt, 'success');

export const abortHostedInitWizard = (
  session: HostedInitWizardSession,
  receipt: InitRunTerminalReceipt,
  error?: unknown,
): Promise<HostedInitWizardSession> => endHostedInitWizard(session, receipt, 'abort', error);

export const reportHostedEncryptFailure = (
  session: HostedInitWizardSession,
  receipt: InitRunTerminalReceipt,
  failure: InitEncryptFailure,
): Promise<HostedInitWizardSession> => endHostedInitWizard(session, receipt, 'encrypt-failure', failure);

export async function closeHostedInitWizard(session: HostedInitWizardSession): Promise<HostedInitWizardSession> {
  if (!session.ended) await closeHostedInitChannel(session.channel);
  return { ...session, ended: true };
}

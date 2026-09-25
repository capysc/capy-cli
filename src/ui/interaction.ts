import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import inquirer from 'inquirer';
import type { SyncConflictData } from './screens/contract';

export type InteractionOutput = Readonly<{
  readonly text: string;
  readonly level?: 'info' | 'warning' | 'error';
  /** Structured sync state for a browser conversation. Terminal copy remains terminal-owned. */
  readonly sync_conflict?: SyncConflictData;
  /** Conversation-only context. It never contains secret values or terminal copy. */
  readonly welcome?: InteractionWelcome;
}>;
export type InteractionWelcome = Readonly<{
  readonly username: string | null;
  readonly project: string | null;
  readonly organization: string | null;
  readonly branch: string | null;
  readonly flowName: string | null;
}>;
/**
 * Optional rendering hint supplied by the command that owns a turn.  It is
 * deliberately descriptive only: transports must never derive it from text.
 */
export type InteractionPresentation = Readonly<{
  readonly title?: string;
  readonly component?: string;
}>;
export type ProviderAuthentication = Readonly<{
  id: string; provider: string; authorization_url: string | null; verification_code: string | null;
  state: 'starting' | 'pending' | 'authorized' | 'failed'; expires_at: string | null; failure_code?: string;
}>;
export type InteractionProgress = Readonly<{ readonly status: 'start' | 'success' | 'failure' | 'warning'; readonly text: string; readonly provider_auth?: ProviderAuthentication }>;
export type InteractionInvocation = Readonly<{ flow: string; goal: string }>;
export type InteractionGoal = Readonly<{
  readonly flow?: string;
  readonly goal?: string;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  readonly code?: string;
  readonly message?: string;
  readonly presentation?: InteractionPresentation;
}>;
export type InteractionQuestion<T> = Readonly<{
  readonly view: unknown;
  readonly decide: (payload: Readonly<Record<string, unknown>>) =>
    | Readonly<{ readonly error: string }>
    | Readonly<{ readonly value: T }>;
  readonly presentation?: InteractionPresentation;
}>;

/**
 * The command's UI boundary. Flow transports install an implementation around
 * the normal command; terminal calls never install one and continue using
 * inquirer/stdout directly.
 */
export type Interaction = Readonly<{
  readonly output: (event: InteractionOutput) => void | Promise<void>;
  readonly progress: (event: InteractionProgress) => void | Promise<void>;
  readonly prompt: <T>(question: InteractionQuestion<T>) => Promise<T | null>;
  readonly goal: (outcome: InteractionGoal) => void | Promise<void>;
}>;

const interactions = new AsyncLocalStorage<Interaction>();

export const runWithInteraction = async <T>(
  interaction: Interaction,
  operation: () => Promise<T>,
): Promise<T> => interactions.run(interaction, operation);

export const currentInteraction = (): Interaction | undefined => interactions.getStore();

export const emitInteractionOutput = (message: string): void => {
  const interaction = currentInteraction();
  if (interaction) void interaction.output({ text: message });
};

/** Emits encrypted conversation context without changing terminal output. */
export const emitInteractionWelcome = (welcome: InteractionWelcome): void => {
  const interaction = currentInteraction();
  if (interaction) void interaction.output({ text: '', welcome });
};

export const emitInteractionProgress = (event: InteractionProgress): void => {
  const interaction = currentInteraction();
  if (interaction) void interaction.progress(event);
};

export const emitInteractionGoal = async (outcome: InteractionGoal): Promise<void> => {
  await currentInteraction()?.goal(outcome);
};

const invocations = new AsyncLocalStorage<InteractionInvocation>();
export const currentInteractionInvocation = (): InteractionInvocation | undefined => invocations.getStore();

/** Prerequisites cannot terminate their owning operation. Only its returned outcome can. */
export const runInteractionOperation = async (
  invocation: InteractionInvocation | undefined,
  operation: () => Promise<InteractionGoal>,
  onError: (error: unknown) => InteractionGoal,
): Promise<Readonly<{ outcome: InteractionGoal; error?: unknown }>> => {
  const parent = currentInteraction();
  const execute = async (): Promise<Readonly<{ outcome: InteractionGoal; error?: unknown }>> => {
    try { return { outcome: await operation() }; }
    catch (error) { return { outcome: onError(error), error }; }
  };
  const prerequisite = (): ReturnType<typeof execute> => parent
    ? runWithInteraction({ ...parent, goal: async () => undefined }, execute)
    : execute();
  const completed = invocation ? await invocations.run(invocation, prerequisite) : await prerequisite();
  const outcome = { ...completed.outcome, ...invocation };
  // Outside the operation catch: an unacknowledged terminal write must not become a second goal.
  await emitInteractionGoal(outcome);
  return { ...completed, outcome };
};

/** Returns undefined outside an interaction so callers can retain their TTY prompt. */
export const askInteraction = <T>(question: InteractionQuestion<T>): Promise<T | null> | undefined =>
  currentInteraction()?.prompt(question);

type JsonRecord = Readonly<Record<string, unknown>>;
const jsonLine = (output: Writable, record: JsonRecord): void => {
  output.write(`${JSON.stringify(record)}\n`);
};
const parseJsonRecord = (line: string): JsonRecord | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
};

const readJsonAnswer = async <T>(
  iterator: AsyncIterator<string>,
  output: Writable,
  id: string,
  question: InteractionQuestion<T>,
): Promise<T | null> => {
  const next = await iterator.next();
  if (next.done) return null;
  const record = parseJsonRecord(next.value);
  const payload = record?.type === 'answer' && record.id === id && record.payload !== null
    && typeof record.payload === 'object' && !Array.isArray(record.payload)
    ? record.payload as Readonly<Record<string, unknown>> : null;
  if (payload === null) {
    jsonLine(output, { type: 'input-error', id, message: 'Expected an answer record for the current prompt.' });
    return readJsonAnswer(iterator, output, id, question);
  }
  const decision = question.decide(payload);
  if ('error' in decision) {
    jsonLine(output, { type: 'input-error', id, message: decision.error });
    return readJsonAnswer(iterator, output, id, question);
  }
  return decision.value;
};

/**
 * Explicit stdin/stdout adapter for `capy --json`. Each output is one JSONL
 * record. It deliberately lives outside the command so Flow can provide an
 * encrypted adapter without stdout capture or console monkey-patching.
 */
export const createJsonLineInteraction = (input: Readable, output: Writable): Interaction => {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const prompt = async <T>(question: InteractionQuestion<T>): Promise<T | null> => {
    const id = crypto.randomUUID();
    jsonLine(output, { type: 'prompt', id, question: question.view });
    return readJsonAnswer(iterator, output, id, question);
  };
  return {
    output: event => jsonLine(output, { type: 'output', ...event }),
    progress: event => jsonLine(output, { type: 'progress', ...event }),
    prompt,
    goal: ({ presentation: _presentation, ...outcome }) => jsonLine(output, { type: 'goal', ...outcome }),
  };
};

type TerminalQuestion = Readonly<Record<string, unknown>> & Readonly<{ readonly presentation?: InteractionPresentation }>;
export class ExitPromptError extends Error {
  readonly name = 'ExitPromptError';
}
/** Fatal command failures must escape per-item batch catches. */
export class InteractionCommandError extends Error {
  constructor(readonly code: string, message: string = code) { super(message); }
}
export const interactionOrTerminal = (nonTty?: boolean): boolean =>
  currentInteraction() !== undefined || (!nonTty && process.stdin.isTTY === true);
export function commandExit(code: number, message = 'The command could not complete this step.'): never {
  if (currentInteraction()) throw new InteractionCommandError(`COMMAND_EXIT_${code}`, message);
  process.exit(code);
};
const choiceRecord = (choice: unknown): TerminalQuestion | undefined =>
  typeof choice === 'object' && choice !== null ? choice as TerminalQuestion : undefined;
const choiceValue = (choice: unknown): unknown => {
  const record = choiceRecord(choice);
  return record && 'value' in record ? record.value : record && 'name' in record ? record.name : choice;
};
const choiceLabel = (choice: unknown): string => String(choiceRecord(choice)?.name ?? choice);
const resolveSetting = (value: unknown, answers: TerminalQuestion): unknown =>
  typeof value === 'function' ? value(answers) : value;

const askTerminalQuestion = async (question: TerminalQuestion, answers: TerminalQuestion): Promise<TerminalQuestion> => {
  const interaction = currentInteraction();
  if (!interaction) return await inquirer.prompt([question as any], answers);
  const name = String(question.name);
  const kind = String(question.type ?? 'input');
  const offered = resolveSetting(question.choices, answers);
  const choices = Array.isArray(offered) ? offered.flatMap((choice, index) => {
    const record = choiceRecord(choice);
    if (record?.type === 'separator') return [];
    return [{ label: choiceLabel(choice), value: `choice:${index}`, original: choiceValue(choice),
      disabled: Boolean(resolveSetting(record?.disabled, answers)), checked: record?.checked === true }];
  }) : undefined;
  const defaultValue = resolveSetting(question.default, answers);
  const initial = choices ? kind === 'checkbox'
    ? choices.filter(choice => !choice.disabled && (Array.isArray(defaultValue)
      ? defaultValue.some(value => Object.is(value, choice.original)) : choice.checked)).map(choice => choice.value)
    : choices.find(choice => Object.is(choice.original, defaultValue))?.value
    : defaultValue;
  const answer = await interaction.prompt<Readonly<{ answer: unknown }>>({
    view: { text: String(resolveSetting(question.message, answers) ?? ''),
      ...(question.secretSummary === undefined ? {} : { secretSummary: question.secretSummary }),
      input: { kind, ...(choices ? { choices: choices.map(({ label, value, disabled }) => ({ label, value, disabled })) } : {}),
        ...(initial === undefined ? {} : { default: initial }) } },
    ...(question.presentation === undefined ? {} : { presentation: question.presentation }),
    decide: payload => {
      const raw = payload.value;
      const decode = (token: unknown) => choices?.find(choice => choice.value === token && !choice.disabled);
      if (choices && (kind === 'checkbox'
        ? !Array.isArray(raw) || raw.some(token => !decode(token)) || new Set(raw).size !== raw.length
        : !decode(raw))) return { error: 'That is not one of the available choices.' };
      if (!choices && (kind === 'confirm' ? typeof raw !== 'boolean' : typeof raw !== 'string')) {
        return { error: kind === 'confirm' ? 'Choose yes or no.' : 'Enter a text response.' };
      }
      const decoded = choices ? kind === 'checkbox'
        ? (raw as readonly unknown[]).map(token => decode(token)!.original) : decode(raw)!.original : raw;
      const value = typeof question.filter === 'function' ? question.filter(decoded, answers) : decoded;
      const validation = typeof question.validate === 'function' ? question.validate(value, answers) : true;
      if (validation instanceof Promise) return { error: 'This question requires synchronous validation.' };
      return validation === true || validation === undefined ? { value: { answer: value } } : { error: String(validation) };
    },
  });
  if (answer === null) throw new ExitPromptError('Interaction cancelled');
  return { ...answers, [name]: answer.answer };
};

/** Questions and value objects stay CLI-owned; remote choices contain opaque IDs only. */
export const prompt = async <T = any>(questions: readonly TerminalQuestion[]): Promise<T> => {
  if (!currentInteraction()) return await inquirer.prompt(questions as any) as T;
  const ask = async (index: number, answers: TerminalQuestion): Promise<TerminalQuestion> => {
    const question = questions[index];
    if (!question) return answers;
    const enabled = question.when === undefined || resolveSetting(question.when, answers) !== false;
    return ask(index + 1, enabled ? await askTerminalQuestion(question, answers) : answers);
  };
  return await ask(0, {}) as T;
};

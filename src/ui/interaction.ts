import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { InitQuestion } from './initWizardQuestions';
import inquirer from 'inquirer';

export type InteractionOutput = Readonly<{ readonly text: string }>;
export type InteractionProgress = Readonly<{ readonly status: 'start' | 'success' | 'failure' | 'warning'; readonly text: string }>;
export type InteractionGoal = Readonly<{
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  readonly code?: string;
  readonly message?: string;
}>;
export type InteractionQuestion<T> = Readonly<{
  readonly view: unknown;
  readonly decide: (payload: Readonly<Record<string, unknown>>) =>
    | Readonly<{ readonly error: string }>
    | Readonly<{ readonly value: T }>;
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

export const emitInteractionProgress = (event: InteractionProgress): void => {
  const interaction = currentInteraction();
  if (interaction) void interaction.progress(event);
};

export const emitInteractionGoal = (outcome: InteractionGoal): void => {
  const interaction = currentInteraction();
  if (interaction) void interaction.goal(outcome);
};

/** Returns undefined outside an interaction so callers can retain their TTY prompt. */
export const askInteraction = <T>(question: InitQuestion<T>): Promise<T | null> | undefined =>
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
    goal: outcome => jsonLine(output, { type: 'goal', ...outcome }),
  };
};

type TerminalQuestion = Readonly<Record<string, unknown>>;
class ExitPromptError extends Error {
  readonly name = 'ExitPromptError';
}
const choiceValue = (choice: unknown): unknown => typeof choice === 'object' && choice !== null
  && 'value' in choice ? (choice as Readonly<{ readonly value: unknown }>).value : choice;
const choiceLabel = (choice: unknown): string => typeof choice === 'object' && choice !== null
  && 'name' in choice ? String((choice as Readonly<{ readonly name: unknown }>).name) : String(choice);

const askTerminalQuestion = async <T>(question: TerminalQuestion): Promise<T> => {
  const interaction = currentInteraction();
  if (!interaction) return (await inquirer.prompt([question as any])) as T;
  const name = String(question.name);
  const choices = Array.isArray(question.choices)
    ? question.choices.map(choice => ({ label: choiceLabel(choice), value: choiceValue(choice) })) : undefined;
  const answer = await interaction.prompt<unknown>({
    view: {
      text: String(question.message ?? ''),
      input: { kind: String(question.type ?? 'input'), choices, default: question.default },
    },
    decide: payload => {
      const value = payload.value;
      const offered = choices?.some(choice => Object.is(choice.value, value));
      if (choices !== undefined && !offered) return { error: 'That is not one of the available choices.' };
      const validate = typeof question.validate === 'function' ? question.validate as (input: unknown) => unknown : null;
      const validation = validate ? validate(value) : true;
      return validation === true || validation === undefined
        ? { value, record: {} } : { error: String(validation) };
    },
  });
  if (answer === null) {
    throw new ExitPromptError('Interaction cancelled');
  }
  return { [name]: answer } as T;
};

/** A small inquirer-compatible boundary: question objects remain CLI-owned. */
export const prompt = async <T = any>(questions: readonly TerminalQuestion[]): Promise<T> => {
  const first = questions[0];
  return first === undefined ? {} as T : askTerminalQuestion<T>(first);
};

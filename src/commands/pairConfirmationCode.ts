import type { ConfirmationState } from '../auth/deviceGrant';
import { pairCodeRequired } from '../auth/deviceGrant';

/** The question, and what it says after a wrong code. */
export function confirmationQuestion(state: ConfirmationState): string {
  if (!state.mismatch) return 'Enter the code shown in Keep:'; // COPY-FLAG
  const left = state.attemptsLeft === null ? '' : ` ${state.attemptsLeft} ${state.attemptsLeft === 1 ? 'try' : 'tries'} left.`;
  return `That code did not match.${left} Enter the code shown in Keep:`; // COPY-FLAG
}

/**
 * The terminal flow's way to get the one-time code Keep shows the approver (CAP-877). Only a person at this terminal
 * can answer it: off a TTY it refuses with PAIR_CODE_REQUIRED, and nothing is installed.
 */
export async function askConfirmationCode(state: ConfirmationState, json: boolean): Promise<string> {
  if (!process.stdin.isTTY) throw pairCodeRequired();
  const inquirer = (await import('inquirer')).default;
  const prompt = inquirer.createPromptModule({ output: json ? process.stderr : process.stdout });
  const answer = await prompt<{ readonly code: string }>([{ type: 'input', name: 'code', message: confirmationQuestion(state) }]);
  return answer.code;
}

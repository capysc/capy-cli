/**
 * `capy checkout -b NAME` asks one question a flag can answer: whether the new branch is protected. In a terminal it
 * asks; with nobody to ask (spec 3l, CAP-909) the run stops with BRANCH_PROTECTION_REQUIRED (exit 3) and a `form`
 * elicitation asking the terminal's question. The field's values are the two flags, so `answer.rerun` takes the
 * answer as typed. Nothing is created until it is answered.
 */
import type { ElicitationForm } from '../ui/elicitation';
import { binName } from './binName';
import { ASK_FOR_CHOICE } from './agentConfirm';

export const PROTECT_FLAG = '--protected';
export const OPEN_FLAG = '--no-protected';

/** The terminal's question, word for word, without its colour codes. */
export function protectQuestion(branchName: string): string {
  return `Make "${branchName}" a protected branch? (invite-only)`;
}

/** A branch name as the shell takes it: as it is when it is plain, else in single quotes. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function protectionElicitation(branchName: string, devMode: boolean): ElicitationForm {
  return {
    kind: 'form',
    question: protectQuestion(branchName),
    details: { branch: { name: branchName } },
    display: `| | |\n| --- | --- |\n| Branch | ${branchName.replace(/\|/g, '\\|')} |\n| Protected | to choose |`, // COPY-FLAG
    fields: [{
      name: 'protected',
      type: 'string',
      pattern: `^(${PROTECT_FLAG}|${OPEN_FLAG})$`,
      question: protectQuestion(branchName),
      description: 'A protected branch is invite-only; an open one is open to everyone on the project.', // COPY-FLAG
      options: [
        { value: PROTECT_FLAG, label: 'Yes' }, // COPY-FLAG
        { value: OPEN_FLAG, label: 'No' }, // COPY-FLAG
      ],
    }],
    // `--json` with `-b` only describes the route, so the run that creates the branch is the `--non-tty` one.
    answer: { rerun: `${binName(devMode)} checkout ${shellWord(branchName)} -b <protected> --non-tty` },
  };
}

/** The refusal `capy checkout -b NAME --json` prints when protection is unanswered: the route as before, plus the question. */
export function protectionRefusal(branchName: string, devMode: boolean, route: { stops: unknown; unanswered: readonly string[] }): Record<string, unknown> {
  return {
    ok: false,
    code: 'BRANCH_PROTECTION_REQUIRED',
    error: `\`capy checkout -b\` needs to know whether "${branchName}" is protected. ${ASK_FOR_CHOICE}`, // COPY-FLAG
    ...route,
    elicitation: protectionElicitation(branchName, devMode),
  };
}

/** Off a terminal, with no flag: the human-mode stop, naming the two flags. Exit 3. */
export function protectionNeedsFlagMessage(branchName: string): string {
  return `\`capy checkout ${shellWord(branchName)} -b\` has no terminal to ask whether the branch is protected. Run \`capy checkout ${shellWord(branchName)} -b --json\` to get the question for the human.`; // COPY-FLAG
}

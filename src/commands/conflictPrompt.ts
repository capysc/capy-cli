/**
 * The terminal's answer to a conflict (CAP-717): one question per conflicting name, mine or theirs.
 * Off a terminal nothing here runs: `--resolve` / `--conflict` decide (sync/conflicts.ts). Never shows a
 * value, only the name and, for a deploy target, where.
 */
import { resolveKeyOf, type Conflict, type Resolution, type Resolutions } from '../sync/conflicts';

// COPY-FLAG: minimal, neutral wording; pending approval.
function questionFor(conflict: Conflict): string {
  return conflict.kind === 'target'
    ? `${conflict.name} on ${conflict.target} was changed outside Capy. Which value?`
    : `${conflict.name} was changed in Capy since you last synced. Which value?`;
}

// COPY-FLAG: minimal, neutral wording; pending approval.
const unsavedQuestionFor = (names: readonly string[]): string => `${names.join(', ')} changed in this folder and is not saved to Capy. Save and deploy?`;

/**
 * `capy deploy` found folder edits Capy does not hold (CAP-717): one question naming them (never a value).
 * Enter saves them to Capy and delivers; declining stops the deploy with nothing saved and nothing delivered.
 */
export async function askSaveAndDeploy(names: readonly string[]): Promise<boolean> {
  const inquirer = (await import('inquirer')).default;
  const { save } = (await inquirer.prompt([{ type: 'confirm', name: 'save', message: unsavedQuestionFor(names), default: true }])) as { save: boolean };
  return save;
}

/** Asks about each conflict in turn (one prompt, then the rest) and returns the answers by decision key. */
export async function askConflicts(conflicts: readonly Conflict[]): Promise<Resolutions> {
  const inquirer = (await import('inquirer')).default;
  const ask = async (rest: readonly Conflict[], answered: Resolutions): Promise<Resolutions> => {
    if (rest.length === 0) return answered;
    const [conflict, ...later] = rest;
    const { choice } = (await inquirer.prompt([
      {
        type: 'list',
        name: 'choice',
        message: questionFor(conflict),
        choices: [
          { name: 'Mine', value: 'mine' }, // COPY-FLAG
          { name: 'Theirs', value: 'theirs' }, // COPY-FLAG
        ],
      },
    ])) as { choice: Resolution };
    return ask(later, { ...answered, [resolveKeyOf(conflict)]: choice });
  };
  return ask(conflicts, {});
}

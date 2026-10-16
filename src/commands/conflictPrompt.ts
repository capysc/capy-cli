/**
 * The terminal's answer to a platform row (CAP-717): one question per Dokploy value that was changed outside Capy,
 * `local` (deliver Capy's value) or `remote` (keep the platform's and skip it). A folder row is bare `capy`'s own
 * table and menu (commands/capyCommand.ts), never asked here. Off a terminal nothing here runs: `--resolve` /
 * `--conflict` answer (sync/conflicts.ts). Never shows a value, only the name and where.
 */
import { isTargetConflict, resolveKeyOf, type Conflict, type Resolutions, type TargetResolution } from '../sync/conflicts';

// COPY-FLAG: minimal, neutral wording; pending approval.
const questionFor = (conflict: Conflict): string =>
  isTargetConflict(conflict) ? `${conflict.name} on ${conflict.target} was changed outside Capy. Which value?` : `${conflict.name} differs from Capy. Which value?`;

/** Asks about each platform row in turn (one prompt, then the rest) and returns the answers by decision key. */
export async function askPlatformConflicts(conflicts: readonly Conflict[]): Promise<Resolutions> {
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
          { name: "Capy's value (local)", value: 'local' }, // COPY-FLAG
          { name: "The platform's value (remote)", value: 'remote' }, // COPY-FLAG
        ],
      },
    ])) as { choice: TargetResolution };
    return ask(later, { ...answered, [resolveKeyOf(conflict)]: choice });
  };
  return ask(conflicts, {});
}

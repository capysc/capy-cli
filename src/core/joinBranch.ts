/**
 * Which branch a folder is put on when it joins an existing project.
 *
 * One rule for every command that joins (bare `capy`, `capy connect <provider> --discover`): the branch comes from the
 * project's own branch list and is never an assumed name. A person at a terminal is always asked, even when the project has
 * one branch. With nobody to answer the run stops with a code that names the branches, unless the caller already named one.
 * A project with no branch at all offers to create its first (a person at a terminal) or stops with `BRANCH_NOT_FOUND`.
 */
import inquirer from 'inquirer';
import ora from '../ui/spinner';
import { Branch, CapyError, ERROR_CODES } from '../types/index';
import { selectBranchWithServer } from './branchResolver';
import { validateBranchNameInput } from './branchNameRule';

const grey = (s: string): string => `\x1b[90m${s}\x1b[0m`;

/**
 * The branch picker. Off a terminal (`canAsk` false) nobody can pick, so the run ends with `refusal`, a coded error
 * naming the branches, and nothing is guessed.
 */
export async function promptBranchPick(
  canAsk: boolean,
  branches: readonly Branch[],
  defaultName: string | undefined,
  intro: string,
  refusal: (names: readonly string[]) => CapyError,
): Promise<string> {
  if (!canAsk) throw refusal(branches.map((b) => b.name));
  console.log(`\n${intro}`);
  const { selected: pick } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: 'Which branch do you want to use?',
    choices: branches.map(b => ({
      name: b.is_protected ? `${b.name}  ${grey('(protected)')}` : b.name,
      value: b.name,
    })),
    default: defaultName,
  }]);
  return pick;
}

/** Asks whether the initial branch is 'development' or a custom name. */
export async function askInitialBranchChoice(): Promise<string> {
  const { initialBranchChoice } = await inquirer.prompt([{
    type: 'list',
    name: 'initialBranchChoice',
    message: 'What branch should this project start with?',
    choices: [
      { name: 'development (default)', value: 'development' },
      { name: 'another branch', value: 'other' },
    ],
  }]);
  return initialBranchChoice;
}

/** Asks for the custom initial branch name. */
export async function askCustomBranchName(): Promise<string> {
  const { branchName } = await inquirer.prompt([{
    type: 'input',
    name: 'branchName',
    message: 'Branch name:',
    validate: validateBranchNameInput,
  }]);
  return String(branchName).trim();
}

/** What joining a project needs from its caller. */
export interface JoinBranchDeps {
  readonly project: { readonly id: string; readonly name: string };
  readonly listBranches: () => Promise<Branch[]>;
  readonly createBranch: (name: string, isProtected: boolean) => Promise<unknown>;
  /** Whether anyone can be asked: false for a run with no terminal (or `--yes`, `--json`), so a pick is refused with the names. */
  readonly canAsk: boolean;
  /** A branch the caller already named (a flag). It is used as given when the project has it, and nobody is asked. */
  readonly named?: string;
}

/**
 * Joining a project that has no branch at all: its setup stopped after the project was created and before its first
 * branch was. The person names the branch, it is created open to the project, and the join goes on with it.
 * No name is assumed. Only a project admin can create a branch: anyone else gets FIRST_BRANCH_NEEDS_ADMIN, its own code so
 * the screen says who to ask instead of the generic "no access to these secrets".
 */
async function createFirstBranch(deps: JoinBranchDeps): Promise<string> {
  const { project } = deps;
  if (!deps.canAsk || deps.named !== undefined) {
    throw new CapyError(
      `${project.name} has no branches yet. Ask the human to run \`capy\` in a terminal in this folder and create one there.`, // COPY-FLAG
      ERROR_CODES.BRANCH_NOT_FOUND,
      { branches: [] },
    );
  }
  console.log(`\n${project.name} has no branches yet. Create its first branch to join it.`); // COPY-FLAG
  const choice = await askInitialBranchChoice();
  const name = choice === 'other' ? await askCustomBranchName() : choice;
  const spinner = ora(`Creating branch ${name}...`).start();
  try {
    // Open to the project, like a new project's first branch: protection is a separate, later action.
    await deps.createBranch(name, false);
  } catch (err) {
    spinner.fail(`Failed to create branch ${name}`);
    // A 403 with no code of its own is "not a project admin". One that carries a code (a revoked membership) is that refusal, and keeps its screen.
    if (err instanceof CapyError && err.code === ERROR_CODES.PERMISSION_DENIED && err.details?.code === undefined) {
      throw new CapyError(
        `${project.name} has no branches yet, and only a project admin can create one. Ask a project admin to run \`capy\` in a folder for this project and create its first branch.`, // COPY-FLAG
        ERROR_CODES.FIRST_BRANCH_NEEDS_ADMIN,
        { ...err.details, cause: err },
      );
    }
    throw err;
  }
  spinner.succeed(`Created branch ${name}`);
  return name;
}

/** The branch the caller named, when the project has it; otherwise BRANCH_NOT_FOUND naming the branches the project does have. */
function namedBranchOf(deps: JoinBranchDeps, named: string, branches: readonly Branch[]): string {
  if (branches.some((b) => b.name === named)) return named;
  const names = branches.map((b) => b.name);
  throw new CapyError(
    `${deps.project.name} has no branch named "${named}" (branches: ${names.join(', ')}).`, // COPY-FLAG
    ERROR_CODES.BRANCH_NOT_FOUND,
    { branches: names },
  );
}

/**
 * The branch an existing project is joined on: the one the caller named, or the one the person picks from the project's
 * own branch list, even when it has a single branch. Never a branch name assumed here, and never auto-selected: a
 * project's first branch can have any name, and reading or pushing a name the project does not have splits its secrets
 * across a branch nobody created. With nobody to ask, the run stops with the branch names.
 */
export function resolveJoinBranch(deps: JoinBranchDeps): Promise<string> {
  const { project } = deps;
  return selectBranchWithServer({
    listBranches: deps.listBranches,
    syncedBranches: [],
    alwaysAsk: true,
    createFirst: () => createFirstBranch(deps),
    promptPick: async (branches, defaultName) =>
      deps.named !== undefined
        ? namedBranchOf(deps, deps.named, branches)
        : promptBranchPick(deps.canAsk, branches, defaultName, `Joining ${project.name}.`, (names) =>
          new CapyError(
            `Joining ${project.name} needs a branch (branches: ${names.join(', ')}). Pass the one to use with \`--branch <name>\`.`, // COPY-FLAG
            ERROR_CODES.NO_ACTIVE_BRANCH,
            { branches: names },
          )),
  });
}

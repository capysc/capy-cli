import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import inquirer from 'inquirer';
import { isGitRepo } from '../deploy/git';
import { isInteractive } from './interactive';

/** The folder picker's question and first choice; the agent's form asks the same. */
export const FOLDER_QUESTION = 'Which folder contains your project?'; // COPY-FLAG
export const THIS_FOLDER_CHOICE = 'Use this folder'; // COPY-FLAG

/** The keepless-or-shared question and its two choices; the agent's form asks the same, word for word. */
export const SETUP_SHARING_QUESTION = 'How would you like to set up Capy for this project?'; // COPY-FLAG
export const SHARE_CHOICE = {
  folderOnly: {
    label: 'Set up this folder only', // COPY-FLAG
    /** The terminal pre-selects it; an agent's form has no default, so "(default)" is the terminal's alone. */
    terminalSuffix: ' (default)',
    description: 'When teammates set up their own copy of the app, they’ll need to choose this project in Capy to get its secrets.', // COPY-FLAG
  },
  shared: {
    label: 'Share the setup through Git', // COPY-FLAG
    description: 'Capy commits keep.lock so copies of the same code point to the same Capy project and secret versions (this is useful for keeping larger teams or more complex projects in sync).', // COPY-FLAG
  },
} as const;

/** Bound only after the person confirms a directory. Browsing performs no writes. */
export async function pickProjectFolder(folder: string): Promise<string> {
  const directories = readdirSync(folder, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(entry => entry.name);
  const parent = dirname(folder);
  const { selected } = await inquirer.prompt<{ selected: string }>([{
    type: 'list',
    name: 'selected',
    message: `${FOLDER_QUESTION}\n  ${folder}`,
    choices: [
      { name: THIS_FOLDER_CHOICE, value: folder },
      { name: 'Enter a folder path…', value: '' },
      ...(parent === folder ? [] : [{ name: '.. (up one folder)', value: parent }]),
      ...directories.map(name => ({ name: name + '/', value: join(folder, name) })),
    ],
  }]);
  if (selected === folder) return folder;
  if (selected) return pickProjectFolder(selected);
  const { path } = await inquirer.prompt<{ path: string }>([{
    type: 'input',
    name: 'path',
    message: 'Project folder path',
    validate: (value: string) => value.trim() !== '' && statSync(resolve(folder, value), { throwIfNoEntry: false })?.isDirectory() === true || 'Enter an existing folder path.',
  }]);
  return pickProjectFolder(resolve(folder, path));
}

export async function chooseSetupSharing(folder: string, human: boolean): Promise<boolean> {
  if (!human || !isInteractive() || !isGitRepo(folder)) return false;
  const { share } = await inquirer.prompt<{ share: boolean }>([{
    type: 'list',
    name: 'share',
    message: SETUP_SHARING_QUESTION,
    default: false,
    choices: [
      {
        name: `${SHARE_CHOICE.folderOnly.label}${SHARE_CHOICE.folderOnly.terminalSuffix}\n    ${SHARE_CHOICE.folderOnly.description}`,
        short: 'Set up this folder only',
        value: false,
      },
      {
        name: `${SHARE_CHOICE.shared.label}\n    ${SHARE_CHOICE.shared.description}`,
        short: 'Share the setup through Git',
        value: true,
      },
    ],
  }]);
  return share;
}

/** Files that mark a folder as a project, besides a `.env`. */
const PROJECT_MARKERS: readonly string[] = ['.env', 'package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json'];

/**
 * The subfolders of `folder` that look like a project (they hold a `.env` or a package file), by name, at most `limit`,
 * in name order. Read-only; skips hidden folders and node_modules, as the terminal's picker does.
 */
export function projectSubfolders(folder: string, limit: number): readonly string[] {
  return readdirSync(folder, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(entry => entry.name)
    .filter(name => /^[A-Za-z0-9_@%+=:,.-]+$/.test(name))
    .filter(name => PROJECT_MARKERS.some(marker => statSync(join(folder, name, marker), { throwIfNoEntry: false }) !== undefined))
    .sort()
    .slice(0, limit);
}

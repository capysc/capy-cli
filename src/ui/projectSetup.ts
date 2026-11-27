import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import inquirer from 'inquirer';
import { isGitRepo } from '../deploy/git';
import { isInteractive } from './interactive';
import { folderTree, PACKAGE_MARKERS } from './folderTree';

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

/**
 * Bound only after the person confirms a folder. Browsing performs no writes.
 * A tree the person opens and closes (CAP-929): see `folderTree.ts` for the keys.
 */
export async function pickProjectFolder(folder: string): Promise<string> {
  return folderTree({ message: FOLDER_QUESTION, start: folder });
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
const PROJECT_MARKERS: readonly string[] = ['.env', ...PACKAGE_MARKERS];

/** A subfolder that looks like a project, and the first marker file it holds (`.env` when it has one). */
export interface ProjectSubfolder {
  readonly name: string;
  readonly marker: string;
}

/**
 * Every subfolder of `folder` that looks like a project (it holds a `.env` or a package file), as the terminal lists
 * them, with no cap (Vincent, 2026-11-27: "Can you not cap?"): those
 * with a `.env` first, since that is what setup encrypts, then by name. Read-only; skips hidden folders and
 * node_modules, as the terminal's picker does.
 */
export function projectSubfolders(folder: string): readonly ProjectSubfolder[] {
  return readdirSync(folder, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(entry => entry.name)
    .filter(name => /^[A-Za-z0-9_@%+=:,.-]+$/.test(name))
    .flatMap(name => {
      // A subfolder that cannot be read is left out, rather than hiding every other one.
      const marker = PROJECT_MARKERS.find(m => {
        try {
          return statSync(join(folder, name, m), { throwIfNoEntry: false }) !== undefined;
        } catch {
          return false;
        }
      });
      return marker === undefined ? [] : [{ name, marker }];
    })
    .sort((a, b) => Number(b.marker === '.env') - Number(a.marker === '.env') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

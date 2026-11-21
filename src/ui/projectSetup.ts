import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import inquirer from 'inquirer';
import { isGitRepo } from '../deploy/git';
import { isInteractive } from './interactive';

/** Bound only after the person confirms a directory. Browsing performs no writes. */
export async function pickProjectFolder(folder: string): Promise<string> {
  const directories = readdirSync(folder, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(entry => entry.name);
  const parent = dirname(folder);
  const { selected } = await inquirer.prompt<{ selected: string }>([{
    type: 'list',
    name: 'selected',
    message: `Which folder contains your project?\n  ${folder}`,
    choices: [
      { name: 'Use this folder', value: folder },
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
    message: 'How would you like to set up Capy for this project?',
    default: false,
    choices: [
      {
        name: 'Set up this folder only (default)\n    When teammates set up their own copy of the app, they’ll need to choose this project in Capy to get its secrets.',
        short: 'Set up this folder only',
        value: false,
      },
      {
        name: 'Share the setup through Git\n    Capy commits keep.lock so copies of the same code point to the same Capy project and secret versions (this is useful for keeping larger teams or more complex projects in sync).',
        short: 'Share the setup through Git',
        value: true,
      },
    ],
  }]);
  return share;
}

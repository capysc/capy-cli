/**
 * The inquirer project pickers' questions, in one place.
 *
 * Every one is a type-to-filter single-select (see `searchPrompts` for the
 * match rule and for how the "New project" row behaves under a filter). The
 * messages are the ones the pickers have always shown, word for word.
 */
import { searchableSelectQuestion } from './searchPrompts';

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
}

/** `capy` (init): "New project" first and pre-selected, then the org's existing projects. */
export function initProjectQuestion(existing: readonly ProjectRef[], createNewProjectValue: string): any {
  return searchableSelectQuestion({
    name: 'projectChoice',
    message: 'Which project do you want to use?',
    choices: [
      { name: 'New project', value: createNewProjectValue },
      ...existing.map((p) => ({ name: p.name, value: p.id })),
    ],
    default: createNewProjectValue,
  });
}

/** `capy org` switch: the projects of the org just chosen. */
export function orgProjectQuestion(orgProjects: readonly ProjectRef[]): any {
  return searchableSelectQuestion({
    name: 'projectId',
    message: 'Select project:',
    choices: orgProjects.map((p) => ({ name: p.name, value: p.id })),
  });
}

/** Dokploy discovery: "New project (<default name>)" first and pre-selected, then existing projects. */
export function discoveryProjectQuestion(
  existing: readonly ProjectRef[],
  defaultName: string,
  newProjectValue: string,
): any {
  return searchableSelectQuestion({
    name: 'projectChoice',
    message: 'Which project should this folder use?',
    choices: [
      { name: `New project (${defaultName})`, value: newProjectValue },
      ...existing.map((p) => ({ name: p.name, value: p.id })),
    ],
    default: newProjectValue,
  });
}

/** CLI-owned question specifications shared by the two initialization transports. */
import type { InitWizardInput } from '../core/initWizardPlan';
import type { InitWizardView } from './initWizardScreen';
import type { InitLocalEnv, InitOrg, InitProject, InitTarget } from './screens/contract';

type Immutable<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer U)[] ? readonly Immutable<U>[]
    : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type InitWizardRecord = Immutable<Partial<InitWizardInput>>;
export type InitQuestionVerdict<T> = Readonly<{ error: string }> | Readonly<{ value: T; record: InitWizardRecord }>;
export type InitQuestion<T> = Readonly<{
  view: Immutable<Omit<InitWizardView, 'input'>>;
  decide: (payload: Readonly<Record<string, unknown>>) => InitQuestionVerdict<T>;
}>;

export function initProjectNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Project name cannot be empty';
  if (!/^[a-zA-Z0-9-_]+$/u.test(trimmed)) return 'Project name can only contain letters, numbers, hyphens, and underscores';
  return undefined;
}

export function organizationQuestion(orgs: readonly Immutable<InitOrg>[]): InitQuestion<string | 'create'> {
  return {
    view: { step: 'organization', orgs },
    decide: payload => {
      if (payload.createOrganization === true) return { value: 'create', record: { organization: { kind: 'new' } } };
      const id = typeof payload.organizationId === 'string' ? payload.organizationId : '';
      const org = orgs.find(item => item.id === id);
      return org ? { value: id, record: { organization: { kind: 'existing', name: org.name } } }
        : { error: 'That organization is not one this session can reach.' };
    },
  };
}

export function projectQuestion(projects: readonly Immutable<InitProject>[]): InitQuestion<string | 'new'> {
  return {
    view: { step: 'project', projects },
    decide: payload => {
      if (payload.newProject === true) return { value: 'new', record: { project: { kind: 'new' } } };
      const id = typeof payload.projectId === 'string' ? payload.projectId : '';
      const project = projects.find(item => item.id === id);
      return project ? { value: id, record: { project: { kind: 'existing', name: project.name } } }
        : { error: 'That project is not in this organization.' };
    },
  };
}

export function projectNameQuestion(defaultName: string): InitQuestion<string> {
  return {
    view: { step: 'project-name', value: defaultName },
    decide: payload => {
      const name = typeof payload.projectName === 'string' ? payload.projectName.trim() : '';
      const problem = initProjectNameProblem(name);
      return problem ? { error: problem } : { value: name, record: { project: { kind: 'new', name } } };
    },
  };
}

export function branchChoiceQuestion(): InitQuestion<'development' | 'other'> {
  return {
    view: { step: 'branch' },
    decide: payload => payload.branchChoice === 'development' || payload.branchChoice === 'other'
      ? { value: payload.branchChoice, record: { branchChoice: payload.branchChoice } }
      : { error: 'That is not a branch this step offers.' },
  };
}

export function branchNameQuestion(): InitQuestion<string> {
  return {
    view: { step: 'branch-name' },
    decide: payload => {
      const name = typeof payload.branchName === 'string' ? payload.branchName.trim() : '';
      return name.length === 0 ? { error: 'Branch name cannot be empty' }
        : { value: name, record: { branchName: name } };
    },
  };
}

export function encryptQuestion(localEnv: Immutable<InitLocalEnv>, target: Immutable<InitTarget>): InitQuestion<boolean> {
  return {
    view: { step: 'encrypt', localEnv, target },
    decide: payload => typeof payload.encrypt === 'boolean'
      ? { value: payload.encrypt, record: { encrypt: payload.encrypt } }
      : { error: 'That is not an answer the encrypt step can produce.' },
  };
}

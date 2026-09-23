import { expect, test } from 'bun:test';
import {
  branchChoiceQuestion, branchNameQuestion, encryptQuestion,
  organizationQuestion, projectNameQuestion, projectQuestion,
} from '../../src/ui/initWizardQuestions';

test('organization accepts only existing memberships while projects retain creation', () => {
  const orgs = [{ id: 'org_beta', name: 'Beta', isCurrent: false }] as const;
  const org = organizationQuestion(orgs);
  expect(org.decide({ organizationId: 'org_beta' })).toEqual({ value: 'org_beta', record: { organization: { kind: 'existing', name: 'Beta' } } });
  expect(org.decide({ organizationId: 'org_unknown' })).toEqual({ error: 'That organization is not one this session can reach.' });
  expect(org.decide({ createOrganization: true, organizationId: 'org_beta' })).toEqual({ error: 'Create your organization in Keep before initializing this repository.' });
  expect(org.view.orgs).toEqual(orgs);
  const project = projectQuestion([{ id: 'project_beta', name: 'Payments' }]);
  expect(project.decide({ projectId: 'project_unknown' })).toEqual({ error: 'That project is not in this organization.' });
  expect(project.decide({ newProject: true, projectId: 'project_beta' })).toEqual({ value: 'new', record: { project: { kind: 'new' } } });
});

test('project and branch name questions preserve their different validators', () => {
  expect(projectNameQuestion('prefill').view.value).toBe('prefill');
  expect(projectNameQuestion('').decide({ projectName: '  payments-api  ' })).toEqual({ value: 'payments-api', record: { project: { kind: 'new', name: 'payments-api' } } });
  expect(projectNameQuestion('').decide({ projectName: '  ' })).toEqual({ error: 'Project name cannot be empty' });
  expect(projectNameQuestion('').decide({ projectName: 'branch with spaces' })).toEqual({ error: 'Project name can only contain letters, numbers, hyphens, and underscores' });
  expect(branchNameQuestion().decide({ branchName: '  branch with spaces  ' })).toEqual({ value: 'branch with spaces', record: { branchName: 'branch with spaces' } });
  expect(branchNameQuestion().decide({ branchName: ' ' })).toEqual({ error: 'Branch name cannot be empty' });
  expect(branchChoiceQuestion().decide({ branchChoice: 'other' })).toEqual({ value: 'other', record: { branchChoice: 'other' } });
  expect(branchChoiceQuestion().decide({ branchChoice: 'arbitrary' })).toEqual({ error: 'That is not a branch this step offers.' });
});

test('encrypt consent remains a strict boolean and the screen carries only names/count', () => {
  const question = encryptQuestion({ count: 1, names: ['DUMMY_NAME'] }, { orgName: 'Beta', projectName: 'Payments', branch: 'development' });
  for (const payload of [{ encrypt: 'true' }, { encrypt: 1 }, {}, { __action: 'cancel' }]) {
    expect(question.decide(payload)).toEqual({ error: 'That is not an answer the encrypt step can produce.' });
  }
  expect(question.decide({ encrypt: false })).toEqual({ value: false, record: { encrypt: false } });
  expect(question.decide({ encrypt: true })).toEqual({ value: true, record: { encrypt: true } });
  expect(question.view.localEnv).toEqual({ count: 1, names: ['DUMMY_NAME'] });
});

/** ISOLATED (mock.module): selected-organization refresh replacement propagation. */
import { beforeEach, describe, expect, jest, mock, test } from 'bun:test';

const USER_ID = 'user_org_replacement';
const CURRENT_ORG = { id: 'org-current', workos_org_id: 'workos-current', name: 'Current' } as const;
const SELECTED_ORG = { id: 'org-selected', workos_org_id: 'workos-selected', name: 'Selected' } as const;
const CREATED_ORG = { id: 'org-created', workos_org_id: 'workos-created', name: 'Created' } as const;
const SELECTED_PROJECT = { id: 'project-selected', name: 'Selected project', organization_id: SELECTED_ORG.id } as const;
const CREATED_PROJECT = { id: 'project-created', name: 'Created project', organization_id: CREATED_ORG.id } as const;

const detectProjectState = jest.fn();
const writeKeepFile = jest.fn();
const writeSyncState = jest.fn();
const initialSetTokenProvider = jest.fn();
const scopedSetTokenProvider = jest.fn();
const initialListProjects = jest.fn();
const scopedListProjects = jest.fn();
const refreshWithCredentials = jest.fn();
const replacementGetValidToken = jest.fn(async () => ({ authority: 'replacement' }));
const prompt = jest.fn();
const switchOrganizationInBrowser = jest.fn();
const nameFirstProjectInBrowser = jest.fn();
const createNewOrganization = jest.fn();
const displayErrorAndExit = jest.fn();
const initialClient = {
  setTokenProvider: initialSetTokenProvider,
  listProjects: initialListProjects,
};
const scopedClient = {
  setTokenProvider: scopedSetTokenProvider,
  listProjects: scopedListProjects,
};
const replacementAuthService = { getValidToken: replacementGetValidToken };
const successfulAuth = {
  success: true,
  organization_id: SELECTED_ORG.id,
  organization_name: SELECTED_ORG.name,
  user_id: USER_ID,
  organizations: [CURRENT_ORG, SELECTED_ORG],
} as const;
const initialAuth = {
  success: true,
  organization_id: CURRENT_ORG.id,
  organization_name: CURRENT_ORG.name,
  user_id: USER_ID,
  user_email: 'org-replacement@example.test',
  organizations: [CURRENT_ORG, SELECTED_ORG],
  _refresh_token: 'refresh-before',
} as const;

const serviceClientConstructor = jest.fn();
const initialAuthService = {
  setSessionUserId: jest.fn(),
  authenticateSilent: jest.fn(async () => initialAuth),
  authenticate: jest.fn(async () => initialAuth),
  getValidToken: jest.fn(async () => ({ authority: 'initial' })),
  getToken: jest.fn(() => null),
  refreshWithCredentials,
};

mock.module('../../src/core/projectManager', () => ({
  ProjectManager: jest.fn(() => ({
    detectProjectState,
    getDefaultProjectName: () => 'default',
  })),
}));
mock.module('../../src/files/fileManager', () => ({
  FileManager: jest.fn(() => ({
    writeKeepFile,
    writeSyncState,
    readEnvFile: () => ({}),
  })),
}));
mock.module('../../src/auth/authService', () => ({ AuthService: jest.fn(() => initialAuthService) }));
mock.module('../../src/service/serviceClient', () => ({ ServiceClient: serviceClientConstructor }));
mock.module('../../src/crypto/keyResolver', () => ({
  hasOrgKey: () => true,
  resolveProjectKey: jest.fn(),
}));
mock.module('../../src/commands/orgCreation', () => ({ createNewOrganization }));
mock.module('../../src/ui/selectWeb', () => ({ switchOrganizationInBrowser, nameFirstProjectInBrowser }));
mock.module('../../src/ui/errorScreen', () => ({ displayErrorAndExit }));
mock.module('inquirer', () => ({ __esModule: true, default: { prompt }, prompt }));
mock.module('ora', () => ({
  __esModule: true,
  default: () => ({ start: () => ({ succeed: jest.fn(), fail: jest.fn() }) }),
}));

import { OrgCommand } from '../../src/commands/orgCommand';

const resetMocks = (): void => [
  detectProjectState,
  writeKeepFile,
  writeSyncState,
  initialSetTokenProvider,
  scopedSetTokenProvider,
  initialListProjects,
  scopedListProjects,
  refreshWithCredentials,
  replacementGetValidToken,
  prompt,
  switchOrganizationInBrowser,
  nameFirstProjectInBrowser,
  createNewOrganization,
  displayErrorAndExit,
  serviceClientConstructor,
  initialAuthService.setSessionUserId,
  initialAuthService.authenticateSilent,
  initialAuthService.authenticate,
  initialAuthService.getValidToken,
  initialAuthService.getToken,
].forEach((candidate) => candidate.mockClear());

beforeEach(() => {
  resetMocks();
  detectProjectState.mockResolvedValue({
    initialized: true,
    organizationId: CURRENT_ORG.id,
    projectId: 'project-current',
    projectName: 'Current project',
    userId: USER_ID,
  });
  initialAuthService.authenticateSilent.mockResolvedValue(initialAuth);
  initialAuthService.authenticate.mockResolvedValue(initialAuth);
  refreshWithCredentials.mockResolvedValue({ auth: successfulAuth, authService: replacementAuthService });
  serviceClientConstructor.mockImplementationOnce(() => initialClient);
  serviceClientConstructor.mockImplementationOnce(() => scopedClient);
});

const assertReplacementBinding = async (): Promise<void> => {
  expect(serviceClientConstructor).toHaveBeenCalledTimes(2);
  expect(scopedSetTokenProvider).toHaveBeenCalledTimes(1);
  const provider = scopedSetTokenProvider.mock.calls[0]?.[0] as (() => Promise<unknown>) | undefined;
  expect(provider).toBeFunction();
  expect(await provider?.()).toEqual({ authority: 'replacement' });
  expect(replacementGetValidToken).toHaveBeenCalledTimes(1);
  expect(initialListProjects).not.toHaveBeenCalled();
};

describe('org command selected-authority replacement', () => {
  test('terminal selection lists and binds through the returned replacement service', async () => {
    prompt.mockImplementation(async (questions: readonly Readonly<{ name?: string }>[]) =>
      questions[0]?.name === 'orgId' ? { orgId: SELECTED_ORG.id } : { projectId: SELECTED_PROJECT.id });
    scopedListProjects.mockResolvedValue([SELECTED_PROJECT]);

    await new OrgCommand('https://service.example.test').execute();

    expect(refreshWithCredentials).toHaveBeenCalledWith('refresh-before', SELECTED_ORG.id, USER_ID);
    expect(scopedListProjects).toHaveBeenCalledTimes(1);
    expect(writeKeepFile).toHaveBeenCalledWith(expect.objectContaining({
      org_id: SELECTED_ORG.id,
      project_id: SELECTED_PROJECT.id,
    }));
    await assertReplacementBinding();
  });

  test('terminal creation carries the returned replacement into project selection', async () => {
    prompt.mockImplementation(async (questions: readonly Readonly<{ name?: string }>[]) =>
      questions[0]?.name === 'orgId' ? { orgId: '__create_new__' } : { projectId: CREATED_PROJECT.id });
    createNewOrganization.mockImplementation(async (_auth, serviceClientFor) => ({
      organization: CREATED_ORG,
      auth: { ...successfulAuth, organization_id: CREATED_ORG.id, organization_name: CREATED_ORG.name },
      authService: replacementAuthService,
      serviceClient: serviceClientFor(replacementAuthService),
    }));
    scopedListProjects.mockResolvedValue([CREATED_PROJECT]);

    await new OrgCommand('https://service.example.test').execute();

    expect(refreshWithCredentials).not.toHaveBeenCalled();
    expect(scopedListProjects).toHaveBeenCalledTimes(1);
    expect(writeKeepFile).toHaveBeenCalledWith(expect.objectContaining({
      org_id: CREATED_ORG.id,
      project_id: CREATED_PROJECT.id,
    }));
    await assertReplacementBinding();
  });

  test('web selection uses the exact picked organization replacement for both project reads', async () => {
    scopedListProjects.mockResolvedValue([SELECTED_PROJECT]);
    switchOrganizationInBrowser.mockImplementation(async (input: Readonly<{
      onOrgChosen: (orgId: string) => Promise<unknown>;
    }>) => {
      const outcome = await input.onOrgChosen(SELECTED_ORG.id);
      expect(outcome).toEqual({ ok: true, projects: [{ id: SELECTED_PROJECT.id, name: SELECTED_PROJECT.name }] });
      return { action: 'select-project', orgId: SELECTED_ORG.id, projectId: SELECTED_PROJECT.id, cancelled: false };
    });

    await new OrgCommand('https://service.example.test', false, { web: true }).execute();

    expect(refreshWithCredentials).toHaveBeenCalledWith('refresh-before', SELECTED_ORG.id, USER_ID);
    expect(scopedListProjects).toHaveBeenCalledTimes(2);
    expect(writeKeepFile).toHaveBeenCalledWith(expect.objectContaining({
      org_id: SELECTED_ORG.id,
      project_id: SELECTED_PROJECT.id,
    }));
    await assertReplacementBinding();
  });

  test('web creation binds the replacement without reusing the original client', async () => {
    switchOrganizationInBrowser.mockResolvedValue({ action: 'create', cancelled: false });
    createNewOrganization.mockImplementation(async (_auth, serviceClientFor) => ({
      organization: CREATED_ORG,
      auth: { ...successfulAuth, organization_id: CREATED_ORG.id, organization_name: CREATED_ORG.name },
      authService: replacementAuthService,
      serviceClient: serviceClientFor(replacementAuthService),
    }));
    nameFirstProjectInBrowser.mockResolvedValue(null);

    await new OrgCommand('https://service.example.test', false, { web: true }).execute();

    expect(refreshWithCredentials).not.toHaveBeenCalled();
    expect(scopedListProjects).not.toHaveBeenCalled();
    await assertReplacementBinding();
  });

  test('does not construct or bind a scoped client when returned auth is unsuccessful', async () => {
    prompt.mockResolvedValue({ orgId: SELECTED_ORG.id });
    refreshWithCredentials.mockResolvedValue({
      auth: { success: false, error: 'fixture refusal' },
      authService: replacementAuthService,
    });

    await new OrgCommand('https://service.example.test').execute();

    expect(serviceClientConstructor).toHaveBeenCalledTimes(1);
    expect(scopedSetTokenProvider).not.toHaveBeenCalled();
    expect(scopedListProjects).not.toHaveBeenCalled();
    expect(displayErrorAndExit).toHaveBeenCalledWith(expect.objectContaining({ message: 'fixture refusal' }));
  });
});

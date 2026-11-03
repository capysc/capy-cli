import { beforeEach, expect, mock, test } from 'bun:test';
import { runWithInteraction, type Interaction, type InteractionQuestion } from '../../src/ui/interaction';

const initialize = mock(async () => ({ project_id: 'synthetic-project', project_name: 'synthetic-project', org_id: 'synthetic-org' }));
const branch = mock(async () => ({}));
const writeKeep = mock(() => undefined);
const silent = mock(async () => ({ success: true, user_id: 'synthetic-user', organization_id: 'synthetic-org',
  organizations: [{ id: 'synthetic-org', name: 'Synthetic organization' }], user_email: 'synthetic@example.invalid' }));
const listProjects = mock(async () => []);
mock.module('../../src/core/projectManager', () => ({ ProjectManager: class {
  detectProjectState = async () => ({ initialized: false });
  readSyncState = () => ({ user_id: 'synthetic-user', org_id: 'synthetic-org' });
  writeSyncStateUserId = () => undefined;
  getDefaultProjectName = () => 'synthetic-project';
  getEnvPath = () => '/nonexistent-synthetic-flow-fixture/.env';
  writeActiveBranch = () => undefined;
} }));
mock.module('../../src/files/fileManager', () => ({ FileManager: class {
  readEnvMeta = () => null;
  writeKeepFile = writeKeep;
  ensureCapyGitignore = () => undefined;
} }));
mock.module('../../src/auth/authService', () => ({ AuthService: class {
  authenticateSilent = silent;
  getValidToken = async () => null;
  getToken = () => null;
} }));
mock.module('../../src/service/serviceClient', () => ({ ServiceClient: class {
  setTokenProvider = () => undefined;
  listProjects = listProjects;
  initializeProject = initialize;
  createBranch = branch;
} }));
mock.module('../../src/crypto/keyResolver', () => ({ hasOrgKey: () => true, resolveProjectKey: async () => 'synthetic-key' }));
mock.module('../../src/config/profileConfig', () => ({ isLocalOnly: () => false }));
mock.module('../../src/git/syncHooks', () => ({ installSyncHooks: () => undefined }));
import { CapyCommand } from '../../src/commands/capyCommand';

beforeEach(() => {
  initialize.mockClear(); branch.mockClear(); writeKeep.mockClear(); silent.mockClear(); listProjects.mockClear();
});
const fixture = (approved: boolean) => {
  const goal = mock(async () => undefined);
  const output = mock(async () => undefined);
  const interaction: Interaction = { binding: { userId: 'synthetic-user', organizationId: 'synthetic-org' },
    output, progress: async () => undefined, goal,
    prompt: async <T>(question: InteractionQuestion<T>) => {
      const view = question.view as Readonly<{ input: Readonly<{ kind: string; choices?: readonly Readonly<{ value: string }>[] }> }>;
      const value = view.input.kind === 'confirm' ? approved : view.input.choices ? view.input.choices[0].value : 'synthetic-project';
      const verdict = question.decide({ value });
      if ('error' in verdict) throw new Error(verdict.error);
      return verdict.value;
    },
  };
  return { goal, output, interaction };
};

test('browser approval applies current CLI repository setup exactly once and only then reports success', async () => {
  const f = fixture(true);
  await runWithInteraction(f.interaction, () => new CapyCommand({ silentAuthOnly: true }, true).execute());
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(initialize).toHaveBeenCalledWith('synthetic-project', 'synthetic-org');
  expect(branch).toHaveBeenCalledTimes(1);
  expect(writeKeep).toHaveBeenCalledTimes(1);
  expect(f.goal).toHaveBeenCalledWith({ flow: 'init-wizard', goal: 'repository_onboarded', status: 'succeeded' });
});

test('declined browser approval changes no project or key file and reports skipped', async () => {
  const f = fixture(false);
  await runWithInteraction(f.interaction, () => new CapyCommand({ silentAuthOnly: true }, true).execute());
  expect(initialize).not.toHaveBeenCalled();
  expect(branch).not.toHaveBeenCalled();
  expect(writeKeep).not.toHaveBeenCalled();
  expect(f.goal).toHaveBeenCalledWith({ flow: 'init-wizard', goal: 'repository_onboarded', status: 'skipped' });
});

test('a changed authenticated organization is refused before any application or success claim', async () => {
  const f = fixture(true);
  silent.mockResolvedValueOnce({ success: true, user_id: 'synthetic-user', organization_id: 'other-org', organizations: [], user_email: 'synthetic@example.invalid' });
  await expect(runWithInteraction(f.interaction, () => new CapyCommand({ silentAuthOnly: true }, true).execute())).rejects.toThrow('The flow account or organization changed.');
  expect(initialize).not.toHaveBeenCalled();
  expect(writeKeep).not.toHaveBeenCalled();
  expect(f.goal).not.toHaveBeenCalled();
});

test('failed project execution cannot report success or write a keep file', async () => {
  const f = fixture(true);
  initialize.mockRejectedValueOnce(new Error('Synthetic service refusal'));
  await expect(runWithInteraction(f.interaction, () => new CapyCommand({ silentAuthOnly: true }, true).execute())).rejects.toThrow('Synthetic service refusal');
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(writeKeep).not.toHaveBeenCalled();
  expect(f.goal).not.toHaveBeenCalled();
});

test('an unavailable project inventory cannot be mistaken for an empty organization', async () => {
  const f = fixture(true);
  listProjects.mockRejectedValueOnce(new Error('Synthetic inventory outage'));
  await expect(runWithInteraction(f.interaction, () => new CapyCommand({ silentAuthOnly: true }, true).execute())).rejects.toThrow('Could not verify the organization project inventory.');
  expect(initialize).not.toHaveBeenCalled();
  expect(writeKeep).not.toHaveBeenCalled();
  expect(f.goal).not.toHaveBeenCalled();
});

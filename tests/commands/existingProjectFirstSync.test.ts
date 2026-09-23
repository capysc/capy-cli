import { expect, mock, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
mock.module('../../src/crypto/keyResolver', () => ({ resolveProjectKey: async () => 'fixture-key', hasOrgKey: () => true, wrapAndSaveMasterKey: async () => undefined, unwrapMasterKey: async () => Buffer.alloc(32), resolveFromSeedPhrase: () => '', resolveProjectKeyByTrial: () => null, loadOrMintLocalRoot: () => Buffer.alloc(32), resolveFromLocalKey: () => '', saveLocalKey: () => undefined, decryptLocalMasterKeyHex: () => '' }));
const { CapyCommand } = await import('../../src/commands/capyCommand');
import { CapyError } from '../../src/types';
import { runWithInteraction, type InteractionQuestion } from '../../src/ui/interaction';
const methods = CapyCommand.prototype as unknown as Readonly<Record<string, (this: unknown, ...args: readonly unknown[]) => Promise<unknown>>>;
const project = { id: 'project-one', name: 'Existing', organization_id: 'org-one' };
const org = { id: 'org-one', name: 'Doan' };
const auth = { success: true, user_id: 'user-one' };

for (const remote of ['404', 'no-keep', 'empty-keep', 'other-branch'] as const) {
  test(`${remote}: existing project uses the real first-sync consent instead of pulling zero secrets`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'capy-first-sync-'));
    const path = join(directory, '.env');
    writeFileSync(path, 'EXAMPLE=synthetic\n');
    const sync = mock(async () => ({ ok: true }));
    const writeEncrypted = mock(() => undefined);
    const context = { transport: 'local', operationDeadline: null, authService: {}, serviceClient: { getDecryptData: async () => {
      if (remote === '404') throw new CapyError('No secrets', 'NOT_FOUND', { status: 404 });
      return { keep_file: remote === 'no-keep' ? null : JSON.stringify({ version: '3.0', variables: remote === 'other-branch' ? { OTHER: [{ branch: 'production' }] } : {} }), env_content: '' };
    } } };
    const subject = {
      options: {}, keyServiceOps: () => ({}),
      projectManager: { getEnvPath: () => path, writeActiveBranch: () => undefined },
      fileManager: { readEnvFile: () => ({ EXAMPLE: 'synthetic' }), writeKeepFile: () => undefined, ensureCapyGitignore: () => undefined, writeEncryptedEnvFile: writeEncrypted },
      syncInitialEnvironment: sync,
      finishInitialSecrets: (...args: readonly unknown[]) => methods.finishInitialSecrets.call(subject, ...args),
    };
    const question = mock(async <T>(q: InteractionQuestion<T>) => {
      expect(q.view).toMatchObject({ secretSummary: { count: 1, names: ['EXAMPLE'] } });
      const decision = q.decide({ value: true });
      return 'value' in decision ? decision.value : null;
    });
    try {
      const result = await runWithInteraction({ output: () => undefined, progress: () => undefined, goal: () => undefined, prompt: question }, () => methods.bootstrapExistingProject.call(subject, project, org.id, auth.user_id, context, auth, org, null));
      expect(result).toMatchObject({ status: 'succeeded', target: { projectId: project.id, branch: 'development' } });
      expect(sync).toHaveBeenCalledTimes(1);
      expect(question).toHaveBeenCalledTimes(1);
      expect(writeEncrypted).not.toHaveBeenCalled();
      expect(readFileSync(path, 'utf8')).toBe('EXAMPLE=synthetic\n');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

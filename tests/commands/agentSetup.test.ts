/**
 * Bare `capy` in a folder that is not a project yet, with nobody to ask (agent mode).
 *
 * Real `CapyCommand`, `FileManager`, `ProjectManager` and `SyncEngine` in a temp directory that is a real git
 * repository, so the assertions are about files on disk and about which service calls were made, and in what order.
 * Sign-in, the service, key resolution and the global cache are faked (the service as spies on the real client).
 *
 * Isolated: `mock.module()` is process-wide (tests/run-tests.sh).
 */
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realKeyResolver from '../../src/crypto/keyResolver';
import * as realGlobalConfig from '../../src/config/globalConfig';
import * as realProfileConfig from '../../src/config/profileConfig';

mock.module('../../src/crypto/keyResolver', () => ({
  ...realKeyResolver,
  hasOrgKey: () => true,
  resolveProjectKey: async () => 'a'.repeat(64),
}));
mock.module('../../src/config/globalConfig', () => ({
  ...realGlobalConfig,
  writeKeepCache: () => undefined,
}));
mock.module('../../src/config/profileConfig', () => ({
  ...realProfileConfig,
  isLocalOnly: () => false,
}));
const prompts = mock((_questions: unknown) => Promise.resolve({}));
mock.module('inquirer', () => ({
  default: { prompt: prompts, createPromptModule: () => prompts, Separator: class Separator {} },
}));

import { CapyCommand } from '../../src/commands/capyCommand';
import { AuthService } from '../../src/auth/authService';
import { ProjectManager } from '../../src/core/projectManager';
import { ServiceClient } from '../../src/service/serviceClient';
import { PromptEngine } from '../../src/ui/promptEngine';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import type { CliOptions, KeepFile, SetupOptions, SyncState } from '../../src/types/index';
import { FileManager } from '../../src/files/fileManager';
import { deriveResourceId } from '../../src/crypto/resourceId';
import { Encryptor } from '../../src/crypto/encryptor';

const ORIGIN = process.cwd();
const dirs = mock((_: string) => undefined);

/** A value that must never reach stdout or stderr. */
const SENTINEL = 'sentinel-secret-value-7f3a9c';

const ORG = { id: 'org-1', name: 'Acme' };
const OTHER_ORG = { id: 'org-2', name: 'Other' };

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'capy-agent-setup-'));
  dirs(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  process.chdir(dir);
  prompts.mockClear();
});
afterEach(() => {
  mock.restore();
  process.chdir(ORIGIN);
  dirs.mock.calls.forEach(([dir]) => rmSync(dir, { recursive: true, force: true }));
  dirs.mockClear();
});

interface Calls {
  /** The service calls, in the order they were made. */
  readonly events: () => readonly string[];
  readonly initializeProject: ReturnType<typeof spyOn>;
  readonly createBranch: ReturnType<typeof spyOn>;
  readonly pushSecrets: ReturnType<typeof spyOn>;
  readonly listProjects: ReturnType<typeof spyOn>;
  readonly listBranches: ReturnType<typeof spyOn>;
  readonly authenticateSilent: ReturnType<typeof spyOn>;
  readonly authenticate: ReturnType<typeof spyOn>;
}

interface World {
  readonly orgs?: ReadonlyArray<{ id: string; name: string }>;
  readonly projects?: ReadonlyArray<{ id: string; name: string; organization_id: string }>;
  readonly listFails?: boolean;
  readonly signedIn?: boolean;
  readonly branchFails?: boolean;
  /** The branches every project has. Default: none, as for a project whose first branch is not created yet. */
  readonly branches?: ReadonlyArray<{ name: string; is_protected: boolean }>;
}

/** Fakes every network and sign-in edge; returns the spies and the order the service was called in. */
function fakeWorld(world: World = {}): Calls {
  const { orgs = [ORG], projects = [], listFails = false, signedIn = true, branchFails = false, branches = [] } = world;
  const record = mock((_event: string) => undefined);
  const authenticateSilent = spyOn(AuthService.prototype, 'authenticateSilent').mockImplementation(async (orgId?: string) =>
    signedIn
      ? ({ success: true, user_id: 'user-1', user_email: 'dev@example.com', organization_id: orgId ?? orgs[0].id, organizations: orgs, _auth_method: 'cached' } as never)
      : ({ success: false, error: 'No valid session available', error_code: 'no_session' } as never),
  );
  const authenticate = spyOn(AuthService.prototype, 'authenticate').mockResolvedValue({ success: false, error: 'a browser was opened' } as never);
  const listProjects = spyOn(ServiceClient.prototype, 'listProjects').mockImplementation(async () => {
    record('listProjects');
    if (listFails) throw new CapyError('Failed to connect', ERROR_CODES.NETWORK_ERROR);
    return projects.map((p) => ({ ...p })) as never;
  });
  const initializeProject = spyOn(ServiceClient.prototype, 'initializeProject').mockImplementation(async (name: string) => {
    record('initializeProject');
    return { org_id: ORG.id, project_id: 'proj-new', project_name: name, created: true };
  });
  const createBranch = spyOn(ServiceClient.prototype, 'createBranch').mockImplementation(async (_projectId: string, name: string, isProtected?: boolean) => {
    // The folder is already linked to the project when the first branch is created.
    record(`createBranch(keep.lock:${existsSync(join(process.cwd(), 'keep.lock'))})`);
    if (branchFails) throw new CapyError('Failed to create the branch', ERROR_CODES.SERVICE_ERROR);
    return { id: 'b1', name, project_id: 'proj-new', is_protected: isProtected === true } as never;
  });
  const listBranches = spyOn(ServiceClient.prototype, 'listBranches').mockImplementation(async () => {
    record('listBranches');
    return branches.map((b) => ({ id: `id-${b.name}`, project_id: 'proj-web', ...b })) as never;
  });
  const pushSecrets = spyOn(ServiceClient.prototype, 'pushSecrets').mockImplementation(async () => {
    record('pushSecrets');
    return { keep_hash: 'a'.repeat(64) } as never;
  });
  return { events: () => record.mock.calls.map(([event]) => event), initializeProject, createBranch, pushSecrets, listProjects, listBranches, authenticateSilent, authenticate };
}

class ExitSignal extends Error {
  constructor(public readonly code: number | undefined) {
    super('exit');
  }
}

interface Captured {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: Record<string, any> | undefined;
}

/** Runs bare `capy` in agent mode with these flags and captures what it printed and how it ended. */
async function run(answers: Partial<SetupOptions> = {}, extra: Partial<CliOptions> = {}, devMode: boolean = false): Promise<Captured> {
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const setup: SetupOptions = { json: true, nonTty: true, agentMode: true, ...answers };
  const thrown: unknown = await new CapyCommand({ setup, protocol: true, ...extra }, devMode).execute().then(() => null, (err: unknown) => err);
  const stdout = logSpy.mock.calls.map((args) => args.map(String).join('\n')).join('\n');
  const stderr = errSpy.mock.calls.map((args) => args.map(String).join('\n')).join('\n');
  const exitCode = exitSpy.mock.calls.length > 0 ? (exitSpy.mock.calls[exitSpy.mock.calls.length - 1][0] as number | undefined) : undefined;
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  if (thrown !== null && !(thrown instanceof ExitSignal)) throw thrown;
  return { exitCode, stdout, stderr, json: stdout.trim().startsWith('{') ? JSON.parse(stdout) : undefined };
}

const folder = (...parts: string[]) => join(process.cwd(), ...parts);
const readJson = (path: string): KeepFile => JSON.parse(readFileSync(path, 'utf-8')) as KeepFile;
const ALL_ANSWERS = { name: 'demo', branch: 'development', protectedAnswer: 'no' } as const;
const fieldNames = (json: Record<string, any> | undefined): string[] => (json?.elicitation.fields as Array<{ name: string }>).map((f) => f.name);

describe('questions left: one INIT_INPUT_REQUIRED form, nothing created or written', () => {
  test('one organization with projects: asks project, name, branch and protected; not the organization', async () => {
    const calls = fakeWorld({ projects: [{ id: 'proj-web', name: 'web', organization_id: ORG.id }] });
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\nDB_URL=other\n`, 'utf-8');

    const out = await run();

    expect(out.exitCode).toBe(3);
    expect(out.json).toMatchObject({ ok: false, code: 'INIT_INPUT_REQUIRED' });
    const form = out.json!.elicitation;
    expect(form.kind).toBe('form');
    expect(fieldNames(out.json)).toEqual(['project', 'name', 'branch', 'protected']);
    expect(form.fields[0].options).toEqual([{ value: 'new', label: 'New project' }, { value: 'proj-web', label: 'web' }]);
    expect(form.answer.rerun).toBe('capy --project <project> --name <name> --branch <branch> --protected <protected> --json');
    expect(form.details).toMatchObject({ org: ORG, variables: 2 });
    expect(form.display).toContain('2 variables to encrypt and push');
    expect(form.display).toContain('Acme');
    // Nothing was created, linked or written.
    expect(calls.initializeProject).not.toHaveBeenCalled();
    expect(calls.createBranch).not.toHaveBeenCalled();
    expect(calls.pushSecrets).not.toHaveBeenCalled();
    expect(existsSync(folder('keep.lock'))).toBe(false);
    expect(existsSync(folder('.capy'))).toBe(false);
    expect(readFileSync(folder('.env'), 'utf-8')).toBe(`API_KEY=${SENTINEL}\nDB_URL=other\n`);
    expect(prompts).not.toHaveBeenCalled();
  });

  test('one organization with no projects: the organization and the project are not asked (one possible answer each)', async () => {
    fakeWorld();
    const out = await run();
    expect(out.exitCode).toBe(3);
    expect(fieldNames(out.json)).toEqual(['name', 'branch', 'protected']);
    expect(out.json!.elicitation.answer.rerun).toBe('capy --name <name> --branch <branch> --protected <protected> --json');
    const [name, branch, isProtected] = out.json!.elicitation.fields;
    // The same field names, wording, defaults and rules as `capy project create`.
    expect(name).toMatchObject({ name: 'name', pattern: '^[a-zA-Z0-9-_]+$', question: 'What should the project be called?' });
    expect(branch).toMatchObject({ name: 'branch', question: 'What should its first branch be called?', default: 'development' });
    expect(branch.description).toBe('A Capy branch works like a git branch. Capy branches can be used to set different variables for different environments.');
    expect(isProtected).toMatchObject({ name: 'protected', default: 'no', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] });
  });

  test('only what is unanswered is asked, and the typed answers are repeated in the rerun', async () => {
    fakeWorld();
    const out = await run({ name: 'demo', branch: 'main' });
    expect(out.exitCode).toBe(3);
    expect(fieldNames(out.json)).toEqual(['protected']);
    expect(out.json!.elicitation.answer.rerun).toBe('capy --name demo --branch main --protected <protected> --json');
  });

  test('under another binary (CAPY_BIN_NAME) the rerun command starts with that binary', async () => {
    fakeWorld();
    const env = spyOn(process, 'env', 'get' as never).mockReturnValue({ ...process.env, CAPY_BIN_NAME: 'capy-staging' } as never);
    const out = await run({ name: 'demo', branch: 'main' }).finally(() => env.mockRestore());
    expect(out.exitCode).toBe(3);
    expect(out.json!.elicitation.answer.rerun).toBe('capy-staging --name demo --branch main --protected <protected> --json');
  });

  test('under capy-dev (no CAPY_BIN_NAME) the rerun command starts with capy-dev', async () => {
    fakeWorld();
    const { CAPY_BIN_NAME: _unset, ...rest } = process.env;
    const env = spyOn(process, 'env', 'get' as never).mockReturnValue(rest as never);
    const out = await run({ name: 'demo', branch: 'main' }, {}, true).finally(() => env.mockRestore());
    expect(out.exitCode).toBe(3);
    expect(out.json!.elicitation.answer.rerun).toBe('capy-dev --name demo --branch main --protected <protected> --json');
  });

  test('several organizations and no --org: the organization is asked first, alone, as options of id and name; no project is looked up', async () => {
    const calls = fakeWorld({ orgs: [ORG, OTHER_ORG] });
    const out = await run();
    expect(out.exitCode).toBe(3);
    expect(out.json).toMatchObject({ code: 'INIT_INPUT_REQUIRED' });
    expect(fieldNames(out.json)).toEqual(['org']);
    expect(out.json!.elicitation.fields[0].options).toEqual([{ value: 'org-1', label: 'Acme' }, { value: 'org-2', label: 'Other' }]);
    expect(out.json!.elicitation.answer.rerun).toBe('capy --org <org> --json');
    expect(calls.listProjects).not.toHaveBeenCalled();
    expect(calls.initializeProject).not.toHaveBeenCalled();
  });

  test('the form never carries a value of the .env', async () => {
    fakeWorld({ projects: [{ id: 'proj-web', name: 'web', organization_id: ORG.id }] });
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\n`, 'utf-8');
    const out = await run();
    expect(out.stdout).not.toContain(SENTINEL);
    expect(out.stderr).not.toContain(SENTINEL);
  });
});

describe('every answer given: create, then link, then push', () => {
  test('the service calls happen in that order, keep.lock exists before the first branch is made, and the result says what happened', async () => {
    const calls = fakeWorld();
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\nDB_URL=two\n`, 'utf-8');

    const out = await run({ ...ALL_ANSWERS, protectedAnswer: 'yes' });

    expect(out.exitCode).toBeUndefined();
    expect(calls.events()).toEqual(['listProjects', 'initializeProject', 'createBranch(keep.lock:true)', 'pushSecrets']);
    expect(calls.createBranch).toHaveBeenCalledWith('proj-new', 'development', true);
    expect(out.json).toEqual({
      ok: true,
      created: true,
      org: ORG,
      project: { id: 'proj-new', name: 'demo' },
      branch: { name: 'development', protected: true },
      pushed: 2,
      env_found: true,
    });
    expect(readJson(folder('keep.lock'))).toMatchObject({ org_id: 'org-1', project_id: 'proj-new', project_name: 'demo' });
    expect(Object.keys(readJson(folder('keep.lock')).variables).toSorted()).toEqual(['API_KEY', 'DB_URL']);
    expect(readFileSync(folder('.capy', 'branch'), 'utf-8')).toBe('development');
    // The .env is ciphertext now, and no value reached the output.
    expect(readFileSync(folder('.env'), 'utf-8')).not.toContain(SENTINEL);
    expect(out.stdout).not.toContain(SENTINEL);
    expect(out.stderr).not.toContain(SENTINEL);
    // Agent mode never opened a prompt or a browser.
    expect(prompts).not.toHaveBeenCalled();
    expect(calls.authenticate).not.toHaveBeenCalled();
  });

  test('a folder with no .env is set up all the same: project, branch and link, nothing pushed, and the result says so', async () => {
    const calls = fakeWorld();
    const out = await run(ALL_ANSWERS);
    expect(out.exitCode).toBeUndefined();
    expect(out.json).toMatchObject({ ok: true, created: true, pushed: 0, env_found: false });
    expect(calls.pushSecrets).not.toHaveBeenCalled();
    expect(calls.createBranch).toHaveBeenCalledWith('proj-new', 'development', false);
    expect(readJson(folder('keep.lock'))).toMatchObject({ project_id: 'proj-new', variables: {} });
  });

  test('--org picks the organization by name or id, so it is not asked', async () => {
    const calls = fakeWorld({ orgs: [ORG, OTHER_ORG] });
    const out = await run({ ...ALL_ANSWERS, org: 'Acme' });
    expect(out.json).toMatchObject({ ok: true, org: ORG });
    expect(calls.initializeProject).toHaveBeenCalledWith('demo', 'org-1');
    expect(calls.authenticateSilent).toHaveBeenCalledWith('org-1');
  });

  test('an unknown --org is ORG_NOT_FOUND and nothing is created', async () => {
    const calls = fakeWorld({ orgs: [ORG, OTHER_ORG] });
    const out = await run({ ...ALL_ANSWERS, org: 'nope' });
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'ORG_NOT_FOUND' });
    expect(calls.initializeProject).not.toHaveBeenCalled();
    expect(existsSync(folder('keep.lock'))).toBe(false);
  });

  test('a name the organization already has is PROJECT_NAME_EXISTS, checked again against the service, and nothing is created', async () => {
    const calls = fakeWorld({ projects: [{ id: 'proj-demo', name: 'Demo', organization_id: ORG.id }] });
    const out = await run(ALL_ANSWERS);
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'PROJECT_NAME_EXISTS', project: { id: 'proj-demo' } });
    expect(calls.initializeProject).not.toHaveBeenCalled();
  });

  test('a name or branch that breaks the rule is refused with its code before the service is asked anything', async () => {
    const calls = fakeWorld();
    const badName = await run({ ...ALL_ANSWERS, name: 'has space' });
    expect(badName.json).toMatchObject({ code: 'PROJECT_NAME_INVALID' });
    const badBranch = await run({ ...ALL_ANSWERS, branch: '.hidden' });
    expect(badBranch.json).toMatchObject({ code: 'BRANCH_NAME_INVALID' });
    const badProtected = await run({ ...ALL_ANSWERS, protectedAnswer: 'maybe' });
    expect(badProtected.json).toMatchObject({ code: 'BRANCH_PROTECTION_INVALID' });
    expect(calls.authenticateSilent).not.toHaveBeenCalled();
    expect(calls.initializeProject).not.toHaveBeenCalled();
  });

  test('--dry-run creates and writes nothing and says what it would do', async () => {
    const calls = fakeWorld();
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as never);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    await new CapyCommand({ dryRun: true, setup: { json: true, nonTty: true, agentMode: true, ...ALL_ANSWERS } }, false).execute();
    const printed = logSpy.mock.calls.map((a) => a.join('\n')).join('\n');
    logSpy.mockRestore();
    exitSpy.mockRestore();
    expect(JSON.parse(printed)).toMatchObject({ ok: true, dry_run: true, project: { name: 'demo' } });
    expect(calls.initializeProject).not.toHaveBeenCalled();
    expect(existsSync(folder('keep.lock'))).toBe(false);
  });
});

describe('an existing project', () => {
  const PROD = [{ name: 'prod', is_protected: false }];
  const PROD_AND_STAGING = [...PROD, { name: 'staging', is_protected: true }];

  test('--project and --branch link the folder to that branch: no project is created, and no branch name is assumed', async () => {
    const calls = fakeWorld({ projects: [{ id: 'proj-web', name: 'web', organization_id: ORG.id }], branches: PROD });
    spyOn(ServiceClient.prototype, 'getDecryptData').mockRejectedValue(
      new CapyError('No secrets', ERROR_CODES.NO_SECRETS, { status: 404 }),
    );
    const read = ServiceClient.prototype.getDecryptData as unknown as ReturnType<typeof spyOn>;
    const out = await run({ project: 'web', branch: 'prod' });
    expect(out.exitCode).toBeUndefined();
    expect(out.json).toMatchObject({ ok: true, created: false, project: { id: 'proj-web', name: 'web' }, branch: { name: 'prod' }, pushed: 0 });
    expect(read.mock.calls[0]?.[1]).toBe('prod');
    expect(calls.initializeProject).not.toHaveBeenCalled();
    expect(calls.createBranch).not.toHaveBeenCalled();
    expect(readJson(folder('keep.lock'))).toMatchObject({ project_id: 'proj-web' });
    expect(readFileSync(folder('.capy', 'branch'), 'utf-8').trim()).toBe('prod');
  });

  test('--project with no --branch asks which of the project branches, even when it has one: INIT_INPUT_REQUIRED, nothing read or written', async () => {
    fakeWorld({ projects: [{ id: 'proj-web', name: 'web', organization_id: ORG.id }], branches: PROD });
    const read = spyOn(ServiceClient.prototype, 'getDecryptData');
    const out = await run({ project: 'web' });
    expect(out.exitCode).toBe(3);
    expect(out.json).toMatchObject({ ok: false, code: 'INIT_INPUT_REQUIRED' });
    expect(fieldNames(out.json)).toEqual(['branch']);
    const field = out.json!.elicitation.fields[0];
    expect(field.options).toEqual([{ value: 'prod', label: 'prod' }]);
    expect(field.default).toBeUndefined();
    expect(out.json!.elicitation.details).toMatchObject({ project: { id: 'proj-web', name: 'web' }, branches: [{ name: 'prod', protected: false }] });
    expect(out.json!.elicitation.answer.rerun).toContain('--project web --branch <branch> --json');
    expect(out.json!.elicitation.display).not.toContain('First branch');
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(folder('keep.lock'))).toBe(false);
    expect(existsSync(folder('.capy', 'branch'))).toBe(false);
  });

  test('several branches: the form offers each, and marks the protected one', async () => {
    fakeWorld({ projects: [{ id: 'proj-web', name: 'web', organization_id: ORG.id }], branches: PROD_AND_STAGING });
    const out = await run({ project: 'web' });
    expect(out.json!.elicitation.fields[0].options).toEqual([{ value: 'prod', label: 'prod' }, { value: 'staging', label: 'staging (protected)' }]);
  });

  test('--branch the project does not have is BRANCH_NOT_FOUND naming its branches: nothing read or written', async () => {
    fakeWorld({ projects: [{ id: 'proj-web', name: 'web', organization_id: ORG.id }], branches: PROD });
    const read = spyOn(ServiceClient.prototype, 'getDecryptData');
    const out = await run({ project: 'web', branch: 'development' });
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'BRANCH_NOT_FOUND', branches: ['prod'] });
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(folder('keep.lock'))).toBe(false);
  });

  test('a project with no branches is BRANCH_NOT_FOUND: no branch is created or assumed', async () => {
    const calls = fakeWorld({ projects: [{ id: 'proj-web', name: 'web', organization_id: ORG.id }] });
    const out = await run({ project: 'web', branch: 'development' });
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'BRANCH_NOT_FOUND', branches: [] });
    expect(calls.createBranch).not.toHaveBeenCalled();
    expect(existsSync(folder('keep.lock'))).toBe(false);
  });

  const WEB = { id: 'proj-web', name: 'web', organization_id: ORG.id };
  /** What the form tells the human about the folder's variables, which the human approves before choosing a project. */
  const variablesRowOf = (display: string): string => display.split('\n').find((line) => line.includes('Variables')) ?? '';

  test('with a project to choose, the summary states both outcomes, and choosing an existing project does what it says (secrets: replaced, copy kept, nothing pushed)', async () => {
    const calls = fakeWorld({ projects: [WEB], branches: [{ name: 'development', is_protected: false }] });
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\nDB_URL=other\n`, 'utf-8');

    const asked = await run();
    const row = variablesRowOf(asked.json!.elicitation.display);
    expect(row).toContain('2 variables to encrypt and push');
    expect(row).toContain('Existing project');
    expect(row).toContain('nothing is pushed');
    expect(row).toContain('replace');
    expect(row).toContain('.pre-capy.old');

    const keep = { version: '3.0', org_id: ORG.id, project_id: WEB.id, project_name: WEB.name, variables: {} };
    spyOn(ServiceClient.prototype, 'getDecryptData').mockResolvedValue({
      keep_hash: 'a'.repeat(64),
      keep_file: JSON.stringify(keep),
      env_content: `API_KEY=capy:${deriveResourceId('development', 'API_KEY')}:${Encryptor.encrypt('remote-value', 'a'.repeat(64))}\n`,
    } as never);
    const out = await run({ project: WEB.id, branch: 'development' });

    expect(out.json).toMatchObject({ ok: true, created: false, pushed: 0, pulled: 1 });
    expect(calls.pushSecrets).not.toHaveBeenCalled();
    const env = readFileSync(folder('.env'), 'utf-8');
    expect(env).toContain('API_KEY=capy:');
    expect(env).not.toContain('DB_URL');
    expect(env).not.toContain(SENTINEL);
    const backup = readFileSync(folder('.env.pre-capy.old'), 'utf-8');
    expect(backup).toContain(`# API_KEY=${SENTINEL}`);
    expect(backup).toContain('# DB_URL=other');
  });

  test('with a project to choose, an existing project with no secrets leaves the .env as it is and pushes nothing, as the summary says', async () => {
    const calls = fakeWorld({ projects: [WEB], branches: [{ name: 'development', is_protected: false }] });
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\n`, 'utf-8');
    const asked = await run();
    expect(variablesRowOf(asked.json!.elicitation.display)).toContain('nothing is pushed');
    spyOn(ServiceClient.prototype, 'getDecryptData').mockRejectedValue(new CapyError('No secrets', ERROR_CODES.NO_SECRETS, { status: 404 }));
    const out = await run({ project: WEB.id, branch: 'development' });
    expect(out.json).toMatchObject({ ok: true, created: false, pushed: 0 });
    expect(calls.pushSecrets).not.toHaveBeenCalled();
    expect(readFileSync(folder('.env'), 'utf-8')).toBe(`API_KEY=${SENTINEL}\n`);
  });

  test('with no project to choose (a new one), the summary keeps saying only what will be encrypted and pushed', async () => {
    fakeWorld();
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\n`, 'utf-8');
    const asked = await run();
    const row = variablesRowOf(asked.json!.elicitation.display);
    expect(row).toContain('1 variable to encrypt and push');
    expect(row).not.toContain('Existing project');
  });

  test('--project that matches nothing is PROJECT_NOT_FOUND and nothing is created', async () => {
    const calls = fakeWorld({ projects: [{ id: 'proj-web', name: 'web', organization_id: ORG.id }] });
    const out = await run({ project: 'api' });
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(calls.initializeProject).not.toHaveBeenCalled();
  });
});

describe('a failed project lookup', () => {
  test('refuses with PROJECT_LOOKUP_FAILED and makes no create call, whatever else was answered', async () => {
    const calls = fakeWorld({ listFails: true });
    const out = await run(ALL_ANSWERS);
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'PROJECT_LOOKUP_FAILED', cause: 'NETWORK_ERROR' });
    expect(calls.initializeProject).not.toHaveBeenCalled();
    expect(calls.createBranch).not.toHaveBeenCalled();
    expect(existsSync(folder('keep.lock'))).toBe(false);
  });
});

describe('no session', () => {
  test('refuses with the not-signed-in code and names `capy pair` as the next command; no browser, no calls', async () => {
    const calls = fakeWorld({ signedIn: false });
    const out = await run(ALL_ANSWERS);
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'AUTH_FAILED', reason: 'no_session', next_command: 'capy pair' });
    expect(calls.authenticate).not.toHaveBeenCalled();
    expect(calls.listProjects).not.toHaveBeenCalled();
    expect(calls.initializeProject).not.toHaveBeenCalled();
  });
});

describe('a run that stopped after the project was created', () => {
  test('the same command run again finishes the job on the same project: no second project', async () => {
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\n`, 'utf-8');
    const first = fakeWorld({ branchFails: true });
    const failed = await run(ALL_ANSWERS);
    expect(failed.exitCode).toBe(1);
    expect(failed.json).toMatchObject({ ok: false, code: 'BRANCH_CREATE_FAILED', project: { id: 'proj-new', name: 'demo' } });
    expect(first.initializeProject).toHaveBeenCalledTimes(1);
    // The folder already names the project, so the next run can find it.
    expect(readJson(folder('keep.lock'))).toMatchObject({ project_id: 'proj-new', project_name: 'demo' });
    expect(readFileSync(folder('.env'), 'utf-8')).toContain(SENTINEL);
    mock.restore();

    const second = fakeWorld();
    const finished = await run(ALL_ANSWERS);
    expect(finished.exitCode).toBeUndefined();
    expect(second.initializeProject).not.toHaveBeenCalled();
    expect(second.createBranch).toHaveBeenCalledWith('proj-new', 'development', false);
    expect(second.pushSecrets).toHaveBeenCalledTimes(1);
    expect(finished.json).toMatchObject({ ok: true, created: false, resumed: true, project: { id: 'proj-new', name: 'demo' }, pushed: 1 });
    expect(readFileSync(folder('.capy', 'branch'), 'utf-8')).toBe('development');
    expect(readFileSync(folder('.env'), 'utf-8')).not.toContain(SENTINEL);
    expect(finished.stdout).not.toContain(SENTINEL);
    expect(finished.stderr).not.toContain(SENTINEL);
  });
});

const readSyncStateFile = (): SyncState => JSON.parse(readFileSync(folder('.capy', 'sync-state'), 'utf-8')) as SyncState;
const MARKER = { org_id: 'org-1', project_id: 'proj-new', branch: 'development', protected: false } as const;
/** What a run must not have printed, on either stream. */
const expectNoLeak = (out: Captured): void => {
  expect(out.stdout).not.toContain(SENTINEL);
  expect(out.stderr).not.toContain(SENTINEL);
};

/** A setup that created the project and linked the folder and then failed on the first branch: the marker is left behind. */
async function strandedSetup(world: World = {}): Promise<void> {
  writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\n`, 'utf-8');
  const first = fakeWorld({ ...world, branchFails: true });
  const failed = await run({ ...ALL_ANSWERS, ...(world.orgs === undefined ? {} : { org: 'Acme' }) });
  expect(failed.json).toMatchObject({ ok: false, code: 'BRANCH_CREATE_FAILED' });
  expect(first.initializeProject).toHaveBeenCalledTimes(1);
  mock.restore();
}

/** The folder, the marker and the .env exactly as a refused rerun must leave them. */
function expectStranded(calls: Calls): void {
  expect(calls.initializeProject).not.toHaveBeenCalled();
  expect(calls.createBranch).not.toHaveBeenCalled();
  expect(calls.pushSecrets).not.toHaveBeenCalled();
  expect(readSyncStateFile().pending_setup).toEqual(MARKER);
  expect(readJson(folder('keep.lock'))).toMatchObject({ project_id: 'proj-new', variables: {} });
  expect(existsSync(folder('.capy', 'branch'))).toBe(false);
  expect(readFileSync(folder('.env'), 'utf-8')).toBe(`API_KEY=${SENTINEL}\n`);
}

describe('the pending-setup marker', () => {
  test('is written when the folder is linked, next to what the sync state already held, and is gone when setup is done', async () => {
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\n`, 'utf-8');
    fakeWorld({ branchFails: true });
    await run(ALL_ANSWERS);
    expect(readSyncStateFile()).toMatchObject({ user_id: 'user-1', pending_setup: MARKER });
    mock.restore();

    fakeWorld();
    const finished = await run(ALL_ANSWERS);
    expect(finished.json).toMatchObject({ ok: true, resumed: true });
    expect(readSyncStateFile().pending_setup).toBeUndefined();
    expect(readSyncStateFile().user_id).toBe('user-1');
    expectNoLeak(finished);
  });

  test('a setup that finishes in one run never leaves one', async () => {
    fakeWorld();
    const out = await run(ALL_ANSWERS);
    expect(out.json).toMatchObject({ ok: true, created: true });
    expect(readSyncStateFile().pending_setup).toBeUndefined();
  });

  test('a setup that fails at the push keeps it, so the rerun can finish', async () => {
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\n`, 'utf-8');
    const calls = fakeWorld();
    calls.pushSecrets.mockImplementation(async () => {
      throw new CapyError('The service is down', ERROR_CODES.NETWORK_ERROR);
    });
    const failed = await run(ALL_ANSWERS);
    expect(failed.exitCode).toBe(1);
    expect(failed.json).toMatchObject({ ok: false, code: 'NETWORK_ERROR' });
    expect(readSyncStateFile().pending_setup).toEqual(MARKER);
    expectNoLeak(failed);
  });
});

describe('a normal sync does not carry the marker forward', () => {
  test('a setup finished by hand with bare capy leaves no marker behind', async () => {
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\n`, 'utf-8');
    const first = fakeWorld();
    first.pushSecrets.mockImplementation(async () => {
      throw new CapyError('The service is down', ERROR_CODES.NETWORK_ERROR);
    });
    await run(ALL_ANSWERS);
    expect(readSyncStateFile().pending_setup).toEqual(MARKER);
    mock.restore();

    const calls = fakeWorld();
    spyOn(AuthService.prototype, 'getToken').mockReturnValue('token');
    const remoteLine = `API_KEY=capy:${deriveResourceId('development', 'API_KEY')}:${Encryptor.encrypt('remote-value', 'a'.repeat(64))}\n`;
    spyOn(ServiceClient.prototype, 'getDecryptData').mockResolvedValue({ keep_hash: 'a'.repeat(64), env_content: remoteLine } as never);
    rmSync(folder('.env'), { force: true });
    const asked = await run({});
    expect(asked.json).toMatchObject({ ok: false, code: 'SECRETS_CONFLICT' });
    expect(readSyncStateFile().pending_setup).toEqual(MARKER);

    const out = await run({}, { conflictFlags: { resolve: ['API_KEY=remote'], conflict: asked.json!.conflict_id as string } });
    expect(readSyncStateFile().pending_setup).toBeUndefined();
  });
});

describe('a normal sync from the menu does not carry the marker forward', () => {
  test('retrieving the remote values in a terminal clears a stranded marker', async () => {
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\n`, 'utf-8');
    const first = fakeWorld();
    first.pushSecrets.mockImplementation(async () => {
      throw new CapyError('The service is down', ERROR_CODES.NETWORK_ERROR);
    });
    await run(ALL_ANSWERS);
    expect(readSyncStateFile().pending_setup).toEqual(MARKER);
    mock.restore();

    fakeWorld();
    spyOn(AuthService.prototype, 'getToken').mockReturnValue('token');
    const remoteLine = `API_KEY=capy:${deriveResourceId('development', 'API_KEY')}:${Encryptor.encrypt('remote-value', 'a'.repeat(64))}\n`;
    spyOn(ServiceClient.prototype, 'getDecryptData').mockResolvedValue({ keep_hash: 'a'.repeat(64), env_content: remoteLine } as never);
    prompts.mockImplementation(() => Promise.resolve({ action: 'retrieve_remote' }));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const err = spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSignal(code); }) as never);
    await new CapyCommand({}, false).execute().catch((e: unknown) => (e instanceof ExitSignal ? undefined : Promise.reject(e))).finally(() => {
      exit.mockRestore();
      log.mockRestore();
      err.mockRestore();
    });
    expect(prompts).toHaveBeenCalledTimes(1);
    expect(readSyncStateFile().pending_setup).toBeUndefined();
  });
});

describe('a linked folder with no marker is a healthy project', () => {
  test('the same --name, --branch and --protected are not a resume: it syncs as it always has, creates and pushes nothing, and says the flags were not applied', async () => {
    writeFileSync(folder('.env'), `API_KEY=${SENTINEL}\n`, 'utf-8');
    fakeWorld();
    await run(ALL_ANSWERS);
    expect(readSyncStateFile().pending_setup).toBeUndefined();
    mock.restore();

    const calls = fakeWorld();
    const sync = spyOn(CapyCommand.prototype as unknown as { syncProject: () => Promise<string> }, 'syncProject').mockResolvedValue('up-to-date');
    const before = readFileSync(folder('keep.lock'), 'utf-8');
    const out = await run(ALL_ANSWERS);

    expect(out.exitCode).toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(calls.initializeProject).not.toHaveBeenCalled();
    expect(calls.listBranches).not.toHaveBeenCalled();
    expect(calls.createBranch).not.toHaveBeenCalled();
    expect(calls.pushSecrets).not.toHaveBeenCalled();
    expect(readFileSync(folder('keep.lock'), 'utf-8')).toBe(before);
    expect(out.json).toEqual({ ok: true, ignored_flags: ['--name', '--branch', '--protected'] });
    expectNoLeak(out);
  });

  test('a different --branch on a healthy project creates no branch either', async () => {
    fakeWorld();
    await run(ALL_ANSWERS);
    mock.restore();

    const calls = fakeWorld();
    spyOn(CapyCommand.prototype as unknown as { syncProject: () => Promise<string> }, 'syncProject').mockResolvedValue('up-to-date');
    const out = await run({ name: 'demo', branch: 'feature', protectedAnswer: 'yes', org: 'Acme' });
    expect(calls.createBranch).not.toHaveBeenCalled();
    expect(calls.listBranches).not.toHaveBeenCalled();
    expect(out.json).toEqual({ ok: true, ignored_flags: ['--org', '--name', '--branch', '--protected'] });
  });

  test('no setup flags: nothing extra is printed', async () => {
    fakeWorld();
    await run(ALL_ANSWERS);
    mock.restore();
    fakeWorld();
    spyOn(CapyCommand.prototype as unknown as { syncProject: () => Promise<string> }, 'syncProject').mockResolvedValue('up-to-date');
    const out = await run({});
    expect(out.stdout).toBe('');
  });

  test('a marker that names another project than keep.lock does is stale: the normal sync, nothing created', async () => {
    fakeWorld();
    await run(ALL_ANSWERS);
    mock.restore();
    const fm = new FileManager(process.cwd());
    fm.writeSyncState({ ...readSyncStateFile(), pending_setup: { ...MARKER, project_id: 'proj-other' } });

    const calls = fakeWorld();
    const sync = spyOn(CapyCommand.prototype as unknown as { syncProject: () => Promise<string> }, 'syncProject').mockResolvedValue('up-to-date');
    const out = await run(ALL_ANSWERS);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(calls.createBranch).not.toHaveBeenCalled();
    expect(calls.pushSecrets).not.toHaveBeenCalled();
    expect(out.json).toMatchObject({ ok: true, ignored_flags: ['--name', '--branch', '--protected'] });
  });
});

describe('a marker and answers that differ from it: refused, nothing changed', () => {
  test('--org naming another organization (by name) is SETUP_PENDING_MISMATCH', async () => {
    await strandedSetup({ orgs: [ORG, OTHER_ORG] });
    const calls = fakeWorld({ orgs: [ORG, OTHER_ORG] });
    const out = await run({ ...ALL_ANSWERS, org: 'Other' });
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'SETUP_PENDING_MISMATCH', differs: ['--org'], project: { id: 'proj-new', name: 'demo' } });
    expectStranded(calls);
    expectNoLeak(out);
  });

  test('--org naming another organization (by id), or one that does not exist, is refused the same way', async () => {
    await strandedSetup({ orgs: [ORG, OTHER_ORG] });
    const calls = fakeWorld({ orgs: [ORG, OTHER_ORG] });
    const byId = await run({ ...ALL_ANSWERS, org: 'org-2' });
    expect(byId.json).toMatchObject({ code: 'SETUP_PENDING_MISMATCH', differs: ['--org'] });
    const unknown = await run({ ...ALL_ANSWERS, org: 'nope' });
    expect(unknown.json).toMatchObject({ code: 'SETUP_PENDING_MISMATCH', differs: ['--org'] });
    expectStranded(calls);
    expectNoLeak(byId);
    expectNoLeak(unknown);
  });

  test('--org naming another organization is refused even when it is the only setup flag, or comes with only --name', async () => {
    await strandedSetup({ orgs: [ORG, OTHER_ORG] });
    const calls = fakeWorld({ orgs: [ORG, OTHER_ORG] });
    const sync = spyOn(CapyCommand.prototype as unknown as { syncProject: () => Promise<string> }, 'syncProject').mockResolvedValue('up-to-date');
    const alone = await run({ org: 'Other' });
    expect(alone.exitCode).toBe(1);
    expect(alone.json).toMatchObject({ ok: false, code: 'SETUP_PENDING_MISMATCH', differs: ['--org'], project: { id: 'proj-new', name: 'demo' } });
    const withName = await run({ org: 'Other', name: 'demo' });
    expect(withName.json).toMatchObject({ ok: false, code: 'SETUP_PENDING_MISMATCH', differs: ['--org'] });
    expect(sync).not.toHaveBeenCalled();
    expectStranded(calls);
    expectNoLeak(alone);
    expectNoLeak(withName);
  });

  test('the right --org alone is not a resume: the folder syncs as before, the flag is reported as not applied, the marker stays', async () => {
    await strandedSetup({ orgs: [ORG, OTHER_ORG] });
    const calls = fakeWorld({ orgs: [ORG, OTHER_ORG] });
    const sync = spyOn(CapyCommand.prototype as unknown as { syncProject: () => Promise<string> }, 'syncProject').mockResolvedValue('up-to-date');
    const out = await run({ org: 'Acme' });
    expect(out.exitCode).toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(out.json).toEqual({ ok: true, ignored_flags: ['--org'] });
    expectStranded(calls);
  });

  test('the same organization, by name or by id, is the resume', async () => {
    await strandedSetup({ orgs: [ORG, OTHER_ORG] });
    const byName = fakeWorld({ orgs: [ORG, OTHER_ORG] });
    const out = await run({ ...ALL_ANSWERS, org: 'acme' });
    expect(out.json).toMatchObject({ ok: true, resumed: true });
    expect(byName.initializeProject).not.toHaveBeenCalled();
    expect(readSyncStateFile().pending_setup).toBeUndefined();
    expectNoLeak(out);
  });

  test('a different --branch is refused', async () => {
    await strandedSetup();
    const calls = fakeWorld();
    const out = await run({ ...ALL_ANSWERS, branch: 'main' });
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'SETUP_PENDING_MISMATCH', differs: ['--branch'], branch: { name: 'development', protected: false } });
    expectStranded(calls);
    expectNoLeak(out);
  });

  test('a different --protected is refused', async () => {
    await strandedSetup();
    const calls = fakeWorld();
    const out = await run({ ...ALL_ANSWERS, protectedAnswer: 'yes' });
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'SETUP_PENDING_MISMATCH', differs: ['--protected'] });
    expectStranded(calls);
    expectNoLeak(out);
  });

  test('several differences are all named, and an unknown --protected word is a difference too', async () => {
    await strandedSetup();
    const calls = fakeWorld();
    const out = await run({ ...ALL_ANSWERS, branch: 'main', protectedAnswer: 'maybe' });
    expect(out.json).toMatchObject({ code: 'SETUP_PENDING_MISMATCH', differs: ['--branch', '--protected'] });
    expectStranded(calls);
    expectNoLeak(out);
  });

  test('a different --name or --project is refused too', async () => {
    await strandedSetup();
    const calls = fakeWorld();
    const name = await run({ ...ALL_ANSWERS, name: 'other' });
    expect(name.json).toMatchObject({ code: 'SETUP_PENDING_MISMATCH', differs: ['--name'] });
    const project = await run({ ...ALL_ANSWERS, project: 'web' });
    expect(project.json).toMatchObject({ code: 'SETUP_PENDING_MISMATCH', differs: ['--project'] });
    expectStranded(calls);
    expectNoLeak(name);
    expectNoLeak(project);
  });

  test('the answers that agree finish the setup on the same project and clear the marker', async () => {
    await strandedSetup();
    const calls = fakeWorld();
    const out = await run({ ...ALL_ANSWERS, project: 'new' });
    expect(out.exitCode).toBeUndefined();
    expect(out.json).toMatchObject({ ok: true, created: false, resumed: true, project: { id: 'proj-new', name: 'demo' }, branch: { name: 'development', protected: false }, pushed: 1 });
    expect(calls.initializeProject).not.toHaveBeenCalled();
    expect(calls.createBranch).toHaveBeenCalledTimes(1);
    expect(calls.pushSecrets).toHaveBeenCalledTimes(1);
    expect(readSyncStateFile().pending_setup).toBeUndefined();
    expectNoLeak(out);
  });

  test('a marker with no setup flags at all is not a resume: the folder syncs as before and the marker stays', async () => {
    await strandedSetup();
    const calls = fakeWorld();
    const sync = spyOn(CapyCommand.prototype as unknown as { syncProject: () => Promise<string> }, 'syncProject').mockResolvedValue('up-to-date');
    const out = await run({});
    expect(sync).toHaveBeenCalledTimes(1);
    expect(calls.createBranch).not.toHaveBeenCalled();
    expect(calls.pushSecrets).not.toHaveBeenCalled();
    expect(out.stdout).toBe('');
    expect(readSyncStateFile().pending_setup).toEqual(MARKER);
  });
});

describe('agent mode: a failure the setup steps did not code still ends as coded JSON', () => {
  test('a plain error from a read is a coded refusal, not a stack or prose', async () => {
    await strandedSetup();
    fakeWorld();
    spyOn(FileManager.prototype, 'readEnvMeta').mockImplementation(() => {
      throw new Error('disk exploded');
    });
    const out = await run(ALL_ANSWERS);
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'SERVICE_ERROR' });
    expect(typeof out.json!.error).toBe('string');
    expectNoLeak(out);
  });

  test('a CapyError keeps its own code', async () => {
    await strandedSetup();
    fakeWorld();
    spyOn(FileManager.prototype, 'readEnvMeta').mockImplementation(() => {
      throw new CapyError('Cannot read the file', ERROR_CODES.PERMISSION_DENIED);
    });
    const out = await run(ALL_ANSWERS);
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expectNoLeak(out);
  });

  test('the same on a folder that is not a project yet (the organization key lookup)', async () => {
    fakeWorld();
    spyOn(ProjectManager.prototype, 'readSyncState').mockImplementationOnce(() => null).mockImplementationOnce(() => null).mockImplementation(() => {
      throw new Error('state unreadable');
    });
    const out = await run(ALL_ANSWERS);
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false, code: 'SERVICE_ERROR' });
  });
});

describe('agent mode: a keep.lock that cannot be read', () => {
  test('is a coded refusal on stdout with the error\'s own code, never an error screen', async () => {
    writeFileSync(folder('keep.lock'), '{not json', 'utf-8');
    fakeWorld();
    const out = await run(ALL_ANSWERS);
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ ok: false });
    expect(out.json!.code).toBe('INVALID_FORMAT');
    expect(out.stdout).not.toContain('\u001b[');
    expect(out.stdout.trim().startsWith('{')).toBe(true);
  });
});

describe('terminal mode (no setup flags)', () => {
  const runSetup = (command: CapyCommand): Promise<void> =>
    (command as unknown as { runInitialization: () => Promise<void> }).runInitialization();

  /** What the person "types" in the terminal, keyed by the prompt's `name`. */
  function fakeTerminal() {
    prompts.mockImplementation((questions: unknown) => {
      const name = (questions as Array<{ name: string }>)[0].name;
      if (name === 'orgId') return Promise.resolve({ orgId: 'org-1' });
      if (name === 'initialBranchChoice') return Promise.resolve({ initialBranchChoice: 'development' });
      if (name === 'confirmEncrypt') return Promise.resolve({ confirmEncrypt: true });
      return Promise.resolve({});
    });
    return spyOn(PromptEngine.prototype, 'promptForProjectName').mockResolvedValue('demo');
  }

  function fakeTerminalWorld() {
    spyOn(AuthService.prototype, 'authenticate').mockResolvedValue({
      success: true, user_id: 'user-1', user_email: 'dev@example.com', organization_id: 'org-1', organizations: [ORG, OTHER_ORG], _auth_method: 'oauth',
    } as never);
    spyOn(ServiceClient.prototype, 'listProjects').mockResolvedValue([]);
    spyOn(ServiceClient.prototype, 'initializeProject').mockResolvedValue({ org_id: 'org-1', project_id: 'proj-1', project_name: 'demo', created: true });
    return spyOn(ServiceClient.prototype, 'createBranch').mockResolvedValue({ id: 'b1', name: 'development', project_id: 'proj-1', is_protected: false } as never);
  }

  test('with no flags it asks the same questions as before: the organization, the name and the branch', async () => {
    fakeTerminal();
    const name = spyOn(PromptEngine.prototype, 'promptForProjectName').mockResolvedValue('demo');
    const createBranch = fakeTerminalWorld();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    await runSetup(new CapyCommand({}, false)).finally(() => log.mockRestore());
    const asked = prompts.mock.calls.map(([q]) => (q as Array<{ name: string }>)[0].name);
    expect(asked).toEqual(['orgId', 'initialBranchChoice']);
    expect(name).toHaveBeenCalledTimes(1);
    expect(createBranch).toHaveBeenCalledWith('proj-1', 'development', false);
  });

  test('each flag answers its prompt and that prompt is skipped', async () => {
    fakeTerminal();
    const name = spyOn(PromptEngine.prototype, 'promptForProjectName').mockResolvedValue('never-asked');
    const createBranch = fakeTerminalWorld();
    const initializeProject = spyOn(ServiceClient.prototype, 'initializeProject').mockResolvedValue({ org_id: 'org-2', project_id: 'proj-1', project_name: 'typed', created: true });
    spyOn(AuthService.prototype, 'refreshWithCredentials').mockResolvedValue({ success: true } as never);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const setup: SetupOptions = { json: false, nonTty: false, agentMode: false, org: 'Other', name: 'typed', branch: 'main', protectedAnswer: 'yes' };
    await runSetup(new CapyCommand({ setup }, false)).finally(() => log.mockRestore());
    expect(prompts).not.toHaveBeenCalled();
    expect(name).not.toHaveBeenCalled();
    expect(initializeProject).toHaveBeenCalledWith('typed', 'org-2');
    expect(createBranch).toHaveBeenCalledWith('proj-1', 'main', true);
  });
});

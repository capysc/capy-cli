/**
 * `--org` (spec 3l, Vincent 2026-11-26): it picks among the organizations the signed-in account belongs to, never
 * beyond them; a folder's keep.lock still decides; and with several organizations and nobody to ask, the refusal
 * carries the terminal's pick as a form whose rerun adds `--org`.
 */
import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { AuthService } from '../../src/auth/authService';
import { ProjectManager } from '../../src/core/projectManager';
import { resolveOrgContext } from '../../src/core/orgContext';
import { setCommandShape, setRequestedOrg } from '../../src/core/requestedOrg';
import { CapyError } from '../../src/types/index';

const ACME = { id: 'org_1', name: 'Acme' };
const OTHER = { id: 'org_2', name: 'Other' };

function world(orgs: Array<{ id: string; name: string }>, folderOrgId?: string) {
  spyOn(ProjectManager.prototype, 'detectProjectState').mockResolvedValue({ initialized: !!folderOrgId, organizationId: folderOrgId } as never);
  const session = (orgId: string | undefined) => ({ success: true, user_id: 'u_1', user_email: 'dev@example.com', organization_id: orgId ?? orgs[0].id, organizations: orgs });
  const silent = spyOn(AuthService.prototype, 'authenticateSilent').mockImplementation((async (orgId?: string) => session(orgId)) as never);
  spyOn(AuthService.prototype, 'authenticate').mockImplementation((async () => { throw new Error('no browser sign-in in tests'); }) as never);
  return { silent };
}

async function refusal(run: () => Promise<unknown>): Promise<CapyError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof CapyError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

const ARGV = process.argv;
afterEach(() => {
  setRequestedOrg(undefined);
  setCommandShape({ org: false, json: false, nonTty: false });
  process.argv = ARGV;
});

describe('resolveOrgContext and --org', () => {
  it('picks the org by id or by name among the account\'s own', async () => {
    world([ACME, OTHER]);
    setRequestedOrg('org_2');
    expect((await resolveOrgContext(undefined, false, { promptForOrg: false })).orgId).toBe('org_2');
    setRequestedOrg('Acme');
    expect((await resolveOrgContext(undefined, false, { promptForOrg: false })).orgId).toBe('org_1');
  });

  it('an org the account is not in is ORG_NOT_FOUND, never used', async () => {
    world([ACME, OTHER]);
    setRequestedOrg('org_evil');
    const err = await refusal(() => resolveOrgContext(undefined, false, { promptForOrg: false }));
    expect(err.code).toBe('ORG_NOT_FOUND');
  });

  it('the folder\'s keep.lock decides: --org naming another org is ORG_FOLDER_MISMATCH; naming the same one is fine', async () => {
    world([ACME, OTHER], 'org_1');
    setRequestedOrg('org_2');
    expect((await refusal(() => resolveOrgContext(undefined, false, { promptForOrg: false }))).code).toBe('ORG_FOLDER_MISMATCH');
    setRequestedOrg('Acme');
    expect((await resolveOrgContext(undefined, false, { promptForOrg: false })).orgId).toBe('org_1');
  });

  it('several orgs, no --org, nobody to ask: ORG_SELECTION_REQUIRED with the orgs and the terminal\'s pick as a form', async () => {
    world([ACME, OTHER]);
    setCommandShape({ org: true, json: true, nonTty: false });
    process.argv = ['node', 'capy-dev', 'users', '--json'];
    const err = await refusal(() => resolveOrgContext(undefined, true, { promptForOrg: false }));
    expect(err.code).toBe('ORG_SELECTION_REQUIRED');
    expect(err.details.orgs).toEqual([ACME, OTHER]);
    const e = err.details.elicitation;
    expect(e.kind).toBe('form');
    expect(e.fields[0].question).toBe('Select organization:');
    expect(e.fields[0].options).toEqual([{ value: 'org_1', label: 'Acme' }, { value: 'org_2', label: 'Other' }]);
    expect(e.answer.rerun).toBe('capy-dev users --org <org> --json');
    expect(err.message).not.toContain('--org');
  });

  it('two orgs sharing the name --org gave: the pick again, of those two', async () => {
    const twin = { id: 'org_3', name: 'Acme' };
    world([ACME, OTHER, twin]);
    setRequestedOrg('Acme');
    const err = await refusal(() => resolveOrgContext(undefined, false, { promptForOrg: false }));
    expect(err.code).toBe('ORG_SELECTION_REQUIRED');
    expect(err.details.orgs).toEqual([ACME, twin]);
  });

  it('the rerun sets --org once (the typed one is dropped), and ends as the command can: --json, --non-tty or nothing', async () => {
    const twin = { id: 'org_3', name: 'Acme' };
    world([ACME, OTHER, twin]);
    setRequestedOrg('Acme');
    setCommandShape({ org: true, json: false, nonTty: false });
    process.argv = ['node', 'capy', 'grant-branch', 'a@b.co', 'web', 'prod', '--org', 'Acme'];
    const err = await refusal(() => resolveOrgContext(undefined, false, { promptForOrg: false }));
    expect(err.details.elicitation.answer.rerun).toBe('capy grant-branch a@b.co web prod --org <org>');
  });

  it('a command with no --org gets the orgs but no form: its rerun could not carry the answer', async () => {
    world([ACME, OTHER]);
    setCommandShape({ org: false, json: true, nonTty: true });
    const err = await refusal(() => resolveOrgContext(undefined, false, { promptForOrg: false }));
    expect(err.code).toBe('ORG_SELECTION_REQUIRED');
    expect(err.details.orgs).toEqual([ACME, OTHER]);
    expect(err.details.elicitation).toBeUndefined();
  });

  it('an org refusal that reaches the top uncaught is coded JSON on stdout (exit 3 for the pick, 1 otherwise), never a stack', async () => {
    const { exitIfOrgRefusal } = await import('../../src/core/orgSelection');
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation(((l: unknown) => { lines.push(String(l)); }) as never);
    const codes: Array<number | undefined> = [];
    const exit = spyOn(process, 'exit').mockImplementation(((c?: number) => { codes.push(c); return undefined as never; }) as never);
    try {
      exitIfOrgRefusal(new CapyError('pick', 'ORG_SELECTION_REQUIRED', { orgs: [ACME] }));
      exitIfOrgRefusal(new CapyError('nope', 'ORG_NOT_FOUND', { orgs: [ACME] }));
      expect(exitIfOrgRefusal(new Error('other'))).toBe(false);
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
    expect(codes).toEqual([3, 1]);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: false, code: 'ORG_SELECTION_REQUIRED', orgs: [ACME] });
    expect(JSON.parse(lines[1])).toMatchObject({ ok: false, code: 'ORG_NOT_FOUND' });
  });
});

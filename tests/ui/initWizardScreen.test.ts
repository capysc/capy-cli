/**
 * The first run, served as the compiled `init-wizard` screen.
 *
 * Two things are pinned here. The payload: what a step puts in front of a
 * person, which for the last step is a list of variable NAMES and never a
 * value or a snippet of one. And the channel: six questions in ONE window,
 * where answering a stop releases the CLI to do the work that stop unlocked
 * and the browser reloads into whatever the CLI reached next — the property
 * that replaced six unrelated pages, and the one that breaks silently.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildInitWizardData,
  projectNameProblem,
  InitWizardSession,
} from '../../src/ui/initWizardScreen';

const headers = { 'content-type': 'application/json' };

async function waitForUrl(getUrl: () => string): Promise<string> {
  for (let i = 0; i < 400 && !getUrl(); i++) await new Promise((r) => setTimeout(r, 10));
  return getUrl();
}

const ORGS = [
  { id: 'org-1', name: 'mikes-market-hq', isCurrent: true },
  { id: 'org-2', name: 'side-project-labs', isCurrent: false },
];

const PROJECTS = [
  { id: 'p-1', name: 'mikes-market' },
  { id: 'p-2', name: 'mikes-market-staging' },
];

/** POST an answer the way the screen does, and return the parsed body. */
async function submit(url: URL, nonce: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${url.port}/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ nonce, payload }),
  });
  return res.json();
}

/** Fetch the page the wizard is serving right now. */
const page = async (url: URL): Promise<string> => (await fetch(url.href)).text();

/** The payload inlined into the page the wizard is serving right now. */
async function served(url: URL): Promise<any> {
  const html = await page(url);
  const match = html.match(/window\.__CAPY_DATA__ = (.*);\n/);
  if (!match) throw new Error('no payload in the served page');
  return JSON.parse(match[1].replace(/\\u003c/g, '<'));
}

/** One stop off the rail the page is currently drawing. */
const stop = (data: any, id: string) => data.stops.find((s: any) => s.id === id);

describe('buildInitWizardData', () => {
  test('draws the whole route on every step, not just the stops behind it', () => {
    const d = buildInitWizardData({ step: 'organization', input: { orgCount: 2 }, orgs: ORGS }, 'n');
    expect(d.stops).toHaveLength(10);
    expect(d.stops[0].id).toBe('auth');
    expect(d.stops.at(-1)!.id).toBe('encrypt');
    expect(d.step).toBe('organization');
    expect(d.nonce).toBe('n');
  });

  test('the consent gate carries variable NAMES and a count — never a value', () => {
    const d = buildInitWizardData(
      {
        step: 'encrypt',
        input: { localEnvCount: 2 },
        localEnv: { count: 2, names: ['STRIPE_SECRET_KEY', 'DATABASE_URL'] },
        target: { projectName: 'mikes-market', orgName: 'mikes-market-hq', branch: 'development' },
      },
      'n',
    );
    expect(d.localEnv).toEqual({ count: 2, names: ['STRIPE_SECRET_KEY', 'DATABASE_URL'] });
    const json = JSON.stringify(d);
    // The values are still plaintext on disk at this point and the entire
    // question this step asks is whether they may stop being. Not even the
    // `abc...xyz` snippet the diff tables use belongs on this page.
    expect(json).not.toContain('sk_live');
    expect(json).not.toContain('postgres://');
    expect(json).not.toContain('...');
  });

  test('strips the terminal colour codes off names the CLI also prints', () => {
    const d = buildInitWizardData(
      {
        step: 'organization',
        input: {},
        orgs: [{ id: 'org-1', name: '\x1b[1mmikes-market-hq\x1b[0m', isCurrent: true }],
      },
      'n',
    );
    expect(d.orgs![0].name).toBe('mikes-market-hq');
    expect(JSON.stringify(d)).not.toContain('\x1b');
  });

  test('a failed project lookup is a different fact from an empty organization', () => {
    // The CLI swallows the error and proceeds as if the org had none, which
    // walks the user into a second project alongside the one they have.
    const d = buildInitWizardData(
      { step: 'project-name', input: { projectCount: 0, projectsUnavailable: true }, projectsUnavailable: true },
      'n',
    );
    expect(d.projectsUnavailable).toBe(true);
  });

  test('every step says how it is answered without a browser', () => {
    const steps = ['organization', 'project', 'project-name', 'branch', 'branch-name', 'encrypt'] as const;
    for (const step of steps) {
      const d = buildInitWizardData({ step, input: {} }, 'n');
      expect(d.nonTty?.command).toBeTruthy();
      expect(d.nonTty?.why).toBeTruthy();
    }
    // The invite code is a bearer credential, so its escape is a REFUSAL to
    // take one from argv rather than a flag that would leak it.
    expect(buildInitWizardData({ step: 'redeem', input: {} }, 'n').nonTty!.command).toBe('capy redeem <code>');
  });

  test('a refused answer is re-served with the CLI\'s own sentence', () => {
    const d = buildInitWizardData(
      { step: 'project-name', input: {}, value: 'mikes market', rejected: 'Project name can only contain letters, numbers, hyphens, and underscores' },
      'n',
    );
    expect(d.value).toBe('mikes market');
    expect(d.rejected).toContain('letters, numbers, hyphens, and underscores');
  });
});

describe('projectNameProblem', () => {
  test('is the CLI\'s validator, word for word', () => {
    expect(projectNameProblem('  ')).toBe('Project name cannot be empty');
    expect(projectNameProblem('mikes market')).toBe(
      'Project name can only contain letters, numbers, hyphens, and underscores',
    );
    expect(projectNameProblem('mikes-market_2')).toBeUndefined();
  });
});

describe('InitWizardSession', () => {
  test('walks six stops in ONE window, and the CLI works between them', async () => {
    let url = '';
    const session = new InitWizardSession({ open: false, onListen: (u) => (url = u) });

    // The CLI's own order, with the work each answer unlocks in between.
    const worked: string[] = [];
    const run = (async () => {
      session.record({ signedInAs: 'mike@market.example', orgCount: 2 });
      const org = await session.askOrganization(ORGS);
      worked.push('switch-org');
      session.record({ hasOrgKey: true, projectCount: 2, projectsUnavailable: false });
      const project = await session.askProject(PROJECTS);
      worked.push('list-projects');
      const name = await session.askProjectName('mikes-market');
      worked.push('create-project');
      const branch = await session.askBranchChoice();
      worked.push('create-branch');
      session.record({ localEnvCount: 2 });
      const encrypt = await session.askEncrypt(
        { count: 2, names: ['STRIPE_SECRET_KEY', 'DATABASE_URL'] },
        { projectName: 'mikes-market', orgName: 'mikes-market-hq', branch: 'development' },
      );
      await session.finish();
      return { org, project, name, branch, encrypt };
    })();

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    // Step one is the compiled screen itself, served whole.
    const first = await page(u);
    expect(first).toContain('window.__CAPY_DATA__');
    expect(first).toContain('mikes-market-hq');
    expect(first).not.toContain('id="screen"');

    // Answering releases the CLI and holds the POST until it asks again — so
    // by the time the response arrives, the next step IS the one being served.
    expect(await submit(u, nonce, { __action: 'submit', organizationId: 'org-2' })).toEqual({ next: true });
    expect(worked).toContain('switch-org');
    expect(await page(u)).toContain('mikes-market-staging');

    expect(await submit(u, nonce, { __action: 'submit', newProject: true })).toEqual({ next: true });
    await submit(u, nonce, { __action: 'submit', projectName: 'mikes-market' });
    await submit(u, nonce, { __action: 'submit', branchChoice: 'development' });

    // The last page names the variables it is asking about, and nothing else.
    const consent = await page(u);
    expect(consent).toContain('STRIPE_SECRET_KEY');
    expect(consent).not.toContain('sk_live');

    expect(await submit(u, nonce, { __action: 'submit', encrypt: true })).toEqual({ done: true });

    expect(await run).toEqual({
      org: 'org-2',
      project: 'new',
      name: 'mikes-market',
      branch: 'development',
      encrypt: true,
    });
    expect(worked).toEqual(['switch-org', 'list-projects', 'create-project', 'create-branch']);
  });

  test('an organization this session cannot reach is refused, not switched to', async () => {
    // Which organization a directory belongs to decides which key its secrets
    // are encrypted to. A submit the screen could not have produced is not an
    // answer to guess at.
    let url = '';
    let settled = false;
    const session = new InitWizardSession({ open: false, timeoutMs: 4_000, onListen: (u) => (url = u) });
    const run = (async () => {
      const chosen = await session.askOrganization(ORGS);
      await session.finish();
      return chosen;
    })();
    void run.then(() => (settled = true)).catch(() => undefined);

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    const body = await submit(u, nonce, { __action: 'submit', organizationId: 'org-999' });
    expect(body.error).toContain('not one this session can reach');
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    // The step is still live: answering properly finishes it.
    await submit(u, nonce, { __action: 'submit', organizationId: 'org-1' });
    expect(await run).toBe('org-1');
  });

  test('a name the CLI would refuse never reaches the service', async () => {
    let url = '';
    const session = new InitWizardSession({ open: false, timeoutMs: 4_000, onListen: (u) => (url = u) });
    const run = (async () => {
      const name = await session.askProjectName('mikes-market');
      await session.finish();
      return name;
    })();

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    // The CLI's sentence, not a paraphrase of it.
    expect((await submit(u, nonce, { __action: 'submit', projectName: 'mikes market' })).error).toBe(
      'Project name can only contain letters, numbers, hyphens, and underscores',
    );
    expect((await submit(u, nonce, { __action: 'submit', projectName: '   ' })).error).toBe(
      'Project name cannot be empty',
    );

    await submit(u, nonce, { __action: 'submit', projectName: '  mikes-market  ' });
    expect(await run).toBe('mikes-market');
  });

  test('the consent gate reads a closed window as NO', async () => {
    // `confirmEncrypt = chosen === 'yes'` already meant this, and after this
    // step the .env in the directory is ciphertext. Nothing about leaving may
    // look like agreement to that.
    let url = '';
    const session = new InitWizardSession({ open: false, timeoutMs: 4_000, onListen: (u) => (url = u) });
    const run = session.askEncrypt(
      { count: 2, names: ['A', 'B'] },
      { projectName: 'mikes-market', orgName: 'hq', branch: 'development' },
    );

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await submit(u, nonce, { __action: 'cancel' });
    expect(await run).toBe(false);
  });

  test('an answer the encrypt step cannot produce is refused rather than read as yes', async () => {
    let url = '';
    let settled = false;
    const session = new InitWizardSession({ open: false, timeoutMs: 4_000, onListen: (u) => (url = u) });
    const run = session.askEncrypt(
      { count: 1, names: ['A'] },
      { projectName: 'mikes-market', orgName: 'hq', branch: 'development' },
    );
    void run.then(() => (settled = true));

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    // A truthy string is not a boolean. Reading it as one would encrypt on a
    // submit the screen never made.
    const body = await submit(u, nonce, { __action: 'submit', encrypt: 'yes' });
    expect(body.error).toContain('not an answer the encrypt step can produce');
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    await submit(u, nonce, { __action: 'cancel' });
    expect(await run).toBe(false);
  });

  test('a cancelled stop answers null, and the run stops asking', async () => {
    let url = '';
    const session = new InitWizardSession({ open: false, timeoutMs: 4_000, onListen: (u) => (url = u) });
    const run = session.askOrganization(ORGS);

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    await submit(u, nonce, { __action: 'cancel' });
    expect(await run).toBeNull();
  });

  test('the rail redraws with each answer folded in', async () => {
    let url = '';
    const session = new InitWizardSession({ open: false, timeoutMs: 4_000, onListen: (u) => (url = u) });
    const run = (async () => {
      session.record({ orgCount: 2 });
      await session.askOrganization(ORGS);
      session.record({ hasOrgKey: true, projectCount: 0 });
      await session.askProjectName('mikes-market');
      await session.finish();
    })();

    const u = new URL(await waitForUrl(() => url));
    const nonce = u.searchParams.get('n') ?? '';

    // Before: the organization stop is where the traveller stands, and the
    // fork behind it is two blanks.
    const first = await served(u);
    expect(stop(first, 'organization').state).toBe('current');
    expect(stop(first, 'organization-name').blank).toBe(true);

    await submit(u, nonce, { __action: 'submit', organizationId: 'org-1' });

    // After: it is settled with the organization's own name, the fork it did
    // not take is skipped, and the project stop is skipped because this org
    // has none — a route redrawn by the CLI, not by the page.
    const second = await served(u);
    expect(stop(second, 'organization')).toMatchObject({ state: 'done', answer: 'mikes-market-hq' });
    expect(stop(second, 'organization-name').state).toBe('skipped');
    expect(stop(second, 'organization-name').blank).toBeUndefined();
    expect(stop(second, 'project').state).toBe('skipped');
    expect(stop(second, 'project-name').state).toBe('current');

    await submit(u, nonce, { __action: 'submit', projectName: 'mikes-market' });
    await run;
  });
});

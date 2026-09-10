import { describe, expect, test } from 'bun:test';
import {
  blockedFromError,
  buildInitWizardData,
  InitWizardSession,
  projectNameProblem,
} from '../../src/ui/initWizardScreen';
import {
  branchChoiceQuestion,
  encryptQuestion,
  organizationQuestion,
  projectNameQuestion,
  projectQuestion,
} from '../../src/ui/initWizardQuestions';
import { CapyError, ERROR_CODES } from '../../src/types';

const headers = { 'content-type': 'application/json' };
const ORGS = [
  { id: 'org-1', name: 'mikes-market-hq', isCurrent: true },
  { id: 'org-2', name: 'side-project-labs', isCurrent: false },
] as const;
const PROJECTS = [
  { id: 'p-1', name: 'mikes-market' },
  { id: 'p-2', name: 'mikes-market-staging' },
] as const;

const submit = async (
  url: URL,
  nonce: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<unknown> => {
  const response = await fetch(`http://127.0.0.1:${url.port}/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ nonce, payload }),
  });
  return response.json();
};

const page = async (url: URL): Promise<string> => (await fetch(url.href)).text();

const served = async (url: URL): Promise<Record<string, unknown>> => {
  const html = await page(url);
  const match = html.match(/window\.__CAPY_DATA__ = (.*);\n/);
  if (match === null) throw new Error('no payload in the served page');
  return JSON.parse(match[1].replace(/\\u003c/g, '<')) as Record<string, unknown>;
};

const questionUrl = async (started: Promise<string>): Promise<Readonly<{ url: URL; nonce: string }>> => {
  const url = new URL(await started);
  return { url, nonce: url.searchParams.get('n') ?? '' };
};

describe('buildInitWizardData', () => {
  test('draws the whole route with immutable, ANSI-free presentation data', () => {
    const data = buildInitWizardData(
      {
        step: 'organization',
        input: { orgCount: 2 },
        orgs: [{ id: 'org-1', name: '\x1b[1mmikes-market-hq\x1b[0m', isCurrent: true }],
      },
      'n',
    );
    expect(data.stops).toHaveLength(10);
    expect(data.orgs?.[0]?.name).toBe('mikes-market-hq');
    expect(data.nonce).toBe('n');
  });

  test('uses the shared project-name validator verbatim', () => {
    expect(projectNameProblem('mikes market')).toBe(
      'Project name can only contain letters, numbers, hyphens, and underscores',
    );
    expect(projectNameProblem('mikes-market_2')).toBeUndefined();
  });
});

describe('InitWizardSession', () => {
  test('threads accepted answers through one held-post window', async () => {
    const started = Promise.withResolvers<string>();
    const initial = new InitWizardSession({ open: false, onListen: started.resolve });
    const run = (async () => {
      const organization = await initial
        .record({ signedInAs: 'mike@market.example', orgCount: 2 })
        .askQuestion(organizationQuestion(ORGS));
      const project = await organization.session
        .record({ hasOrgKey: true, projectCount: 2, projectsUnavailable: false })
        .askQuestion(projectQuestion(PROJECTS));
      const name = await project.session.askQuestion(projectNameQuestion('mikes-market'));
      const branch = await name.session.askQuestion(branchChoiceQuestion());
      const encrypt = await branch.session
        .record({ localEnvCount: 2 })
        .askQuestion(encryptQuestion(
          { count: 2, names: ['STRIPE_SECRET_KEY', 'DATABASE_URL'] },
          { projectName: 'mikes-market', orgName: 'mikes-market-hq', branch: 'development' },
        ));
      const terminal = await encrypt.session.finish();
      return { organization, project, name, branch, encrypt, terminal };
    })();
    const first = await questionUrl(started.promise);

    expect(await page(first.url)).toContain('mikes-market-hq');
    expect(await submit(first.url, first.nonce, { __action: 'submit', organizationId: 'org-2' })).toEqual({ next: true });
    expect(await page(first.url)).toContain('mikes-market-staging');
    expect(await submit(first.url, first.nonce, { __action: 'submit', newProject: true })).toEqual({ next: true });
    expect(await submit(first.url, first.nonce, { __action: 'submit', projectName: 'mikes-market' })).toEqual({ next: true });
    expect(await submit(first.url, first.nonce, { __action: 'submit', branchChoice: 'development' })).toEqual({ next: true });
    expect(await submit(first.url, first.nonce, { __action: 'submit', encrypt: true })).toEqual({ done: true });

    const result = await run;
    expect(result.organization.value).toBe('org-2');
    expect(result.project.value).toBe('new');
    expect(result.name.value).toBe('mikes-market');
    expect(result.branch.value).toBe('development');
    expect(result.encrypt.value).toBe(true);
    expect(await result.terminal.abort()).toBeInstanceOf(InitWizardSession);
  });

  test('keeps an inline refusal live and makes cancellation terminal', async () => {
    const started = Promise.withResolvers<string>();
    const initial = new InitWizardSession({ open: false, onListen: started.resolve, timeoutMs: 4_000 });
    const answer = initial.askQuestion(organizationQuestion(ORGS));
    const first = await questionUrl(started.promise);

    expect(await submit(first.url, first.nonce, { __action: 'submit', organizationId: 'org-999' })).toEqual({
      error: 'That organization is not one this session can reach.',
    });
    expect(await submit(first.url, first.nonce, { __action: 'cancel' })).toEqual({ done: true });

    const cancelled = await answer;
    expect(cancelled.value).toBeNull();
    await cancelled.session.finish();
    expect(await fetch(first.url.href).then(() => 'up').catch(() => 'down')).toBe('down');
    const error = await cancelled.session.askQuestion(projectNameQuestion('mikes-market')).catch(reason => reason);
    expect(error).toBeInstanceOf(CapyError);
    expect((error as CapyError).code).toBe(ERROR_CODES.SERVICE_ERROR);
  });

  test('keeps a declared failure on its coded final page', async () => {
    const started = Promise.withResolvers<string>();
    const initial = new InitWizardSession({
      open: false,
      onListen: started.resolve,
      timeoutMs: 4_000,
      finalGraceMs: 3_000,
    });
    const run = (async () => {
      const organization = await initial.record({ orgCount: 2 }).askQuestion(organizationQuestion(ORGS));
      return organization.session
        .record({ hasOrgKey: false })
        .willBlock(
          'redeem',
          {
            code: ERROR_CODES.AUTH_FAILED,
            title: 'This device does not hold this organization\'s key',
            detail: 'The shared key has never been transferred here.',
            remedy: 'capy redeem <code>',
          },
          { facts: [{ label: 'Organization', value: 'mikes-market-hq' }] },
        )
        .abort(new CapyError('no key', ERROR_CODES.AUTH_FAILED));
    })();
    const first = await questionUrl(started.promise);

    expect(await submit(first.url, first.nonce, { __action: 'submit', organizationId: 'org-1' })).toEqual({ next: true });
    const blocked = await served(first.url);
    expect(blocked.step).toBe('redeem');
    expect((blocked.blocked as { code?: string }).code).toBe(ERROR_CODES.AUTH_FAILED);
    expect(await run).toBeInstanceOf(InitWizardSession);
  });

  test('clears an accepted encrypt answer before showing the post-push failure', async () => {
    const started = Promise.withResolvers<string>();
    const initial = new InitWizardSession({
      open: false,
      onListen: started.resolve,
      timeoutMs: 4_000,
      finalGraceMs: 3_000,
    });
    const run = (async () => {
      const answer = await initial
        .record({ localEnvCount: 1 })
        .askQuestion(encryptQuestion(
          { count: 1, names: ['DATABASE_URL'] },
          { projectName: 'mikes-market', orgName: 'hq', branch: 'development' },
        ));
      return answer.session.reportEncryptFailure({
        code: ERROR_CODES.SERVICE_ERROR,
        reason: 'Keep did not answer (503).',
        envRewritten: false,
        backupWritten: false,
        pushed: false,
      });
    })();
    const first = await questionUrl(started.promise);

    expect(await submit(first.url, first.nonce, { __action: 'submit', encrypt: true })).toEqual({ next: true });
    const failed = await served(first.url);
    expect((failed.encryptFailure as { code?: string }).code).toBe(ERROR_CODES.SERVICE_ERROR);
    expect(JSON.stringify(failed)).not.toContain('sk_live');
    expect(await run).toBeInstanceOf(InitWizardSession);
  });
});

test('blockedFromError retains the CLI code without parsing prose', () => {
  expect(blockedFromError(new CapyError('no key', ERROR_CODES.AUTH_FAILED)).code).toBe(ERROR_CODES.AUTH_FAILED);
});

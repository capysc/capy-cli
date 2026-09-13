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
    // The invite code is key material, so its escape is a REFUSAL to take one
    // from argv rather than a flag that would leak it.
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

describe('blockedFromError', () => {
  test('carries the error\'s CODE and never mines its sentence for a remedy', () => {
    const b = blockedFromError(
      new CapyError(
        'You have access to "hq" but no encryption key on this device.\n\n  run:\n\n    capy redeem <code>',
        ERROR_CODES.AUTH_FAILED,
      ),
    );
    expect(b.code).toBe(ERROR_CODES.AUTH_FAILED);
    // The command inside that sentence is not lifted out of it: prose is not a
    // contract, and a call site that knows the remedy states it in fields.
    expect(b.remedy).toBe('capy');
  });

  test('an error with no code is not given one that means something else', () => {
    expect(blockedFromError(new Error('socket hang up')).code).toBe('UNKNOWN');
    expect(blockedFromError(undefined).detail).toContain('without saying why');
  });

  test('the bold the CLI prints does not reach the browser as [1m', () => {
    const data = buildInitWizardData(
      {
        step: 'redeem',
        input: {},
        blocked: {
          code: 'AUTH_FAILED',
          title: '\x1b[1mNo key\x1b[0m',
          detail: 'Ask for \x1b[1mcapy redeem\x1b[0m',
          remedy: '\x1b[1mcapy redeem <code>\x1b[0m',
        },
        blockedNames: ['\x1b[1mSTRIPE_SECRET_KEY\x1b[0m'],
        blockedFacts: [{ label: 'Organization', value: '\x1b[1mhq\x1b[0m' }],
      },
      'n',
    );
    expect(JSON.stringify(data)).not.toContain('\u001b');
    expect(data.blocked!.title).toBe('No key');
    expect(data.blockedNames).toEqual(['STRIPE_SECRET_KEY']);
    expect(data.blockedFacts).toEqual([{ label: 'Organization', value: 'hq' }]);
  });
});

describe('projectNameProblem', () => {
  test('uses the shared project-name validator verbatim', () => {
    expect(projectNameProblem('  ')).toBe('Project name cannot be empty');
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

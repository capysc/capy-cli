/**
 * `capy setup` (CAP-891): the order of the steps, where it stops, and that every stop names `capy setup` as the
 * command to run next. The steps themselves (pairing, the folder, the agent instructions) have their own tests; here
 * they are stand-ins that record what was asked of them. Nothing is prefilled for the human: a stop is passed on as it is.
 */
import { describe, expect, test } from 'bun:test';
import { asSetupCommand, forSetup, setupOutcome, type FolderOutcome, type SetupCommandOptions, type SetupDeps } from '../../src/commands/setupCommand';
import type { PairAgentOutcome } from '../../src/commands/pairAgentCommand';
import type { Refusal } from '../../src/commands/refusal';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const OPTIONS: SetupCommandOptions = { answers: {} };

const NOT_SIGNED_IN: Refusal = { code: ERROR_CODES.AUTH_FAILED, message: 'Not authenticated. Run `capy pair` to sign in.', exitCode: 1, extra: { reason: 'no_session', next_command: 'capy pair' } };

const LINK: Refusal = {
  code: ERROR_CODES.PAIR_APPROVAL_PENDING,
  message: 'Waiting for approval.',
  exitCode: 3,
  extra: { elicitation: { kind: 'link', url: 'https://keep.example/pair/abc', code: 'ABCD', purpose: 'p', expires_at: 'soon', answer: { wait: 'capy pair --wait' } } },
};

const CODE_FORM: Refusal = {
  code: ERROR_CODES.PAIR_CODE_REQUIRED,
  message: 'Approved in Keep.',
  exitCode: 3,
  extra: { elicitation: { kind: 'form', fields: [{ name: 'code' }], answer: { rerun: 'capy pair --wait --code <code>' } } },
};

const FOLDER_FORM: Refusal = {
  code: ERROR_CODES.INIT_INPUT_REQUIRED,
  message: 'Questions left.',
  exitCode: 3,
  extra: { elicitation: { kind: 'form', fields: [{ name: 'project' }], answer: { rerun: 'capy --org org_1 --project <project> --json' } } },
};

const CREATED = { ok: true, created: true, org: { id: 'org_1', name: 'Acme' }, project: { id: 'p_1', name: 'web' }, branch: { name: 'development', protected: false }, pushed: 2, env_found: true };

const paired: PairAgentOutcome = { kind: 'done', body: { ok: true, user_id: 'u_1', paired: true, keys: 'installed' } };

/** Stand-in steps. `folder` and `pair` answer from their lists in order (the last answer repeats); `calls` is what was asked. */
function deps(over: { readonly pending?: boolean; readonly folder?: readonly FolderOutcome[]; readonly pair?: readonly PairAgentOutcome[]; readonly agentsFiles?: SetupDeps['agentsFiles'] }) {
  const calls: string[] = [];
  const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
  const at = <T,>(list: readonly T[], index: number): T => list[Math.min(index, list.length - 1)] as T;
  const made: SetupDeps = {
    pendingPair: () => over.pending === true,
    pair: async (step) => {
      const answer = at(over.pair ?? [paired], count('pair'));
      calls.push(`pair ${step.wait ? 'wait' : 'start'}${step.code === undefined ? '' : ` code=${step.code}`}`);
      return answer;
    },
    folder: async () => {
      const answer = at(over.folder ?? [{ kind: 'done', result: CREATED }], count('folder'));
      calls.push('folder');
      return answer;
    },
    linked: async () => ({ organizationId: 'org_1', projectId: 'p_1', projectName: 'web', activeBranch: 'main' }),
    agentsFiles: over.agentsFiles ?? ((apply) => {
      calls.push(`agents apply=${apply}`);
      return [{ path: 'AGENTS.md', action: 'created' }, { path: 'CLAUDE.md', action: 'unchanged' }];
    }),
    integrations: () => [{ provider: 'stripe', found: ['.env:STRIPE_SECRET_KEY'], next: 'capy connect stripe' }],
  };
  return { made, calls };
}

const elicitationAnswer = (r: Refusal) => (r.extra?.elicitation as { answer: Record<string, string> }).answer;

describe('asSetupCommand', () => {
  test('the pairing wait, the pairing code and the folder answers all become capy setup', () => {
    expect(asSetupCommand('capy pair --wait', 'capy')).toBe('capy setup --json');
    expect(asSetupCommand('capy pair --wait --code <code>', 'capy')).toBe('capy setup --code <code> --json');
    expect(asSetupCommand('capy --org org_1 --project <project> --json', 'capy')).toBe('capy setup --org org_1 --project <project> --json');
    expect(asSetupCommand('capy-staging --env-path apps/web/.env --name <name> --json', 'capy-staging')).toBe('capy-staging setup --env-path apps/web/.env --name <name> --json');
  });

  test('any other command is left as it is', () => {
    expect(asSetupCommand('capy project restore web --yes', 'capy')).toBe('capy project restore web --yes');
  });

  test('a refusal with no elicitation is left as it is', () => {
    const plain: Refusal = { code: 'X', message: 'm', exitCode: 1 };
    expect(forSetup(plain, 'capy')).toBe(plain);
  });
});

describe('setupOutcome', () => {
  test('signed in, questions answered: folder, agent instructions, then the finished setup with integrations', async () => {
    const { made, calls } = deps({});
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'agents apply=true']);
    expect(outcome).toEqual({
      kind: 'done',
      result: {
        ok: true,
        setup: 'complete',
        created: true,
        org: { id: 'org_1', name: 'Acme' },
        project: { id: 'p_1', name: 'web' },
        branch: { name: 'development', protected: false },
        pushed: 2,
        env_found: true,
        agents_files: [{ path: 'AGENTS.md', action: 'created' }, { path: 'CLAUDE.md', action: 'unchanged' }],
        integrations: [{ provider: 'stripe', found: ['.env:STRIPE_SECRET_KEY'], next: 'capy connect stripe' }],
      },
    });
  });

  test('a code with a pairing waiting: the pairing is finished with that code first, then the folder', async () => {
    const { made, calls } = deps({ pending: true });
    const outcome = await setupOutcome({ ...OPTIONS, code: ' ABCD ' }, made);
    expect(calls).toEqual(['pair wait code=ABCD', 'folder', 'agents apply=true']);
    expect(outcome.kind).toBe('done');
  });

  test('a wrong code stops there, and the form reruns capy setup --code', async () => {
    const { made, calls } = deps({ pending: true, pair: [{ kind: 'refusal', refusal: { ...CODE_FORM, code: ERROR_CODES.PAIR_CODE_MISMATCH } }] });
    const outcome = await setupOutcome({ ...OPTIONS, code: 'ZZZZ' }, made);
    expect(calls).toEqual(['pair wait code=ZZZZ']);
    if (outcome.kind !== 'refusal') throw new Error('expected a refusal');
    expect(outcome.refusal.code).toBe(ERROR_CODES.PAIR_CODE_MISMATCH);
    expect(outcome.refusal.exitCode).toBe(3);
    expect(elicitationAnswer(outcome.refusal)).toEqual({ rerun: 'capy setup --code <code> --json' });
  });

  test('a code with no pairing waiting was used already: the rerun goes straight to the folder', async () => {
    const { made, calls } = deps({ pending: false });
    await setupOutcome({ ...OPTIONS, code: 'ABCD' }, made);
    expect(calls).toEqual(['folder', 'agents apply=true']);
  });

  test('nobody signed in: a pairing starts and its link waits on capy setup', async () => {
    const { made, calls } = deps({ folder: [{ kind: 'refusal', refusal: NOT_SIGNED_IN }], pair: [{ kind: 'refusal', refusal: LINK }] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'pair start']);
    if (outcome.kind !== 'refusal') throw new Error('expected a refusal');
    expect(outcome.refusal.code).toBe(ERROR_CODES.PAIR_APPROVAL_PENDING);
    expect(elicitationAnswer(outcome.refusal)).toEqual({ wait: 'capy setup --json' });
    // The link itself is the pairing's own, untouched.
    expect((outcome.refusal.extra?.elicitation as { url: string; code: string }).url).toBe('https://keep.example/pair/abc');
  });

  test('nobody signed in and a pairing already waiting: it is waited on, never replaced', async () => {
    const { made, calls } = deps({ pending: true, folder: [{ kind: 'refusal', refusal: NOT_SIGNED_IN }], pair: [{ kind: 'refusal', refusal: CODE_FORM }] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'pair wait']);
    if (outcome.kind !== 'refusal') throw new Error('expected a refusal');
    expect(elicitationAnswer(outcome.refusal)).toEqual({ rerun: 'capy setup --code <code> --json' });
  });

  test('a pairing that completes inside the run goes on to the folder, once', async () => {
    const { made, calls } = deps({ pending: true, folder: [{ kind: 'refusal', refusal: NOT_SIGNED_IN }, { kind: 'done', result: CREATED }] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'pair wait', 'folder', 'agents apply=true']);
    expect(outcome.kind).toBe('done');
  });

  test('still not signed in after pairing: the refusal is passed on and no second pairing starts', async () => {
    const { made, calls } = deps({ folder: [{ kind: 'refusal', refusal: NOT_SIGNED_IN }] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'pair start', 'folder']);
    if (outcome.kind !== 'refusal') throw new Error('expected a refusal');
    expect(outcome.refusal.code).toBe(ERROR_CODES.AUTH_FAILED);
    expect(outcome.refusal.extra?.next_command).toBe('capy setup --json');
  });

  test('a sign-in failure pairing cannot fix (no next_command) starts no pairing', async () => {
    const offline: Refusal = { code: ERROR_CODES.AUTH_FAILED, message: 'offline', exitCode: 1, extra: { reason: 'network' } };
    const { made, calls } = deps({ folder: [{ kind: 'refusal', refusal: offline }] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder']);
    expect(outcome).toEqual({ kind: 'refusal', refusal: offline });
  });

  test('folder questions left: the form is passed on and reruns capy setup with the same flags', async () => {
    const { made, calls } = deps({ folder: [{ kind: 'refusal', refusal: FOLDER_FORM }] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder']);
    if (outcome.kind !== 'refusal') throw new Error('expected a refusal');
    expect(outcome.refusal.code).toBe(ERROR_CODES.INIT_INPUT_REQUIRED);
    expect(outcome.refusal.exitCode).toBe(3);
    expect(elicitationAnswer(outcome.refusal)).toEqual({ rerun: 'capy setup --org org_1 --project <project> --json' });
    expect((outcome.refusal.extra?.elicitation as { fields: unknown }).fields).toEqual([{ name: 'project' }]);
  });

  test('a folder that is a project already still gets the agent instructions and the integrations', async () => {
    const { made, calls } = deps({ folder: [{ kind: 'sync' }] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'agents apply=true']);
    if (outcome.kind !== 'done') throw new Error('expected a result');
    expect(outcome.result).toMatchObject({
      ok: true,
      setup: 'complete',
      created: false,
      already_set_up: true,
      org: { id: 'org_1' },
      project: { id: 'p_1', name: 'web' },
      branch: { name: 'main', protected: null },
    });
  });

  test('a dry run starts no pairing, writes no file and says so', async () => {
    const signedOut = deps({ pending: true, folder: [{ kind: 'refusal', refusal: NOT_SIGNED_IN }] });
    const stopped = await setupOutcome({ ...OPTIONS, code: 'ABCD', dryRun: true }, signedOut.made);
    expect(signedOut.calls).toEqual(['folder']);
    if (stopped.kind !== 'refusal') throw new Error('expected a refusal');
    expect(stopped.refusal.code).toBe(ERROR_CODES.AUTH_FAILED);
    expect(stopped.refusal.extra?.next_command).toBe('capy setup --json');

    const signedIn = deps({ folder: [{ kind: 'done', result: { ok: true, dry_run: true, org: { id: 'org_1', name: 'Acme' }, would_push: 2 } }] });
    const outcome = await setupOutcome({ ...OPTIONS, dryRun: true }, signedIn.made);
    expect(signedIn.calls).toEqual(['folder', 'agents apply=false']);
    if (outcome.kind !== 'done') throw new Error('expected a result');
    expect(outcome.result.setup).toBe('dry_run');
    expect(outcome.result.would_push).toBe(2);
    expect('dry_run' in outcome.result).toBe(false);
  });

  test('agent instructions that cannot be written end as a coded refusal', async () => {
    const { made } = deps({ agentsFiles: () => { throw new CapyError('AGENTS.md has a damaged Capy block.', ERROR_CODES.AGENTS_BLOCK_MALFORMED); } });
    const outcome = await setupOutcome(OPTIONS, made);
    if (outcome.kind !== 'refusal') throw new Error('expected a refusal');
    expect(outcome.refusal.code).toBe(ERROR_CODES.AGENTS_BLOCK_MALFORMED);
    expect(outcome.refusal.exitCode).toBe(1);
  });

  test('local-only mode has nothing to set up here', async () => {
    const { made, calls } = deps({ folder: [undefined] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder']);
    expect(outcome.kind).toBe('refusal');
  });
});

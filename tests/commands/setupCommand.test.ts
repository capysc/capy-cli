/**
 * `capy setup` (CAP-891): the order of the steps, where it stops, and that every stop names `capy setup` as the
 * command to run next. The steps themselves (pairing, the folder, the agent instructions) have their own tests; here
 * they are stand-ins that record what was asked of them. Nothing is prefilled for the human: a stop is passed on as it is.
 */
import { describe, expect, test } from 'bun:test';
import { asSetupCommand, forSetup, setupOutcome, type FolderOutcome, type LinkedFolder, type PendingPair, type SetupCommandOptions, type SetupDeps } from '../../src/commands/setupCommand';
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

const LINKED: LinkedFolder = { organizationId: 'org_1', projectId: 'p_1', projectName: 'web', activeBranch: 'main' };

interface Stand {
  /** `true` is a pairing that is waiting. */
  readonly pending?: boolean | PendingPair;
  readonly folder?: readonly FolderOutcome[];
  readonly pair?: readonly PairAgentOutcome[];
  readonly linked?: readonly LinkedFolder[];
  /** What the session check answers, in order: a refusal, or undefined for "signed in". */
  readonly session?: readonly (Refusal | undefined)[];
  readonly agentsFiles?: SetupDeps['agentsFiles'];
  readonly localOnly?: boolean;
}

/** Stand-in steps. Each answers from its list in order (the last answer repeats); `calls` is what was asked. */
function deps(over: Stand) {
  const calls: string[] = [];
  const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
  const at = <T,>(list: readonly T[], index: number): T => list[Math.min(index, list.length - 1)] as T;
  let pending: PendingPair = over.pending === true ? 'waiting' : over.pending === false || over.pending === undefined ? 'none' : over.pending;
  const made: SetupDeps = {
    localOnly: () => over.localOnly === true,
    pendingPair: () => pending,
    pair: async (step) => {
      const answer = at(over.pair ?? [paired], count('pair'));
      calls.push(`pair ${step.wait ? 'wait' : 'start'}${step.code === undefined ? '' : ` code=${step.code}`}${step.noRenew === true ? ' no-renew' : ''}`);
      // As the real wait does: a pairing the service says is gone is dropped (CAP-902).
      if (answer.kind === 'refusal' && answer.refusal.code === ERROR_CODES.PAIR_EXPIRED) pending = 'none';
      return answer;
    },
    folder: async (answers) => {
      const answer = at(over.folder ?? [{ kind: 'done', result: CREATED }], count('folder'));
      calls.push(answers === undefined ? 'folder' : `folder name=${answers.name} branch=${answers.branch} protected=${answers.protectedAnswer}`);
      return answer;
    },
    linked: async () => at(over.linked ?? [LINKED], count('linked-read')),
    session: async (orgId) => {
      const answer = at(over.session ?? [undefined], count('session'));
      calls.push(`session org=${orgId}`);
      return answer;
    },
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
    // CAP-913: starting again after the last link expired is setup again.
    expect(asSetupCommand('capy pair --json', 'capy')).toBe('capy setup --json');
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

  test('a folder that is a project already, signed in: the agent instructions and the integrations, and the sync to run next', async () => {
    const { made, calls } = deps({ folder: [{ kind: 'sync', ignoredFlags: ['--name'] }] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'session org=org_1', 'agents apply=true']);
    if (outcome.kind !== 'done') throw new Error('expected a result');
    expect(outcome.result).toMatchObject({
      ok: true,
      setup: 'complete',
      created: false,
      already_set_up: true,
      org: { id: 'org_1' },
      project: { id: 'p_1', name: 'web' },
      branch: { name: 'main', protected: null },
      ignored_flags: ['--name'],
      next: 'capy --json',
    });
  });

  test('a cloned project on a machine that was never paired is not complete: pairing starts and nothing is written', async () => {
    const { made, calls } = deps({ folder: [{ kind: 'sync' }], session: [NOT_SIGNED_IN], pair: [{ kind: 'refusal', refusal: LINK }] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'session org=org_1', 'pair start']);
    if (outcome.kind !== 'refusal') throw new Error('expected a refusal');
    expect(outcome.refusal.code).toBe(ERROR_CODES.PAIR_APPROVAL_PENDING);
    expect(elicitationAnswer(outcome.refusal)).toEqual({ wait: 'capy setup --json' });
  });

  test('a cloned project and the code from Keep: the pairing is finished, the session is checked again, then it completes', async () => {
    const { made, calls } = deps({ pending: true, folder: [{ kind: 'sync' }] });
    const outcome = await setupOutcome({ ...OPTIONS, code: 'ABCD' }, made);
    expect(calls).toEqual(['pair wait code=ABCD', 'folder', 'session org=org_1', 'agents apply=true']);
    expect(outcome.kind).toBe('done');
  });

  test('a cloned project, signed out, with a pairing waiting: it is waited on, then the folder is read again', async () => {
    const { made, calls } = deps({ pending: true, folder: [{ kind: 'sync' }], session: [NOT_SIGNED_IN, undefined] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'session org=org_1', 'pair wait', 'folder', 'session org=org_1', 'agents apply=true']);
    expect(outcome.kind).toBe('done');
  });

  test('a linked folder that cannot reach the service is a refusal, never complete', async () => {
    const offline: Refusal = { code: ERROR_CODES.AUTH_FAILED, message: 'offline', exitCode: 1, extra: { reason: 'network' } };
    const { made, calls } = deps({ folder: [{ kind: 'sync' }], session: [offline] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'session org=org_1']);
    expect(outcome).toEqual({ kind: 'refusal', refusal: offline });
  });

  test('a setup that stopped half way is picked back up with the answers the folder kept, once', async () => {
    const half: LinkedFolder = { ...LINKED, pendingSetup: { branch: 'development', protected: true } };
    const { made, calls } = deps({ folder: [{ kind: 'sync' }, { kind: 'done', result: { ...CREATED, created: false, resumed: true } }], linked: [half] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'session org=org_1', 'folder name=web branch=development protected=yes', 'agents apply=true']);
    if (outcome.kind !== 'done') throw new Error('expected a result');
    expect(outcome.result).toMatchObject({ setup: 'complete', resumed: true, branch: { name: 'development' } });
  });

  test('a half-way setup whose resume fails is that refusal, never complete', async () => {
    const half: LinkedFolder = { ...LINKED, pendingSetup: { branch: 'development', protected: false } };
    const failed: Refusal = { code: 'BRANCH_CREATE_FAILED', message: 'no', exitCode: 1 };
    const { made, calls } = deps({ folder: [{ kind: 'sync' }, { kind: 'refusal', refusal: failed }], linked: [half] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder', 'session org=org_1', 'folder name=web branch=development protected=no']);
    expect(outcome).toEqual({ kind: 'refusal', refusal: failed });
  });

  // CAP-902: the service may still hold the approval after the link ran out on this machine's clock, so the code is sent.
  test('a code with a pairing whose link ran out locally is still sent to it, and setup carries on', async () => {
    const { made, calls } = deps({ pending: 'expired' });
    const outcome = await setupOutcome({ ...OPTIONS, code: 'ABCD' }, made);
    expect(calls).toEqual(['pair wait code=ABCD no-renew', 'folder', 'agents apply=true']);
    expect(outcome.kind).toBe('done');
  });

  test('signed in, a code, and a pairing the service says is gone: it is dropped, no new link, and setup carries on', async () => {
    const gone: Refusal = { code: ERROR_CODES.PAIR_EXPIRED, message: 'expired', exitCode: 1 };
    const { made, calls } = deps({ pending: 'expired', pair: [{ kind: 'refusal', refusal: gone }] });
    const outcome = await setupOutcome({ ...OPTIONS, code: 'ABCD' }, made);
    expect(calls).toEqual(['pair wait code=ABCD no-renew', 'folder', 'agents apply=true']);
    expect(outcome.kind).toBe('done');
  });

  test('signed out with a pairing the service says is gone: the code is sent, it is dropped, and one new pairing starts', async () => {
    const gone: Refusal = { code: ERROR_CODES.PAIR_EXPIRED, message: 'expired', exitCode: 1 };
    const fresh: Refusal = { ...LINK, code: ERROR_CODES.PAIR_APPROVAL_PENDING };
    const { made, calls } = deps({ pending: 'expired', folder: [{ kind: 'refusal', refusal: NOT_SIGNED_IN }], pair: [{ kind: 'refusal', refusal: gone }, { kind: 'refusal', refusal: fresh }] });
    const outcome = await setupOutcome({ ...OPTIONS, code: 'ABCD' }, made);
    expect(calls).toEqual(['pair wait code=ABCD no-renew', 'folder', 'pair start']);
    if (outcome.kind !== 'refusal') throw new Error('expected a refusal');
    expect(outcome.refusal.code).toBe(ERROR_CODES.PAIR_APPROVAL_PENDING);
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

  test('local-only mode is refused before any step, so a linked folder never reaches pairing', async () => {
    const { made, calls } = deps({ localOnly: true, pending: true, folder: [{ kind: 'sync' }], session: [NOT_SIGNED_IN] });
    const outcome = await setupOutcome({ ...OPTIONS, code: 'ABCD' }, made);
    expect(calls).toEqual([]);
    if (outcome.kind !== 'refusal') throw new Error('expected a refusal');
    expect(outcome.refusal.exitCode).toBe(1);
  });

  test('a folder step with nothing to say is a refusal', async () => {
    const { made, calls } = deps({ folder: [undefined] });
    const outcome = await setupOutcome(OPTIONS, made);
    expect(calls).toEqual(['folder']);
    expect(outcome.kind).toBe('refusal');
  });
});

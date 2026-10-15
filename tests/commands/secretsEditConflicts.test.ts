/**
 * `capy secrets` edit and conflicts (CAP-714), against the real edit actions and engine (`createEditActionsWith` ->
 * `runSecretSet`) over the fake service of tests/helpers/secretsWorld.ts. The properties:
 *   - a location someone else changed since the row was listed is reported, BEFORE any push: nothing is written
 *     until every such location is decided;
 *   - mine writes that location, bound to the value that was seen; theirs skips it and writes the rest;
 *   - a decision made against a value that has since moved is not applied: the conflict comes back, nothing is written;
 *   - a location that moves between the check and its push is refused (SECRETS_CONFLICT), not overwritten;
 *   - no value ever appears in what is returned.
 */
import { describe, test, expect, mock } from 'bun:test';
import { createEditActionsWith, settleLocations } from '../../src/commands/secretsEditActions';
import type { SetLocation } from '../../src/commands/secretsSet';
import { hashValue } from '../../src/deploy/keepGate';
import type { RunRequest } from '../../src/ui/secretsEditFlow';
import { ERROR_CODES } from '../../src/types/index';
import { NAME, OLD_VALUE, SENTINEL, PROJECT_NAMES, everythingSentTo, fakeGithub, fakeService, makeEnv, type Loc } from '../helpers/secretsWorld';

const MOVED = 'moved-by-someone-else-2222';

const A_STAGING: SetLocation = { project_id: 'pA', project_name: PROJECT_NAMES.pA, branch: 'staging', protected: false };
const C_DEV: SetLocation = { project_id: 'pC', project_name: PROJECT_NAMES.pC, branch: 'development', protected: false };

const request = (over: Partial<RunRequest> = {}): RunRequest => ({
  name: NAME,
  value: SENTINEL,
  locations: [A_STAGING, C_DEV],
  repos: [],
  bases: {},
  // What the row listed for these locations: the old value.
  seen: hashValue(OLD_VALUE),
  ...over,
});

/** The world as the screen listed it, except that `pA/staging` holds `movedValue` now. */
function rig(movedValue: string | undefined = MOVED) {
  const locs: readonly Loc[] = [{ project: 'pA', branch: 'staging', value: movedValue }, { project: 'pC', branch: 'development' }];
  const service = fakeService({ locs });
  const github = fakeGithub([]);
  const env = makeEnv(service, github);
  const actions = createEditActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [] }) }, 'org1', env);
  return { service, actions, env };
}

const decision = (choice: 'mine' | 'theirs', theirs: string, yours: string = hashValue(SENTINEL)) => ({ choice, theirs, yours });
const pushedProjects = (service: ReturnType<typeof fakeService>): readonly string[] => service.pushSecrets.mock.calls.map((c) => String(c[0]));

describe('the run reads every location first', () => {
  test('a location someone else changed is reported as a conflict and NOTHING is pushed, to it or to any other location', async () => {
    const r = rig();
    const out = await r.actions.run(request());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a conflict');
    expect(out.code).toBe(ERROR_CODES.SECRETS_CONFLICT);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts?.[0].location).toEqual(A_STAGING);
    expect(out.conflicts?.[0].conflict).toMatchObject({
      kind: 'source',
      name: NAME,
      project: PROJECT_NAMES.pA,
      branch: 'staging',
      pinned: hashValue(OLD_VALUE),
      yours: hashValue(SENTINEL),
      theirs: hashValue(MOVED),
    });
    expect(r.service.pushSecrets.mock.calls).toHaveLength(0);
    // Fingerprints and names: no value anywhere.
    const printed = JSON.stringify(out);
    [SENTINEL, MOVED, OLD_VALUE].forEach((v) => expect(printed).not.toContain(v));
  });

  test('no location moved: the run goes ahead exactly as before', async () => {
    const r = rig(OLD_VALUE);
    const out = await r.actions.run(request());
    expect(out.ok).toBe(true);
    expect(pushedProjects(r.service).toSorted()).toEqual(['pA', 'pC']);
  });

  test('a location that already holds the new value is not a conflict', async () => {
    const r = rig(SENTINEL);
    const out = await r.actions.run(request());
    expect(out.ok).toBe(true);
  });
});

describe('mine and theirs', () => {
  const key = 'pA/staging';

  test('mine: the moved location is written too, with the new value', async () => {
    const r = rig();
    const out = await r.actions.run(request({ decisions: { [key]: decision('mine', hashValue(MOVED)) } }));
    expect(out.ok).toBe(true);
    if (!out.ok || !('result' in out)) throw new Error('expected a result');
    expect(out.result.updated.map((l) => `${l.project}/${l.branch}`).toSorted()).toEqual([`${PROJECT_NAMES.pA}/staging`, `${PROJECT_NAMES.pC}/development`].toSorted());
    expect(out.result.failed).toEqual([]);
    expect(pushedProjects(r.service).toSorted()).toEqual(['pA', 'pC']);
    // The pushed keep for pA/staging pins the new value.
    const pushedA = r.service.pushSecrets.mock.calls.find((c) => c[0] === 'pA');
    const keep = JSON.parse(String(pushedA?.[1])) as { variables: Record<string, Array<{ branch: string; value_hash: string }>> };
    expect(keep.variables[NAME].find((e) => e.branch === 'staging')?.value_hash).toBe(hashValue(SENTINEL));
  });

  test('theirs: the moved location is skipped (never pushed), the other is written', async () => {
    const r = rig();
    const out = await r.actions.run(request({ decisions: { [key]: decision('theirs', hashValue(MOVED)) } }));
    expect(out.ok).toBe(true);
    if (!out.ok || !('result' in out)) throw new Error('expected a result');
    expect(pushedProjects(r.service)).toEqual(['pC']);
    expect(out.result.updated.map((l) => l.project)).toEqual([PROJECT_NAMES.pC]);
    expect(out.result.failed).toEqual([]);
  });

  test('a decision made against another value of the location is NOT applied: the conflict comes back and nothing is pushed', async () => {
    const r = rig();
    const out = await r.actions.run(request({ decisions: { [key]: decision('mine', hashValue('the-value-it-had-when-decided')) } }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a conflict');
    expect(out.conflicts?.[0].conflict.theirs).toBe(hashValue(MOVED));
    expect(r.service.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('a decision made for another new value is NOT applied either', async () => {
    const r = rig();
    const out = await r.actions.run(request({ decisions: { [key]: decision('mine', hashValue(MOVED), hashValue('a-different-new-value')) } }));
    expect(out.ok).toBe(false);
    expect(r.service.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('a location that moves between the check and its push is refused (SECRETS_CONFLICT), and not overwritten', async () => {
    // One location. The check reads it as listed; by the time it is pushed, someone else changed it.
    const early = fakeService({ locs: [{ project: 'pA', branch: 'staging' }] });
    const late = fakeService({ locs: [{ project: 'pA', branch: 'staging', value: MOVED }] });
    const reads = mock((_: string) => undefined);
    const client = {
      getDecryptData: mock(async (projectId: string, branch?: string, ...rest: unknown[]) => {
        reads(projectId);
        return (reads.mock.calls.length <= 1 ? early : late).getDecryptData(projectId, branch, ...(rest as [undefined]));
      }),
      pushSecrets: late.pushSecrets,
    };
    const env = { ...makeEnv(early, fakeGithub([])), client: client as never };
    const actions = createEditActionsWith({ getOrgRepos: async () => ({ org_id: 'org1', repos: [] }) }, 'org1', env);
    const out = await actions.run(request({ locations: [A_STAGING] }));
    expect(out.ok).toBe(true);
    if (!out.ok || !('result' in out)) throw new Error('expected a result');
    expect(out.result.updated).toEqual([]);
    expect(out.result.failed).toEqual([expect.objectContaining({ kind: 'location', project: PROJECT_NAMES.pA, branch: 'staging', code: ERROR_CODES.SECRETS_CONFLICT })]);
    expect(late.pushSecrets.mock.calls).toHaveLength(0);
    expect(everythingSentTo(late.pushSecrets)).not.toContain(SENTINEL);
  });
});

describe('settleLocations (pure)', () => {
  const reads = [{ action: 'update' as const, serverKeep: undefined, current: { hash: hashValue(MOVED), serverKeepHash: 'k' } }, { action: 'update' as const, serverKeep: undefined, current: { hash: hashValue(OLD_VALUE), serverKeepHash: 'k' } }];

  test('without a fingerprint to compare with, nothing is checked (the request goes ahead whole)', () => {
    const settled = settleLocations(request({ seen: undefined }), reads);
    expect(settled).toMatchObject({ kind: 'ready', locations: [A_STAGING, C_DEV] });
  });

  test('the allowed fingerprints of a location are: the new value, the one listed, and the one that was decided against', () => {
    const settled = settleLocations(request({ decisions: { 'pA/staging': decision('mine', hashValue(MOVED)) } }), reads);
    if (settled.kind !== 'ready' || settled.allowed === undefined) throw new Error('expected ready');
    expect(settled.allowed(A_STAGING)).toEqual([hashValue(SENTINEL), hashValue(OLD_VALUE), hashValue(MOVED)]);
  });
});

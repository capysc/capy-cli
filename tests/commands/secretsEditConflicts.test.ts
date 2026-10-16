/**
 * `capy secrets` edit with no folder (docs/conflict-resolution.md), against the real edit actions and engine
 * (`createEditActionsWith` -> `runSecretSet`) over the fake service of tests/helpers/secretsWorld.ts. For each
 * location `compareSecrets` gets pinned (the row's fingerprint), local (the new value) and remote (the location now).
 * The properties:
 *   - a location someone else changed since the row was listed is reported as a row, BEFORE any push: nothing is
 *     written until every such location is answered;
 *   - local writes that location, bound to the value that was seen; remote leaves it and writes the rest;
 *   - an answer made against a value that has since moved is not applied: the row comes back, nothing is written;
 *   - a location that moves between the check and its push is refused (SECRETS_CONFLICT), not overwritten;
 *   - every upload names the keep it was built from (`base_keep_hash`);
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

const decision = (choice: 'local' | 'remote', remote: string, local: string = hashValue(SENTINEL)) => ({ choice, remote, local });
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
    expect(out.conflicts?.[0].conflict).toEqual({
      name: NAME,
      project: PROJECT_NAMES.pA,
      branch: 'staging',
      type: 'changed',
      pinned: hashValue(OLD_VALUE),
      local: hashValue(SENTINEL),
      remote: hashValue(MOVED),
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

describe('local and remote', () => {
  const key = 'pA/staging';

  test('local: the moved location is written too, with the new value', async () => {
    const r = rig();
    const out = await r.actions.run(request({ decisions: { [key]: decision('local', hashValue(MOVED)) } }));
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

  test('remote: the moved location is skipped (never pushed), the other is written', async () => {
    const r = rig();
    const out = await r.actions.run(request({ decisions: { [key]: decision('remote', hashValue(MOVED)) } }));
    expect(out.ok).toBe(true);
    if (!out.ok || !('result' in out)) throw new Error('expected a result');
    expect(pushedProjects(r.service)).toEqual(['pC']);
    expect(out.result.updated.map((l) => l.project)).toEqual([PROJECT_NAMES.pC]);
    expect(out.result.failed).toEqual([]);
  });

  test('an answer made against another value of the location is NOT applied: the row comes back and nothing is pushed', async () => {
    const r = rig();
    const out = await r.actions.run(request({ decisions: { [key]: decision('local', hashValue('the-value-it-had-when-answered')) } }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a conflict');
    expect(out.conflicts?.[0].conflict.remote).toBe(hashValue(MOVED));
    expect(r.service.pushSecrets.mock.calls).toHaveLength(0);
  });

  test('an answer made for another new value is NOT applied either', async () => {
    const r = rig();
    const out = await r.actions.run(request({ decisions: { [key]: decision('local', hashValue(MOVED), hashValue('a-different-new-value')) } }));
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

describe('the upload names the keep it was built from', () => {
  test('every push carries base_keep_hash: the keep hash of the branch it read', async () => {
    const r = rig(OLD_VALUE);
    const out = await r.actions.run(request());
    expect(out.ok).toBe(true);
    r.service.pushSecrets.mock.calls.forEach((c) => expect(String(c[5])).toMatch(/^[0-9a-f]{64}$/));
  });
});

describe('settleLocations (pure)', () => {
  const reads = [{ action: 'update' as const, serverKeep: undefined, current: { hash: hashValue(MOVED), serverKeepHash: 'k' } }, { action: 'update' as const, serverKeep: undefined, current: { hash: hashValue(OLD_VALUE), serverKeepHash: 'k' } }];

  test('without a fingerprint to compare with, nothing is checked (the request goes ahead whole)', () => {
    const settled = settleLocations(request({ seen: undefined }), reads);
    expect(settled).toMatchObject({ kind: 'ready', locations: [A_STAGING, C_DEV] });
  });

  test('a moved location without an answer for the state it holds: the rows, and nothing to push', () => {
    const settled = settleLocations(request(), reads);
    expect(settled.kind).toBe('conflicts');
    expect(settled.kind === 'conflicts' && settled.conflicts.map((c) => c.location)).toEqual([A_STAGING]);
  });

  test('answered for the state it holds: ready, with what the push compares against (the listed fingerprint per location, and the answers)', () => {
    const answers = { 'pA/staging': decision('local', hashValue(MOVED)) };
    const settled = settleLocations(request({ decisions: answers }), reads);
    if (settled.kind !== 'ready') throw new Error('expected ready');
    expect(settled.locations).toEqual([A_STAGING, C_DEV]);
    expect(settled.shown).toEqual({ 'pA/staging': hashValue(OLD_VALUE), 'pC/development': hashValue(OLD_VALUE) });
    expect(settled.answers).toEqual(answers);
  });

  test('remote leaves the moved location out of the push', () => {
    const settled = settleLocations(request({ decisions: { 'pA/staging': decision('remote', hashValue(MOVED)) } }), reads);
    expect(settled).toMatchObject({ kind: 'ready', locations: [C_DEV] });
  });
});

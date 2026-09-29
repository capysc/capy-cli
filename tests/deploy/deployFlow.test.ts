/**
 * Regression tests for `capy deploy` CI mode:
 *   1. Change-gate keys off the pushed values (not the keep.lock file).
 *   2. The PR is built in an isolated worktree — the user's tree/branch are
 *      never touched, and a deploy never strands them.
 *   3. Var-set reconcile detects drift.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { buildDeployKeep, touchDeployKeep, reconcileVars, hashValue } from '../../src/deploy/keepGate';
import {
  fetchRemoteBranch,
  readFileAtRef,
  worktreeAddNewBranch,
  worktreeRemove,
  deleteLocalBranch,
  stageAndCommit,
  pushBranch,
  currentBranch,
  getStatus,
} from '../../src/deploy/git';
import { serializeKeep } from '../../src/files/fileManager';

function git(args: string[], cwd: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function keepWith(vars: Record<string, string>, branch: string): any {
  const variables: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(vars)) {
    variables[k] = [{ resource_id: `r-${k}`, branch, value_hash: hashValue(v) }];
  }
  return { version: '3', org_id: 'o1', project_id: 'p1', project_name: 'proj', variables };
}

// ────────────────────────────────────────────────────────────────────────────
// Issue 1 — gate keys off the values being pushed
// ────────────────────────────────────────────────────────────────────────────
describe('keepGate.buildDeployKeep', () => {
  const base = keepWith({ WORKOS_API_KEY: 'sk_old', WORKOS_CLIENT_ID: 'client_x' }, 'staging');
  const NOW = '2026-06-23T00:00:00.000Z';

  test('no value change → changed=false', () => {
    const env = { WORKOS_API_KEY: 'sk_old', WORKOS_CLIENT_ID: 'client_x' };
    const r = buildDeployKeep(base, env, ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID'], 'staging', NOW);
    expect(r.changed).toBe(false);
  });

  test('bumped value → changed=true, new hash, others untouched', () => {
    const env = { WORKOS_API_KEY: 'sk_NEW', WORKOS_CLIENT_ID: 'client_x' };
    const r = buildDeployKeep(base, env, ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID'], 'staging');
    expect(r.changed).toBe(true);
    const keep = JSON.parse(r.content);
    expect(keep.variables.WORKOS_API_KEY[0].value_hash).toBe(hashValue('sk_NEW'));
    expect(keep.variables.WORKOS_CLIENT_ID[0].value_hash).toBe(hashValue('client_x'));
    // The deploy path does not mint changed_at — the service owns it, and this
    // keep.lock goes straight into a git worktree without passing through it.
    expect(keep.variables.WORKOS_API_KEY[0].changed_at).toBe(base.variables.WORKOS_API_KEY[0].changed_at);
  });

  test('the core bug: a STALE local keep.lock does not mask a real value change', () => {
    // Local keep.lock still records the OLD hash (lagging .env). The gate must
    // use the .env value, not the file, and still detect the change.
    const env = { WORKOS_API_KEY: 'sk_NEW' };
    const r = buildDeployKeep(base, env, ['WORKOS_API_KEY'], 'staging');
    expect(r.changed).toBe(true);
  });

  test('new var not yet on base → added with derived resource_id, changed=true', () => {
    const env = { WORKOS_API_KEY: 'sk_old', STRIPE_KEY: 'sk_live_1' };
    const r = buildDeployKeep(base, env, ['WORKOS_API_KEY', 'STRIPE_KEY'], 'staging', NOW);
    expect(r.changed).toBe(true);
    const keep = JSON.parse(r.content);
    expect(keep.variables.STRIPE_KEY[0].value_hash).toBe(hashValue('sk_live_1'));
    expect(keep.variables.STRIPE_KEY[0].branch).toBe('staging');
  });

  test('--force bumps deploy_revision so it differs from base', () => {
    const touched = touchDeployKeep(base, ['WORKOS_API_KEY'], 'staging');
    expect(touched).not.toBe(serializeKeep(base));
    expect(JSON.parse(touched).deploy_revision).toBe(1);
  });

  test('--force leaves changed_at alone', () => {
    // The whole point: a forced redeploy changes no value, so no value's
    // "last changed" may move. This is what used to collide with
    // server-assigned timestamps on merge.
    const touched = JSON.parse(touchDeployKeep(base, ['WORKOS_API_KEY'], 'staging'));
    expect(touched.variables.WORKOS_API_KEY[0].changed_at).toBe(
      base.variables.WORKOS_API_KEY[0].changed_at,
    );
  });

  test('successive forces increment rather than reset', () => {
    const once = JSON.parse(touchDeployKeep(base, ['WORKOS_API_KEY'], 'staging'));
    const twice = JSON.parse(touchDeployKeep(once, ['WORKOS_API_KEY'], 'staging'));
    expect(twice.deploy_revision).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CAP-679: buildDeployKeep's optional `delivery` param folds `targets` for CI
// mode, keyed to the SAME hash it just computed for value_hash.
// ────────────────────────────────────────────────────────────────────────────
describe('keepGate.buildDeployKeep — CAP-679 delivery folding', () => {
  const base = keepWith({ WORKOS_API_KEY: 'sk_old', WORKOS_CLIENT_ID: 'client_x' }, 'staging');

  test('folds a targets element for every delivered var, keyed to its own hash', () => {
    const env = { WORKOS_API_KEY: 'sk_NEW', WORKOS_CLIENT_ID: 'client_x' };
    const r = buildDeployKeep(
      base,
      env,
      ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID'],
      'staging',
      { provider: 'vercel', target: 'web-prod', ref: { projectId: 'prj_1' } },
      '2026-06-23T00:00:00.000Z',
    );
    const keep = JSON.parse(r.content);
    expect(keep.variables.WORKOS_API_KEY[0].targets).toEqual([
      {
        provider: 'vercel',
        target: 'web-prod',
        ref: { projectId: 'prj_1' },
        deployed_value_hash: hashValue('sk_NEW'),
        deployed_at: '2026-06-23T00:00:00.000Z',
      },
    ]);
    expect(keep.variables.WORKOS_CLIENT_ID[0].targets[0].deployed_value_hash).toBe(hashValue('client_x'));
  });

  test('replaces the same (provider, target) element rather than appending', () => {
    const withPrior: any = JSON.parse(JSON.stringify(base));
    withPrior.variables.WORKOS_API_KEY[0].targets = [
      { provider: 'vercel', target: 'web-prod', deployed_value_hash: 'stale', deployed_at: 't0' },
    ];
    const r = buildDeployKeep(withPrior, { WORKOS_API_KEY: 'sk_NEW' }, ['WORKOS_API_KEY'], 'staging', {
      provider: 'vercel',
      target: 'web-prod',
    });
    const keep = JSON.parse(r.content);
    expect(keep.variables.WORKOS_API_KEY[0].targets).toHaveLength(1);
    expect(keep.variables.WORKOS_API_KEY[0].targets[0].deployed_value_hash).toBe(hashValue('sk_NEW'));
  });

  test('no delivery argument — behaves exactly as before, no targets field added', () => {
    const r = buildDeployKeep(base, { WORKOS_API_KEY: 'sk_NEW' }, ['WORKOS_API_KEY'], 'staging');
    const keep = JSON.parse(r.content);
    expect(keep.variables.WORKOS_API_KEY[0]).not.toHaveProperty('targets');
  });

  test('a stray non-object 5th argument (the old call shape) is ignored, not corrupted', () => {
    // Regression guard: two tests above in this file call
    // buildDeployKeep(base, env, vars, branch, NOW) with a bare ISO string in
    // this exact slot. That call shape must keep working unchanged.
    const r = buildDeployKeep(base, { WORKOS_API_KEY: 'sk_NEW' }, ['WORKOS_API_KEY'], 'staging', '2026-06-23T00:00:00.000Z' as any);
    const keep = JSON.parse(r.content);
    expect(keep.variables.WORKOS_API_KEY[0].value_hash).toBe(hashValue('sk_NEW'));
    expect(keep.variables.WORKOS_API_KEY[0]).not.toHaveProperty('targets');
  });

  test('a brand-new entry (var not yet on base) also gets its targets element', () => {
    const env = { WORKOS_API_KEY: 'sk_old', STRIPE_KEY: 'sk_live_1' };
    const r = buildDeployKeep(base, env, ['WORKOS_API_KEY', 'STRIPE_KEY'], 'staging', {
      provider: 'dokploy',
      target: 'backend-preview',
    });
    const keep = JSON.parse(r.content);
    expect(keep.variables.STRIPE_KEY[0].targets[0]).toMatchObject({
      provider: 'dokploy',
      target: 'backend-preview',
      deployed_value_hash: hashValue('sk_live_1'),
    });
  });

  test('is pure: never mutates baseKeep', () => {
    const before = JSON.stringify(base);
    buildDeployKeep(base, { WORKOS_API_KEY: 'sk_NEW' }, ['WORKOS_API_KEY'], 'staging', {
      provider: 'dokploy',
      target: 't',
    });
    expect(JSON.stringify(base)).toBe(before);
  });

  // ── The bug the validator caught: a redeploy of the SAME value must not
  // manufacture a diff by stamping a fresh deployed_at on a fact that
  // didn't change — otherwise the CI change-gate opens a PR on every run. ──
  test('identical value, already-recorded target → changed is false, no element churn', () => {
    const delivery = { provider: 'dokploy', target: 'backend-preview' };
    const first = buildDeployKeep(base, { WORKOS_API_KEY: 'sk_old' }, ['WORKOS_API_KEY'], 'staging', delivery, 't0');
    const firstKeep = JSON.parse(first.content);
    expect(firstKeep.variables.WORKOS_API_KEY[0].targets[0].deployed_at).toBe('t0');

    // Redeploy: SAME value, SAME delivery, but a NEW timestamp/deploy_id —
    // as a real second `capy deploy` run would pass.
    const second = buildDeployKeep(
      firstKeep,
      { WORKOS_API_KEY: 'sk_old' },
      ['WORKOS_API_KEY'],
      'staging',
      { ...delivery, deployId: 'dep_new' },
      't1',
    );
    expect(second.changed).toBe(false);
    const secondKeep = JSON.parse(second.content);
    // The element is UNTOUCHED — same deployed_at, no deploy_id added — not
    // bumped to 't1'/'dep_new'.
    expect(secondKeep.variables.WORKOS_API_KEY[0].targets).toEqual(firstKeep.variables.WORKOS_API_KEY[0].targets);
    expect(secondKeep.variables.WORKOS_API_KEY[0].targets[0].deployed_at).toBe('t0');
    expect(secondKeep.variables.WORKOS_API_KEY[0].targets[0]).not.toHaveProperty('deploy_id');
  });

  test('identical value, no PRIOR target recorded yet → still changed (a first delivery IS a real change)', () => {
    // Distinguishes "value unchanged" from "target bookkeeping unchanged" —
    // recording a delivery for the first time is a genuine new fact.
    const r = buildDeployKeep(base, { WORKOS_API_KEY: 'sk_old' }, ['WORKOS_API_KEY'], 'staging', {
      provider: 'dokploy',
      target: 'backend-preview',
    });
    expect(r.changed).toBe(true);
  });

  test('a genuine value change still replaces the target element (and reports changed)', () => {
    const delivery = { provider: 'dokploy', target: 'backend-preview' };
    const first = buildDeployKeep(base, { WORKOS_API_KEY: 'sk_old' }, ['WORKOS_API_KEY'], 'staging', delivery, 't0');
    const firstKeep = JSON.parse(first.content);
    const second = buildDeployKeep(firstKeep, { WORKOS_API_KEY: 'sk_NEW' }, ['WORKOS_API_KEY'], 'staging', delivery, 't1');
    expect(second.changed).toBe(true);
    const secondKeep = JSON.parse(second.content);
    expect(secondKeep.variables.WORKOS_API_KEY[0].targets[0].deployed_value_hash).toBe(hashValue('sk_NEW'));
    expect(secondKeep.variables.WORKOS_API_KEY[0].targets[0].deployed_at).toBe('t1');
  });
});

describe('keepGate.reconcileVars', () => {
  test('no drift when selection still matches what the project knew', () => {
    const r = reconcileVars(['A', 'B'], ['A', 'B', 'C'], ['A', 'B', 'C']);
    expect(r.drifted).toBe(false);
  });
  test('a newly-added project var is flagged', () => {
    const r = reconcileVars(['A', 'B'], ['A', 'B', 'C'], ['A', 'B', 'C', 'D']);
    expect(r.added).toEqual(['D']);
    expect(r.drifted).toBe(true);
  });
  test('a selected var that disappeared is flagged', () => {
    const r = reconcileVars(['A', 'B'], ['A', 'B', 'C'], ['A', 'C']);
    expect(r.removed).toEqual(['B']);
    expect(r.drifted).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Issue 2 — e2e: bump a var, run the worktree PR flow, assert the PR + that the
// user's tree/branch are untouched (no stranding).
// ────────────────────────────────────────────────────────────────────────────
describe('deploy CI worktree flow (e2e — no stranding)', () => {
  const TMP = join(tmpdir(), `capy-deployflow-${process.pid}`);
  const ORIGIN = join(TMP, 'origin.git');
  const REPO = join(TMP, 'repo');

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    git(['init', '--bare', '-b', 'main', ORIGIN], TMP);
    git(['init', '-q', '-b', 'main', REPO], TMP);
    git(['config', 'user.email', 't@e.com'], REPO);
    git(['config', 'user.name', 'T'], REPO);
    git(['config', 'commit.gpgsign', 'false'], REPO);
    git(['remote', 'add', 'origin', ORIGIN], REPO);
    // staging (the deploy base) carries the OLD keep.lock.
    git(['checkout', '-q', '-b', 'staging'], REPO);
    writeFileSync(join(REPO, 'keep.lock'), serializeKeep(keepWith({ WORKOS_API_KEY: 'sk_old' }, 'staging')));
    git(['add', '.'], REPO);
    git(['commit', '-q', '-m', 'base'], REPO);
    git(['push', '-q', 'origin', 'staging'], REPO);
    // The user is on a feature branch with a dirty WIP file.
    git(['checkout', '-q', '-b', 'feature'], REPO);
    writeFileSync(join(REPO, 'WIP.txt'), 'work in progress\n');
  });
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  test('bump a var → PR branch off staging with the new hash; user tree untouched', () => {
    // 1. The deploy's CI gate: bump WORKOS_API_KEY in .env.
    fetchRemoteBranch(REPO, 'staging');
    const baseRaw = readFileAtRef(REPO, 'origin/staging', 'keep.lock')!;
    const built = buildDeployKeep(JSON.parse(baseRaw), { WORKOS_API_KEY: 'sk_NEW' }, ['WORKOS_API_KEY'], 'staging', '2026-06-23T00:00:00.000Z');
    expect(built.changed).toBe(true);

    // 2. The worktree PR flow (exactly what the rewritten deployCommand runs):
    //    build the commit off origin/staging in an isolated worktree, push, tear
    //    down — never touching the user's tree. (createPr is a thin `gh` wrapper
    //    layered on this push; the substantive PR content is the pushed branch.)
    const branch = 'capy-deploy-20260623-035959-abcd';
    const wt = join(TMP, 'wt');
    expect(worktreeAddNewBranch(REPO, wt, branch, 'origin/staging').ok).toBe(true);
    writeFileSync(join(wt, 'keep.lock'), built.content);
    expect(stageAndCommit(wt, ['keep.lock'], 'chore(deploy): staging').ok).toBe(true);
    expect(pushBranch(wt, branch).ok).toBe(true);
    worktreeRemove(REPO, wt);
    deleteLocalBranch(REPO, branch);

    // 3a. The PR branch exists on origin with the BUMPED hash...
    expect(git(['rev-parse', '--verify', branch], ORIGIN).code).toBe(0);
    const pushedKeep = JSON.parse(readFileAtRef(REPO, `origin/${branch}`, 'keep.lock')!);
    expect(pushedKeep.variables.WORKOS_API_KEY[0].value_hash).toBe(hashValue('sk_NEW'));
    // ...and it differs from staging (a real, reviewable diff — the PR's point).
    const stagingKeep = JSON.parse(readFileAtRef(REPO, 'origin/staging', 'keep.lock')!);
    expect(stagingKeep.variables.WORKOS_API_KEY[0].value_hash).toBe(hashValue('sk_old'));

    // 3b. THE FIX: the user is still on `feature`, WIP intact, nothing stranded.
    expect(currentBranch(REPO)).toBe('feature');
    expect(existsSync(join(REPO, 'WIP.txt'))).toBe(true);
    expect(readFileSync(join(REPO, 'keep.lock'), 'utf-8')).toContain(hashValue('sk_old')); // feature's keep.lock untouched
    const status = getStatus(REPO).map((e) => e.path);
    expect(status).toEqual(['WIP.txt']); // only the user's WIP — no keep.lock change, no leftovers
    expect(git(['stash', 'list'], REPO).stdout.trim()).toBe(''); // no stash left behind
    expect(git(['branch', '--list', 'capy-deploy-*'], REPO).stdout.trim()).toBe(''); // no temp branch left
  });
});

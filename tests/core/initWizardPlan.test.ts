/**
 * The first-run route, as the CLI declares it.
 *
 * The claim under test is the one the whole trainstop model rests on: the rail
 * a person reads and the array a headless caller would evaluate come out of
 * ONE builder, and that builder distinguishes the three things a bare label
 * cannot — a stop this run will not visit (`skipped`), a stop whose fork is
 * not settled yet (`blank`), and a stop that is genuinely next (`current`).
 */
import { describe, test, expect } from 'bun:test';
import { initWizardPlan, unansweredInitStops } from '../../src/core/initWizardPlan';

const ids = (i: Parameters<typeof initWizardPlan>[0]) => initWizardPlan(i).map((s) => s.id);
const byId = (i: Parameters<typeof initWizardPlan>[0], id: string) =>
  initWizardPlan(i).find((s) => s.id === id)!;

describe('initWizardPlan', () => {
  test('declares all ten stops, in order, whatever this run will do', () => {
    // Nothing is known yet and the route is still the whole route.
    expect(ids({})).toEqual([
      'auth',
      'organization',
      'organization-name',
      'recovery',
      'redeem',
      'project',
      'project-name',
      'branch',
      'branch-name',
      'encrypt',
    ]);
    // A run that answers everything drops nothing either.
    expect(
      ids({
        orgCount: 2,
        organization: { kind: 'existing', name: 'mikes-market-hq' },
        hasOrgKey: true,
        projectCount: 0,
        project: { kind: 'new', name: 'mikes-market' },
        branchChoice: 'development',
        localEnvCount: 3,
        encrypt: true,
      }),
    ).toHaveLength(10);
  });

  test('sign-in is settled before anything opens', () => {
    // `capy` authenticates first; the browser is only reached once there is a
    // session, so this stop can never be the one the traveller stands on.
    const auth = byId({ signedInAs: 'mike@market.example' }, 'auth');
    expect(auth.state).toBe('done');
    expect(auth.answer).toBe('mike@market.example');
  });

  test('an unsettled fork is blank, not skipped and not upcoming', () => {
    // Nobody has chosen an organization, so whether this run names one is not
    // yet knowable — and "we do not know" is a different drawing from "this
    // will not happen".
    const plan = initWizardPlan({ orgCount: 2 });
    expect(plan.find((s) => s.id === 'organization')!.state).toBe('current');
    for (const id of ['organization-name', 'recovery']) {
      const stop = plan.find((s) => s.id === id)!;
      expect(stop.blank).toBe(true);
      expect(stop.state).toBe('upcoming');
    }
  });

  test('the side of a fork this run did not take is skipped', () => {
    const existing = initWizardPlan({
      orgCount: 2,
      organization: { kind: 'existing', name: 'mikes-market-hq' },
    });
    expect(existing.find((s) => s.id === 'organization-name')!.state).toBe('skipped');
    expect(existing.find((s) => s.id === 'recovery')!.state).toBe('skipped');
    // …and a settled stop is no longer blank, whatever it looked like before.
    expect(existing.find((s) => s.id === 'organization-name')!.blank).toBeUndefined();

    const created = initWizardPlan({
      orgCount: 0,
      organization: { kind: 'new', name: 'mikes-market-hq' },
      recoveryShown: true,
    });
    // With no organizations at all the CLI never asks which one to use.
    expect(created.find((s) => s.id === 'organization')!.state).toBe('skipped');
    expect(created.find((s) => s.id === 'organization-name')!.answer).toBe('mikes-market-hq');
    expect(created.find((s) => s.id === 'recovery')!.state).toBe('done');
  });

  test('the recovery phrase stop is manual: it happens, and not on this page', () => {
    expect(byId({}, 'recovery').manual).toBe(true);
    expect(byId({}, 'redeem').manual).toBe(true);
  });

  test('a device that already holds the key never visits redeem', () => {
    expect(byId({ hasOrgKey: true }, 'redeem').state).toBe('skipped');
    // A device that does not is standing on it — the refusal lands on a
    // station that was drawn from the start rather than out of nowhere.
    const missing = initWizardPlan({
      orgCount: 2,
      organization: { kind: 'existing', name: 'mikes-market-hq' },
      hasOrgKey: false,
    });
    expect(missing.find((s) => s.id === 'redeem')!.state).toBe('current');
  });

  test('an organization with no projects is not asked which project to use', () => {
    const none = initWizardPlan({
      orgCount: 1,
      organization: { kind: 'existing', name: 'hq' },
      hasOrgKey: true,
      projectCount: 0,
    });
    expect(none.find((s) => s.id === 'project')!.state).toBe('skipped');
    expect(none.find((s) => s.id === 'project-name')!.state).toBe('current');

    // A lookup that FAILED lands in the same place by a different road, and
    // the input says which — the CLI swallows that error and would otherwise
    // walk the user into a second project alongside one they already have.
    const failed = initWizardPlan({
      orgCount: 1,
      organization: { kind: 'existing', name: 'hq' },
      hasOrgKey: true,
      projectCount: 0,
      projectsUnavailable: true,
    });
    expect(failed.find((s) => s.id === 'project')!.state).toBe('skipped');
    expect(failed.find((s) => s.id === 'project-name')!.state).toBe('current');
  });

  test('bootstrapping an existing project skips every stop after it', () => {
    // That path pulls the project's development branch and returns; there is
    // no first branch to choose and no .env consent to give.
    const plan = initWizardPlan({
      orgCount: 1,
      organization: { kind: 'existing', name: 'hq' },
      hasOrgKey: true,
      projectCount: 3,
      project: { kind: 'existing', name: 'mikes-market' },
    });
    for (const id of ['project-name', 'branch', 'branch-name', 'encrypt']) {
      expect(plan.find((s) => s.id === id)!.state).toBe('skipped');
    }
    expect(unansweredInitStops(plan)).toEqual([]);
  });

  test('the default branch skips the naming stop; another branch does not', () => {
    const base = {
      orgCount: 1,
      organization: { kind: 'existing' as const, name: 'hq' },
      hasOrgKey: true,
      projectCount: 0,
      project: { kind: 'new' as const, name: 'mikes-market' },
    };
    expect(initWizardPlan({ ...base, branchChoice: 'development' }).find((s) => s.id === 'branch-name')!.state)
      .toBe('skipped');
    const other = initWizardPlan({ ...base, branchChoice: 'other' });
    expect(other.find((s) => s.id === 'branch-name')!.state).toBe('current');
    expect(other.find((s) => s.id === 'branch-name')!.blank).toBeUndefined();
  });

  test('an empty directory never reaches the consent gate', () => {
    const base = {
      orgCount: 1,
      organization: { kind: 'existing' as const, name: 'hq' },
      hasOrgKey: true,
      projectCount: 0,
      project: { kind: 'new' as const, name: 'mikes-market' },
      branchChoice: 'development' as const,
    };
    expect(initWizardPlan({ ...base, localEnvCount: 0 }).find((s) => s.id === 'encrypt')!.state).toBe('skipped');
    expect(initWizardPlan({ ...base, localEnvCount: 4 }).find((s) => s.id === 'encrypt')!.state).toBe('current');
    // Refusing the gate is an ANSWER, not a stop that did not happen.
    const refused = initWizardPlan({ ...base, localEnvCount: 4, encrypt: false });
    expect(refused.find((s) => s.id === 'encrypt')!.state).toBe('done');
    expect(refused.find((s) => s.id === 'encrypt')!.answer).toBe('no');
  });

  test('exactly one stop is current, and it is the first one outstanding', () => {
    const plan = initWizardPlan({
      orgCount: 2,
      organization: { kind: 'existing', name: 'hq' },
      hasOrgKey: true,
      projectCount: 2,
    });
    expect(plan.filter((s) => s.state === 'current').map((s) => s.id)).toEqual(['project']);
    // Everything after it is ahead, never behind.
    expect(plan.slice(plan.findIndex((s) => s.id === 'project') + 1).every((s) => s.state !== 'done')).toBe(true);
  });

  test('what is left to ask is derived from the plan, never recomputed', () => {
    expect(unansweredInitStops(initWizardPlan({}))).toEqual([
      'organization',
      'organization-name',
      'recovery',
      'redeem',
      'project',
      'project-name',
      'branch',
      'branch-name',
      'encrypt',
    ]);
  });

  test('carries no secret material of any kind', () => {
    const plan = initWizardPlan({
      signedInAs: 'mike@market.example',
      orgCount: 1,
      organization: { kind: 'new', name: 'hq' },
      recoveryShown: true,
      hasOrgKey: true,
      projectCount: 0,
      project: { kind: 'new', name: 'mikes-market' },
      branchChoice: 'other',
      branchName: 'staging',
      localEnvCount: 12,
      encrypt: true,
    });
    const json = JSON.stringify(plan);
    // The 24 words and the values are the two things this flow handles, and
    // neither has a field on this route to travel in. A completed `recovery`
    // stop records THAT it happened and nothing about what was shown.
    expect(plan.find((s) => s.id === 'recovery')!.answer).toBeUndefined();
    expect(json).not.toContain('abandon');
    expect(json).not.toContain('sk_live');
    // Every answer on the rail is a name or a verdict — never a word list.
    for (const stop of plan) {
      if (stop.answer) expect(stop.answer.split(/\s+/).length).toBeLessThan(4);
    }
  });
});

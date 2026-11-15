/**
 * The pending-setup marker of agent-mode `capy`, as pure decisions.
 *
 * A setup that created the project and linked the folder, but did not finish, leaves a marker in the folder's `.capy`
 * sync state. A run resumes only when that marker is there, names the project keep.lock names, and every setup flag
 * it was given agrees with it. A folder with no such marker is a healthy project, and its setup flags change nothing.
 */
import type { PendingSetup, SetupAnswers, SyncState } from '../types/index';
import { NEW_PROJECT } from './initPlan';

/** The marker in `state`, or undefined when there is none or what is stored is not a marker. */
export function pendingSetupOf(state: SyncState | null): PendingSetup | undefined {
  const raw: unknown = state?.pending_setup;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { org_id, project_id, branch, protected: isProtected } = raw as Record<string, unknown>;
  const valid = typeof org_id === 'string' && typeof project_id === 'string' && typeof branch === 'string' && typeof isProtected === 'boolean';
  return valid ? { org_id, project_id, branch, protected: isProtected } : undefined;
}

/** The setup flags that were typed, as the flags are spelled. */
export function givenSetupFlags(setup: SetupAnswers): readonly string[] {
  const given: ReadonlyArray<readonly [string, unknown]> = [
    ['--org', setup.org],
    ['--project', setup.project],
    ['--name', setup.name],
    ['--branch', setup.branch],
    ['--protected', setup.protectedAnswer],
  ];
  return given.filter(([, value]) => value !== undefined).map(([flag]) => flag);
}

/** The folder's project as keep.lock names it. */
export interface LinkedProject {
  readonly projectId: string;
  readonly projectName: string;
}

/** `--project` agrees when it asks for a new project (the rerun of a setup) or names this very project. */
function projectAgrees(typed: string | undefined, linked: LinkedProject): boolean {
  return typed === undefined || typed === NEW_PROJECT || typed === linked.projectId || typed === linked.projectName;
}

/** `--protected` differs when it is typed and is not the pending answer (a word other than yes or no never agrees). */
function protectedDiffers(typed: string | undefined, pending: boolean): boolean {
  if (typed === undefined) return false;
  if (typed !== 'yes' && typed !== 'no') return true;
  return (typed === 'yes') !== pending;
}

/**
 * The typed flags that differ from the pending setup, by flag. `--org` is not here: an organization may be typed by
 * name, which needs the session to resolve.
 */
export function pendingDisagreements(setup: SetupAnswers, pending: PendingSetup, linked: LinkedProject): readonly string[] {
  const differs: ReadonlyArray<readonly [string, boolean]> = [
    ['--project', !projectAgrees(setup.project, linked)],
    ['--name', setup.name !== undefined && setup.name !== linked.projectName],
    ['--branch', setup.branch !== undefined && setup.branch !== pending.branch],
    ['--protected', protectedDiffers(setup.protectedAnswer, pending.protected)],
  ];
  return differs.filter(([, differ]) => differ).map(([flag]) => flag);
}

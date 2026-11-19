// Thin imperative shell for the `capy projects` screen: the same driver
// `capy secrets` runs on (`runScreen` in secretsScreenDriver.ts), given the
// projects screen as its `ScreenModel`. Edit, deploy and value results land in
// the open project's embedded secrets screen; the screen's own effects (the
// delete question's summary, the delete) go to `ProjectDeleteActions`. Nothing
// here computes what a key does or what a frame looks like.

import { runScreen, type CopyText, type ScreenModel, type SecretsDeployActions, type SecretsEditActions } from './secretsScreenDriver';
import { copyToClipboard } from './clipboard';
import type { LocationDecryptor } from './secretsScreen';
import {
  type DeleteFinished,
  type DeletePreviewLoaded,
  type ProjectRefLite,
  type ProjectsData,
  type ProjectsOwnEffect,
  type ProjectsScreenState,
  applyDeleteDone,
  applyDeletePreview,
  applyIdCopied,
  applyManageDone,
  applyTokensLoaded,
  applyUsersCopied,
  applyUsersDone,
  handleKey,
  initialProjectsScreenState,
  render,
} from './projectsScreen';
import type { ProjectRole, UserTarget, UsersEffect, UsersFinished, UsersProjectRef } from './projectUsers';
import type { AccessRow, BranchRef, ManageEffect, ManageFinished, ManageProjectRef, ManageRefusal, TokenRow } from './projectManage';

/** What the Settings and Capy Branches tabs need (`commands/projectManageActions.ts`). No function ever rejects. */
export interface ProjectsManageActions {
  readonly loadTokens: (project: ManageProjectRef) => Promise<{ readonly ok: true; readonly tokens: readonly TokenRow[] } | { readonly ok: false; readonly refusal: ManageRefusal }>;
  readonly revokeToken: (project: ManageProjectRef, token: TokenRow) => Promise<ManageFinished>;
  readonly setProtected: (project: ManageProjectRef, branch: BranchRef, protect: boolean) => Promise<ManageFinished>;
  readonly deleteBranch: (project: ManageProjectRef, branch: BranchRef) => Promise<ManageFinished>;
  readonly setAccess: (project: ManageProjectRef, branch: BranchRef, user: AccessRow, grant: boolean) => Promise<ManageFinished>;
}

const UNAVAILABLE = { ok: false as const, refusal: { code: 'UNAVAILABLE', message: 'Not available here.' } };

/** Without these actions (tests that only delete), every change is refused rather than sent. */
const NO_MANAGE_ACTIONS: ProjectsManageActions = {
  loadTokens: async () => UNAVAILABLE,
  revokeToken: async () => UNAVAILABLE,
  setProtected: async () => UNAVAILABLE,
  deleteBranch: async () => UNAVAILABLE,
  setAccess: async () => UNAVAILABLE,
};

/** Starts one Settings or Capy Branches effect; its result comes back through `done`. */
function performManage(
  effect: ManageEffect,
  actions: ProjectsManageActions,
  copy: CopyText,
  done: (apply: (state: ProjectsScreenState) => { state: ProjectsScreenState; effect: null }) => void,
): void {
  const finish = (finished: ManageFinished): void => done((state) => ({ state: applyManageDone(state, finished), effect: null }));
  if (effect.type === 'projectIdCopy') {
    void copy(effect.text).then(
      (ok) => done((state) => ({ state: applyIdCopied(state, ok), effect: null })),
      () => done((state) => ({ state: applyIdCopied(state, false), effect: null })),
    );
    return;
  }
  if (effect.type === 'projectTokensLoad') {
    void actions.loadTokens(effect.project).then((loaded) => done((state) => ({ state: applyTokensLoaded(state, loaded), effect: null })));
    return;
  }
  if (effect.type === 'projectTokenRevoke') {
    void actions.revokeToken(effect.project, effect.token).then(finish);
    return;
  }
  if (effect.type === 'projectBranchProtect') {
    void actions.setProtected(effect.project, effect.branch, effect.protect).then(finish);
    return;
  }
  if (effect.type === 'projectBranchDelete') {
    void actions.deleteBranch(effect.project, effect.branch).then(finish);
    return;
  }
  void actions.setAccess(effect.project, effect.branch, effect.user, effect.grant).then(finish);
}

const MANAGE_EFFECT_LIST: readonly ManageEffect['type'][] = [
  'projectIdCopy',
  'projectTokensLoad',
  'projectTokenRevoke',
  'projectBranchProtect',
  'projectBranchDelete',
  'projectBranchAccess',
];
const MANAGE_EFFECT_TYPES: ReadonlySet<string> = new Set<string>(MANAGE_EFFECT_LIST);

/** What deleting a project from the screen needs (`commands/projectDeleteActions.ts`). Neither function ever rejects. */
export interface ProjectsDeleteActions {
  readonly preview: (project: ProjectRefLite) => Promise<DeletePreviewLoaded>;
  readonly run: (project: ProjectRefLite) => Promise<DeleteFinished>;
}

/** What the Users tab needs (`commands/projectUsersActions.ts`). No function ever rejects. */
export interface ProjectsUsersActions {
  readonly invite: (project: UsersProjectRef, email: string, role: ProjectRole) => Promise<UsersFinished>;
  readonly changeRole: (project: UsersProjectRef, target: UserTarget, role: ProjectRole) => Promise<UsersFinished>;
  readonly remove: (project: UsersProjectRef, target: UserTarget) => Promise<UsersFinished>;
}

/** Without Users actions (tests that only delete), every change is refused rather than sent. */
const NO_USERS_ACTIONS: ProjectsUsersActions = {
  invite: async () => ({ ok: false, refusal: { code: 'UNAVAILABLE', message: 'Not available here.' } }),
  changeRole: async () => ({ ok: false, refusal: { code: 'UNAVAILABLE', message: 'Not available here.' } }),
  remove: async () => ({ ok: false, refusal: { code: 'UNAVAILABLE', message: 'Not available here.' } }),
};

/** The projects screen's own effects, by `type`: the ones `capy secrets` does not have. */
const OWN_EFFECT_TYPES: ReadonlySet<string> = new Set<ProjectsOwnEffect['type']>([
  'projectDeletePreview',
  'projectDelete',
  'projectUserInvite',
  'projectUserRole',
  'projectUserRemove',
  'projectUserCopy',
  ...MANAGE_EFFECT_LIST,
]);

/** Starts one Users-tab effect; its result comes back through `done`. */
function performUsers(
  effect: UsersEffect,
  actions: ProjectsUsersActions,
  copy: CopyText,
  done: (apply: (state: ProjectsScreenState) => { state: ProjectsScreenState; effect: null }) => void,
): void {
  const finish = (finished: UsersFinished): void => done((state) => ({ state: applyUsersDone(state, finished), effect: null }));
  if (effect.type === 'projectUserCopy') {
    // A rejected copy is a failed copy: shown, never a crash.
    void copy(effect.text).then(
      (ok) => done((state) => ({ state: applyUsersCopied(state, ok), effect: null })),
      () => done((state) => ({ state: applyUsersCopied(state, false), effect: null })),
    );
    return;
  }
  if (effect.type === 'projectUserInvite') {
    void actions.invite(effect.project, effect.email, effect.role).then(finish);
    return;
  }
  if (effect.type === 'projectUserRole') {
    void actions.changeRole(effect.project, effect.target, effect.role).then(finish);
    return;
  }
  void actions.remove(effect.project, effect.target).then(finish);
}

export function projectsModel(
  deleteActions: ProjectsDeleteActions,
  usersActions: ProjectsUsersActions = NO_USERS_ACTIONS,
  copy: CopyText = copyToClipboard,
  manageActions: ProjectsManageActions = NO_MANAGE_ACTIONS,
): ScreenModel<ProjectsScreenState, ProjectsOwnEffect> {
  return {
    handleKey,
    render,
    isQuit: (state) => state.quit,
    exitTextOf: (state) => state.exitText,
    quitNow: (state) => ({ ...state, quit: true }),
    secretsOf: (state) => state.open?.secrets ?? null,
    withSecrets: (state, secrets) => (state.open === null ? state : { ...state, open: { ...state.open, secrets } }),
    isOwnEffect: (effect): effect is ProjectsOwnEffect => OWN_EFFECT_TYPES.has(effect.type),
    performOwn: (effect, done) => {
      if (MANAGE_EFFECT_TYPES.has(effect.type)) {
        performManage(effect as ManageEffect, manageActions, copy, done);
        return;
      }
      if (effect.type !== 'projectDeletePreview' && effect.type !== 'projectDelete') {
        performUsers(effect as UsersEffect, usersActions, copy, done);
        return;
      }
      const projectId = effect.project.id;
      if (effect.type === 'projectDeletePreview') {
        void deleteActions.preview(effect.project).then((loaded) => done((state) => ({ state: applyDeletePreview(state, projectId, loaded), effect: null })));
        return;
      }
      void deleteActions.run(effect.project).then((finished) => done((state) => ({ state: applyDeleteDone(state, projectId, finished), effect: null })));
    },
  };
}

/** Runs the `capy projects` screen until the user quits. The terminal is always restored (see `runScreen`). */
export async function runProjectsScreen(
  data: ProjectsData,
  decryptAt: LocationDecryptor,
  edit: SecretsEditActions | undefined,
  dryRun: boolean,
  deploy: SecretsDeployActions | undefined,
  deleteActions: ProjectsDeleteActions,
  usersActions: ProjectsUsersActions,
  manageActions: ProjectsManageActions,
  copy?: CopyText,
): Promise<void> {
  await runScreen(projectsModel(deleteActions, usersActions, copy, manageActions), initialProjectsScreenState(data, dryRun), decryptAt, edit, deploy, copy);
}

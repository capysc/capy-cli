// Thin imperative shell for the `capy projects` screen: the same driver
// `capy secrets` runs on (`runScreen` in secretsScreenDriver.ts), given the
// projects screen as its `ScreenModel`. Edit, deploy and value results land in
// the open project's embedded secrets screen; the screen's own effects (the
// delete question's summary, the delete) go to `ProjectDeleteActions`. Nothing
// here computes what a key does or what a frame looks like.

import { runScreen, type CopyText, type ScreenModel, type SecretsDeployActions, type SecretsEditActions } from './secretsScreenDriver';
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
  handleKey,
  initialProjectsScreenState,
  render,
} from './projectsScreen';

/** What deleting a project from the screen needs (`commands/projectDeleteActions.ts`). Neither function ever rejects. */
export interface ProjectsDeleteActions {
  readonly preview: (project: ProjectRefLite) => Promise<DeletePreviewLoaded>;
  readonly run: (project: ProjectRefLite) => Promise<DeleteFinished>;
}

/** The projects screen's own effects, by `type`: the ones `capy secrets` does not have. */
const OWN_EFFECT_TYPES: ReadonlySet<string> = new Set<ProjectsOwnEffect['type']>(['projectDeletePreview', 'projectDelete']);

export function projectsModel(deleteActions: ProjectsDeleteActions): ScreenModel<ProjectsScreenState, ProjectsOwnEffect> {
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
  copy?: CopyText,
): Promise<void> {
  await runScreen(projectsModel(deleteActions), initialProjectsScreenState(data, dryRun), decryptAt, edit, deploy, copy);
}

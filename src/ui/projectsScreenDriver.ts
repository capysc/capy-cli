// Thin imperative shell for the `capy projects` screen: the same driver
// `capy secrets` runs on (`runScreen` in secretsScreenDriver.ts), given the
// projects screen as its `ScreenModel`. Edit, deploy and value results land in
// the open project's embedded secrets screen; nothing here computes what a key
// does or what a frame looks like.

import { runScreen, type CopyText, type ScreenModel, type SecretsDeployActions, type SecretsEditActions } from './secretsScreenDriver';
import type { LocationDecryptor } from './secretsScreen';
import {
  type ProjectsData,
  type ProjectsOwnEffect,
  type ProjectsScreenState,
  handleKey,
  initialProjectsScreenState,
  render,
} from './projectsScreen';

/** The projects screen's own effects, by `type`: the ones `capy secrets` does not have. */
const OWN_EFFECT_TYPES: ReadonlySet<string> = new Set<ProjectsOwnEffect['type']>(['projectsNone']);

function projectsModel(): ScreenModel<ProjectsScreenState, ProjectsOwnEffect> {
  return {
    handleKey,
    render,
    isQuit: (state) => state.quit,
    exitTextOf: (state) => state.exitText,
    quitNow: (state) => ({ ...state, quit: true }),
    secretsOf: (state) => state.open?.secrets ?? null,
    withSecrets: (state, secrets) => (state.open === null ? state : { ...state, open: { ...state.open, secrets } }),
    isOwnEffect: (effect): effect is ProjectsOwnEffect => OWN_EFFECT_TYPES.has(effect.type),
    performOwn: () => {},
  };
}

/** Runs the `capy projects` screen until the user quits. The terminal is always restored (see `runScreen`). */
export async function runProjectsScreen(
  data: ProjectsData,
  decryptAt: LocationDecryptor,
  edit: SecretsEditActions | undefined,
  dryRun: boolean,
  deploy: SecretsDeployActions | undefined,
  copy?: CopyText,
): Promise<void> {
  await runScreen(projectsModel(), initialProjectsScreenState(data, dryRun), decryptAt, edit, deploy, copy);
}

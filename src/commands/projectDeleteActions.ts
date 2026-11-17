// The side effects of deleting a project from the `capy projects` screen. The
// rules are `capy project delete`'s (projectLifecycleCommand.ts), reused, not
// copied: the same summary before the question, the same DELETE (never forced
// from the screen), and the same coded refusals — org owner only, and refused
// while the project has live deploy tokens.

import { ERROR_CODES } from '../types/index';
import type { ServiceClient } from '../service/serviceClient';
import { deletePreviewLines, deletedLines, refusalFor, settle, type OrgRef } from './projectLifecycleCommand';
import type { DeleteFinished, DeletePreviewLoaded, ProjectRefLite, ScreenRefusal } from '../ui/projectsScreen';

/** What the screen needs to delete a project. Neither function ever rejects: a failure comes back as a coded refusal. */
export interface ProjectDeleteActions {
  /** The summary `capy project delete` prints before its question (reads only). */
  readonly preview: (project: ProjectRefLite) => Promise<DeletePreviewLoaded>;
  /** Deletes the project, without `--force`. */
  readonly run: (project: ProjectRefLite) => Promise<DeleteFinished>;
}

/** A refusal as the screen shows it: `capy project delete`'s message and lines, keyed off its code. */
function screenRefusal(err: unknown, project: ProjectRefLite): ScreenRefusal {
  const refusal = refusalFor(err);
  // The screen never forces a delete: the exact command that does is shown instead.
  const force = refusal.code === ERROR_CODES.PROJECT_HAS_LIVE_DEPLOY_TOKENS
    ? [`capy project delete ${project.id} --force`] // COPY-FLAG
    : [];
  return { code: refusal.code, message: refusal.message, lines: [...(refusal.lines ?? []), ...force] };
}

export function createProjectDeleteActions(
  serviceClient: Pick<ServiceClient, 'deleteProject' | 'listDeployTokens' | 'listBranches' | 'getLatestSecrets'>,
  org: OrgRef,
): ProjectDeleteActions {
  return {
    preview: async (project) => {
      const read = await settle(() => deletePreviewLines(serviceClient, org, project));
      return read.ok ? { ok: true, lines: read.value } : { ok: false, refusal: screenRefusal(read.error, project) };
    },
    run: async (project) => {
      const deleted = await settle(() => serviceClient.deleteProject(org.id, project.id, false));
      return deleted.ok ? { ok: true, lines: deletedLines(deleted.value.project) } : { ok: false, refusal: screenRefusal(deleted.error, project) };
    },
  };
}

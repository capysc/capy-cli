// The reads the `capy projects` screen makes after it has drawn: one project's
// secrets index (when its Secrets, Deployments or Connectors tab is first shown)
// and the org's member list (when the Users tab, or a branch's access dialog,
// first needs it). Each is read once per screen; the screen keeps the result.
//
// A read the service refuses with PERMISSION_DENIED comes back as `denied`, so
// the screen hides what it feeds; any other failure comes back as a plain
// failure. Both are decided from the error's code, never from its message.

import { CapyError, ERROR_CODES } from '../types/index';
import type { ServiceClient } from '../service/serviceClient';
import type { ProjectsLoadActions } from '../ui/projectsScreenDriver';

type LoadServiceClient = Pick<ServiceClient, 'getSecretIndex' | 'listMemberDetails'>;

/** A failed read: refused (403 PERMISSION_DENIED) or not. */
function failureOf(err: unknown): { readonly ok: false; readonly denied: boolean } {
  return { ok: false, denied: err instanceof CapyError && err.code === ERROR_CODES.PERMISSION_DENIED };
}

/** No function ever rejects. */
export function createProjectsLoadActions(serviceClient: LoadServiceClient, orgId: string): ProjectsLoadActions {
  return {
    loadIndex: async (projectId) => {
      try {
        // Asks for this project only. A service that ignores the filter answers the whole index: the screen reads this project's rows from it.
        const index = await serviceClient.getSecretIndex(orgId, { projectId });
        return { ok: true, rows: index.rows, skipped: index.skipped };
      } catch (err) {
        return failureOf(err);
      }
    },
    loadMembers: async () => {
      try {
        return { ok: true, members: (await serviceClient.listMemberDetails(orgId)).members };
      } catch (err) {
        return failureOf(err);
      }
    },
  };
}

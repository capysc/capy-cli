import { ServiceClient, type ListedBranch, type ListedProject, type ListedRepo, type OrgRepoLink } from '../service/serviceClient';
import type { ProjectItem, ProjectsData } from '../ui/projectsScreen';
import { resolveOrgContext } from '../core/orgContext';
import { excludeSystemProject } from '../system/reservedProjectName';
import { Spinner } from '../ui/spinner';
import { CapyError, ERROR_CODES } from '../types/index';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

export interface ProjectBranchSummary {
  id: string;
  name: string;
  protected: boolean;
}

/** CAP-697: one repo (and folder) that holds this project's keep.lock. */
export interface ProjectRepoSummary {
  host: string;
  owner: string;
  name: string;
  path: string;
  github_repo_id: number | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  branches: ProjectBranchSummary[];
  /**
   * Only on `--deleted` output: when the project was deleted, `null` for a live one.
   * A deleted project lists no branches (the service answers 410 for them).
   */
  deleted_at?: string | null;
  /**
   * Linked repos. Absent when the caller may not read them (only owners, admins
   * and project admins can) or the lookup failed; `[]` means "none linked".
   */
  repos?: ProjectRepoSummary[];
  /**
   * Variables in the project: distinct name and value pairs across all branches.
   * Only when the service sends the summary; `null` when it cannot say (the index
   * is not ready) or the caller may not see it. `null` never means zero.
   */
  variable_count?: number | null;
  /** The newest change among the project's variables (ISO 8601), or `null`. Only when the service sends the summary. */
  variables_updated_at?: string | null;
  /** The status code of the project's secrets index, or `null`. Only when the service sends the summary. */
  index_status?: string | null;
}

/** `owner/name`, plus `/path` when the keep.lock is not at the repo root. */
export function formatRepo(repo: { owner: string; name: string; path: string }): string {
  return repo.path === '.' ? `${repo.owner}/${repo.name}` : `${repo.owner}/${repo.name}/${repo.path}`;
}

/** The org's repo links, or `null` when they cannot be read (a 403 for a plain member, a network error): never fails the command. */
async function loadOrgRepos(serviceClient: ServiceClient, orgId: string): Promise<readonly OrgRepoLink[] | null> {
  try {
    return (await serviceClient.getOrgRepos(orgId)).repos;
  } catch {
    return null;
  }
}

function withRepos(projects: readonly ProjectSummary[], links: readonly OrgRepoLink[] | null): ProjectSummary[] {
  if (links === null) return [...projects];
  return projects.map((p) => ({
    ...p,
    repos: links
      .filter((l) => l.project_id === p.id)
      .map((l) => ({ host: l.host, owner: l.owner, name: l.name, path: l.path, github_repo_id: l.github_repo_id ?? null })),
  }));
}

/** A newer service sends each project's branches in the list itself. */
function carriesBranches(project: ListedProject): project is ListedProject & { branches: ListedBranch[] } {
  return Array.isArray(project.branches);
}

/**
 * True when the list already answers what the repo request would: some project
 * carries `repos`, or every project carries `branches` (a service that sends
 * branches sends repos wherever the caller may read them, so a caller who got
 * none could not read them from the repo request either).
 */
function listCarriesRepoInfo(projects: readonly ListedProject[]): boolean {
  return projects.some((p) => Array.isArray(p.repos)) || (projects.length > 0 && projects.every(carriesBranches));
}

function repoSummaryOf(repo: ListedRepo): ProjectRepoSummary {
  return { host: repo.host, owner: repo.owner, name: repo.name, path: repo.path, github_repo_id: repo.github_repo_id ?? null };
}

/** The summary fields exactly as the service sent them (`null` kept), and nothing for a service that sends none. */
function summaryFieldsOf(project: ListedProject): Pick<ProjectSummary, 'variable_count' | 'variables_updated_at' | 'index_status'> {
  return {
    ...(project.variable_count === undefined ? {} : { variable_count: project.variable_count }),
    ...(project.variables_updated_at === undefined ? {} : { variables_updated_at: project.variables_updated_at }),
    ...(project.index_status === undefined ? {} : { index_status: project.index_status }),
  };
}

/** The projects the caller administers (`admin_projects` of `GET /orgs/:id/me`), or `null` when that cannot be read. */
async function loadAdminProjectIds(serviceClient: ServiceClient, orgId: string): Promise<readonly string[] | null> {
  try {
    return (await serviceClient.getOrgMe(orgId)).admin_projects.map((p) => p.id);
  } catch {
    return null;
  }
}

/** A project's branches for the screen: from the list when the service sends them, else one request. */
async function screenBranchesOf(serviceClient: ServiceClient, project: ListedProject): Promise<ProjectBranchSummary[]> {
  if (carriesBranches(project)) return project.branches.map((b) => ({ id: b.id, name: b.name, protected: b.is_protected }));
  return (await serviceClient.listBranches(project.id)).map((b) => ({ id: b.id, name: b.name, protected: b.is_protected }));
}

/** The variable summary the list carries, as the screen keeps it: exactly as sent (`null` kept), and nothing for a service that sends none. */
function listSummaryOf(project: ListedProject): Pick<ProjectItem, 'variableCount' | 'variablesUpdatedAt' | 'indexStatus'> {
  return {
    ...(project.variable_count === undefined ? {} : { variableCount: project.variable_count }),
    ...(project.variables_updated_at === undefined ? {} : { variablesUpdatedAt: project.variables_updated_at }),
    ...(project.index_status === undefined ? {} : { indexStatus: project.index_status }),
  };
}

/**
 * What the interactive screen draws from: `GET /projects` and nothing else for a
 * current service, which sends each project's branches, repos (only on projects
 * the caller administers) and variable summary in that one response. The org's
 * secrets index and member list are not read here: the screen reads them when a
 * tab first needs them (`ProjectsData.lazy`).
 *
 * An older service sends less, and the existing fallbacks stay: one request for
 * each project's branches, and one for the org's repo links (with the caller's
 * administered projects, so a link is attached only to those). A part the
 * service does not return to the caller is left out, and the screen hides it:
 * a project with no repos attached hides its Git repos tab.
 */
export async function loadScreenData(serviceClient: ServiceClient, orgId: string): Promise<ProjectsData> {
  const listed = excludeSystemProject(await serviceClient.listProjects());
  // A newer service puts branches and repos in the list: no per-project and no repo request then. With no project there is nothing to attach them to.
  const reposInList = listCarriesRepoInfo(listed);
  const needsRepoRequests = !reposInList && listed.length > 0;
  const [withBranches, links, adminIds] = await Promise.all([
    Promise.all(listed.map(async (p) => ({ p, branches: await screenBranchesOf(serviceClient, p) }))),
    needsRepoRequests ? loadOrgRepos(serviceClient, orgId) : Promise.resolve(null),
    needsRepoRequests ? loadAdminProjectIds(serviceClient, orgId) : Promise.resolve(null),
  ]);
  const reposFor = (project: ListedProject): Pick<ProjectItem, 'repos'> => {
    // The service sends `repos` only on projects the caller administers.
    if (reposInList) return Array.isArray(project.repos) ? { repos: project.repos.map(repoSummaryOf) } : {};
    if (links === null || (adminIds !== null && !adminIds.includes(project.id))) return {};
    return {
      repos: links
        .filter((l) => l.project_id === project.id)
        .map((l) => ({ host: l.host, owner: l.owner, name: l.name, path: l.path, github_repo_id: l.github_repo_id ?? null })),
    };
  };
  const projects: readonly ProjectItem[] = withBranches.map(({ p, branches }) => ({
    id: p.id,
    name: p.name,
    createdAt: p.created_at ?? null,
    branches,
    ...reposFor(p),
    ...listSummaryOf(p),
  }));
  const reposShown = reposInList ? listed.some((p) => Array.isArray(p.repos)) : links !== null;
  return { projects, index: null, members: null, reposShown, lazy: { indexes: {}, members: 'unloaded', adminProjectIds: adminIds } };
}

/**
 * `capy projects` — read-only listing of every project in the caller's active
 * organization, with each project's branches. No subcommands, no writes.
 *
 * Works from any directory: org is resolved via `resolveOrgContext` (cached
 * session, prompting for an org if the caller belongs to more than one and
 * there's no local keep.lock hint) rather than requiring a project to already
 * be checked out — mirrors `invite`/`kick`/`users`.
 *
 * The service already excludes the org's reserved `_system` project from
 * `GET /projects` (see service/src/routes/projects.ts); `excludeSystemProject`
 * here is the same belt-and-braces client-side guard `usersCommand`/
 * `inviteCommand` already apply, in case an older or misbehaving service ever
 * lets it through.
 */
export class ProjectsCommand {
  constructor(
    private readonly apiUrl?: string,
    private readonly devMode: boolean = false,
  ) {}

  async execute(opts: { json?: boolean; deleted?: boolean; dryRun?: boolean } = {}): Promise<void> {
    const json = opts.json === true;
    const includeDeleted = opts.deleted === true;
    // A terminal on both ends, no --json and no --deleted: the interactive screen. Everything else is today's output.
    if (!json && !includeDeleted && process.stdout.isTTY === true && process.stdin.isTTY === true) {
      await this.runInteractive(opts.dryRun === true);
      return;
    }
    // Same CAP-273 contract as `usersCommand`/`listCommand`: under --json, no
    // progress output at all, so stdout stays pure JSON even on a TTY.
    const spinner = json ? null : new Spinner('Loading projects...');

    try {
      // The spinner starts once the org is known: resolving it may ask which org.
      const { orgId, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);
      spinner?.start();
      const listed = await this.listRawProjects(serviceClient, includeDeleted);
      const summaries = await this.loadProjectSummaries(serviceClient, listed, includeDeleted);
      // A newer service puts branches and repos in the list: no per-project and no repo request then.
      const projects = listCarriesRepoInfo(listed) ? summaries : withRepos(summaries, await loadOrgRepos(serviceClient, orgId));

      spinner?.succeed(`${projects.length} project${projects.length !== 1 ? 's' : ''}`);
      this.render(projects, json);
    } catch (err) {
      spinner?.fail('Failed to load projects');
      this.exitWithError(err, json);
    }
  }

  /** The interactive screen (`ui/projectsScreen.ts`): live projects only, with the same loading spinner. */
  private async runInteractive(dryRun: boolean): Promise<void> {
    const spinner = new Spinner('Loading projects...');
    try {
      // The spinner starts once the org is known: resolving it may ask which org.
      const { orgId, orgName, userId, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);
      spinner.start();
      const data = { ...(await loadScreenData(serviceClient, orgId)), selfUserId: userId };
      const { createLocationDecryptor } = await import('./secretsValueDecryptor');
      const { createEditActions } = await import('./secretsEditActions');
      const { createDeployActions } = await import('./secretsDeployActions');
      const { createProjectDeleteActions } = await import('./projectDeleteActions');
      const { createProjectUsersActions } = await import('./projectUsersActions');
      const { createProjectManageActions } = await import('./projectManageActions');
      const { createProjectsLoadActions } = await import('./projectsLoadActions');
      const { runProjectsScreen } = await import('../ui/projectsScreenDriver');
      spinner.stop();
      await runProjectsScreen(
        data,
        createLocationDecryptor(orgId, userId, serviceClient),
        createEditActions(orgId, userId, serviceClient, dryRun),
        dryRun,
        createDeployActions(orgId, userId, serviceClient, dryRun, this.devMode),
        createProjectDeleteActions(serviceClient, { id: orgId, name: orgName }),
        createProjectUsersActions(serviceClient, orgId, userId),
        createProjectManageActions(serviceClient, orgId),
        createProjectsLoadActions(serviceClient, orgId),
      );
    } catch (err) {
      spinner.fail('Failed to load projects');
      this.exitWithError(err, false);
    }
  }

  private async listRawProjects(serviceClient: ServiceClient, includeDeleted: boolean): Promise<ListedProject[]> {
    // The argument is only passed for `--deleted`, so a plain listing sends exactly the request it always did.
    const listed = includeDeleted ? await serviceClient.listProjects({ includeDeleted: true }) : await serviceClient.listProjects();
    return excludeSystemProject(listed);
  }

  private async loadProjectSummaries(
    serviceClient: ServiceClient,
    rawProjects: readonly ListedProject[],
    includeDeleted: boolean,
  ): Promise<ProjectSummary[]> {
    // Concurrent per-project branch fetch, only for a service that does not send branches in the list.
    return Promise.all(
      rawProjects.map(async (p) => {
        const deletedAt = includeDeleted ? (p.deleted_at ?? null) : undefined;
        const branches = await this.branchesOf(serviceClient, p, deletedAt);
        return {
          id: p.id,
          name: p.name,
          branches,
          ...(includeDeleted ? { deleted_at: deletedAt } : {}),
          ...(Array.isArray(p.repos) ? { repos: p.repos.map(repoSummaryOf) } : {}),
          ...summaryFieldsOf(p),
        };
      }),
    );
  }

  private async branchesOf(
    serviceClient: ServiceClient,
    project: ListedProject,
    deletedAt: string | null | undefined,
  ): Promise<ProjectBranchSummary[]> {
    if (carriesBranches(project)) return project.branches.map((b) => ({ id: b.id, name: b.name, protected: b.is_protected }));
    // A deleted project answers 410 PROJECT_DELETED to its branch list: it has none to show.
    if (deletedAt !== null && deletedAt !== undefined) return [];
    return (await serviceClient.listBranches(project.id)).map((b) => ({ id: b.id, name: b.name, protected: b.is_protected }));
  }

  private render(projects: ProjectSummary[], json: boolean): void {
    if (json) {
      console.log(JSON.stringify({ ok: true, projects }, null, 2));
      return;
    }

    if (projects.length === 0) {
      console.log('\n  No projects found.\n');
      return;
    }

    console.log('');
    for (const project of projects) {
      console.log(`  ${B(project.name)} ${DIM}·${RESET} ${this.formatBranchesOrDeleted(project)}${this.formatRepos(project.repos)}${this.formatVariableCount(project.variable_count)}`);
    }
    console.log('');
  }

  /** ` · owner/name` (plus `/path` when not the repo root) per linked repo; nothing when there are none. */
  private formatRepos(repos: ProjectRepoSummary[] | undefined): string {
    if (repos === undefined || repos.length === 0) return '';
    return ` ${DIM}·${RESET} ${repos.map(formatRepo).join(', ')}`;
  }

  /** ` · 7 variables`; nothing when the service did not send a count or cannot say (`null`). */
  private formatVariableCount(count: number | null | undefined): string {
    if (typeof count !== 'number') return '';
    return ` ${DIM}·${RESET} ${count} ${count === 1 ? 'variable' : 'variables'}`; // COPY-FLAG
  }

  /** A deleted project reads `deleted <date>` where the branches would be. */
  private formatBranchesOrDeleted(project: ProjectSummary): string {
    if (project.deleted_at === null || project.deleted_at === undefined) return this.formatBranches(project.branches);
    return `${DIM}deleted ${project.deleted_at.slice(0, 10)}${RESET}`; // COPY-FLAG
  }

  private formatBranches(branches: ProjectBranchSummary[]): string {
    if (branches.length === 0) return `${DIM}(no branches)${RESET}`;
    return branches
      .map((b) => (b.protected ? `${b.name} ${DIM}(protected)${RESET}` : b.name))
      .join(', ');
  }

  /** Coded JSON on stdout under --json, prose on stderr otherwise. Never exposes secret values (there are none in this response). */
  private exitWithError(err: unknown, json: boolean): never {
    const { code, message } = this.describeError(err);
    if (json) {
      console.log(JSON.stringify({ ok: false, code, error: message }, null, 2));
    } else {
      console.error(`  ${message}`);
    }
    process.exit(1);
  }

  private describeError(err: unknown): { code: string; message: string } {
    if (err instanceof CapyError) return { code: err.code, message: err.message };
    const message = err instanceof Error ? err.message : String(err);
    return { code: ERROR_CODES.SERVICE_ERROR, message };
  }
}

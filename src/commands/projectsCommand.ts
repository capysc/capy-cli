import { ServiceClient, type OrgRepoLink } from '../service/serviceClient';
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
   * Linked repos. Absent when the caller may not read them (only owners, admins
   * and project admins can) or the lookup failed; `[]` means "none linked".
   */
  repos?: ProjectRepoSummary[];
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

  async execute(opts: { json?: boolean } = {}): Promise<void> {
    const json = opts.json === true;
    // Same CAP-273 contract as `usersCommand`/`listCommand`: under --json, no
    // progress output at all, so stdout stays pure JSON even on a TTY.
    const spinner = json ? null : new Spinner('Loading projects...');
    spinner?.start();

    try {
      const { orgId, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);
      const summaries = await this.loadProjectSummaries(serviceClient);
      const projects = withRepos(summaries, await loadOrgRepos(serviceClient, orgId));

      spinner?.succeed(`${projects.length} project${projects.length !== 1 ? 's' : ''}`);
      this.render(projects, json);
    } catch (err) {
      spinner?.fail('Failed to load projects');
      this.exitWithError(err, json);
    }
  }

  private async loadProjectSummaries(serviceClient: ServiceClient): Promise<ProjectSummary[]> {
    const rawProjects = excludeSystemProject(await serviceClient.listProjects());
    // Concurrent per-project branch fetch — independent GETs, fine to fan out.
    return Promise.all(
      rawProjects.map(async (p) => ({
        id: p.id,
        name: p.name,
        branches: (await serviceClient.listBranches(p.id)).map((b) => ({
          id: b.id,
          name: b.name,
          protected: b.is_protected,
        })),
      })),
    );
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
      console.log(`  ${B(project.name)} ${DIM}·${RESET} ${this.formatBranches(project.branches)}${this.formatRepos(project.repos)}`);
    }
    console.log('');
  }

  /** ` · owner/name` (plus `/path` when not the repo root) per linked repo; nothing when there are none. */
  private formatRepos(repos: ProjectRepoSummary[] | undefined): string {
    if (repos === undefined || repos.length === 0) return '';
    return ` ${DIM}·${RESET} ${repos.map(formatRepo).join(', ')}`;
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

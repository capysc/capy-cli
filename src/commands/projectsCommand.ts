import { ServiceClient } from '../service/serviceClient';
import { resolveOrgContext } from '../core/orgContext';
import { excludeSystemProject } from '../system/reservedProjectName';
import { Spinner } from '../ui/spinner';
import { CapyError, ERROR_CODES } from '../types/index';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

export interface ProjectBranchSummary {
  readonly id: string;
  readonly name: string;
  readonly protected: boolean;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly branches: readonly ProjectBranchSummary[];
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
 *
 * Three output modes, same rule `secretsCommand.ts` (CAP-680) codified first:
 *
 * - `--json` → unchanged: the `{ok, projects}` payload, always, on any surface.
 * - No `--json`, and BOTH stdout and stdin are TTYs → the interactive
 *   type-to-search screen (`ui/projectsScreenDriver.ts`), with the same
 *   loading spinner shown beforehand.
 * - No `--json`, and it is NOT a full TTY (piped/CI/agent, or a real
 *   terminal with piped stdin) → today's unchanged static human table — the
 *   exact `render()` path this command always used before the interactive
 *   screen existed.
 */
export class ProjectsCommand {
  constructor(
    private readonly apiUrl?: string,
    private readonly devMode: boolean = false,
  ) {}

  async execute(opts: { json?: boolean } = {}): Promise<void> {
    const json = opts.json === true;
    // Interactive only when BOTH streams are real TTYs — an agent/CI caller,
    // or a real terminal with piped stdin, falls straight through to the
    // same static table this command has always printed in that case.
    const isFullTty = process.stdout.isTTY === true && process.stdin.isTTY === true;
    const interactive = !json && isFullTty;
    // Same CAP-273 contract as `usersCommand`/`listCommand`: under --json, no
    // progress output at all, so stdout stays pure JSON even on a TTY.
    const spinner = json ? null : new Spinner('Loading projects...');
    spinner?.start();

    try {
      const { serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);
      const projects = await this.loadProjectSummaries(serviceClient);

      if (interactive) {
        // No "succeed" message — like `secretsScreen`'s launch, the screen
        // takes over the terminal immediately, so there's nothing to leave
        // behind on scroll-back.
        spinner?.stop();
        const { runProjectsScreen } = await import('../ui/projectsScreenDriver');
        await runProjectsScreen(projects);
        return;
      }

      spinner?.succeed(`${projects.length} project${projects.length !== 1 ? 's' : ''}`);
      this.render(projects, json);
    } catch (err) {
      spinner?.fail('Failed to load projects');
      this.exitWithError(err, json);
    }
  }

  private async loadProjectSummaries(serviceClient: ServiceClient): Promise<readonly ProjectSummary[]> {
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

  private render(projects: readonly ProjectSummary[], json: boolean): void {
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
      console.log(`  ${B(project.name)} ${DIM}·${RESET} ${this.formatBranches(project.branches)}`);
    }
    console.log('');
  }

  private formatBranches(branches: readonly ProjectBranchSummary[]): string {
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

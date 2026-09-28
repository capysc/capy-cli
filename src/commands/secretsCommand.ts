import { SecretIndexRow, SecretIndexService, SecretIndexSkipped } from '../service/serviceClient';
import { resolveOrgContext } from '../core/orgContext';
import { Spinner } from '../ui/spinner';
import { CapyError, ERROR_CODES } from '../types/index';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

/** Strips SGR escape codes before measuring a cell's on-screen width. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A cell's cap, past which it is truncated with a trailing `…` — generous, but bounded so one long name/email/branch/service never blows out every row. */
const MAX_CELL_WIDTH = 40;

/** Truncate a PLAIN (no-ANSI) string to `MAX_CELL_WIDTH`, leaving room for the ellipsis. Apply this BEFORE adding any ANSI decoration (a protected marker, a disambiguating hash) — decoration is only added to a cell that made the cut. */
function truncatePlain(s: string): string {
  return s.length <= MAX_CELL_WIDTH ? s : `${s.slice(0, MAX_CELL_WIDTH - 1)}…`;
}

/** Pad `s`'s VISIBLE length (ANSI-stripped) up to `width` with trailing spaces. */
function padVisible(s: string, width: number): string {
  const vis = stripAnsi(s).length;
  return vis >= width ? s : s + ' '.repeat(width - vis);
}

export interface SecretsOpts {
  json?: boolean;
  /** Keep only rows with at least one location in this project — exact, case-sensitive match on `project_name`. */
  project?: string;
  /** Keep only rows with at least one location on this branch — exact, case-sensitive match. */
  branch?: string;
  /** Force the static table even on a TTY (the interactive screen's escape hatch). */
  noInteractive?: boolean;
}

/** One row, pre-rendered into its own column lines — `lines.length` is the same for every column within a row (padded with `''`), and is the number of terminal lines this row occupies. */
interface RenderedRow {
  name: readonly string[];
  users: readonly string[];
  branch: readonly string[];
  service: readonly string[];
}

const HEADERS = ['NAME', 'USERS', 'BRANCH', 'SERVICE'] as const;

/**
 * `capy secrets` — read-only listing of every secret NAME across the
 * caller's active organization, grouped by (name, value_hash). Values are
 * NEVER shown, NEVER requested: the server's `/orgs/:orgId/secrets`
 * contract (see `ServiceClient.getSecretIndex`) carries only names, hashes,
 * locations, and readers — nothing this command touches can leak a value.
 *
 * Modeled on `ProjectsCommand`: org resolved via `resolveOrgContext` (works
 * from any directory, no project needs to be checked out), `--json` prints
 * the server payload verbatim (plus `ok: true`), and a service failure
 * surfaces as a coded refusal on both surfaces — never a stack trace.
 *
 * Two rows can share the same NAME with a DIFFERENT value_hash — that's a
 * real divergence (the same-named var holds different values in different
 * places), not a defect. The human table marks it (see `formatName`) so it
 * reads as deliberate rather than as a rendering bug.
 *
 * On a real terminal (both stdout and stdin are TTYs) with neither `--json`
 * nor `--no-interactive`, this hands off to the interactive screen
 * (`ui/secretsScreenDriver.ts`) instead of printing the static table — same
 * index, same org-scoped read, just a navigable view with an on-demand,
 * one-location-at-a-time value reveal (see CAP-675 / `ui/secretsScreen.ts`).
 */
export class SecretsCommand {
  constructor(
    private readonly apiUrl?: string,
    private readonly devMode: boolean = false,
  ) {}

  async execute(opts: SecretsOpts = {}): Promise<void> {
    const json = opts.json === true;
    const interactive =
      !json &&
      opts.noInteractive !== true &&
      process.stdout.isTTY === true &&
      process.stdin.isTTY === true;

    // Same CAP-273 contract as `usersCommand`/`projectsCommand`: under
    // --json, no progress output at all, so stdout stays pure JSON even on
    // a TTY. The interactive screen shows the same loading line while the
    // index loads, then clears it before taking over the terminal.
    const spinner = json ? null : new Spinner('Loading secrets...');
    spinner?.start();

    try {
      const { orgId, userId, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);
      const index = await serviceClient.getSecretIndex(orgId);
      const rows = this.filterRows(index.rows, opts);

      if (interactive) {
        const { createLocationDecryptor } = await import('./secretsValueDecryptor');
        const { runSecretsScreen } = await import('../ui/secretsScreenDriver');
        spinner?.stop();
        await runSecretsScreen(rows, createLocationDecryptor(orgId, userId, serviceClient));
        return;
      }

      spinner?.succeed(`${rows.length} secret${rows.length !== 1 ? 's' : ''}`);
      this.render(rows, index.skipped, index.org_id, json);
    } catch (err) {
      spinner?.fail('Failed to load secrets');
      this.exitWithError(err, json);
    }
  }

  private filterRows(rows: readonly SecretIndexRow[], opts: SecretsOpts): SecretIndexRow[] {
    const projectFilter = opts.project;
    const branchFilter = opts.branch;
    if (!projectFilter && !branchFilter) return [...rows];
    return rows.filter((row) =>
      row.locations.some(
        (loc) =>
          (!projectFilter || loc.project_name === projectFilter) &&
          (!branchFilter || loc.branch === branchFilter),
      ),
    );
  }

  private render(rows: readonly SecretIndexRow[], skipped: readonly SecretIndexSkipped[], orgId: string, json: boolean): void {
    if (json) {
      console.log(JSON.stringify({ ok: true, org_id: orgId, rows, skipped }, null, 2));
    } else if (rows.length === 0) {
      console.log('\n  No secrets found.\n');
    } else {
      this.printTable(rows);
    }

    // Names only, never a value — printed on stderr on EITHER surface, so
    // --json's stdout stays pure while the gap is still reported somewhere
    // a human (or a script that checks stderr) will see it.
    if (skipped.length > 0) {
      console.error(
        `  ⚠ Skipped ${skipped.length} project${skipped.length !== 1 ? 's' : ''}: ` +
          skipped.map((s) => `${s.project_name} (${s.code})`).join(', '),
      );
    }
  }

  private printTable(rows: readonly SecretIndexRow[]): void {
    const nameCounts: Readonly<Record<string, number>> = rows.reduce(
      (acc, row) => ({ ...acc, [row.name]: (acc[row.name] ?? 0) + 1 }),
      {} as Record<string, number>,
    );

    const rendered = rows.map((row) => this.renderRow(row, (nameCounts[row.name] ?? 0) > 1));

    const widthOf = (get: (r: RenderedRow) => readonly string[], header: string): number =>
      Math.max(header.length, ...rendered.flatMap((r) => get(r).map((cell) => stripAnsi(cell).length)), 0);
    const widths = {
      name: widthOf((r) => r.name, HEADERS[0]),
      users: widthOf((r) => r.users, HEADERS[1]),
      branch: widthOf((r) => r.branch, HEADERS[2]),
      service: widthOf((r) => r.service, HEADERS[3]),
    };
    const gap = '  ';
    const line = (name: string, users: string, branch: string, service: string): string =>
      [padVisible(name, widths.name), padVisible(users, widths.users), padVisible(branch, widths.branch), padVisible(service, widths.service)].join(gap);
    const totalWidth =
      widths.name + widths.users + widths.branch + widths.service + gap.length * 3;

    console.log('');
    console.log(`  ${B(line(HEADERS[0], HEADERS[1], HEADERS[2], HEADERS[3]))}`);
    console.log(`  ${DIM}${'─'.repeat(totalWidth)}${RESET}`);

    rendered.forEach((r, i) => {
      const height = Math.max(r.name.length, r.users.length, r.branch.length, r.service.length, 1);
      Array.from({ length: height }, (_, lineIdx) => lineIdx).forEach((lineIdx) => {
        console.log(
          `  ${line(r.name[lineIdx] ?? '', r.users[lineIdx] ?? '', r.branch[lineIdx] ?? '', r.service[lineIdx] ?? '')}`,
        );
      });
      if (i < rendered.length - 1) console.log(`  ${DIM}${'─'.repeat(totalWidth)}${RESET}`);
    });

    const projectCount = new Set(rows.flatMap((r) => r.locations.map((l) => l.project_id))).size;
    console.log('');
    console.log(`  ${rows.length} secret${rows.length !== 1 ? 's' : ''} across ${projectCount} project${projectCount !== 1 ? 's' : ''}`);
    console.log('');
  }

  /** One row's four column line-arrays — see `RenderedRow`'s own doc for the line-count contract. */
  private renderRow(row: SecretIndexRow, ambiguousName: boolean): RenderedRow {
    const name = [this.formatName(row, ambiguousName)];

    const userCount = row.users.length;
    const users = [
      `${userCount} user${userCount !== 1 ? 's' : ''}`,
      ...row.users.map((u) => truncatePlain(u.email)),
    ];

    const branch = row.locations.map((loc) => this.formatBranch(loc));
    const service = row.locations.map((loc) => this.formatService(loc.service));

    return { name, users, branch, service };
  }

  /** The bare name, plus (only when another row shares it with a DIFFERENT value) a dim `#<hash8>` disambiguator — a stable, factual suffix, never invented copy. */
  private formatName(row: SecretIndexRow, ambiguous: boolean): string {
    const plain = truncatePlain(row.name);
    if (!ambiguous) return plain;
    return `${plain} ${DIM}#${row.value_hash.slice(0, 8)}${RESET}`;
  }

  /** `project · branch`, marked `(protected)` the same way `ProjectsCommand.formatBranches` does. */
  private formatBranch(loc: { project_name: string; branch: string; protected: boolean }): string {
    const plain = truncatePlain(`${loc.project_name} · ${loc.branch}`);
    return loc.protected ? `${plain} ${DIM}(protected)${RESET}` : plain;
  }

  /**
   * The Dokploy service, prefixed with its Dokploy project when known —
   * real Dokploy service names are often generic (many SlideSpeak services
   * are literally named `main`), so `<dokploy_project> / <name>` disambiguates.
   * Falls back to bare `<name>` with no project, then `dokploy:<compose_id>`
   * when Dokploy never set a name, then `—` when this location has no
   * service at all.
   */
  private formatService(service: SecretIndexService | null): string {
    if (!service) return '—';
    if (service.name) {
      return truncatePlain(service.dokploy_project ? `${service.dokploy_project} / ${service.name}` : service.name);
    }
    if (service.compose_id) return truncatePlain(`dokploy:${service.compose_id}`);
    return '—';
  }

  /** Coded JSON on stdout under --json, prose on stderr otherwise. Never exposes a secret value — there are none in this response. */
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

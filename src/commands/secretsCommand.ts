import { SecretIndexRow, SecretIndexSkipped } from '../service/serviceClient';
import { resolveOrgContext } from '../core/orgContext';
import { Spinner } from '../ui/spinner';
import { CapyError, ERROR_CODES } from '../types/index';
import { rowIdOf } from './secretsRowId';
import { secretRowStatus, type SecretRowStatus } from '../core/deployStatus';

/** `status` (`no target` | `in sync` | `behind` | `unknown` — stable codes, not on-screen words) plus, when some target lags, how many of how many. `no target`: the row has no Capy deploy target, so Capy can't say. */
function statusFields(status: SecretRowStatus): Record<string, string | number> {
  if (status.kind !== 'behind') return { status: status.kind };
  return { status: status.kind, targets_not_deployed: status.behind, targets_total: status.total };
}

export interface SecretsOpts {
  json?: boolean;
  /** Keep only rows with at least one location in this project — exact, case-sensitive match on `project_name`. */
  project?: string;
  /** Keep only rows with at least one location on this branch — exact, case-sensitive match. */
  branch?: string;
  /** Keep only rows with exactly this NAME (case-sensitive). */
  name?: string;
  /** The global `--dry-run`: the screen's edit flow only plans, and says so. Has no effect on `--json`. */
  dryRun?: boolean;
}

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
 * Exactly two output modes now (the static human table is gone — CAP-680):
 *
 * - `--json` → the JSON payload, always, on any surface.
 * - No `--json`, and BOTH stdout and stdin are TTYs → the interactive
 *   screen (`ui/secretsScreenDriver.ts`, CAP-675), with the same loading
 *   spinner shown beforehand.
 * - No `--json`, and it is NOT a full TTY (piped/CI/agent — no interactive
 *   escape hatch was ever offered for this, so there is no third mode to
 *   fall back to) → the SAME JSON `--json` would have printed, emitted
 *   automatically. This is a deliberate machine-safety default: a caller
 *   that isn't a real terminal can never get raw ANSI on stdout or block
 *   on a prompt it cannot answer.
 *
 * `--project`/`--branch` filter identically in every mode.
 *
 * Two rows can share the same NAME with a DIFFERENT value_hash — that's a
 * real divergence (the same-named var holds different values in different
 * places), not a defect; the interactive screen's own name-disambiguation
 * lives in `ui/secretsScreen.ts`, not here.
 */
export class SecretsCommand {
  constructor(
    private readonly apiUrl?: string,
    private readonly devMode: boolean = false,
  ) {}

  async execute(opts: SecretsOpts = {}): Promise<void> {
    const json = opts.json === true;
    const isFullTty = process.stdout.isTTY === true && process.stdin.isTTY === true;
    const interactive = !json && isFullTty;
    // Covers BOTH an explicit --json request and the automatic non-TTY
    // fallback — from here on they're the same output, just reached two
    // different ways.
    const emitJson = json || !isFullTty;

    // Only the interactive path shows a spinner. `--json` never has (CAP-273:
    // stdout stays pure JSON even on a TTY); the auto-JSON fallback mirrors
    // that same "no progress output" contract rather than risk a stray
    // status line landing on stdout — a piped/CI/agent caller has no
    // terminal to animate on anyway.
    const spinner = interactive ? new Spinner('Loading secrets...') : null;
    spinner?.start();

    try {
      const { orgId, userId, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);
      const index = await serviceClient.getSecretIndex(orgId);
      const rows = this.filterRows(index.rows, opts);

      if (interactive) {
        const { createLocationDecryptor } = await import('./secretsValueDecryptor');
        const { runSecretsScreen } = await import('../ui/secretsScreenDriver');
        const { createEditActions } = await import('./secretsEditActions');
        spinner?.stop();
        await runSecretsScreen(
          rows,
          createLocationDecryptor(orgId, userId, serviceClient),
          createEditActions(orgId, userId, serviceClient, opts.dryRun === true),
          opts.dryRun === true,
        );
        return;
      }

      this.emitJsonOutput(rows, index.skipped, index.org_id);
    } catch (err) {
      spinner?.fail('Failed to load secrets');
      this.exitWithError(err, emitJson);
    }
  }

  private filterRows(rows: readonly SecretIndexRow[], opts: SecretsOpts): SecretIndexRow[] {
    const projectFilter = opts.project;
    const branchFilter = opts.branch;
    const named = opts.name === undefined ? [...rows] : rows.filter((row) => row.name === opts.name);
    if (!projectFilter && !branchFilter) return named;
    return named.filter((row) =>
      row.locations.some(
        (loc) =>
          (!projectFilter || loc.project_name === projectFilter) &&
          (!branchFilter || loc.branch === branchFilter),
      ),
    );
  }

  private emitJsonOutput(rows: readonly SecretIndexRow[], skipped: readonly SecretIndexSkipped[], orgId: string): void {
    // `row_id`: an opaque, stable handle for (name, value) that `capy secrets set --row` takes. Never a slice of the value's hash.
    // CAP-702, additive: `status` is the STATUS column's value; each target's `up_to_date` says it has the current value (`deployed` already means "not --no-deploy").
    const withIds = rows.map((row) => ({
      ...row,
      row_id: rowIdOf(row.name, row.value_hash),
      ...statusFields(secretRowStatus(row)),
      locations: row.locations.map((loc) =>
        loc.targets === undefined ? loc : { ...loc, targets: loc.targets.map((t) => ({ ...t, up_to_date: !t.stale })) },
      ),
    }));
    console.log(JSON.stringify({ ok: true, org_id: orgId, rows: withIds, skipped }, null, 2));

    // Names only, never a value — always stderr, so stdout stays pure JSON
    // whether this is an explicit --json call or the automatic non-TTY one.
    if (skipped.length > 0) {
      console.error(
        `  ⚠ Skipped ${skipped.length} project${skipped.length !== 1 ? 's' : ''}: ` +
          skipped.map((s) => `${s.project_name} (${s.code})`).join(', '),
      );
    }
  }

  /** Coded JSON on stdout when `emitJson` (explicit --json OR the automatic non-TTY fallback), prose on stderr otherwise (a real interactive terminal). Never exposes a secret value — there are none in this response. */
  private exitWithError(err: unknown, emitJson: boolean): never {
    const { code, message } = this.describeError(err);
    if (emitJson) {
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

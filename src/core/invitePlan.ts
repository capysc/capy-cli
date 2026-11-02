/**
 * The route `capy invite <email>` will travel, computed before anything is
 * asked, and described again at the end of the run in `--json`.
 *
 * ONE function, for the reason `branchCreatePlan` gives: the array a headless
 * caller parses has to be the same object whatever built it.
 *
 * An explicit flag settles a stop before the run starts, an existing
 * membership settles the next ones, and a headless run with a blank remaining
 * falls back or refuses rather than guessing. Every settled stop is `done`
 * carrying WHAT settled it — never `skipped`, because the plan resolved it
 * rather than dropping it.
 *
 * THE EXPIRY STOP IS AN ADDITION, NOT A PORT. `capy invite` has exactly two
 * prompts, role and projects. `resolveNotAfter` reads `--expires`, then
 * `--ttl`, then `CAPY_INVITE_TTL_SECONDS`, then a 7-day default, and it NEVER
 * asks — so the stop is settled before the command starts and the plan says
 * which of those four settled it. The env override and the service's 30-day cap
 * both change how long a code stays redeemable without saying so anywhere, and
 * an invite that outlives its purpose is a key left in a door.
 */
import type { InviteTeammateStop } from '../ui/screens/contract';

/**
 * Roles that reach every project in the organization.
 *
 * The same test `inviteCommand` makes before it asks about projects at all
 * (`role === 'project-admin' || role === 'member'`), written once so the rail
 * and the questions cannot disagree about whether a run has a project stop.
 */
const ORG_WIDE_ROLES: ReadonlySet<string> = new Set(['admin', 'owner', 'org-admin']);

/** Whether an invite with this role has to name projects. */
export const roleNeedsProjects = (role: string): boolean => !ORG_WIDE_ROLES.has(role);

/**
 * An answer the run already holds, and where it came from.
 *
 * `flag`, when present, is the literal text the caller could find in their own
 * shell history, or the state that stood in for one.
 */
export interface SettledAnswer {
  value: string;
  flag?: string;
}

export interface InvitePlanInput {
  /** `--role`, or an inherited membership role. */
  role?: SettledAnswer;
  /**
   * Project NAMES this invite will grant, once something settled them.
   *
   * `note` replaces the stop's description on a finished run that did not get
   * everything it asked for. `names` is a claim about what this invite GRANTED,
   * so a project the fan-out could not assign never appears in it — and a stop
   * that quietly lists fewer projects than the run set out to grant would be
   * hiding the failure rather than reporting it.
   */
  projects?: { names: string[]; flag?: string; note?: string };
  /** `--expires` / `--ttl`. */
  expiry?: SettledAnswer;
  /** `CAPY_INVITE_TTL_SECONDS` rendered in `--ttl`'s own vocabulary, when set. */
  envTtl?: string;
  /** What `resolveNotAfter` would use with no flag at all: `12h`, or the env's. */
  defaultTtl: string;
}

const LABEL: Record<string, string> = {
  role: 'Role',
  projects: 'Projects',
  expiry: 'Expiry',
  code: 'Code',
};

/**
 * What happens at each station.
 *
 * The CLI's own `--role` / `--project` / `--ttl` help text, verbatim, because
 * two wordings for one thing is a bug in the product.
 */
const DETAIL: Record<string, string> = {
  role: 'invitee role: member | project-admin | admin',
  projects: 'grant project access',
  expiry: 'invite lifetime, max 12h, e.g. 30m, 2h, 12h',
  code: 'the redeem code, shown once',
};

const stop = (
  id: string,
  state: InviteTeammateStop['state'],
  extra: Partial<InviteTeammateStop> = {},
): InviteTeammateStop => ({ id, label: LABEL[id], state, detail: DETAIL[id], ...extra });

const settled = (id: string, a: SettledAnswer): InviteTeammateStop =>
  stop(id, 'done', { answer: a.value, ...(a.flag ? { flag: a.flag } : {}) });

/** Which source settled a lifetime nobody was asked about. */
function unpromptedExpiry(input: InvitePlanInput): SettledAnswer {
  // Not flags, but naming what decided is still the honest answer to "why was I
  // never asked?" — the same judgement `branchCreatePlan` makes when it marks a
  // positional as `argument`.
  if (input.envTtl) return { value: input.envTtl, flag: 'CAPY_INVITE_TTL_SECONDS' };
  return { value: input.defaultTtl, flag: 'default' };
}

function roleStop(input: InvitePlanInput): InviteTeammateStop {
  return input.role ? settled('role', input.role) : stop('role', 'upcoming');
}

function projectsStop(input: InvitePlanInput): InviteTeammateStop {
  // An org-wide role never visits the project stop, and saying so up front is
  // the point of declaring the whole route rather than dropping the station.
  // Until a role is settled there is no way to know, so the stop stands.
  if (input.role && !roleNeedsProjects(input.role.value)) {
    return stop('projects', 'skipped', { detail: 'not asked: this role reaches every project' });
  }
  if (input.projects && input.projects.names.length > 0) {
    const p = settled('projects', { value: input.projects.names.join(', '), flag: input.projects.flag });
    return input.projects.note ? { ...p, detail: input.projects.note } : p;
  }
  return stop('projects', 'upcoming');
}

export function invitePlan(input: InvitePlanInput): InviteTeammateStop[] {
  const stops = [
    roleStop(input),
    projectsStop(input),
    input.expiry ? settled('expiry', input.expiry) : settled('expiry', unpromptedExpiry(input)),
    stop('code', 'upcoming'),
  ];

  // Only the first unanswered station is where the traveller stands. Derived
  // here rather than set by each branch above, so a stop cannot be marked
  // `current` while an earlier one is still outstanding.
  const firstUpcoming = stops.findIndex((s) => s.state === 'upcoming');
  return stops.map((s, i) => (i === firstUpcoming ? { ...s, state: 'current' as const } : s));
}

// ---------------------------------------------------------------------------
// The TTL vocabulary
// ---------------------------------------------------------------------------

/**
 * Parse `--ttl`'s grammar — `30s` / `10m` / `2h` / `12h`, or bare seconds — to
 * milliseconds.
 *
 * Pure, and returns null rather than exiting. The command's `--ttl`
 * validation calls this and keeps its exit.
 */
export function parseTtl(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[(m[2] || 's').toLowerCase()]!;
  return n * mult;
}

/**
 * Milliseconds back into `--ttl`'s own vocabulary.
 *
 * Used to say what `CAPY_INVITE_TTL_SECONDS` is worth in the units the flag
 * takes, so "why does this invite last an hour" is answered with something the
 * reader could type back.
 */
export function formatTtl(ms: number): string {
  if (ms % 86400000 === 0) return `${ms / 86400000}d`;
  if (ms % 3600000 === 0) return `${ms / 3600000}h`;
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  return `${Math.round(ms / 1000)}s`;
}

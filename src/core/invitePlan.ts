/**
 * The route `capy invite <email>` will travel, computed before anything opens.
 *
 * ONE function, for the reason `branchCreatePlan` gives: the rail a person
 * reads and the array a headless caller parses have to be the same object, and
 * two builders — one for the page, one for `--json` — would make that a promise
 * nobody could keep past the first divergence.
 *
 * The precedence is §8.2's, and it is why a stop can arrive already answered:
 * an explicit flag settles a stop before the run starts, an existing membership
 * settles the next ones, the browser is asked about whatever is left, and a
 * headless run with a blank remaining falls back or refuses rather than
 * guessing. Every settled stop is `done` carrying WHAT settled it — never
 * `skipped`, because the plan resolved it rather than dropping it, and `Role ·
 * admin` with no marker is indistinguishable from a question the user answered
 * two seconds ago. An answer the browser gave carries no marker precisely
 * because there is nothing to explain: the user was there.
 *
 * THE EXPIRY STOP IS AN ADDITION, NOT A PORT. `capy invite` has exactly two
 * prompts, role and projects. `resolveNotAfter` reads `--expires`, then
 * `--ttl`, then `CAPY_INVITE_TTL_SECONDS`, then a 7-day default, and it NEVER
 * asks — so on a terminal run the stop is settled before the command starts and
 * the rail says which of those four settled it. That is the point of drawing
 * it: the env override and the service's 30-day cap both change how long a code
 * stays redeemable without saying so anywhere, and an invite that outlives its
 * purpose is a key left in a door. Under `--web`, where there IS somewhere to
 * ask, it becomes a question. `contract.ts`'s `InviteStop` sanctions both: "A
 * CLI implementing this contract may serve it or skip it; skipping it is not a
 * regression."
 */
import type { InviteTeammateStop } from '../ui/screens/contract';
import type { MemberProject } from '../service/serviceClient';

/**
 * A project a member actually holds a role on. Narrower than `MemberProject`
 * so a merely-visible project cannot reach anything that grants access —
 * `heldProjects` is the only way to obtain one.
 */
export interface HeldMemberProject extends MemberProject {
  role: NonNullable<MemberProject['role']>;
}

/**
 * The subset of a member's projects they genuinely have access to.
 *
 * `member.projects` is EVERY project in the organization, annotated with this
 * member's role — or with no role at all, meaning the project is merely
 * visible to them, not theirs. Reading that array directly in order to
 * reproduce someone's existing access therefore inherits the whole org, which
 * is how a plain re-issue came to grant projects nobody asked to hand over.
 * Everything that reproduces or describes existing access goes through here.
 *
 * Sibling of `grantedProjects` below, and deliberately not the same question:
 * this reads what a member HOLDS; that decides what an invite will GRANT.
 */
export function heldProjects(
  member: { projects?: MemberProject[] } | null | undefined,
): readonly HeldMemberProject[] {
  return (member?.projects ?? []).filter((p): p is HeldMemberProject => p.role != null);
}

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
 * Which projects an invite ends up granting.
 *
 * A function rather than three lines at the call site, because two of the three
 * cases are quiet failures. `--project` SETTLES the projects stop, so a `--web`
 * run never serves that step and the browser's answer comes back empty —
 * reading that emptiness as "no projects" is how `capy invite bob --project
 * storefront --web` grants nothing at all and says it succeeded. And an
 * org-wide role takes none whatever a flag said, which the terminal path
 * achieves by never entering its project block; here it has to be said.
 */
export function grantedProjects(
  role: string,
  answeredInBrowser: string[],
  fromProjectFlag: string[],
): string[] {
  if (!roleNeedsProjects(role)) return [];
  return answeredInBrowser.length > 0 ? answeredInBrowser : fromProjectFlag;
}

/**
 * An answer the run already holds, and where it came from.
 *
 * `flag` absent means nobody has to be told why they were not asked — the
 * browser asked, and they answered. Present, it is the literal text the caller
 * could find in their own shell history, or the state that stood in for one.
 */
export interface SettledAnswer {
  value: string;
  flag?: string;
}

export interface InvitePlanInput {
  /** `--role`, an inherited membership role, or a role the browser answered. */
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
  /** `--expires` / `--ttl`, or a lifetime the browser answered. */
  expiry?: SettledAnswer;
  /** `CAPY_INVITE_TTL_SECONDS` rendered in `--ttl`'s own vocabulary, when set. */
  envTtl?: string;
  /** What `resolveNotAfter` would use with no flag at all: `7d`, or the env's. */
  defaultTtl: string;
  /**
   * Whether this run has anywhere to ask about expiry.
   *
   * False for every terminal run — `resolveNotAfter` does not prompt — so the
   * stop arrives `done`, marked with whichever source settled it. True only
   * under `--web`, where a browser can hold the question.
   */
  canAskExpiry: boolean;
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
  expiry: 'invite lifetime, e.g. 30m, 24h, 7d',
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

export function invitePlan(input: InvitePlanInput): InviteTeammateStop[] {
  const stops: InviteTeammateStop[] = [];

  stops.push(input.role ? settled('role', input.role) : stop('role', 'upcoming'));

  // An org-wide role never visits the project stop, and saying so up front is
  // the point of declaring the whole route rather than dropping the station.
  // Until a role is settled there is no way to know, so the stop stands.
  if (input.role && !roleNeedsProjects(input.role.value)) {
    stops.push(stop('projects', 'skipped', { detail: 'not asked: this role reaches every project' }));
  } else if (input.projects && input.projects.names.length > 0) {
    const p = settled('projects', { value: input.projects.names.join(', '), flag: input.projects.flag });
    stops.push(input.projects.note ? { ...p, detail: input.projects.note } : p);
  } else {
    stops.push(stop('projects', 'upcoming'));
  }

  stops.push(
    input.expiry
      ? settled('expiry', input.expiry)
      : input.canAskExpiry
        ? stop('expiry', 'upcoming')
        : settled('expiry', unpromptedExpiry(input)),
  );

  stops.push(stop('code', 'upcoming'));

  // Only the first unanswered station is where the traveller stands. Derived
  // here rather than set by each branch above, so a stop cannot be marked
  // `current` while an earlier one is still outstanding.
  const first = stops.find((s) => s.state === 'upcoming');
  if (first) first.state = 'current';

  return stops;
}

/**
 * The stops this run still has to ask about.
 *
 * `code` is excluded because it is the terminus rather than a question — the
 * same way `create` is excluded from `unansweredStops`. A `skipped` stop is
 * excluded too: the plan decided this run never visits it, which is settled,
 * not outstanding. Anything left here is something no flag and no existing
 * membership answered, so a run with nowhere to ask has to fall back or refuse
 * rather than pick for the user.
 */
export function unansweredInviteStops(stops: InviteTeammateStop[]): string[] {
  return stops
    .filter((s) => s.id !== 'code' && s.state !== 'done' && s.state !== 'skipped')
    .map((s) => s.id);
}

// ---------------------------------------------------------------------------
// The TTL vocabulary
// ---------------------------------------------------------------------------

/**
 * Parse `--ttl`'s grammar — `30s` / `10m` / `24h` / `7d`, or bare seconds — to
 * milliseconds.
 *
 * Pure, and returns null rather than exiting, because the browser has to be
 * able to reject an answer without taking the process down with it. The
 * command's `--ttl` validation calls this and keeps its exit.
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

/**
 * A future instant in words: "in 7 days".
 *
 * `formatRelativeTime` only looks backwards ("3 days ago"); an expiry is always
 * ahead, and rendering it through that function is how a screen ends up telling
 * somebody their freshly minted code lapsed just now.
 */
export function formatRelativeFuture(atMs: number, now: number = Date.now()): string {
  const seconds = Math.floor((atMs - now) / 1000);
  if (seconds <= 0) return 'in the past';
  if (seconds < 60) return 'in under a minute';

  const unit = (n: number, word: string) => `in ${n} ${word}${n === 1 ? '' : 's'}`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return unit(minutes, 'minute');

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');

  return unit(Math.floor(hours / 24), 'day');
}

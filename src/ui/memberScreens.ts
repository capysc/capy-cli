// `capy invite` and `capy kick`, served as compiled screens.
//
// Three prompts between them, and one of the three is the most expensive
// question the CLI asks:
//
//   1. `capy invite <email>` asks `Select a role for <email>:` — a three-item
//      list whose entries are `Member` / `Project Admin` / `Admin`, display
//      labels that cannot be pasted into the `--role` flag they belong to and
//      that say nothing about what each one reaches. Under `--web` it is the
//      `invite-teammate` screen's role step, which shows the slug the flag
//      takes and one line of what it can do beside each.
//   2. `capy invite <email>` then asks `Grant <Role> access to which
//      projects?` — a checkbox list with the working directory's project
//      pre-ticked and no indication that that is why it is ticked. Under
//      `--web` the row says where the tick came from.
//   3. `capy kick <email>` asks one confirm, defaulting to No, with the entire
//      consequence compressed into the question itself. Under `--web` it is
//      `org-members`' `confirm-remove` view: what they lose and what removal
//      does NOT reach are two callouts ABOVE the button, and the button holds
//      until the address is typed back. A destructive action's consequence
//      never goes inside the control that performs it.
//
// The route is `invitePlan`'s array, not this file's and not the screen's. One
// builder feeds both `--json` and the payload, which is the only way the rail a
// person reads and the array an agent parses can be claimed to be the same.
//
// KEY MATERIAL. A redeem code carries a double-wrapped copy of the organization
// key: whoever holds it can join the org until it expires, exactly the way a
// recovery phrase can. So it travels CLI → page and never back. It is inlined
// into a display-only screen — `SCREEN_CSP` gives that page `connect-src
// 'none'`, so the document that renders it has no socket to send it down — it
// is never a wizard answer, and under `--web` it is never printed, because an
// agent shelling `capy` reads stdout.
import { runBrowserWizard } from './browserWizard';
import { withDeclineBridge, type DeclineBridge } from './declineBridge';
import { renderScreen, ScreenServer } from './screens/serve';
import {
  invitePlan,
  unansweredInviteStops,
  roleNeedsProjects,
  parseTtl,
  formatRelativeFuture,
  type InvitePlanInput,
} from '../core/invitePlan';
import type {
  ExistingMember,
  ExpiryPreset,
  GrantableRole,
  InviteProject,
  InviteStop,
  InviteTeammateData,
  IssuedInvite,
  OrgMember,
  OrgMembersData,
  OrgRole,
  ProjectRef,
} from './screens/contract';

/**
 * Strip terminal colour codes on the way into a payload.
 *
 * Applied to everything the CLI also PRINTS — the organization name it puts in
 * bold, a service error it echoes back — because a payload is not a terminal
 * and an escape renders as a literal `[90m` in the browser.
 *
 * Deliberately NOT applied to an email or a project id: those are identifiers
 * the answer comes back as and the command then acts on, so they have to
 * round-trip byte for byte. They are resolved against the list the server sent
 * instead, which no rewriting can defeat.
 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------
// invite-teammate
// ---------------------------------------------------------------------------

/**
 * What each role reaches, in one line.
 *
 * The CLI has no copy for this at all — its picker offers three display labels
 * and nothing else — so rather than invent a fourth vocabulary these are the
 * lines the `org-members` screen already uses for the same three roles. One
 * product, one description of what `admin` means.
 */
const ROLE_NOTES: Record<string, string> = {
  admin: 'Every project, every branch',
  'project-admin': 'Runs the projects you pick',
  member: 'Named projects, and protected branches you grant',
};

/**
 * The lifetimes offered without typing.
 *
 * `30m`, `24h` and `7d` are the CLI's own examples, lifted verbatim from
 * `--ttl <duration>`'s help — "invite lifetime, e.g. 30m, 24h, 7d (or
 * seconds)" — so the presets are the flag's documented vocabulary rather than
 * a second one invented for the page.
 */
const TTL_PRESETS = ['30m', '24h', '7d'] as const;

/** The service's ceiling. It clamps anything longer and tells nobody. */
const SERVER_CAP_DAYS = 30;

export interface WebInviteParams {
  /**
   * The address the redeem code is BOUND to.
   *
   * `innerWrap` lowercases into the HKDF salt (`${orgId}:${email.toLowerCase()}`),
   * so the lowercased address is the one that decides whether the code can ever
   * be redeemed — and it is therefore the one the page names. It does NOT trim,
   * and neither does this: a page that showed a trimmed address would be
   * claiming a binding the code does not have.
   */
  email: string;
  /** Argv as typed, when normalising changed it. */
  rawEmail?: string;
  orgName: string;
  callerEmail: string;
  callerRole: string;
  /** Already filtered by what this caller may grant. */
  grantableRoles: string[];
  /** Every project in the organization, cwd first, as the CLI orders them. */
  projects: Array<{ id: string; name: string; isCwd: boolean }>;
  /** The membership this address already has, when it has one. */
  existing?: {
    role: string;
    status: string;
    projects: ProjectRef[];
  };
  /** The plan input, so the rail is `invitePlan`'s and not a second one. */
  plan: InvitePlanInput;
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
  /** Test hook only: fixes `now` so every computed expiry is deterministic. */
  now?: Date;
}

/** What the browser answered. `cancelled` means no invite may be minted. */
export interface WebInviteResult {
  role: string;
  /** Ids, in the order the screen returned them. Empty for an org-wide role. */
  projectIds: string[];
  /** The chosen lifetime in `--ttl`'s vocabulary, when the browser asked. */
  ttl?: string;
  cancelled: boolean;
}

/** Answers folded forward as the wizard advances. */
export interface InviteAnswers {
  role?: string;
  projectIds?: string[];
  ttl?: string;
}

/**
 * How each question is answered without a browser.
 *
 * Two escapes rather than one, because the last stop has no safe headless form
 * and pretending otherwise would be the dangerous kind of helpful.
 */
function nonTtyEscapes(email: string): InviteTeammateData['nonTty'] {
  return {
    questions: {
      command: `capy invite ${email} --role member --project <name> --ttl 7d`,
      why: 'Off a TTY every question falls back rather than asking: the role becomes member, and the projects become whichever one you happen to be standing in. An invite scoped to the wrong project is a key handed to the wrong person, so name both.',
    },
    reveal: {
      command: `capy invite ${email} --json`,
      why: 'The code carries a double-wrapped copy of the organization key. That flag puts it on stdout, where your shell history, your scrollback and anything piping this command all keep a copy. This page is why it does not have to.',
    },
  };
}

/** The lifetimes, resolved to the absolute instants the CLI would bind them to. */
function expiryPresets(now: number): ExpiryPreset[] {
  return TTL_PRESETS.map((ttl) => {
    const at = now + parseTtl(ttl)!;
    return { ttl, expiresAtIso: new Date(at).toISOString(), relative: formatRelativeFuture(at, now) };
  });
}

/**
 * The instant a settled expiry names.
 *
 * A settled expiry is either `--ttl`'s grammar (a duration from now) or
 * `--expires`' (an absolute date), and the plan carries whichever the caller
 * typed. Resolving both here keeps the page from having to know which flag it
 * came from — and `resolveNotAfter` reads them in the same order.
 */
function expiryAt(value: string, now: number): number {
  const ttl = parseTtl(value);
  if (ttl !== null) return now + ttl;
  const absolute = Date.parse(value);
  return Number.isNaN(absolute) ? now : absolute;
}

const expiryIso = (value: string, now: number): string => new Date(expiryAt(value, now)).toISOString();
const expiryRelative = (value: string, now: number): string => formatRelativeFuture(expiryAt(value, now), now);

/** Which question this run is standing on, or null when nothing is left to ask. */
function currentStep(p: WebInviteParams, answered: InviteAnswers): InviteStop | null {
  const [next] = unansweredInviteStops(planFor(p, answered));
  if (next === 'role') return 'role';
  if (next === 'projects') return 'projects';
  if (next === 'expiry') return 'expiry';
  return null;
}

/**
 * The plan, folded forward with whatever the browser has answered so far.
 *
 * Recomputed from one builder on every render rather than mutated in place, so
 * the rail redraws itself and this file never decides what a stop's state is.
 *
 * `minted` closes the route. Once the code exists nothing is outstanding, and a
 * lifetime nobody was asked about was decided by `resolveNotAfter` — so the
 * stop is `done`, marked with the source that settled it, rather than `current`
 * on a run that has already finished. That is the difference between a rail and
 * a decoration: every state on it describes something the run did.
 */
function planFor(p: WebInviteParams, answered: InviteAnswers, minted = false): ReturnType<typeof invitePlan> {
  const names = (answered.projectIds ?? [])
    .map((id) => p.projects.find((x) => x.id === id)?.name)
    .filter((n): n is string => !!n);

  // An answer the browser gave carries no `flag`: nobody has to be told why
  // they were not asked about a question they just answered. Only what argv or
  // an existing membership settled arrives already marked, and that marking is
  // `p.plan`'s, made before this browser opened.
  return invitePlan({
    ...p.plan,
    canAskExpiry: p.plan.canAskExpiry && !minted,
    role: p.plan.role ?? (answered.role ? { value: answered.role } : undefined),
    projects: names.length > 0 ? { names } : p.plan.projects,
    expiry: p.plan.expiry ?? (answered.ttl ? { value: answered.ttl } : undefined),
  });
}

export function buildInviteData(
  p: WebInviteParams,
  nonce: string,
  answered: InviteAnswers = {},
  issued?: IssuedInvite,
): InviteTeammateData {
  const now = (p.now ?? new Date()).getTime();

  const grantableRoles: GrantableRole[] = p.grantableRoles.map((value) => ({
    value,
    note: ROLE_NOTES[value] ?? '',
    needsProjects: roleNeedsProjects(value),
  }));

  const projects: InviteProject[] = p.projects.map((x) => ({
    id: x.id,
    name: stripAnsi(x.name),
    isCwd: x.isCwd,
  }));

  const existing: ExistingMember | undefined = p.existing
    ? {
        role: p.existing.role,
        projects: p.existing.projects.map((x) => ({ id: x.id, name: stripAnsi(x.name) })),
        // The service's own word, not a re-spelling: the CLI fetches this field
        // and renders it nowhere, which is why re-inviting someone still
        // holding an unredeemed code looks like a first invite.
        status: p.existing.status,
      }
    : undefined;

  const stops = planFor(p, answered, !!issued);
  const step = issued ? 'code' : (currentStep(p, answered) ?? 'code');

  // The code page carries two things the CLI also PRINTS — the names of the
  // projects this invite granted, and the service's own message for each one it
  // could not — and a payload is not a terminal. `\x1b[90m` renders in a
  // browser as the literal `[90m`, so the same stripping the org name gets
  // applies here rather than only on the way to stdout.
  const cleaned: IssuedInvite | undefined = issued
    ? {
        ...issued,
        grantedProjects: issued.grantedProjects.map((x) => ({ id: x.id, name: stripAnsi(x.name) })),
        assignmentFailures: issued.assignmentFailures.map((f) => ({
          project: { id: f.project.id, name: stripAnsi(f.project.name) },
          error: stripAnsi(f.error),
        })),
      }
    : undefined;

  return {
    nonce,
    inviteeEmail: p.email,
    ...(p.rawEmail && p.rawEmail !== p.email ? { rawInviteeEmail: p.rawEmail } : {}),
    orgName: stripAnsi(p.orgName),
    callerEmail: p.callerEmail,
    callerRole: p.callerRole,
    grantableRoles,
    // The CLI's own `default: 'member'`, carried rather than restated.
    defaultRole: 'member',
    projects,
    ...(existing ? { existing } : {}),
    expiry: {
      presets: expiryPresets(now),
      defaultTtl: p.plan.defaultTtl,
      ...(p.plan.envTtl ? { envOverrideTtl: p.plan.envTtl } : {}),
      serverCapDays: SERVER_CAP_DAYS,
    },
    // What each control opens on. Only answers this run actually holds — never
    // a default dressed up as one, which is how a rail ends up reporting `Role
    // member` for a run nobody was asked about.
    resolved: {
      ...(p.plan.role?.value ?? answered.role
        ? { role: p.plan.role?.value ?? answered.role }
        : {}),
      ...(answered.projectIds
        ? { projectIds: answered.projectIds }
        : p.existing && p.existing.projects.length > 0
          ? { projectIds: p.existing.projects.map((x) => x.id) }
          : {}),
      ...(p.plan.expiry
        ? {
            expiry: {
              ttl: p.plan.expiry.value,
              expiresAtIso: expiryIso(p.plan.expiry.value, now),
              relative: expiryRelative(p.plan.expiry.value, now),
            },
          }
        : {}),
    },
    ...(cleaned ? { issued: cleaned } : {}),
    stops,
    step,
    nonTty: nonTtyEscapes(p.email),
  };
}

/**
 * Ask whatever the plan left outstanding, in the browser.
 *
 * Only the QUESTION stops are served here. The code stop is a whole page the
 * CLI cannot ask anything on — see `serveInviteCode` — and it does not exist
 * yet at this point in the run anyway: the lifetime chosen on the last stop is
 * bound into the KMS wrap, so the code cannot be minted until this resolves.
 */
export async function askInviteInBrowser(p: WebInviteParams): Promise<WebInviteResult> {
  // The nonce is minted inside `runBrowserWizard` and reaches a caller only
  // through `renderFirst`. A second standalone step has to be rendered with
  // that same token, so it is captured on the way past rather than each flow
  // minting its own — which would put the security token of every browser path
  // in the hands of each path instead of in one place.
  let nonce = '';
  let answered: InviteAnswers = {};
  const render = (): string => renderScreen('invite-teammate', buildInviteData(p, nonce, answered));

  const out = await runBrowserWizard(
    {
      title: `Invite ${p.email} — ${p.orgName}`,
      // Rendered per-request so the nonce the page echoes is the one this
      // server minted. `standalone` because a compiled screen is a whole
      // document and cannot be dropped into the wizard shell.
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Answered — minting the invite.',
      renderFirst: (n) => {
        nonce = n;
        return render();
      },
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { role: '', projectIds: [], cancelled: true } };
      }

      const step = currentStep(p, answered);

      if (step === 'role') {
        const role = typeof payload.role === 'string' ? payload.role : '';
        if (!p.grantableRoles.includes(role)) {
          // The screen offers only what this caller may grant, so anything else
          // is a malformed submit rather than a user mistake. The wording is
          // the CLI's own refusal, which says the same thing at the same point.
          return {
            error: `Your role (${p.callerRole}) can't grant "${role}". Allowed: ${p.grantableRoles.join(', ')}.`,
          };
        }
        answered = { ...answered, role };
      } else if (step === 'projects') {
        const raw = Array.isArray(payload.projectIds) ? payload.projectIds : null;
        if (!raw) return { error: 'That is not an answer the projects step can produce.' };
        const ids = raw.filter((id): id is string => typeof id === 'string' && p.projects.some((x) => x.id === id));
        if (ids.length !== raw.length) {
          // A project id the screen never offered did not come from the screen,
          // and granting access to a project nobody named is the failure this
          // refusal exists to prevent.
          return { error: 'That project is not in this organization.' };
        }
        if (ids.length === 0) {
          // The screen holds its button until at least one is ticked, and the
          // CLI's own checkbox validator says the same sentence.
          return { error: 'Pick at least one project' };
        }
        answered = { ...answered, projectIds: ids };
      } else if (step === 'expiry') {
        const ttl = typeof payload.ttl === 'string' ? payload.ttl : '';
        if (parseTtl(ttl) === null) {
          // `--ttl`'s own refusal, verbatim, so the flag and the page reject an
          // unparseable lifetime with one sentence rather than two.
          return { error: `Invalid --ttl "${ttl}". Use e.g. 30m, 24h, 7d, or a number of seconds.` };
        }
        answered = { ...answered, ttl };
      } else {
        // Nothing was outstanding, so no screen asked this. Refusing keeps a
        // stray submit from minting a key nobody was asked about.
        return { error: 'There is nothing left to answer on this run.' };
      }

      if (currentStep(p, answered) === null) {
        return {
          done: true,
          result: {
            role: (p.plan.role?.value ?? answered.role)!,
            projectIds: answered.projectIds ?? [],
            ttl: answered.ttl,
            cancelled: false,
          },
        };
      }
      // A whole document cannot be spliced into the open page, so it is handed
      // back as `standalone` and the browser reloads to receive it.
      return { screen: { html: render(), standalone: true } };
    },
  );
  return out as WebInviteResult;
}

/**
 * Show the minted code, on a page that cannot send it anywhere.
 *
 * A second server, not a fourth wizard step, and the screen is the reason: the
 * `code` view of `invite-teammate` is a Page, not a Wizard — it has no form, no
 * submit and no cancel, because a code is something you are handed rather than
 * something you answer. A wizard step that can never be answered is a CLI that
 * never returns.
 *
 * `ScreenServer` is the right vehicle for exactly that: single-use tokenised
 * URL, 127.0.0.1 only, closes itself the moment it has served, and the strict
 * `SCREEN_CSP` — `connect-src 'none'` — so the one document in this flow that
 * holds key material is also the one document with no way to open a socket.
 */
export async function serveInviteCode(
  p: WebInviteParams,
  issued: IssuedInvite,
  answered: InviteAnswers,
  opts: { open?: boolean; timeoutMs?: number } = {},
): Promise<{ url: string; close: () => void }> {
  const server = new ScreenServer(
    'invite-teammate',
    // The nonce is inert here: the page has nothing to post it back with. It is
    // still filled rather than left blank, because a payload field that is
    // sometimes a token and sometimes an empty string is a field nobody can
    // reason about at the point it matters.
    buildInviteData(p, 'display-only', answered, issued),
    { timeoutMs: opts.timeoutMs ?? 120_000 },
  );
  const url = await server.start();
  if (opts.open) {
    const { openScreen } = await import('./openScreen');
    const { SCREEN_WIDE } = await import('./screens/generated');
    await openScreen(url, { kind: 'dialog', wide: SCREEN_WIDE['invite-teammate'] });
  }
  return { url, close: () => server.close() };
}

// ---------------------------------------------------------------------------
// org-members · confirm-remove
// ---------------------------------------------------------------------------

export interface WebKickParams {
  orgName: string;
  /** The signed-in caller, so removing yourself is visible as that. */
  callerRole: string;
  currentUserId: string;
  /** The one membership this command is about. */
  member: {
    membershipId: string;
    userId: string;
    email: string;
    role: string;
    status: string;
    createdAt?: string;
    projects: Array<{ id: string; name: string; role?: 'project-admin' | 'member' }>;
  };
  open?: boolean;
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/** Roles that hold every branch of every project. */
const ALL_ACCESS_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'org-admin']);

export function buildKickData(p: WebKickParams, nonce: string): OrgMembersData {
  const m = p.member;

  const member: OrgMember = {
    membershipId: m.membershipId,
    userId: m.userId,
    email: m.email,
    role: m.role as OrgRole,
    // The service says `active` / `invited`; the screen's vocabulary is
    // `active` / `pending`. Mapped here rather than passed through, because
    // an unrecognised status renders as no badge at all — which is exactly how
    // an unredeemed invite becomes invisible in the terminal today.
    status: m.status === 'active' ? 'active' : 'pending',
    createdAt: m.createdAt ?? null,
    hasAllAccess: ALL_ACCESS_ROLES.has(m.role),
    projects: m.projects.map((x) => ({
      id: x.id,
      name: stripAnsi(x.name),
      role: x.role ?? null,
      // `capy kick` never reads branch grants — it deletes the membership, and
      // every grant under it goes with it. An empty list is the honest answer;
      // a fabricated one would draw toggles this command cannot honour.
      branches: [],
    })),
  };

  return {
    nonce,
    orgName: stripAnsi(p.orgName),
    callerRole: p.callerRole as OrgRole,
    currentUserId: p.currentUserId,
    // `capy kick` has exactly one verb. It grants no role, so the role menu on
    // this screen has nothing to offer and the list view is a roster to read.
    assignableRoles: [],
    allProjects: [],
    members: [member],
    view: 'confirm-remove',
    subjectUserId: m.userId,
    nonTty: {
      command: 'capy users --json',
      why: 'Reading the roster changes nothing, so it needs no browser and no confirmation.',
    },
    removeNonTty: {
      command: `capy kick ${m.email}`,
      why: 'There is no flag that says yes. Removal is confirmed by typing the address back — here, or at the terminal prompt — so a run with nowhere to ask leaves the membership alone rather than assuming.',
    },
  };
}

/**
 * The "no" this screen has no way to send.
 *
 * `confirm-remove` offers two controls. The destructive one POSTs. The decline
 * — `Keep them`, which is the answer the terminal DEFAULTS to — is CLIENT-SIDE
 * ONLY: it clears the field and flips the view back to the roster, and the CLI
 * is never told. Driven in a real browser, the run is still pending 1.5s after
 * that click and ends on the wizard's five-minute timeout, on a page that has
 * nothing left to answer with. A flow whose most common ending cannot be
 * reached is not a flow, and "the user waited five minutes" is not a refusal
 * anyone should have to perform.
 *
 * The real fix is the screen's and is reported as such: `confirm-remove`'s
 * decline should POST `{__action:'cancel'}`, exactly the way the same package's
 * `Wizard` cancel already does — which is why `capy invite`'s Cancel needs
 * nothing here.
 *
 * The bridge itself is `src/ui/declineBridge.ts`: the same defect turned up on
 * `deploy-targets`' `confirm-remove` and `deploy-tokens`' `confirm-revoke`, and
 * three copies of a script that answers for the user would be three ways for a
 * page to say no. What it watches here is `button.danger` — the only control on
 * this view that can answer the question, by its design-system variant and
 * never by its label.
 */
const kickDeclineBridge = (nonce: string, stillAMember: string): DeclineBridge => ({
  nonce,
  question: 'button.danger',
  headline: 'Cancelled — nothing was changed.',
  detail: stillAMember,
});

/**
 * Serve the removal confirm and wait for it.
 *
 * Returns false for every ending that is not an explicit confirmation:
 * cancelled, declined, closed, timed out, interrupted. That is not defensive
 * coding — a step nobody answered has not been approved, and the one thing this
 * flow must never do is read a closed window as agreement to cut somebody off
 * from every secret in the organization.
 */
export async function confirmKickInBrowser(p: WebKickParams): Promise<boolean> {
  const out = await runBrowserWizard(
    {
      title: `Remove ${p.member.email} — ${p.orgName}`,
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Removed — back to your terminal.',
      renderFirst: (nonce) =>
        withDeclineBridge(
          renderScreen('org-members', buildKickData(p, nonce)),
          kickDeclineBridge(
            nonce,
            `${stripAnsi(p.member.email)} is still a member of ${stripAnsi(p.orgName)}.`,
          ),
        ),
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') return { done: true, result: false };
      if (payload.__action === 'apply') {
        // The list view can queue role and grant edits. `capy kick` cannot
        // apply one — it holds a single DELETE — so applying a batch here
        // would mean reporting changes the command never made.
        return { error: 'capy kick only removes a member. Change roles and grants with capy users.' };
      }
      if (payload.action !== 'remove') {
        return { error: 'That is not an action this screen offers.' };
      }
      // Resolved against the membership the CLI already found, never trusted:
      // the id in this payload is what a DELETE is about to be aimed at.
      if (payload.membershipId !== p.member.membershipId) {
        return { error: 'That is not the member this command is about.' };
      }
      return { done: true, result: true };
    },
  );
  return out === true;
}

// The Users tab of `capy projects`: who is in the project and with what role,
// and the dialogs that change it — invite by email, change a role, remove from
// the project. Pure: `usersDialogKey` is a reducer over the dialog, and
// `renderUsersDialog` a function of it. `projectsScreen.ts` wires them in; the
// side effects live in `commands/projectUsersActions.ts`.
//
// Locked rows: the org owner (nobody changes the owner's role), org admins
// (their role is org-wide: it is changed in `capy users`, not from inside one
// project), and the caller (the service refuses a change to your own role).
// The service enforces every rule again; a refusal is shown in its words.

import type { MemberDetail } from '../service/serviceClient';
import { INVITE_ROLE_LABELS, inviteRoleAbout, type InviteRole } from '../core/inviteRoles';

const ESC = '\x1b';
const INVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const BOLD = `${ESC}[1m`;
const GREEN = `${ESC}[32m`;
const CYAN = `${ESC}[36m`;

const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const KEY_ESC = ESC;
const KEY_ESC_ESC = `${ESC}${ESC}`;
const KEY_CTRL_C = '\x03';
const KEY_ENTER = '\r';
const KEY_BACKSPACE = '\x7f';
const KEY_BACKSPACE2 = '\b';

// ── Rows ──────────────────────────────────────────────────────────────────────

/** Why a row's role cannot be changed from this tab. */
export type UserLock = 'owner' | 'admin' | 'self';

export interface ProjectUserRow {
  readonly userId: string;
  readonly email: string;
  /** Their project role, or their org role when it reaches every project (owner, admin). */
  readonly role: string;
  readonly lock: UserLock | null;
}

/** Org roles that reach every project (the service's own role values). */
export const ORG_WIDE_ROLES: readonly string[] = ['owner', 'admin'];

/** Why `member`'s row is locked, if it is. */
function lockOf(member: MemberDetail, selfUserId: string | null): UserLock | null {
  if (member.role === 'owner') return 'owner';
  if (member.role === 'admin') return 'admin';
  if (selfUserId !== null && member.userId === selfUserId) return 'self';
  return null;
}

/**
 * The project's users: everyone with a role in this project (their project
 * role), plus the org's owners and admins, who reach every project (their org
 * role).
 */
export function projectUserRows(members: readonly MemberDetail[], projectId: string, selfUserId: string | null = null): readonly ProjectUserRow[] {
  return members.flatMap((m) => {
    const membership = m.projects.find((p) => p.id === projectId);
    const orgWide = ORG_WIDE_ROLES.includes(m.role);
    if (membership === undefined && !orgWide) return [];
    const role = orgWide || membership === undefined ? m.role : membership.role ?? m.role;
    return [{ userId: m.userId, email: m.email, role, lock: lockOf(m, selfUserId) }];
  });
}

/** What a locked row says when Enter is pressed on it. */
export const LOCK_TEXT: Readonly<Record<UserLock, string>> = {
  owner: "The owner's role cannot be changed", // reused from `capy users`
  admin: "An admin's role applies to every project. Change it with `capy users`.", // COPY-FLAG
  self: 'You cannot change your own role.', // COPY-FLAG
};

// ── Dialogs ───────────────────────────────────────────────────────────────────

export interface UsersProjectRef {
  readonly id: string;
  readonly name: string;
}

export interface UserTarget {
  readonly userId: string;
  readonly email: string;
}

/** The roles a project grants (the service's own values). */
export type ProjectRole = 'member' | 'project-admin';

/** Names as `capy invite` shows them. */
export const PROJECT_ROLE_LABELS: Readonly<Record<ProjectRole, string>> = {
  member: 'Member',
  'project-admin': 'Project Admin',
};

type RoleChoice = ProjectRole | 'remove';
/** What an invite offers: the project's roles, and `admin` (org-wide) for a caller who may grant it. */
const PROJECT_INVITE_CHOICES: readonly InviteRole[] = ['member', 'project-admin'];
const ADMIN_INVITE_CHOICES: readonly InviteRole[] = [...PROJECT_INVITE_CHOICES, 'admin'];
export const inviteChoices = (canInviteAdmin: boolean): readonly InviteRole[] => (canInviteAdmin ? ADMIN_INVITE_CHOICES : PROJECT_INVITE_CHOICES);
const CHANGE_CHOICES: readonly RoleChoice[] = ['member', 'project-admin', 'remove'];
const REMOVE_LABEL = 'Remove from project'; // COPY-FLAG

function choiceLabel(choice: RoleChoice): string {
  return choice === 'remove' ? REMOVE_LABEL : PROJECT_ROLE_LABELS[choice];
}

/** A coded refusal, in the service's words. */
export interface UsersRefusal {
  readonly code: string;
  readonly message: string;
}

export type UsersDialog =
  | { readonly step: 'email'; readonly project: UsersProjectRef; readonly email: string; readonly error: string | null }
  | { readonly step: 'inviteRole'; readonly project: UsersProjectRef; readonly email: string; readonly choice: number; readonly choices: readonly InviteRole[] }
  | { readonly step: 'changeRole'; readonly project: UsersProjectRef; readonly target: UserTarget; readonly current: string; readonly choice: number }
  | { readonly step: 'confirmRemove'; readonly project: UsersProjectRef; readonly target: UserTarget }
  | { readonly step: 'working'; readonly project: UsersProjectRef; readonly label: string }
  | { readonly step: 'invited'; readonly project: UsersProjectRef; readonly lines: readonly string[]; readonly command: string; readonly copied: boolean | null }
  | { readonly step: 'refused'; readonly project: UsersProjectRef; readonly refusal: UsersRefusal };

export type UsersEffect =
  | { readonly type: 'projectUserInvite'; readonly project: UsersProjectRef; readonly email: string; readonly role: InviteRole }
  | { readonly type: 'projectUserRole'; readonly project: UsersProjectRef; readonly target: UserTarget; readonly role: ProjectRole }
  | { readonly type: 'projectUserRemove'; readonly project: UsersProjectRef; readonly target: UserTarget }
  | { readonly type: 'projectUserCopy'; readonly text: string };

/** What an invite, role change or removal came back with. `members`: the org's users read again (`null` when that read failed). */
export type UsersFinished =
  | {
      readonly ok: true;
      readonly lines: readonly string[];
      readonly members: readonly MemberDetail[] | null;
      /** A new person was invited: the command to send them. */
      readonly redeemCommand?: string;
    }
  | { readonly ok: false; readonly refusal: UsersRefusal };

export interface UsersStep {
  readonly dialog: UsersDialog | null;
  readonly effect: UsersEffect | null;
  /** Lines for the screen's notes (shown until the next key). */
  readonly notes: readonly string[];
}

export const USERS_CANCELLED_TEXT = 'Cancelled.'; // reused from `capy project delete`
export const USERS_DRY_RUN_TEXT = 'Dry run: nothing was changed.'; // COPY-FLAG

const stay = (dialog: UsersDialog | null, notes: readonly string[] = []): UsersStep => ({ dialog, effect: null, notes });

export function startInvite(project: UsersProjectRef): UsersDialog {
  return { step: 'email', project, email: '', error: null };
}

/** Enter on a row: its role choices, or why it is locked. */
export function startChange(project: UsersProjectRef, row: ProjectUserRow): UsersStep {
  if (row.lock !== null) return stay(null, [LOCK_TEXT[row.lock]]);
  const current = CHANGE_CHOICES.indexOf(row.role as RoleChoice);
  return stay({
    step: 'changeRole',
    project,
    target: { userId: row.userId, email: row.email },
    current: row.role,
    choice: Math.max(0, current),
  });
}

function isEsc(key: string): boolean {
  return key === KEY_ESC || key === KEY_ESC_ESC || key === KEY_CTRL_C;
}

function step(choice: number, count: number, key: string): number {
  if (key === KEY_UP) return (choice - 1 + count) % count;
  if (key === KEY_DOWN) return (choice + 1) % count;
  return choice;
}

/** A plausible address: something@something. The service is the judge of the rest. */
function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(email);
}

/** The email typed: refused here when it is already in the project (or reaches every project). */
function submitEmail(dialog: Extract<UsersDialog, { step: 'email' }>, rows: readonly ProjectUserRow[], canInviteAdmin: boolean): UsersStep {
  const email = dialog.email.trim().toLowerCase();
  if (!looksLikeEmail(email)) return stay({ ...dialog, error: 'Enter an email address.' }); // COPY-FLAG
  const row = rows.find((r) => r.email.toLowerCase() === email);
  if (row !== undefined && row.lock !== null && row.lock !== 'self') return stay(null, [`${row.email} already reaches every project.`]); // COPY-FLAG
  if (row !== undefined) return stay(null, [`${row.email} is already in this project.`]); // COPY-FLAG
  return stay({ step: 'inviteRole', project: dialog.project, email, choice: 0, choices: inviteChoices(canInviteAdmin) });
}

function editEmail(dialog: Extract<UsersDialog, { step: 'email' }>, key: string): UsersStep {
  if (key === KEY_BACKSPACE || key === KEY_BACKSPACE2) return stay({ ...dialog, email: dialog.email.slice(0, -1), error: null });
  // Printable characters only (a paste arrives as one string of them).
  const printable = Array.from(key).every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f);
  return printable ? stay({ ...dialog, email: dialog.email + key, error: null }) : stay(dialog);
}

/** Starts `effect`, unless this is a dry run: then nothing is sent, and the screen says so. */
function send(project: UsersProjectRef, label: string, effect: UsersEffect, dryRun: boolean): UsersStep {
  if (dryRun) return stay(null, [USERS_DRY_RUN_TEXT]);
  return { dialog: { step: 'working', project, label }, effect, notes: [] };
}

/** Pure reducer over an open dialog. `rows`: the project's users now. */
export function usersDialogKey(
  dialog: UsersDialog,
  key: string,
  /** `canInviteAdmin`: the caller may invite an org admin (absent: no). */
  ctx: { readonly dryRun: boolean; readonly rows: readonly ProjectUserRow[]; readonly canInviteAdmin?: boolean },
): UsersStep {
  if (dialog.step === 'working') return stay(dialog);
  if (dialog.step === 'refused') return stay(null);
  if (dialog.step === 'invited') {
    if (key === 'c' || key === 'C') return { dialog, effect: { type: 'projectUserCopy', text: dialog.command }, notes: [] };
    return stay(null);
  }
  if (isEsc(key)) return stay(null, [USERS_CANCELLED_TEXT]);

  if (dialog.step === 'email') return key === KEY_ENTER ? submitEmail(dialog, ctx.rows, ctx.canInviteAdmin === true) : editEmail(dialog, key);

  if (dialog.step === 'inviteRole') {
    if (key !== KEY_ENTER) return stay({ ...dialog, choice: step(dialog.choice, dialog.choices.length, key) });
    const role = dialog.choices[dialog.choice];
    return send(dialog.project, `Inviting ${dialog.email}...`, { type: 'projectUserInvite', project: dialog.project, email: dialog.email, role }, ctx.dryRun); // COPY-FLAG
  }

  if (dialog.step === 'changeRole') {
    if (key !== KEY_ENTER) return stay({ ...dialog, choice: step(dialog.choice, CHANGE_CHOICES.length, key) });
    const choice = CHANGE_CHOICES[dialog.choice];
    if (choice === 'remove') return stay({ step: 'confirmRemove', project: dialog.project, target: dialog.target });
    // The role it already has: nothing to send.
    if (choice === dialog.current) return stay(null);
    return send(dialog.project, `Changing ${dialog.target.email}'s role...`, { type: 'projectUserRole', project: dialog.project, target: dialog.target, role: choice }, ctx.dryRun); // COPY-FLAG
  }

  // confirmRemove: No is the default, as in the delete question.
  if (key === 'y' || key === 'Y') {
    return send(dialog.project, `Removing ${dialog.target.email}...`, { type: 'projectUserRemove', project: dialog.project, target: dialog.target }, ctx.dryRun); // COPY-FLAG
  }
  if (key === 'n' || key === 'N' || key === KEY_ENTER) return stay(null, [USERS_CANCELLED_TEXT]);
  return stay(dialog);
}

/** The action came back: notes on success (or the redeem command to send), the refusal otherwise. Dropped unless a dialog is working. */
export function usersDialogDone(dialog: UsersDialog | null, finished: UsersFinished): UsersStep {
  if (dialog === null || dialog.step !== 'working') return stay(dialog);
  if (!finished.ok) return stay({ step: 'refused', project: dialog.project, refusal: finished.refusal });
  if (finished.redeemCommand !== undefined) {
    return stay({ step: 'invited', project: dialog.project, lines: finished.lines, command: finished.redeemCommand, copied: null });
  }
  return stay(null, finished.lines);
}

/** The copy of the redeem command finished. */
export function usersCopied(dialog: UsersDialog | null, ok: boolean): UsersDialog | null {
  return dialog !== null && dialog.step === 'invited' ? { ...dialog, copied: ok } : dialog;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

export const hint = (key: string, label: string): string => `${BOLD}${key}${RESET}${DIM} ${label}${RESET}`;
export const hints = (...parts: readonly string[]): string => parts.join(`${DIM} · ${RESET}`);

/** `text` cut into lines of at most `width` characters: a long command is wrapped, never clipped. */
function hardWrap(text: string, width: number): readonly string[] {
  const room = Math.max(1, width);
  return Array.from({ length: Math.max(1, Math.ceil(text.length / room)) }, (_, i) => text.slice(i * room, (i + 1) * room));
}

/** A question line as `capy invite`'s role prompt draws it (inquirer's select): green ?, bold message, dim arrow-key tip. */
export function promptLine(message: string, margin: string): string {
  return `${margin}${GREEN}?${RESET} ${BOLD}${message}${RESET} ${DIM}(Use arrow keys)${RESET}`; // inquirer's own tip
}

/** The choices as inquirer's select draws them: ❯ and cyan on the selected one, two spaces before the others. */
function choiceLines(choices: readonly RoleChoice[], selected: number, current: string | null, margin: string): readonly string[] {
  return choices.map((c, i) => {
    const marker = c === current ? ` ${DIM}(current)${RESET}` : ''; // COPY-FLAG: (current)
    return i === selected ? `${margin}${CYAN}❯ ${choiceLabel(c)}${RESET}${marker}` : `${margin}  ${choiceLabel(c)}${marker}`;
  });
}

/** The invite's roles as inquirer's select draws them, each with what it can access beside it. */
function inviteChoiceLines(choices: readonly InviteRole[], selected: number, margin: string): readonly string[] {
  return choices.map((role, i) => {
    const about = inviteRoleAbout(role);
    return i === selected ? `${margin}${CYAN}❯ ${INVITE_ROLE_LABELS[role]}${RESET}${about}` : `${margin}  ${INVITE_ROLE_LABELS[role]}${about}`;
  });
}

/** The dialog's lines, under the screen's title. `width`: the terminal's. */
export function renderUsersDialog(dialog: UsersDialog, width: number, margin: string): readonly string[] {
  const m = margin;
  if (dialog.step === 'email') {
    return [
      `${m}${BOLD}Invite a user to ${dialog.project.name}${RESET}`, // COPY-FLAG
      '',
      `${m}${DIM}Email:${RESET} ${dialog.email}${INVERSE} ${RESET}`, // COPY-FLAG
      ...(dialog.error === null ? [] : ['', `${m}${dialog.error}`]),
      '',
      m + hints(hint('enter', 'next'), hint('esc', 'cancel')), // COPY-FLAG
    ];
  }
  if (dialog.step === 'inviteRole') {
    return [
      promptLine(`Select a role for ${dialog.email}:`, m), // reused from `capy invite`
      ...inviteChoiceLines(dialog.choices, dialog.choice, m),
      '',
      m + hints(`${DIM}↑↓ choose${RESET}`, hint('enter', 'invite'), hint('esc', 'cancel')), // COPY-FLAG
    ];
  }
  if (dialog.step === 'changeRole') {
    return [
      promptLine(`Select a role for ${dialog.target.email}:`, m), // reused from `capy invite`
      ...choiceLines(CHANGE_CHOICES, dialog.choice, dialog.current, m),
      '',
      m + hints(`${DIM}↑↓ choose${RESET}`, hint('enter', 'select'), hint('esc', 'cancel')), // COPY-FLAG
    ];
  }
  if (dialog.step === 'confirmRemove') {
    return [
      `${m}${BOLD}Remove ${dialog.target.email} from ${dialog.project.name}?${RESET}`, // COPY-FLAG
      `${m}${DIM}They stay in the organization.${RESET}`, // COPY-FLAG
      '',
      m + hints(hint('y', 'yes'), hint('esc', 'no')),
    ];
  }
  if (dialog.step === 'working') return [`${m}${DIM}${dialog.label}${RESET}`];
  if (dialog.step === 'refused') return [`${m}${dialog.refusal.message}`, '', m + hint('esc', 'back')];
  const copied = dialog.copied === null ? [] : [`${m}${DIM}${dialog.copied ? 'Copied.' : 'Could not copy.'}${RESET}`]; // COPY-FLAG
  return [
    ...dialog.lines.map((l) => `${m}${l}`),
    '',
    `${m}Send them this command:`, // reused from `capy invite`
    '',
    // Wrapped, never clipped: the whole command has to be readable (and copyable with c).
    ...hardWrap(dialog.command, width - m.length * 2 - 2).map((l) => `${m}  ${BOLD}${l}${RESET}`),
    '',
    `${m}${DIM}This code is safe to share with your team member over email or your${RESET}`, // reused from `capy invite`
    `${m}${DIM}team messaging app. It can only be used by them.${RESET}`, // reused from `capy invite`
    ...copied,
    '',
    m + hints(hint('c', 'copy'), hint('esc', 'close')), // COPY-FLAG
  ];
}

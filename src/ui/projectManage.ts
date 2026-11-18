// The Settings and Capy Branches tabs of `capy projects`: what an admin does to
// one project besides its users. Pure: `manageKey` is a reducer over the open
// dialog and `renderManage` a function of it; `projectsScreen.ts` wires them in
// and `commands/projectManageActions.ts` performs the effects.
//
// Settings: the project id (Enter copies it), the live deploy tokens (Enter on
// one revokes it, after asking), and Delete project (`projectsScreen.ts`).
// Capy Branches: Enter on a branch offers Protect / Unprotect, Manage access (a
// protected branch: which members may read and write it) and Delete branch.
// `development` is neither protected nor deleted (the service refuses both).
// The service enforces every rule again; a refusal is shown in its words.

import type { MemberDetail } from '../service/serviceClient';
import { formatRelativeTime } from './relativeTime';
import { hint, hints, promptLine } from './projectUsers';

const ESC = '\x1b';
const INVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[90m`;
const BOLD = `${ESC}[1m`;
const CYAN = `${ESC}[36m`;

const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const KEY_ESC = ESC;
const KEY_ESC_ESC = `${ESC}${ESC}`;
const KEY_CTRL_C = '\x03';
const KEY_ENTER = '\r';
const KEY_BACKSPACE = '\x7f';
const KEY_BACKSPACE2 = '\b';

// ── Shared shapes ─────────────────────────────────────────────────────────────

export interface ManageProjectRef {
  readonly id: string;
  readonly name: string;
}

export interface BranchRef {
  readonly id: string;
  readonly name: string;
  readonly protected: boolean;
}

/** One repo link row of a project: a repo and the folder the project was seen in (`.`: the repo root). */
export interface RepoRowRef {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly path: string;
}

/** A row's identity: owner and name compare case-insensitively (as on GitHub and the service), the folder exactly. */
export const repoRowKey = (row: RepoRowRef): string => `${row.host.toLowerCase()}/${row.owner.toLowerCase()}/${row.name.toLowerCase()}\u0000${row.path}`;

/** The tag of a row whose folder holds the project's keep.lock on the remote. */
export const REMOTE_TAG = '[remote]';

/** `owner/name`, plus `/folder` when the row is not at the repo root. */
function repoRowLabel(row: RepoRowRef): string {
  return row.path === '.' ? `${row.owner}/${row.name}` : `${row.owner}/${row.name}/${row.path}`;
}

/** The branch every project has, which the service never protects or deletes. */
export const DEFAULT_BRANCH = 'development';

/** One live deploy token, as `capy deploy list` lists it. */
export interface TokenRow {
  readonly deployId: string;
  readonly label: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** A coded refusal, in the service's words. */
export interface ManageRefusal {
  readonly code: string;
  readonly message: string;
}

/** A member of the project who may be granted a protected branch (project admins and org admins reach every branch). */
export interface AccessRow {
  readonly userId: string;
  readonly email: string;
  readonly hasAccess: boolean;
}

/** The project's members (project role `member`) and whether each may use `branchId`. */
export function accessRows(members: readonly MemberDetail[], projectId: string, branchId: string): readonly AccessRow[] {
  return members.flatMap((m) => {
    const project = m.projects.find((p) => p.id === projectId);
    if (project === undefined || project.role !== 'member') return [];
    const branch = project.branches.find((b) => b.id === branchId);
    return [{ userId: m.userId, email: m.email, hasAccess: branch?.hasAccess === true }];
  });
}

// ── Settings rows ─────────────────────────────────────────────────────────────

export type SettingsRow = 'projectId' | 'tokens' | 'rename' | 'delete';
// Rename is last so the rows that were there keep their place.
export const SETTINGS_ROWS: readonly SettingsRow[] = ['projectId', 'tokens', 'delete', 'rename'];

export function settingsLabel(row: SettingsRow, projectId: string): string {
  if (row === 'projectId') return `Project ID  ${projectId}`; // COPY-FLAG
  if (row === 'tokens') return 'Deploy tokens'; // COPY-FLAG
  if (row === 'rename') return 'Rename project'; // COPY-FLAG
  return 'Delete project'; // COPY-FLAG
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

type BranchAction = 'protect' | 'access' | 'delete';

export type ManageDialog =
  | { readonly step: 'tokensLoading'; readonly project: ManageProjectRef }
  | { readonly step: 'tokens'; readonly project: ManageProjectRef; readonly tokens: readonly TokenRow[]; readonly cursor: number }
  | { readonly step: 'confirmRevoke'; readonly project: ManageProjectRef; readonly token: TokenRow; readonly back: ManageDialog }
  | { readonly step: 'branchMenu'; readonly project: ManageProjectRef; readonly branch: BranchRef; readonly choice: number }
  | { readonly step: 'confirmDeleteBranch'; readonly project: ManageProjectRef; readonly branch: BranchRef }
  | { readonly step: 'access'; readonly project: ManageProjectRef; readonly branch: BranchRef; readonly cursor: number }
  | { readonly step: 'confirmRemoveRepo'; readonly project: ManageProjectRef; readonly row: RepoRowRef }
  /** The new name being typed (it starts as the current one). `error`: why the last name was refused, in the refuser's words. */
  | { readonly step: 'rename'; readonly project: ManageProjectRef; readonly name: string; readonly error: string | null }
  | { readonly step: 'working'; readonly project: ManageProjectRef; readonly label: string; readonly back: ManageDialog | null }
  | { readonly step: 'refused'; readonly project: ManageProjectRef; readonly refusal: ManageRefusal };

export type ManageEffect =
  | { readonly type: 'projectIdCopy'; readonly text: string }
  | { readonly type: 'projectTokensLoad'; readonly project: ManageProjectRef }
  | { readonly type: 'projectTokenRevoke'; readonly project: ManageProjectRef; readonly token: TokenRow }
  | { readonly type: 'projectBranchProtect'; readonly project: ManageProjectRef; readonly branch: BranchRef; readonly protect: boolean }
  | { readonly type: 'projectBranchDelete'; readonly project: ManageProjectRef; readonly branch: BranchRef }
  | { readonly type: 'projectRepoRemove'; readonly project: ManageProjectRef; readonly row: RepoRowRef }
  | { readonly type: 'projectRename'; readonly project: ManageProjectRef; readonly name: string }
  /** Read from GitHub which of the project's rows hold its keep.lock on the remote (the `[remote]` tag). */
  | { readonly type: 'projectRepoRowsCheck'; readonly project: ManageProjectRef; readonly rows: readonly RepoRowRef[] }
  | { readonly type: 'projectBranchAccess'; readonly project: ManageProjectRef; readonly branch: BranchRef; readonly user: AccessRow; readonly grant: boolean };

/** What a change came back with: lines to show, and whatever was read again. */
export type ManageFinished =
  | {
      readonly ok: true;
      readonly lines: readonly string[];
      /** The project's live tokens, read again (a revoke). */
      readonly tokens?: readonly TokenRow[];
      /** The project's branches, read again (protect, delete). */
      readonly branches?: readonly BranchRef[];
      /** The org's users, read again (access). */
      readonly members?: readonly MemberDetail[];
      /** The project under its new name (a rename). */
      readonly renamed?: { readonly id: string; readonly name: string };
      /** The repo link row that is gone from the project (a row removal). */
      readonly removedRepoRow?: RepoRowRef;
    }
  | { readonly ok: false; readonly refusal: ManageRefusal };

export interface ManageStep {
  readonly dialog: ManageDialog | null;
  readonly effect: ManageEffect | null;
  readonly notes: readonly string[];
}

export const MANAGE_CANCELLED_TEXT = 'Cancelled.'; // reused from `capy project delete`
export const MANAGE_DRY_RUN_TEXT = 'Dry run: nothing was changed.'; // COPY-FLAG (same as the Users tab)
export const NO_TOKENS_TEXT = 'No live deploy tokens.'; // reused from `capy project delete`
export const RENAME_EMPTY_TEXT = 'Enter a name.'; // COPY-FLAG
export const LAST_REPO_LOCK_TEXT = 'The last repo of a project cannot be removed.'; // COPY-FLAG
export const DEFAULT_BRANCH_LOCK_TEXT = 'The default branch (development) cannot be protected or deleted.'; // COPY-FLAG

const stay = (dialog: ManageDialog | null, notes: readonly string[] = []): ManageStep => ({ dialog, effect: null, notes });

function isEsc(key: string): boolean {
  return key === KEY_ESC || key === KEY_ESC_ESC || key === KEY_CTRL_C;
}

function moved(cursor: number, count: number, key: string): number {
  if (count <= 0) return 0;
  if (key === KEY_UP) return Math.max(0, cursor - 1);
  if (key === KEY_DOWN) return Math.min(count - 1, cursor + 1);
  return cursor;
}

function cycled(choice: number, count: number, key: string): number {
  if (key === KEY_UP) return (choice - 1 + count) % count;
  if (key === KEY_DOWN) return (choice + 1) % count;
  return choice;
}

/** Starts `effect`, unless this is a dry run: then nothing is sent, and the screen says so. */
function send(project: ManageProjectRef, label: string, effect: ManageEffect, back: ManageDialog | null, dryRun: boolean): ManageStep {
  if (dryRun) return stay(back, [MANAGE_DRY_RUN_TEXT]);
  return { dialog: { step: 'working', project, label, back }, effect, notes: [] };
}

/** Enter on a Settings row (Delete project is the screen's own: it never reaches here). */
export function startSettings(project: ManageProjectRef, row: Exclude<SettingsRow, 'delete'>): ManageStep {
  if (row === 'projectId') return { dialog: null, effect: { type: 'projectIdCopy', text: project.id }, notes: [] };
  if (row === 'rename') return stay({ step: 'rename', project, name: project.name, error: null });
  return { dialog: { step: 'tokensLoading', project }, effect: { type: 'projectTokensLoad', project }, notes: [] };
}

/** Enter on a branch: its actions, or why `development` has none. */
export function startBranch(project: ManageProjectRef, branch: BranchRef): ManageStep {
  if (branch.name === DEFAULT_BRANCH) return stay(null, [DEFAULT_BRANCH_LOCK_TEXT]);
  return stay({ step: 'branchMenu', project, branch, choice: 0 });
}

/** d on a repo row: the question, or why the project's only row stays. `rowCount`: the project's rows now. */
export function startRepoRemove(project: ManageProjectRef, row: RepoRowRef, rowCount: number): ManageStep {
  if (rowCount <= 1) return stay(null, [LAST_REPO_LOCK_TEXT]);
  return stay({ step: 'confirmRemoveRepo', project, row });
}

/** The rename field: typing edits the name, Enter sends it (the name's rule and the service decide), Esc cancels. */
function renameKey(dialog: Extract<ManageDialog, { step: 'rename' }>, key: string, dryRun: boolean): ManageStep {
  if (isEsc(key)) return stay(null, [MANAGE_CANCELLED_TEXT]);
  if (key === KEY_ENTER) {
    const name = dialog.name.trim();
    if (name === '') return stay({ ...dialog, error: RENAME_EMPTY_TEXT });
    // The same name: nothing to do.
    if (name === dialog.project.name) return stay(null);
    if (dryRun) return stay(null, [MANAGE_DRY_RUN_TEXT]);
    const label = `Renaming ${dialog.project.name}...`; // COPY-FLAG
    return { dialog: { step: 'working', project: dialog.project, label, back: { ...dialog, name, error: null } }, effect: { type: 'projectRename', project: dialog.project, name }, notes: [] };
  }
  if (key === KEY_BACKSPACE || key === KEY_BACKSPACE2) return stay({ ...dialog, name: dialog.name.slice(0, -1), error: null });
  // Printable characters only (a paste arrives as one string of them).
  const printable = Array.from(key).every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f);
  return printable ? stay({ ...dialog, name: dialog.name + key, error: null }) : stay(dialog);
}

/** A protected branch can have its access managed; any other branch is offered protection and deletion only. */
export function branchActions(branch: BranchRef): readonly BranchAction[] {
  return branch.protected ? ['protect', 'access', 'delete'] : ['protect', 'delete'];
}

function branchActionLabel(action: BranchAction, branch: BranchRef): string {
  if (action === 'protect') return branch.protected ? 'Unprotect' : 'Protect'; // COPY-FLAG
  if (action === 'access') return 'Manage access'; // COPY-FLAG
  return 'Delete branch'; // COPY-FLAG
}

/** Pure reducer over an open dialog. `members`: the org's users now (for Manage access). */
export function manageKey(
  dialog: ManageDialog,
  key: string,
  ctx: { readonly dryRun: boolean; readonly members: readonly MemberDetail[] },
): ManageStep {
  if (dialog.step === 'working' || dialog.step === 'tokensLoading') {
    return dialog.step === 'tokensLoading' && isEsc(key) ? stay(null) : stay(dialog);
  }
  if (dialog.step === 'refused') return stay(null);
  if (dialog.step === 'rename') return renameKey(dialog, key, ctx.dryRun);

  if (dialog.step === 'tokens') {
    if (isEsc(key)) return stay(null);
    if (key !== KEY_ENTER) return stay({ ...dialog, cursor: moved(dialog.cursor, dialog.tokens.length, key) });
    const token = dialog.tokens[dialog.cursor];
    return token === undefined ? stay(dialog) : stay({ step: 'confirmRevoke', project: dialog.project, token, back: dialog });
  }

  if (dialog.step === 'confirmRevoke') {
    // No is the default, as in the delete question.
    if (key === 'y' || key === 'Y') {
      const label = `Revoking deploy token ${dialog.token.deployId.slice(0, 12)}...`; // COPY-FLAG
      return send(dialog.project, label, { type: 'projectTokenRevoke', project: dialog.project, token: dialog.token }, dialog.back, ctx.dryRun);
    }
    if (key === 'n' || key === 'N' || key === KEY_ENTER || isEsc(key)) return stay(dialog.back, [MANAGE_CANCELLED_TEXT]);
    return stay(dialog);
  }

  if (dialog.step === 'branchMenu') {
    if (isEsc(key)) return stay(null);
    const actions = branchActions(dialog.branch);
    if (key !== KEY_ENTER) return stay({ ...dialog, choice: cycled(dialog.choice, actions.length, key) });
    const action = actions[dialog.choice];
    if (action === 'access') return stay({ step: 'access', project: dialog.project, branch: dialog.branch, cursor: 0 });
    if (action === 'delete') return stay({ step: 'confirmDeleteBranch', project: dialog.project, branch: dialog.branch });
    const protect = !dialog.branch.protected;
    const label = `${protect ? 'Protecting' : 'Unprotecting'} ${dialog.branch.name}...`; // COPY-FLAG
    return send(dialog.project, label, { type: 'projectBranchProtect', project: dialog.project, branch: dialog.branch, protect }, null, ctx.dryRun);
  }

  if (dialog.step === 'confirmDeleteBranch') {
    if (key === 'y' || key === 'Y') {
      const label = `Deleting branch ${dialog.branch.name}...`; // COPY-FLAG
      return send(dialog.project, label, { type: 'projectBranchDelete', project: dialog.project, branch: dialog.branch }, null, ctx.dryRun);
    }
    if (key === 'n' || key === 'N' || key === KEY_ENTER || isEsc(key)) return stay(null, [MANAGE_CANCELLED_TEXT]);
    return stay(dialog);
  }

  if (dialog.step === 'confirmRemoveRepo') {
    if (key === 'y' || key === 'Y') {
      const label = `Removing ${repoRowLabel(dialog.row)}...`; // COPY-FLAG
      return send(dialog.project, label, { type: 'projectRepoRemove', project: dialog.project, row: dialog.row }, null, ctx.dryRun);
    }
    if (key === 'n' || key === 'N' || key === KEY_ENTER || isEsc(key)) return stay(null, [MANAGE_CANCELLED_TEXT]);
    return stay(dialog);
  }

  // access: Enter grants or revokes the member under the cursor; the list stays open.
  if (isEsc(key)) return stay(null);
  const rows = accessRows(ctx.members, dialog.project.id, dialog.branch.id);
  if (key !== KEY_ENTER) return stay({ ...dialog, cursor: moved(dialog.cursor, rows.length, key) });
  const user = rows[Math.min(dialog.cursor, rows.length - 1)];
  if (user === undefined) return stay(dialog);
  const grant = !user.hasAccess;
  const label = `${grant ? 'Granting' : 'Revoking'} ${user.email}...`; // COPY-FLAG
  return send(dialog.project, label, { type: 'projectBranchAccess', project: dialog.project, branch: dialog.branch, user, grant }, dialog, ctx.dryRun);
}

/** The token list arrived (or was refused). Dropped unless it is still awaited. */
export function manageTokensLoaded(dialog: ManageDialog | null, loaded: { readonly ok: true; readonly tokens: readonly TokenRow[] } | { readonly ok: false; readonly refusal: ManageRefusal }): ManageDialog | null {
  if (dialog === null || dialog.step !== 'tokensLoading') return dialog;
  return loaded.ok
    ? { step: 'tokens', project: dialog.project, tokens: loaded.tokens, cursor: 0 }
    : { step: 'refused', project: dialog.project, refusal: loaded.refusal };
}

/** A change came back: back to where it was started (with what was read again), or the refusal. */
export function manageDone(dialog: ManageDialog | null, finished: ManageFinished): ManageStep {
  if (dialog === null || dialog.step !== 'working') return stay(dialog);
  const back = dialog.back;
  // A refused rename goes back to the field, with the typed name kept and the refusal shown; a rename that went through closes it.
  if (back !== null && back.step === 'rename') return finished.ok ? stay(null, finished.lines) : stay({ ...back, error: finished.refusal.message });
  if (!finished.ok) return stay({ step: 'refused', project: dialog.project, refusal: finished.refusal });
  if (back !== null && back.step === 'tokens' && finished.tokens !== undefined) {
    return stay({ ...back, tokens: finished.tokens, cursor: Math.min(back.cursor, Math.max(0, finished.tokens.length - 1)) }, finished.lines);
  }
  return stay(back, finished.lines);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function pickerLines(labels: readonly string[], selected: number, margin: string): readonly string[] {
  return labels.map((label, i) => (i === selected ? `${margin}${CYAN}❯ ${label}${RESET}` : `${margin}  ${label}`));
}

/** A list with a highlighted cursor row (no caret: a row here is chosen, not opened). */
function cursorLines(lines: readonly string[], cursor: number, width: number, margin: string): readonly string[] {
  return lines.map((l, i) => {
    if (i !== cursor) return `${margin}${l}`;
    const room = Math.max(1, width - margin.length * 2 + 2);
    const padded = l + ' '.repeat(Math.max(0, room - Array.from(l).length));
    return `${margin.slice(1)}${INVERSE} ${padded}${RESET}`;
  });
}

function tokenLine(t: TokenRow, now?: Date): string {
  const label = t.label === null ? '' : `  ${t.label}`;
  return `${t.deployId.slice(0, 12)}...  ${formatRelativeTime(t.createdAt, now)}  ${t.createdBy}${label}`;
}

/** The dialog's lines, under the screen's title. `width`: the terminal's. */
export function renderManage(dialog: ManageDialog, width: number, margin: string, members: readonly MemberDetail[], now?: Date): readonly string[] {
  const m = margin;
  if (dialog.step === 'tokensLoading') return [`${m}${DIM}Loading deploy tokens...${RESET}`, '', m + hint('esc', 'back')]; // COPY-FLAG
  if (dialog.step === 'working') return [`${m}${DIM}${dialog.label}${RESET}`];
  if (dialog.step === 'refused') return [`${m}${dialog.refusal.message}`, '', m + hint('esc', 'back')];
  if (dialog.step === 'tokens') {
    const body = dialog.tokens.length === 0 ? [`${m}${DIM}${NO_TOKENS_TEXT}${RESET}`] : cursorLines(dialog.tokens.map((t) => tokenLine(t, now)), dialog.cursor, width, m);
    const keys = dialog.tokens.length === 0 ? [hint('esc', 'back')] : [`${DIM}↑↓ navigate${RESET}`, hint('enter', 'revoke'), hint('esc', 'back')]; // COPY-FLAG
    return [`${m}${BOLD}Deploy tokens${RESET} ${DIM}${dialog.project.name}${RESET}`, '', ...body, '', m + hints(...keys)]; // COPY-FLAG
  }
  if (dialog.step === 'confirmRevoke') {
    return [
      `${m}${BOLD}Revoke deploy token ${dialog.token.deployId.slice(0, 12)}...?${RESET}`, // COPY-FLAG
      `${m}${DIM}Deploys using it stop getting secrets.${RESET}`, // COPY-FLAG
      '',
      m + hints(hint('y', 'yes'), hint('esc', 'no')),
    ];
  }
  if (dialog.step === 'branchMenu') {
    const actions = branchActions(dialog.branch);
    return [
      promptLine(`${dialog.branch.name}:`, m),
      ...pickerLines(actions.map((a) => branchActionLabel(a, dialog.branch)), dialog.choice, m),
      '',
      m + hints(`${DIM}↑↓ choose${RESET}`, hint('enter', 'select'), hint('esc', 'cancel')), // COPY-FLAG
    ];
  }
  if (dialog.step === 'confirmDeleteBranch') {
    return [
      `${m}${BOLD}Delete branch "${dialog.branch.name}"? This will remove all its secrets.${RESET}`, // reused from `capy branch -D`
      '',
      m + hints(hint('y', 'yes'), hint('esc', 'no')),
    ];
  }
  if (dialog.step === 'rename') {
    return [
      `${m}${BOLD}Rename ${dialog.project.name}${RESET}`, // COPY-FLAG
      '',
      `${m}${DIM}Name:${RESET} ${dialog.name}${INVERSE} ${RESET}`, // COPY-FLAG
      ...(dialog.error === null ? [] : ['', `${m}${dialog.error}`]),
      '',
      m + hints(hint('enter', 'rename'), hint('esc', 'cancel')), // COPY-FLAG
    ];
  }
  if (dialog.step === 'confirmRemoveRepo') {
    return [
      `${m}${BOLD}Remove ${repoRowLabel(dialog.row)} from ${dialog.project.name}?${RESET}`, // COPY-FLAG
      '',
      m + hints(hint('y', 'yes'), hint('esc', 'no')),
    ];
  }
  const rows = accessRows(members, dialog.project.id, dialog.branch.id);
  const body = rows.length === 0
    ? [`${m}${DIM}No members in this project. Project admins and admins can always use every branch.${RESET}`] // COPY-FLAG
    : cursorLines(rows.map((r) => `${r.hasAccess ? '[x]' : '[ ]'} ${r.email}`), Math.min(dialog.cursor, rows.length - 1), width, m);
  return [
    `${m}${BOLD}Who can use ${dialog.branch.name}${RESET} ${DIM}(protected)${RESET}`, // COPY-FLAG
    '',
    ...body,
    '',
    m + hints(`${DIM}↑↓ navigate${RESET}`, hint('enter', 'grant/revoke'), hint('esc', 'back')), // COPY-FLAG
  ];
}

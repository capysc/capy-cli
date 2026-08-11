// `capy edit`, served as compiled screens.
//
// Replaces the 793-line alternate-screen TUI in editScreen.ts for `--web`. The
// terminal path is untouched and still the only thing a person at a real
// terminal gets; what changes here is the RENDERING of the same questions.
//
// Why this flow was worth converting rather than left alone: the TUI has no
// TTY guard at all. Run `capy edit` headlessly and it writes an entire ANSI
// screen into the agent's captured stdout and then blocks forever on a stdin
// that never delivers a key. There is no `--json`, no MCP tool and no browser
// path, so editing one secret is currently something only a human sitting at a
// terminal can do.
//
// THESE SCREENS RENDER REAL SECRET VALUES — the only ones in the product that
// do. Three rules hold everywhere below and are tested:
//
//   1. No plaintext is ever in a payload. `buildSecretTableData` and
//      `buildSecretValueEditorData` receive the decrypted rows because that is
//      where the CLI holds them, and neither copies a value out. Every reveal
//      is its own round trip, so the served HTML — the thing a screenshot, a
//      "save page as" or a devtools copy captures — never holds more than the
//      one value the user asked for.
//   2. `formatSnippet` returns anything six characters or shorter VERBATIM
//      (statusCommand.ts:115), so the terminal's column labelled as masked
//      prints short secrets whole. Here the payload carries NO snippet for
//      those values and says why — see `snippetIsWholeValue`.
//   3. Nothing here logs, prints or serialises a value. It leaves the process
//      only in the body of one loopback response the user asked for, and comes
//      back only in the body of the POST that saves it.
import { runBrowserWizard, BrowserRefusal, type WebRefusal } from './browserWizard';
import { renderScreen } from './screens/serve';
import {
  reclassifyRow,
  renderInlineValue,
  updatedLabelForRow,
  type EditRow,
} from './editScreen';
import { formatSnippet } from '../commands/statusCommand';
import { secretEditPlan } from '../core/secretEditPlan';
import type {
  SecretTableData,
  SecretTableRemoteGap,
  SecretTableRow,
  SecretValueEditorData,
} from './screens/contract';

/**
 * Strip terminal colour codes on the way into a payload.
 *
 * Applied to the strings the CLI also PRINTS — the project name it puts in
 * headers, the age label it formats — because a payload is not a terminal and
 * an escape renders as a literal `[90m` in a browser. Never applied to a
 * variable NAME or to a value: both have to round-trip byte for byte.
 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * A value that cannot be stored, in the kit's own words.
 *
 * The rule is the CLI's: `sanitizePastedText` (editScreen.ts:92) keeps LF and
 * TAB and drops every other control character, so a byte that would not
 * survive a paste in the terminal must not survive a submit from the browser
 * either. The screen refuses these while they are typed and holds its button,
 * so one arriving over the wire means the submit did not come from the screen.
 *
 * The message never quotes the value. It is announced by `role="alert"` and
 * lands in every screenshot of the page, which is the one thing these screens
 * exist to prevent.
 */
const CONTROL_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** A connector owns this value; `capy rotate` writes it. */
export interface ManagedBy {
  provider: string;
  expiresInDays?: number;
}

/** One variable, as `capy edit` knows it. Carries plaintext; a payload does not. */
export interface WebSecretRow extends EditRow {
  /** Edited in this session and not yet committed. */
  dirty?: boolean;
  managedBy?: ManagedBy;
}

export interface WebSecretTableParams {
  projectName: string;
  branch: string;
  /** `local` has no organization and no server: the commit does not push. */
  mode: 'server' | 'local';
  rows: WebSecretRow[];
  /**
   * Why there is no remote side, when there is none. The terminal renders a
   * failed fetch and a project nobody has ever pushed identically — `{n} ? /
   * remote unavailable` — so an offline run is indistinguishable from a fresh
   * project. Minted where the condition is known so they are not.
   */
  remoteGap?: SecretTableRemoteGap;
  /** The remote blob came from the on-disk keep cache rather than the service. */
  remoteFromCache?: boolean;
  /**
   * Local ciphertext that would not decrypt. The terminal drops these in an
   * empty `catch` and then deletes their pins on the next commit.
   */
  undecryptableKeys?: string[];
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/** The CLI's status words, in the screen's vocabulary. Same five conditions. */
function tableStatus(status: EditRow['status']): SecretTableRow['status'] {
  return status === 'in sync' ? 'in-sync' : status;
}

/** Which of the three value states this row is in, without saying what it holds. */
function valueState(row: WebSecretRow): SecretTableRow['value'] {
  const value = row.localValue ?? row.remoteValue;
  if (value === undefined) return 'absent';
  return value === '' ? 'empty' : 'set';
}

/**
 * Recency ranks for the UPDATED column.
 *
 * The column's text is already humanised, and `3 days ago` sorts between `1
 * hour` and `5 minutes` as a string — so the screen is handed an order rather
 * than left to re-parse the prose it was given. The contract asks for two
 * things and both are load-bearing:
 *
 *   - monotonic in recency across the whole table, newest at 0, and rows that
 *     READ the same share a rank. Ranking by the label rather than by the raw
 *     timestamp is what makes the second half true: two rows three days apart
 *     to the second both say "3 days ago", and a table that ordered them by
 *     milliseconds would draw an order the reader cannot see.
 *   - a row with no timestamp gets an explicit LAST rank rather than being left
 *     out. Left optional it falls to a sentinel, and a sentinel is a number
 *     nobody checks.
 *
 * Local mode has no server timestamps at all, only `uncommitted` and
 * `committed`. An uncommitted change is by definition more recent than the
 * last commit, so those two are the whole order.
 */
function updatedRanks(rows: WebSecretRow[], localMode: boolean): Map<string, number> {
  const ranks = new Map<string, number>();

  if (localMode) {
    for (const row of rows) ranks.set(row.key, row.status === 'in sync' ? 1 : 0);
    return ranks;
  }

  const stamped = rows
    .filter((r) => r.changedAt)
    .sort((a, b) => new Date(b.changedAt!).getTime() - new Date(a.changedAt!).getTime());

  let rank = -1;
  let previousLabel: string | null = null;
  for (const row of stamped) {
    if (row.updatedLabel !== previousLabel) {
      rank += 1;
      previousLabel = row.updatedLabel;
    }
    ranks.set(row.key, rank);
  }

  // Everything with no stamp reads "—" and belongs behind everything that has
  // one, on one shared rank rather than in an arbitrary order.
  const last = rank + 1;
  for (const row of rows) if (!ranks.has(row.key)) ranks.set(row.key, last);
  return ranks;
}

export function buildSecretTableData(
  p: WebSecretTableParams,
  nonce: string,
  view: SecretTableData['view'] = 'table',
): SecretTableData {
  const ranks = updatedRanks(p.rows, p.mode === 'local');
  const changeCount = p.rows.filter((r) => r.dirty).length;
  // Stripped ONCE, so every place the name appears in this payload — the
  // header, the rail's destination — carries the same bytes. Two call sites
  // stripping the same string is one call site away from a `[90m` rendering
  // literally in a browser.
  const projectName = stripAnsi(p.projectName);

  const rows: SecretTableRow[] = p.rows.map((row) => {
    const value = row.localValue ?? row.remoteValue;
    const state = valueState(row);
    const cell: SecretTableRow = {
      key: row.key,
      value: state,
      status: tableStatus(row.status),
      updated: stripAnsi(row.updatedLabel),
      updatedRank: ranks.get(row.key) ?? 0,
    };
    // Metadata, not content: a length is the only way to notice a paste that
    // lost its tail, and the mask never varies with it, so the column itself
    // gives nothing away.
    if (value !== undefined) cell.length = value.length;
    if (value !== undefined && value.includes('\n')) cell.lines = value.split('\n').length;
    if (row.dirty) cell.dirty = true;
    if (row.managedBy) cell.managedBy = row.managedBy;
    return cell;
  });

  const data: SecretTableData = {
    nonce,
    projectName,
    branch: p.branch,
    mode: p.mode,
    stops: secretEditPlan({
      variableCount: p.rows.length,
      changeCount,
      localMode: p.mode === 'local',
      destination: `${projectName}/${p.branch}`,
      at: view === 'confirm-commit' ? 'review' : view === 'table' ? 'edit' : 'result',
      discarded: view === 'cancelled',
    }),
    rows,
    view,
    nonTty: {
      command: 'capy list --json',
      why: 'Lists every variable and its status without opening anything. Values are never included — reading one is a step that refuses off a terminal.',
    },
    nonTtyReveal: {
      command: 'capy edit --non-tty',
      why: 'Exits 3 and prints nothing. A value is only ever put in front of a person, so no flag can ask for one.',
    },
  };

  if (p.remoteGap) data.remoteGap = p.remoteGap;
  if (p.remoteFromCache) data.remoteFromCache = true;
  if (p.undecryptableKeys?.length) data.undecryptableKeys = p.undecryptableKeys;

  // The audit's worst finding, computed rather than passed in so it cannot go
  // stale: `saveLocalEdits` builds the whole `.env` from the local plaintext
  // alone and then deletes the branch entry of every variable not in it
  // (editCommand.ts:238,262-268), so anything pinned or remote but absent
  // locally loses its entry on ANY commit — one unrelated edit drops a
  // teammate's variable, silently. Derived from the rows the table is being
  // drawn from, so queueing an edit for such a key takes it off this list in
  // the same render that marks the row dirty.
  const dropped = p.rows.filter((r) => r.localValue === undefined).map((r) => r.key);
  if (dropped.length > 0) data.droppedOnCommitKeys = dropped;
  return data;
}

// ---------------------------------------------------------------------------
// secret-value-editor
// ---------------------------------------------------------------------------

export interface WebSecretValueParams {
  projectName: string;
  branch: string;
  mode: 'server' | 'local';
  row: WebSecretRow;
  /** Whether the remote blob was read at all this run. */
  remoteAvailable: boolean;
  /** Why there is no remote side, when there is none. */
  remoteUnavailable?: SecretTableRemoteGap;
  /** Uncommitted edits across the whole session, this one included. */
  pendingCount: number;
  managedBy?: { provider: string; expiresLabel?: string };
  open?: boolean;
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

export function buildSecretValueEditorData(
  p: WebSecretValueParams,
  nonce: string,
): SecretValueEditorData {
  const value = p.row.localValue ?? p.row.remoteValue;
  const hasValue = value !== undefined;
  // `formatSnippet` returns anything six characters or shorter VERBATIM, so
  // for those there is no masked form to send and the payload carries none.
  // Naming the leak is not containing it: a snippet that IS the value is the
  // secret sitting in the served HTML before anybody asked to see it.
  const snippetIsWholeValue = hasValue && value!.length <= 6;

  const data: SecretValueEditorData = {
    nonce,
    projectName: stripAnsi(p.projectName),
    branch: p.branch,
    mode: p.mode,
    key: p.row.key,
    status: tableStatus(p.row.status),
    snippetIsWholeValue,
    hasLocalValue: p.row.localValue !== undefined,
    hasRemoteValue: p.row.remoteValue !== undefined,
    isEmptyString: value === '',
    multiline: hasValue && value!.includes('\n'),
    valueLength: hasValue ? value!.length : 0,
    updatedLabel: stripAnsi(p.row.updatedLabel),
    remoteAvailable: p.remoteAvailable,
    dirty: p.row.dirty === true,
    pendingCount: p.pendingCount,
    view: 'inspect',
    nonTty: {
      command: 'capy edit --non-tty',
      why: 'A secret value can never come from a flag — it would land in shell history, the process table and every log that captures a command line. There is no argument that answers this step: headless, it exits 3 (needs input) and hands off to a terminal.',
    },
  };

  // The CLI's own masked form, and only while it really is masked. A newline
  // inside a snippet is rendered the way the terminal renders one, so the two
  // surfaces show one value one way.
  if (hasValue && !snippetIsWholeValue) {
    data.snippet = renderInlineValue(formatSnippet(value!));
  }
  if (p.remoteUnavailable) data.remoteUnavailable = p.remoteUnavailable;
  if (p.managedBy) data.managedBy = p.managedBy;
  return data;
}

// ---------------------------------------------------------------------------
// serving
// ---------------------------------------------------------------------------

/**
 * What the table asked the CLI to do next.
 *
 * `cancel` carries WHICH refusal it was, because the three end the run
 * differently in the terminal and only one of them is a control being clicked.
 * `closed` and `timeout` also mean there is no page left to serve anything
 * to — re-rendering the table into a browser that has gone away is how the
 * five-minute hang was reached in the first place.
 */
export type SecretTableOutcome =
  | { action: 'edit'; key: string }
  | { action: 'commit' }
  | { action: 'cancel'; reason: WebRefusal };

/** What the value editor decided. `cancel` queues nothing. */
export type SecretValueOutcome =
  | { action: 'save'; key: string; value: string }
  | { action: 'cancel'; reason: WebRefusal };

/**
 * A step nobody answered, as this flow's own refusal.
 *
 * `capy edit` has no failure mode called "the browser did not say anything":
 * a run that wrote nothing is a run that wrote nothing, and it ends the way
 * the terminal's `q` ends — a line saying so, and exit 0. A real fault (a
 * socket that would not bind) is not a `BrowserRefusal` and still throws.
 */
async function refusalIsCancel(run: Promise<unknown>): Promise<unknown> {
  try {
    return await run;
  } catch (err) {
    if (err instanceof BrowserRefusal && err.reason === 'timeout') {
      return { action: 'cancel', reason: 'timeout' };
    }
    throw err;
  }
}

/** The plaintext for one variable, by the terminal's own rule (editScreen.ts:719). */
const plaintextOf = (row: WebSecretRow | undefined, side: 'current' | 'remote'): string | undefined =>
  side === 'remote' ? row?.remoteValue : (row?.localValue ?? row?.remoteValue);

/**
 * Serve the variable table and wait for what it wants next.
 *
 * `reveal` is answered inline — the flow has not moved, and a reveal that
 * finished the wizard would tear the page down to show one value.
 *
 * `onCommit` runs INSIDE the request, the way the intake's save always has, so
 * the browser reflects what really happened. Resolving first and pushing after
 * would render "Committed — 4 changes are now pushed to staging" and then fail
 * the push into a terminal nobody is looking at; a throw here comes back as a
 * refusal and the screen's own line reads "… — nothing was changed."
 */
export async function serveSecretTable(
  p: WebSecretTableParams,
  onCommit?: () => Promise<void>,
): Promise<SecretTableOutcome> {
  const byKey = new Map(p.rows.map((r) => [r.key, r]));

  const out = await refusalIsCancel(runBrowserWizard(
    {
      title: `Variables — ${p.projectName}/${p.branch}`,
      flow: 'edit',
      // Rendered per-request so the nonce the page echoes is the one this
      // server minted. `standalone` because a compiled screen is a whole
      // document and cannot be dropped into the wizard shell.
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Answered — back to your terminal.',
      renderFirst: (nonce) => renderScreen('secret-table', buildSecretTableData(p, nonce)),
      // The table has no Cancel of its own until a row is dirty — `Review N
      // changes` is the only control that leads to one — so on the state every
      // run OPENS in, closing the window is the only way out a person has.
      // Wiring it here is what makes that an ending instead of a five-minute
      // wait and a thrown error. It discards: a closed window commits nothing.
      closeIsRefusal: { result: { action: 'cancel', reason: 'closed' } satisfies SecretTableOutcome },
    },
    async (_step, payload) => {
      const action = typeof payload.__action === 'string' ? payload.__action : '';

      if (action === 'reveal') {
        const key = typeof payload.key === 'string' ? payload.key : '';
        const row = byKey.get(key);
        // The table only draws rows it was given, so a key outside them did
        // not come from the table — and handing a plaintext to a request the
        // screen could not have made is the whole failure this prevents.
        if (!row) return { error: 'That variable is not on this table.' };
        const value = plaintextOf(row, 'current');
        if (value === undefined) return { error: 'That variable has no value to show.' };
        return { body: { value } };
      }

      if (action === 'edit') {
        const key = typeof payload.key === 'string' ? payload.key : '';
        const row = byKey.get(key);
        if (!row) return { error: 'That variable is not on this table.' };
        // The screen disables its edit control on a connector-owned row, so
        // this can only arrive from something that is not the screen. Letting
        // it through would queue an edit the next rotation silently overwrites.
        if (row.managedBy) {
          return { error: `${row.managedBy.provider} writes this value — use capy rotate ${row.key}.` };
        }
        return { done: true, result: { action: 'edit', key } };
      }

      if (action === 'commit') {
        // A throw propagates as a 500 carrying the reason, which is exactly the
        // shape the screen reads: it stays on the review stop with the edits
        // still queued.
        if (onCommit) await onCommit();
        return { done: true, result: { action: 'commit' } };
      }
      if (action === 'cancel') {
        return { done: true, result: { action: 'cancel', reason: 'declined' } };
      }

      return { error: 'That is not an action this screen offers.' };
    },
  ));
  return out as SecretTableOutcome;
}

/**
 * Serve one variable's editor and wait for the buffer.
 *
 * Reveal arrives on `/reveal` here rather than on `/submit`: reading a value is
 * a question, not an answer, and the page stays exactly where it was.
 */
export async function serveSecretValueEditor(p: WebSecretValueParams): Promise<SecretValueOutcome> {
  const reveal = async (
    _step: number,
    payload: Record<string, unknown>,
  ): Promise<{ body: Record<string, unknown> } | { error: string }> => {
    const key = typeof payload.key === 'string' ? payload.key : '';
    const side = payload.side === 'remote' ? 'remote' : payload.side === 'current' ? 'current' : null;
    // This editor is opened for ONE variable and the screen posts its own key,
    // so anything else is a request to read a secret nobody opened.
    if (key !== p.row.key) return { error: 'That variable is not open in this editor.' };
    if (side === null) return { error: 'That is not a side this editor can read.' };
    const value = plaintextOf(p.row, side);
    if (value === undefined) return { error: 'There is no value on that side to read.' };
    return { body: { value } };
  };

  const out = await refusalIsCancel(runBrowserWizard(
    {
      title: `${p.row.key} — ${p.projectName}/${p.branch}`,
      flow: 'edit',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Saved — back to your terminal.',
      renderFirst: (nonce) => renderScreen('secret-value-editor', buildSecretValueEditorData(p, nonce)),
      routes: { '/reveal': reveal },
      // This editor DOES have a Cancel, and it means "back to the table".
      // Closing the window is the other thing: there is no table to go back
      // to, so it ends the run rather than queueing nothing and looping.
      closeIsRefusal: { result: { action: 'cancel', reason: 'closed' } satisfies SecretValueOutcome },
    },
    async (_step, payload) => {
      const action = typeof payload.__action === 'string' ? payload.__action : '';
      if (action === 'cancel') return { done: true, result: { action: 'cancel', reason: 'declined' } };
      if (action !== 'save') return { error: 'That is not an action this screen offers.' };

      if (payload.key !== p.row.key) {
        return { error: 'That variable is not open in this editor.' };
      }
      if (typeof payload.value !== 'string') {
        // The buffer is a string on the screen and nowhere else, so this is a
        // malformed submit rather than a value the user typed.
        return { error: 'That is not a value this editor can save.' };
      }
      if (CONTROL_CHAR.test(payload.value)) {
        return {
          error:
            'Something in this value cannot be stored — it contains a control character. Copy it again, or delete the stray character.',
        };
      }
      return { done: true, result: { action: 'save', key: p.row.key, value: payload.value } };
    },
  ));
  return out as SecretValueOutcome;
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

export interface WebEditContext {
  /**
   * Commit (and in server mode, push) the given edits. The same callback the
   * TUI is handed, resolving to the server-assigned `changed_at` per variable.
   */
  saveLocalEdits: (edits: Record<string, string>) => Promise<Record<string, string>>;
}

export interface WebEditParams extends WebSecretTableParams {
  remoteAvailable: boolean;
}

/**
 * `capy edit --web`, whole.
 *
 * One page per question, because the table screen cannot become the editor on
 * its own: a loopback server cannot push a navigation, and — unlike every
 * `Wizard`-based screen — `secret-table` does not reload when the CLI answers
 * with `{ next: true }`. It says "Opening <KEY> in the value editor…" and
 * waits, so the CLI does exactly that: it opens the editor. See the note in
 * the parcel report; the fix belongs in packages/ui, not here.
 */
export async function runSecretEditorInBrowser(
  p: WebEditParams,
  ctx: WebEditContext,
): Promise<void> {
  // Edits queued in this session, exactly as the TUI queues them: nothing
  // reaches .env, keep.lock or the server until the commit stop.
  const pending = new Map<string, string>();
  let rows = p.rows;

  /**
   * Say what happened, on every way out.
   *
   * The run ends in the terminal whichever ending it reached, and the three
   * refusals are not the same fact: one is a control that was clicked, one is
   * a window that was closed, and one is a browser that never came back. A
   * run that printed nothing is the failure this replaces — the CLI used to
   * exit with `Timed out waiting for the browser (5 minutes).` and no mention
   * of the edits it was holding.
   */
  const reportRefusal = (reason: WebRefusal): void => {
    const held =
      pending.size > 0 ? ` Discarded ${pending.size} change(s).` : '';
    if (reason === 'timeout') {
      console.log(`\n  The browser never answered.${held} Nothing was written.\n`);
    } else if (reason === 'closed') {
      console.log(`\n  Browser closed.${held} Nothing was written.\n`);
    } else {
      console.log(`\n  Cancelled.${held} Nothing was written.\n`);
    }
  };

  for (;;) {
    let committed = 0;
    const outcome = await serveSecretTable({ ...p, rows }, async () => {
      if (pending.size === 0) return;
      // The TUI's own line, verbatim. It happens before the write here too,
      // because the write is what the browser is waiting on.
      const verb = p.mode === 'local' ? 'Committing' : 'Committing & pushing';
      console.log(`  ${verb} ${pending.size} change(s)…`);
      await ctx.saveLocalEdits(Object.fromEntries(pending));
      committed = pending.size;
      pending.clear();
    });

    if (outcome.action === 'cancel') {
      reportRefusal(outcome.reason);
      return;
    }

    if (outcome.action === 'commit') {
      console.log(`  Committed ${committed} change(s)`);
      return;
    }

    const row = rows.find((r) => r.key === outcome.key);
    if (!row) return;
    const edited = await serveSecretValueEditor({
      projectName: p.projectName,
      branch: p.branch,
      mode: p.mode,
      row,
      remoteAvailable: p.remoteAvailable,
      remoteUnavailable: p.remoteGap,
      pendingCount: pending.size + (row.dirty ? 0 : 1),
      open: p.open,
      // Forwarded so a test can watch this loop open its second, third and
      // fourth server. Without it the only way to reach the editor's URL was
      // to intercept `console.log`, which is why the loop itself — the thing
      // `capy edit --web` actually runs — had no browser test at all.
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
    });

    // The editor's own Cancel means "back to the table". A closed window and a
    // silent one mean there is no browser left, so re-serving the table would
    // open a page nobody can see and wait five minutes for it.
    if (edited.action === 'cancel' && edited.reason !== 'declined') {
      reportRefusal(edited.reason);
      return;
    }

    if (edited.action === 'save') {
      pending.set(edited.key, edited.value);
      // The table redraws from the queued value: its mask, its length and its
      // status all describe what the commit would write, not what is on disk.
      rows = rows.map((r) => {
        if (r.key !== edited.key) return r;
        const next: WebSecretRow = { ...r, localValue: edited.value, dirty: true };
        next.status = reclassifyRow(next, {
          localMode: p.mode === 'local',
          remoteAvailable: p.remoteAvailable,
        });
        next.updatedLabel = updatedLabelForRow(next, { localMode: p.mode === 'local' });
        return next;
      });
    }
  }
}

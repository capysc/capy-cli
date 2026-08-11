// The sync conflict resolver, served as a compiled screen.
//
// Replaces conflictWeb.ts, which hand-wrote its HTML and — more importantly —
// showed only HALF the question. The terminal asks two levels: a whole-run
// action ("retrieve all remote", "commit and push all local", "individually
// resolve"), ordered so the recommended answer sits first, and then the
// per-variable table only if you chose to resolve individually. The old
// browser path discarded the first level entirely and hard-coded individual
// resolution, so a user who wanted "take theirs" answered once per variable
// and never saw the ordering that carried the CLI's recommendation.
//
// This serves the compiled `sync-conflict` screen, which has both levels, and
// returns the action alongside the per-variable choices so the caller can
// apply either.
//
// Only SNIPPETS reach the page (`sk_...001`, first3…last3) — never a full
// secret value — matching the terminal table. The user's selection travels the
// loopback only; this transport never prints or logs it.
import { runBrowserWizard } from './browserWizard';
import { renderScreen } from './screens/serve';
import type { ConflictAction, ConflictRow, SyncConflictData } from './screens/contract';
import type { ResolveRow, ResolveResult } from './resolveTable';

/** What the browser decided: the whole-run action, plus rows if individual. */
export interface WebConflictResult {
  /** `retrieve_remote` | `retrieve_pinned` | `commit_local` | `individual`. */
  action: string;
  choices: ResolveResult['choices'];
  cancelled: boolean;
}

export interface WebConflictParams {
  rows: ResolveRow[];
  /**
   * Which pinned values cannot be reconstructed, by variable name.
   *
   * The terminal marks these by putting the ANSI-italic literal `unresolvable`
   * in the value column and then testing for that string later. A variable
   * whose snippet happened to read "unresolvable" would defeat it, and the
   * escape codes leak terminal formatting into a payload the browser has to
   * strip. The screen takes a boolean instead, which no value can spoof.
   */
  unresolvable: Set<string>;
  showLocal: boolean;
  showRemote: boolean;
  localMode: boolean;
  isOnboarding: boolean;
  isBehind: boolean;
  remoteState: 'ok' | 'empty' | 'unreachable';
  /** The CLI's own menu, carried verbatim so both surfaces read the same. */
  actions: ConflictAction[];
  projectName: string;
  branch: string;
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** What kind of difference this row is, in the CLI's own vocabulary. */
function diffType(row: ResolveRow): ConflictRow['type'] {
  if (row.pinned === null) return 'new';
  if (row.local === null && row.remote === null) return 'deleted';
  return 'changed';
}

/**
 * The route this run will travel, declared before the browser opens.
 *
 * Built here rather than in the screen for the reason §8 gives: the same array
 * is what a headless caller would parse, so a rail the browser draws from its
 * own state would describe a different run than `--json` does. `review` is
 * always where the CLI serves; the later stops are upcoming until the user
 * moves, and the screen says only where it is standing.
 */
function buildStops(willOfferIndividual: boolean): SyncConflictData['stops'] {
  return [
    {
      id: 'review',
      label: 'Review',
      state: 'current',
      detail: 'what differs, and where each value came from',
    },
    {
      id: 'choose',
      label: 'Choose an action',
      state: 'upcoming',
      detail: 'for the whole run, or resolve variable by variable',
    },
    {
      id: 'resolve',
      label: 'Resolve',
      // A run that cannot offer individual resolution never visits this stop,
      // and saying so up front is the point of drawing the whole route.
      state: willOfferIndividual ? 'upcoming' : 'skipped',
      detail: 'pick a source for each variable',
    },
    {
      id: 'apply',
      label: 'Apply',
      state: 'upcoming',
      detail: 'rewrite .env and pin what you chose',
    },
  ];
}

export function buildConflictData(p: WebConflictParams, nonce: string): SyncConflictData {
  const rows: ConflictRow[] = p.rows.map((r) => ({
    variable: r.variable,
    type: diffType(r),
    // Snippets arrive carrying the terminal's own colour codes. The page sets
    // its own type; the escapes would render as literal `[3m` in the browser.
    pinned: r.pinned === null ? null : stripAnsi(r.pinned),
    pinnedUnresolvable: p.unresolvable.has(r.variable),
    local: r.local === null ? null : stripAnsi(r.local),
    remote: r.remote === null ? null : stripAnsi(r.remote),
  }));

  return {
    nonce,
    projectName: p.projectName,
    branch: p.branch,
    localMode: p.localMode,
    showLocal: p.showLocal,
    showRemote: p.showRemote,
    isOnboarding: p.isOnboarding,
    isBehind: p.isBehind,
    remoteState: p.remoteState,
    rows,
    actions: p.actions,
    stops: buildStops(p.actions.some((a) => a.value === 'individual')),
    step: 'review',
  };
}

/** A value the per-variable table may return for a row. */
const SOURCES = new Set(['pinned', 'local', 'remote', 'delete']);

export async function resolveConflictInBrowser(p: WebConflictParams): Promise<WebConflictResult> {
  const out = await runBrowserWizard(
    {
      title: `Resolve ${p.rows.length} conflict${p.rows.length !== 1 ? 's' : ''} — ${p.projectName}/${p.branch}`,
      flow: 'sync',
      // Rendered per-request so the nonce the page echoes is the one this
      // server minted. `standalone` because a compiled screen is a whole
      // document and cannot be dropped into the wizard shell.
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Resolved — back to your terminal.',
      renderFirst: (nonce) => renderScreen('sync-conflict', buildConflictData(p, nonce)),
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { action: 'skip', choices: {}, cancelled: true } };
      }

      const action = typeof payload.action === 'string' ? payload.action : '';
      if (!p.actions.some((a) => a.value === action)) {
        // The page offers only what this run's menu contains, so anything else
        // is a malformed submit rather than a user mistake — refuse it inline
        // instead of applying a guess to somebody's secrets.
        return { error: 'That action is not available for this run.' };
      }
      if (action === 'skip') {
        return { done: true, result: { action, choices: {}, cancelled: true } };
      }

      const choices: ResolveResult['choices'] = {};
      if (action === 'individual') {
        const raw = payload.choices;
        const picked = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        for (const row of p.rows) {
          const c = picked[row.variable];
          if (typeof c === 'string' && SOURCES.has(c)) {
            choices[row.variable] = c as ResolveResult['choices'][string];
          }
        }
        // Individual resolution that answered nothing is not a resolution. The
        // screen holds its button until every row has a source, so an empty
        // set means the submit did not come from that screen.
        if (Object.keys(choices).length !== p.rows.length) {
          return { error: 'Some variables were left unanswered.' };
        }
      }

      return { done: true, result: { action, choices, cancelled: false } };
    },
  );
  return out as WebConflictResult;
}

// The two REPORTS of the sync pair, served as compiled screens:
// `capy status` (sync-status) and the end of a `capy` run (sync-result).
//
// Neither asks anything. They post nothing, carry no nonce, and are served
// under the strict screen policy — `connect-src 'none'` — so a page that only
// reports cannot open a socket at all. That is why they use `ScreenServer`
// rather than `runBrowserWizard`: a wizard exists to collect an answer, and
// there is no answer here to collect.
//
// WHAT WAS WRONG. `capy status` writes its report to a TTY with ANSI bold and
// then calls `process.exit(0)`, and `capy` finishes a sync with three console
// lines. Under `--web` — which is agent-driven, so there is often no terminal
// anyone is watching — the report went to a stream nobody reads. Now the same
// facts render in the browser, with `--json` carried VERBATIM in the payload
// rather than rebuilt, so what a person copies out of the page and what a
// script parses cannot describe different states.
//
// Values never appear in either payload. Both screens carry variable names and
// verdicts; the comparison itself is done on 16-hex sha256 prefixes and not
// even those cross.
import { ScreenServer } from './screens/serve';
import type {
  DiffType,
  ExpiringCredential,
  RemoteFailure,
  RemoteState,
  StatusDiff,
  SyncResultChange,
  SyncResultData,
  SyncStatusData,
} from './screens/contract';

/** Strip terminal colour codes: the CLI bolds these names on its way to a TTY. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------
// sync-status
// ---------------------------------------------------------------------------

/** One row of `compareSecrets`, as `statusCommand` computes it. */
export interface StatusDiffInput {
  variable: string;
  type: DiffType;
  /** Value HASHES, never values. Used only to work out which side moved. */
  pinned?: string;
  local?: string;
  remote?: string;
}

export interface WebSyncStatusParams {
  projectName: string;
  /** Null when the CLI could not tell which branch this directory is on. */
  branch: string | null;
  totalSecrets: number;
  localMatchesPinned: boolean;
  remoteMatchesPinned: boolean;
  /** Whether the remote answered with anything at all. */
  hasRemote: boolean;
  /** Set when the remote could not be read. A code, never the message. */
  remoteFailure?: RemoteFailure;
  diffs: StatusDiffInput[];
  /** Connector credentials the CLI warns about after every run. */
  expiring: ExpiringCredential[];
  /** The `capy status --json` payload, verbatim — the same object, stringified. */
  json: string;
  open?: boolean;
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/**
 * Which side of the comparison moved.
 *
 * The terminal decides this per row to pick its `(changed locally)` /
 * `(changed on remote)` suffix, and then throws the decision away into prose.
 * The same three cases, as a value.
 */
function diffSide(d: StatusDiffInput): StatusDiff['side'] {
  const localMoved = d.local !== d.pinned;
  const remoteMoved = d.remote !== d.pinned;
  if (localMoved && remoteMoved) return 'both';
  return localMoved ? 'local' : 'remote';
}

/**
 * What the remote had to say, as a state rather than as three booleans the
 * screen would have to reassemble.
 *
 * `not_checked` is deliberately never produced here: with no variables at all
 * the CLI skips the fetch entirely and cannot tell that case apart from a
 * remote that answered and was empty, so claiming it would be an invention.
 */
function remoteState(p: WebSyncStatusParams): RemoteState {
  if (p.remoteFailure) return 'failed';
  if (!p.hasRemote) return 'empty';
  return p.remoteMatchesPinned ? 'up_to_date' : 'has_changes';
}

export function buildSyncStatusData(p: WebSyncStatusParams): SyncStatusData {
  const data: SyncStatusData = {
    projectName: stripAnsi(p.projectName),
    branch: p.branch === null ? null : stripAnsi(p.branch),
    totalSecrets: p.totalSecrets,
    localMatchesPinned: p.localMatchesPinned,
    remoteState: remoteState(p),
    diffs: p.diffs.map((d) => ({ variable: d.variable, type: d.type, side: diffSide(d) })),
    expiring: p.expiring,
    json: p.json,
    // The CLI's own last line, and the reason it differs: a caller who cannot
    // read the remote is told to redeem rather than to sync, because syncing
    // will fail the same way again.
    nextCommand:
      p.diffs.length === 0
        ? undefined
        : p.remoteFailure === 'access_denied'
          ? 'capy redeem [invite-code]'
          : 'capy',
    nonTty: {
      command: 'capy status --json',
      why: 'The report is the same either way; --json is the copy a script reads.',
    },
  };
  if (p.remoteFailure) data.remoteFailure = p.remoteFailure;
  return data;
}

/**
 * Serve one report and stop.
 *
 * Returns as soon as the page is being served, not when it is read: the
 * listening socket holds the process open by itself, so the CLI hands the URL
 * over and the run ends when the browser has the page (or when the server's
 * own timeout closes it, if nobody comes).
 */
export async function showSyncStatusInBrowser(p: WebSyncStatusParams): Promise<string> {
  const server = new ScreenServer('sync-status', buildSyncStatusData(p), { timeoutMs: p.timeoutMs });
  const url = await server.start();
  console.log('');
  console.log('  Your status report is in your browser:');
  console.log(`  ${url}`);
  console.log('');
  p.onListen?.(url);
  if (p.open ?? true) await openUrl(url);
  return url;
}

// ---------------------------------------------------------------------------
// sync-result
// ---------------------------------------------------------------------------

export interface WebSyncResultParams {
  projectName: string;
  branch: string | null;
  outcome: SyncResultData['outcome'];
  pulled: SyncResultChange[];
  pushed: SyncResultChange[];
  /**
   * Whether the working `.env` changed on disk. Not derived from `pulled`:
   * `capy` re-encrypts and rewrites the whole file even when nothing differed,
   * and it rewrites nothing at all when the run was skipped.
   */
  envRewritten: boolean;
  open?: boolean;
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

export function buildSyncResultData(p: WebSyncResultParams): SyncResultData {
  return {
    projectName: stripAnsi(p.projectName),
    branch: p.branch === null ? null : stripAnsi(p.branch),
    outcome: p.outcome,
    pulled: p.pulled,
    pushed: p.pushed,
    envRewritten: p.envRewritten,
    nonTty: {
      command: 'capy status --json',
      why: 'The run has already happened; --json is how the same state is read back without a browser.',
    },
  };
}

/** Serve the end-of-run report. Same one-shot posture as the status page. */
export async function showSyncResultInBrowser(p: WebSyncResultParams): Promise<string> {
  const server = new ScreenServer('sync-result', buildSyncResultData(p), { timeoutMs: p.timeoutMs });
  const url = await server.start();
  console.log('');
  console.log('  What this run did is in your browser:');
  console.log(`  ${url}`);
  console.log('');
  p.onListen?.(url);
  if (p.open ?? true) await openUrl(url);
  return url;
}

/** Best-effort browser open; the printed URL is the fallback. */
async function openUrl(url: string): Promise<void> {
  try {
    const open = (await import('open')).default;
    await open(url);
  } catch {
    /* the URL is printed above */
  }
}

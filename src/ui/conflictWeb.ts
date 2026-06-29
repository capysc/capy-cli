// Browser-rendered counterpart to ResolveTable: the `capy --web` sync conflict
// resolver. Renders the same per-variable diff (Pinned / Local / Remote snippets)
// as a CLI-style three-column table and returns the SAME { choices, cancelled }
// shape the TTY ResolveTable returns — so the downstream apply logic in capyCommand
// is identical regardless of how the user chose.
//
// Only SNIPPETS (e.g. `sk_...001`, first3…last3) are sent to the page, never full
// secret values — matching the TTY table. The user's selection flows back over the
// loopback only; this transport never prints or logs it.
//
// Branding: sharp corners, black/white high contrast, and light-dark() colours so
// the page follows the OS theme like the rest of Capy's web pages.
import { runBrowserWizard } from './browserWizard';
import type { ResolveRow, ResolveResult } from './resolveTable';

type Choice = ResolveResult['choices'][string]; // 'pinned' | 'local' | 'remote' | 'delete'

export interface WebResolveParams {
  rows: ResolveRow[];
  showLocal: boolean;
  showRemote: boolean;
  projectName: string;
  branch: string;
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A CSS colour that follows the OS theme: light value first, dark value second. */
const ld = (light: string, dark: string): string => `light-dark(${light},${dark})`;

const MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace';
const FG = ld('#111', '#fff');
const MUTED = ld('#6b7280', '#9ca3af');
const LINE = ld('#000', '#fff');
const DANGER = ld('#b91c1c', '#f87171');

interface Col {
  key: Choice;
  label: string;
}

/** The snippet to show for a given source on a row, or null if it has no value there. */
function cellValue(row: ResolveRow, key: Choice): string | null {
  if (key === 'pinned') return row.pinned && stripAnsi(row.pinned) !== 'unresolvable' ? stripAnsi(row.pinned) : null;
  if (key === 'local') return row.local ? stripAnsi(row.local) : null;
  if (key === 'remote') return row.remote ? stripAnsi(row.remote) : null;
  return '✕'; // 'delete' is always a selectable column
}

/** Visible columns — Pinned/Local/Remote only when present, plus Delete. Mirrors the CLI table. */
function columnsFor(rows: ResolveRow[], showLocal: boolean, showRemote: boolean): Col[] {
  const cols: Col[] = [];
  if (rows.some((r) => cellValue(r, 'pinned') !== null)) cols.push({ key: 'pinned', label: 'Pinned' });
  if (showLocal) cols.push({ key: 'local', label: 'Local' });
  if (showRemote) cols.push({ key: 'remote', label: 'Remote' });
  cols.push({ key: 'delete', label: 'Delete' });
  return cols;
}

/** First real source present on the row (Local → Remote → Pinned); never defaults to delete. */
function defaultKey(row: ResolveRow, cols: Col[]): Choice {
  for (const pref of ['local', 'remote', 'pinned'] as const) {
    if (cols.some((c) => c.key === pref) && cellValue(row, pref) !== null) return pref;
  }
  return 'delete';
}

function rowHtml(row: ResolveRow, cols: Col[]): string {
  const name = esc(row.variable);
  const def = defaultKey(row, cols);
  const cells = cols
    .map((c) => {
      const v = cellValue(row, c.key);
      if (v === null) {
        return `<td style="padding:6px 10px;text-align:center;color:${MUTED};border-top:1px solid ${LINE};">–</td>`;
      }
      const checked = c.key === def ? ' checked' : '';
      const isDel = c.key === 'delete';
      const snippet = isDel
        ? `<span class="cf-snip" style="color:${DANGER};font-size:13px;">discard</span>`
        : `<code class="cf-snip" style="font-family:${MONO};font-size:13px;color:${FG};">${esc(v)}</code>`;
      // The whole cell is the radio's label, so clicking anywhere in it selects.
      return `<td style="padding:0;border-top:1px solid ${LINE};">
        <label style="display:flex;align-items:center;gap:8px;justify-content:center;padding:8px 10px;cursor:pointer;">
          <input type="radio" name="${name}" value="${c.key}"${checked} style="accent-color:${LINE};width:15px;height:15px;flex:none;">
          ${snippet}
        </label></td>`;
    })
    .join('');
  return `<tr><td style="padding:8px 12px;font-family:${MONO};font-weight:600;font-size:13px;color:${FG};border-top:1px solid ${LINE};white-space:nowrap;">${name}</td>${cells}</tr>`;
}

export function buildScreenHtml(p: WebResolveParams): string {
  const n = p.rows.length;
  const cols = columnsFor(p.rows, p.showLocal, p.showRemote);
  const intro = `<p style="margin:0 0 16px;color:${FG};">You have <strong>${n}</strong> environment variable${
    n !== 1 ? 's' : ''
  } that differ. For each, pick which column's value to keep — then apply.</p>`;
  const head = `<th style="text-align:left;padding:8px 12px;font-size:12px;color:${MUTED};font-weight:600;">Variable</th>${cols
    .map(
      (c) =>
        `<th style="text-align:center;padding:8px 10px;font-size:12px;color:${
          c.key === 'delete' ? DANGER : MUTED
        };font-weight:600;">${c.label}</th>`,
    )
    .join('')}`;
  const body = p.rows.map((r) => rowHtml(r, cols)).join('');
  // `:has(:checked)` highlights the selected cell — the web analogue of the CLI's
  // inverse-video selection box. Injected with the screen so it travels with it.
  const style = `<style>
    .cf-table{width:100%;border-collapse:collapse;border:1px solid ${LINE};margin:0 0 16px;}
    .cf-table thead tr{background:${ld('#f5f5f5', '#111')};border-bottom:1px solid ${LINE};}
    .cf-table td label:has(input:checked){background:${LINE};}
    .cf-table td label:has(input:checked) .cf-snip{color:${ld('#fff', '#000')} !important;}
  </style>`;
  // color-scheme on the wrapper enables light-dark() to follow the OS theme. Two
  // forms carry a distinct __action without per-screen JS (the shared wizard handler
  // serializes whichever form is submitted); the radios live in the apply form.
  return `<div style="color-scheme:light dark;">
    ${style}
    ${intro}
    <form>
      <input type="hidden" name="__action" value="apply">
      <table class="cf-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      <button type="submit" style="width:100%;background:${LINE};color:${ld('#fff', '#000')};border:none;padding:12px 16px;font-size:15px;font-weight:600;cursor:pointer;">Apply &amp; commit locally</button>
    </form>
    <form style="margin-top:10px;">
      <input type="hidden" name="__action" value="cancel">
      <button type="submit" style="width:100%;background:transparent;color:${FG};border:1px solid ${LINE};padding:10px 16px;font-size:14px;cursor:pointer;">Cancel — keep working, change nothing</button>
    </form>
  </div>`;
}

/**
 * Render the conflict resolver in the browser and resolve with the user's choice.
 * Returns the same shape as ResolveTable.run(): a per-variable choice map, or
 * `{ cancelled: true }` if the user backed out.
 */
export async function resolveConflictInBrowser(p: WebResolveParams): Promise<ResolveResult> {
  const out = await runBrowserWizard(
    {
      title: `Resolve ${p.rows.length} conflict${p.rows.length !== 1 ? 's' : ''} — ${p.projectName}/${p.branch}`,
      firstScreen: { html: buildScreenHtml(p) },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Resolved — back to your terminal.',
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { choices: {}, cancelled: true } satisfies ResolveResult };
      }
      const choices: ResolveResult['choices'] = {};
      for (const row of p.rows) {
        const c = payload[row.variable];
        if (c === 'pinned' || c === 'local' || c === 'remote' || c === 'delete') {
          choices[row.variable] = c;
        }
      }
      return { done: true, result: { choices, cancelled: false } satisfies ResolveResult };
    },
  );
  return out as ResolveResult;
}

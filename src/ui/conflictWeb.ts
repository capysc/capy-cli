// Browser-rendered counterpart to ResolveTable: the `capy --web` sync conflict
// resolver. Renders the same per-variable diff (Pinned / Local / Remote snippets)
// as a single web screen with one radio group per variable, and returns the SAME
// { choices, cancelled } shape the TTY ResolveTable returns — so the downstream
// apply logic in capyCommand is identical regardless of how the user chose.
//
// Only SNIPPETS (e.g. `sk_...001`, first3…last3) are sent to the page, never full
// secret values — matching the TTY table. The user's selection flows back over the
// loopback only; this transport never prints or logs it.
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

interface Opt {
  value: Choice;
  label: string;
  snippet: string;
}

/** The selectable sources for one variable, in default-preference order. */
function optionsForRow(row: ResolveRow, showLocal: boolean, showRemote: boolean): Opt[] {
  const opts: Opt[] = [];
  if (showLocal && row.local) {
    opts.push({ value: 'local', label: 'Local edit', snippet: stripAnsi(row.local) });
  }
  if (row.pinned && stripAnsi(row.pinned) !== 'unresolvable') {
    opts.push({ value: 'pinned', label: 'Pinned baseline', snippet: stripAnsi(row.pinned) });
  }
  if (showRemote && row.remote) {
    opts.push({ value: 'remote', label: 'Remote (teammate)', snippet: stripAnsi(row.remote) });
  }
  opts.push({ value: 'delete', label: 'Delete this variable', snippet: '—' });
  return opts;
}

function rowHtml(row: ResolveRow, showLocal: boolean, showRemote: boolean): string {
  const name = esc(row.variable);
  const opts = optionsForRow(row, showLocal, showRemote);
  // Default to the first real source (Local edit when present) — never "delete".
  const defaultValue = opts.find((o) => o.value !== 'delete')?.value ?? 'delete';
  const optionsHtml = opts
    .map((o) => {
      const checked = o.value === defaultValue ? ' checked' : '';
      const isDelete = o.value === 'delete';
      return `
      <label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;cursor:pointer;border:1px solid transparent;">
        <input type="radio" name="${name}" value="${o.value}"${checked} style="accent-color:#000;width:16px;height:16px;">
        <span style="min-width:140px;font-weight:500;${isDelete ? 'color:#b91c1c;' : ''}">${esc(o.label)}</span>
        <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#6b7280;">${esc(o.snippet)}</code>
      </label>`;
    })
    .join('');
  return `
    <fieldset style="border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px;margin:0 0 14px;">
      <legend style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;font-size:14px;padding:0 6px;">${name}</legend>
      ${optionsHtml}
    </fieldset>`;
}

function buildScreenHtml(p: WebResolveParams): string {
  const n = p.rows.length;
  const intro = `<p style="margin:0 0 18px;color:#374151;">You have <strong>${n}</strong> environment variable${
    n !== 1 ? 's' : ''
  } that differ. Pick which value to keep for each, then apply.</p>`;
  const rows = p.rows.map((r) => rowHtml(r, p.showLocal, p.showRemote)).join('');
  // Two forms so we can carry a distinct __action without per-screen JS (the shared
  // wizard handler serializes whichever form is submitted). The radios live in the
  // apply form; cancel is its own form.
  return `
    ${intro}
    <form>
      <input type="hidden" name="__action" value="apply">
      ${rows}
      <button type="submit" style="margin-top:6px;width:100%;background:#000;color:#fff;border:none;border-radius:10px;padding:12px 16px;font-size:15px;font-weight:600;cursor:pointer;">Apply &amp; commit locally</button>
    </form>
    <form style="margin-top:10px;">
      <input type="hidden" name="__action" value="cancel">
      <button type="submit" style="width:100%;background:transparent;color:#6b7280;border:1px solid #e5e7eb;border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;">Cancel — keep working, change nothing</button>
    </form>`;
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

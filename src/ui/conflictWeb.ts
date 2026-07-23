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
// Tailwind `neutral` palette (matches the rest of Capy's web pages), not `gray`.
const FG = ld('#171717', '#fafafa'); // neutral-900 / neutral-50
const MUTED = ld('#737373', '#a3a3a3'); // neutral-500 / neutral-400
const LINE = ld('#000', '#fff');
const DANGER = ld('#b91c1c', '#f87171');

interface Opt {
  key: Choice;
  label: string;
  snippet: string | null;
}

/** Selectable sources for one variable, in default-preference order, plus delete. */
function optionsForRow(row: ResolveRow, showLocal: boolean, showRemote: boolean): Opt[] {
  const opts: Opt[] = [];
  const pinned = row.pinned && stripAnsi(row.pinned) !== 'unresolvable' ? stripAnsi(row.pinned) : null;
  if (showLocal && row.local) opts.push({ key: 'local', label: 'Local edit', snippet: stripAnsi(row.local) });
  if (pinned) opts.push({ key: 'pinned', label: 'Pinned baseline', snippet: pinned });
  if (showRemote && row.remote) opts.push({ key: 'remote', label: 'Remote (teammate)', snippet: stripAnsi(row.remote) });
  opts.push({ key: 'delete', label: 'Delete this variable', snippet: null });
  return opts;
}

/** One variable: a mono heading (with a top rule) over its stacked, selectable options. */
function rowHtml(row: ResolveRow, showLocal: boolean, showRemote: boolean): string {
  const name = esc(row.variable);
  const opts = optionsForRow(row, showLocal, showRemote);
  const def = opts.find((o) => o.key !== 'delete')?.key ?? 'delete';
  const optionRows = opts
    .map((o) => {
      const checked = o.key === def ? ' checked' : '';
      const labelColor = o.key === 'delete' ? DANGER : FG;
      const snip = o.snippet
        ? `<code class="cf-snip" style="font-family:${MONO};font-size:13px;color:${MUTED};">${esc(o.snippet)}</code>`
        : '';
      // The whole row is the radio's label, so clicking anywhere selects it.
      return `<label class="cf-opt" style="display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;">
        <input type="radio" name="${name}" value="${o.key}"${checked} style="accent-color:${LINE};width:15px;height:15px;flex:none;">
        <span class="cf-lab" style="min-width:150px;font-weight:500;color:${labelColor};">${o.label}</span>
        ${snip}
      </label>`;
    })
    .join('');
  return `<div style="margin:0 0 4px;">
    <div style="font-family:${MONO};font-weight:600;font-size:13px;color:${FG};padding:14px 12px 6px;border-top:1px solid ${LINE};">${name}</div>
    ${optionRows}
  </div>`;
}

export function buildScreenHtml(p: WebResolveParams): string {
  const n = p.rows.length;
  const intro = `<p style="margin:0 0 6px;color:${FG};">You have <strong>${n}</strong> environment variable${
    n !== 1 ? 's' : ''
  } that differ. For each, pick which value to keep — then apply.</p>`;
  const body = p.rows.map((r) => rowHtml(r, p.showLocal, p.showRemote)).join('');
  // `:has(:checked)` fills the selected option — the web analogue of the CLI's
  // inverse-video selection. The radio's accent flips so its ring stays visible on
  // the inverted background. Injected with the screen so it travels with it.
  const style = `<style>
    .cf-opt:has(input:checked){background:${LINE};}
    .cf-opt:has(input:checked) .cf-lab{color:${ld('#fff', '#000')} !important;}
    .cf-opt:has(input:checked) .cf-snip{color:${ld('#fff', '#000')} !important;}
    .cf-opt:has(input:checked) input{accent-color:${ld('#fff', '#000')} !important;}
  </style>`;
  // color-scheme on the wrapper enables light-dark() to follow the OS theme. Two
  // forms carry a distinct __action without per-screen JS (the shared wizard handler
  // serializes whichever form is submitted); the radios live in the apply form.
  return `<div style="color-scheme:light dark;">
    ${style}
    ${intro}
    <form>
      <input type="hidden" name="__action" value="apply">
      ${body}
      <button type="submit" style="width:100%;background:${LINE};color:${ld('#fff', '#000')};border:none;padding:12px 16px;font-size:15px;font-weight:600;cursor:pointer;margin-top:18px;">Apply &amp; commit locally</button>
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

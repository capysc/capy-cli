// Browser-rendered replacements for the interactive TTY prompts used during
// `capy` first-run setup (org picker, project picker, project-name input). Under
// `--web` the process has no interactive terminal (e.g. it's driven through the
// MCP), so an inquirer prompt would hang forever with nothing on screen. These
// render the same choices/inputs as a single loopback screen and return the
// user's answer.
//
// No secret material is involved — only names/ids already known to the client.
import { runBrowserWizard, type WizardScreen } from './browserWizard';

export interface SelectOption {
  id: string;
  name: string;
  /** Small muted subtitle under the option label. */
  note?: string;
  /** Small accent badge after the label (e.g. "← current"). */
  badge?: string;
}

export interface SelectWebOptions {
  open?: boolean;
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A CSS colour that follows the OS theme: light value first, dark value second. */
const ld = (light: string, dark: string): string => `light-dark(${light},${dark})`;
const MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace';
// Tailwind `neutral` palette (matches the rest of Capy's web pages), not `gray`.
const FG = ld('#171717', '#fafafa'); // neutral-900 / neutral-50
const MUTED = ld('#737373', '#a3a3a3'); // neutral-500 / neutral-400
const LINE = ld('#000', '#fff');
const ROW = ld('#e5e5e5', '#404040'); // faint divider — neutral-200 / neutral-700
const ACCENT = ld('#0d9488', '#2dd4bf'); // teal-600 / teal-400

const BTN = `width:100%;background:${LINE};color:${ld('#fff', '#000')};border:none;padding:12px 16px;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px;`;
const NOTE = `color:${MUTED};font-size:13px;margin:8px 0 0;`;
const wrap = (inner: string): string => `<div style="color-scheme:light dark;color:${FG};">${inner}</div>`;

function optionRow(o: SelectOption, checked: boolean, first: boolean): string {
  const badge = o.badge ? ` <span style="color:${ACCENT};font-size:12px;">${esc(o.badge)}</span>` : '';
  const note = o.note ? `<br><span style="${NOTE}">${esc(o.note)}</span>` : '';
  const border = first ? `border-top:1px solid ${ROW};` : '';
  return `
    <label style="display:flex;gap:10px;align-items:center;padding:12px 2px;${border}border-bottom:1px solid ${ROW};cursor:pointer;">
      <input type="radio" name="choice" value="${esc(o.id)}"${checked ? ' checked' : ''} style="accent-color:${LINE};">
      <span><strong>${esc(o.name)}</strong>${badge}${note}</span>
    </label>`;
}

export function selectScreen(intro: string, options: SelectOption[], defaultId?: string): WizardScreen {
  const hasDefault = defaultId != null && options.some(o => o.id === defaultId);
  const rows = options
    .map((o, i) => optionRow(o, hasDefault ? o.id === defaultId : i === 0, i === 0))
    .join('');
  return {
    html: wrap(`
      <p style="margin:0 0 18px;color:${FG};">${esc(intro)}</p>
      <form>
        ${rows}
        <button type="submit" style="${BTN};margin-top:16px;">Continue</button>
      </form>`),
  };
}

/**
 * Render a single-choice list in the browser and resolve with the chosen option
 * id. Resolves null if the user closed/cancelled the page.
 */
export async function selectInBrowser(
  params: { title: string; intro: string; options: SelectOption[]; defaultId?: string },
  opts: SelectWebOptions = {},
): Promise<string | null> {
  const valid = new Set(params.options.map(o => o.id));
  const result = await runBrowserWizard(
    {
      title: params.title,
      firstScreen: selectScreen(params.intro, params.options, params.defaultId),
      open: opts.open ?? true,
      onListen: opts.onListen,
      timeoutMs: opts.timeoutMs,
      doneMessage: 'Selection received — back to your terminal.',
    },
    async (_step, payload) => {
      const choice = typeof payload.choice === 'string' ? payload.choice : '';
      if (!valid.has(choice)) return { error: 'Please choose an option.' };
      return { done: true, result: choice };
    },
  );
  return typeof result === 'string' ? result : null;
}

export function textScreen(intro: string, label: string, defaultValue?: string): WizardScreen {
  const field = `width:100%;box-sizing:border-box;font-family:${MONO};font-size:15px;padding:9px 2px;border:none;border-bottom:1px solid ${LINE};color:${FG};background:transparent;margin-bottom:14px;`;
  return {
    html: wrap(`
      <p style="margin:0 0 12px;color:${FG};">${esc(intro)}</p>
      <form>
        <input type="text" name="value" value="${defaultValue ? esc(defaultValue) : ''}" placeholder="${esc(label)}" autofocus style="${field}">
        <button type="submit" style="${BTN}">Continue</button>
      </form>`),
  };
}

/**
 * Render a single free-text input in the browser and resolve with the entered
 * (trimmed) value. `validate` returns true when valid, or an error string shown
 * inline so the user can retry on the same screen. Resolves null if cancelled.
 */
export async function promptTextInBrowser(
  params: {
    title: string;
    intro: string;
    label: string;
    defaultValue?: string;
    validate?: (input: string) => true | string;
  },
  opts: SelectWebOptions = {},
): Promise<string | null> {
  const result = await runBrowserWizard(
    {
      title: params.title,
      firstScreen: textScreen(params.intro, params.label, params.defaultValue),
      open: opts.open ?? true,
      onListen: opts.onListen,
      timeoutMs: opts.timeoutMs,
      doneMessage: 'Received — back to your terminal.',
    },
    async (_step, payload) => {
      const value = typeof payload.value === 'string' ? payload.value.trim() : '';
      const verdict = params.validate ? params.validate(value) : (value ? true : 'This field is required.');
      if (verdict !== true) return { error: verdict };
      return { done: true, result: value };
    },
  );
  return typeof result === 'string' ? result : null;
}

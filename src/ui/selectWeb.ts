// Browser-rendered replacements for the interactive TTY prompts of the org and
// project pickers. Under `--web` the process has no interactive terminal (e.g.
// it's driven through the MCP), so an inquirer prompt would hang forever with
// nothing on screen.
//
// `capy org`'s three questions — which organization, which project, and what to
// call the first one — are served by the compiled `switch-organization` screen
// (`switchOrganizationInBrowser`, below). It ships one fact the terminal does
// not have: whether this device holds each organization's encryption key. The
// CLI re-scopes the session and prints `Organization: {name}` BEFORE it checks,
// so today you are congratulated on a switch and then handed an error about a
// key you cannot produce; the screen refuses the row instead.
//
// The two generic helpers under it — `selectInBrowser` and
// `promptTextInBrowser` — still hand-write their HTML. They are `capy`'s
// first-run pickers (branch, project, encrypt-and-push), which belong to the
// `init-wizard` screen and to whoever owns `capyCommand.ts`; converting them
// from here would put two agents in one file. They are left exactly as they
// were so that flow keeps working until then.
//
// No secret material is involved — only names/ids already known to the client.
import { runBrowserWizard, type WizardScreen } from './browserWizard';
import { renderScreen } from './screens/serve';
import { ORG_CREATE_STOP_IDS, orgSwitchPlan } from '../core/onboardingPlan';
import type { OrgProjectRow, OrgRow, SwitchOrganizationData } from './screens/contract';

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

/**
 * Strip terminal colour codes on the way into a payload.
 *
 * The refusals this file hands back are sentences the CLI wrote for a terminal
 * — `firstProjectRefusal` bolds the organization name with `\x1b[1m…\x1b[0m`
 * so it stands out in a scrollback — and a payload is not a terminal. Left in,
 * the page renders `Binding it to a project in [1mnorthwind[0m would make
 * those values unreadable.` Applied at the boundary rather than at the source
 * because the source is shared: the TTY path raises the same sentence as a
 * CapyError, where the bold is the point.
 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

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
    /** Sync or async — org-name entry checks availability against the server. */
    validate?: (input: string) => true | string | Promise<true | string>;
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
      const verdict = params.validate ? await params.validate(value) : (value ? true : 'This field is required.');
      // The validator belongs to the caller and may well have formatted its
      // refusal for a terminal.
      if (verdict !== true) return { error: stripAnsi(verdict) };
      return { done: true, result: value };
    },
  );
  return typeof result === 'string' ? result : null;
}

// ---------------------------------------------------------------------------
// switch-organization — capy org --web
// ---------------------------------------------------------------------------

/** Which of the two stops the picker is standing on. */
type SwitchOrgView = 'org' | 'project' | 'first-project';

/** What the screen needs to draw, independent of which question it is asking. */
export interface OrgScreenFacts {
  /** Email of the signed-in user, so a wrong-account switch is obvious. */
  signedInAs?: string;
  /** The org the working directory is pinned to, when there is one. */
  currentOrgId?: string;
  /**
   * Every org this user belongs to, each carrying whether THIS DEVICE holds
   * its encryption key. That flag is the point: without it the run announces a
   * successful switch and then fails on a key the user cannot produce.
   */
  orgs: OrgRow[];
  /** Whether the cwd already has a keep.lock pinning it to some project. */
  hasKeepLock: boolean;
  /** Suggested name for the first project, prefilled by the CLI. */
  defaultProjectName?: string;
  /** The branch a first project is bootstrapped with. Hardcoded `development`. */
  firstBranchName?: string;
}

export interface WebSwitchOrgParams extends OrgScreenFacts {
  /**
   * The work between the two questions: re-scope the session to `orgId`, check
   * this device can decrypt for it, and list its projects.
   *
   * Answers with a shape rather than throwing, so a switch that fails is a
   * refusal the user can answer by picking a different row — not a dead page
   * waiting on a command that has already given up.
   */
  onOrgChosen: (
    orgId: string,
  ) => Promise<{ ok: true; projects: OrgProjectRow[] } | { ok: false; reason: string }>;
  /** Open the browser automatically (false in tests; the URL is still printed). */
  open?: boolean;
  /** Test hook: receives the loopback URL once listening. */
  onListen?: (url: string) => void;
  timeoutMs?: number;
}

/**
 * What the browser settled.
 *
 * `create` resolves out rather than continuing here: naming an organization and
 * writing down its recovery phrase is the `create-organization` screen's job,
 * and the CLI has real work to do — creating the org, re-scoping the session —
 * before there is a project list to ask about.
 */
export type WebSwitchOrgResult =
  | { action: 'create'; cancelled: false }
  | { action: 'select-project'; orgId: string; projectId: string; cancelled: false }
  | { action: 'create-project'; orgId: string; projectName: string; cancelled: false }
  | { action: 'cancel'; cancelled: true };

export interface SwitchOrgState {
  /** The org chosen so far. */
  orgId?: string;
  /** Projects in it, once listed. An empty array is a real state. */
  projects?: OrgProjectRow[];
}

function switchOrgView(s: SwitchOrgState): SwitchOrgView {
  if (!s.orgId || s.projects === undefined) return 'org';
  return s.projects.length === 0 ? 'first-project' : 'project';
}

export function buildSwitchOrganizationData(
  p: OrgScreenFacts & {
    state?: SwitchOrgState;
    /**
     * This window opened AFTER the create route was walked — the organization
     * was named, its recovery phrase was written down, and it exists.
     *
     * Without it the rail on the very next screen strikes those three stops
     * through as "not needed", which is the route describing a different run
     * than the one that just happened.
     */
    created?: boolean;
  },
  nonce: string,
): SwitchOrganizationData {
  const s = p.state ?? {};
  const view = switchOrgView(s);
  const chosen = p.orgs.find(o => o.id === s.orgId);

  return {
    nonce,
    mode: 'switch',
    signedInAs: p.signedInAs,
    currentOrgId: p.currentOrgId,
    orgs: p.orgs,
    allowCreate: true,
    stops: orgSwitchPlan({ orgName: chosen?.name, created: p.created }),
    createStopIds: ORG_CREATE_STOP_IDS,
    projects: view === 'project' ? s.projects : undefined,
    view,
    subjectOrgName: chosen?.name,
    // The truth about this directory, not about this route. CAP-316 has the
    // screen skip the rail when a keep.lock exists because a switch is then
    // one decision — but this CLI still asks for a project either way, so the
    // flag says what is on disk and the plan above says what will be asked.
    hasKeepLock: p.hasKeepLock,
    defaultProjectName: p.defaultProjectName,
    firstBranchName: p.firstBranchName,
    nonTty: {
      command: 'capy org',
      why: 'Switching organization changes which secrets this session can read, and creating one generates a recovery phrase that is shown once. Neither is chosen for you.',
    },
  };
}

/**
 * Serve `capy org`'s questions and return what was chosen.
 *
 * Two stops in one window: the organization, then the project — the second
 * arrives by reloading the same address, because a compiled screen is a whole
 * document and cannot be spliced into the page that asked the first question.
 */
export async function switchOrganizationInBrowser(
  p: WebSwitchOrgParams,
): Promise<WebSwitchOrgResult> {
  const state: SwitchOrgState = {};
  let nonce = '';

  const render = (): string =>
    renderScreen('switch-organization', buildSwitchOrganizationData({ ...p, state }, nonce));

  const out = await runBrowserWizard(
    {
      title: 'Switch organization',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Chosen — back to your terminal.',
      renderFirst: (n) => {
        nonce = n;
        return render();
      },
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') {
        return { done: true, result: { action: 'cancel', cancelled: true } };
      }

      const view = switchOrgView(state);

      if (view === 'org') {
        if (payload.__action === 'create') {
          return { done: true, result: { action: 'create', cancelled: false } };
        }
        if (payload.__action !== 'switch') {
          return { error: 'That is not an action this screen offers.' };
        }
        const orgId = typeof payload.orgId === 'string' ? payload.orgId : '';
        const org = p.orgs.find(o => o.id === orgId);
        // Three refusals the screen already makes for itself — it holds its
        // button on all three — so any of them arriving means the submit did
        // not come from the screen.
        if (!org) return { error: 'That organization is not one you belong to.' };
        if (org.id === p.currentOrgId) {
          return { error: `This directory is already on ${org.name}.` };
        }
        if (!org.hasLocalKey) {
          return {
            error: `This machine has no encryption key for ${org.name}, so nothing there would decrypt.`,
          };
        }

        const outcome = await p.onOrgChosen(orgId);
        // The reason is the CLI's own sentence, written for a scrollback: the
        // first-project refusal bolds the organization name and the auth layer
        // hands back whatever the service said. It reaches a browser here, so
        // the escapes come off before it does.
        if (!outcome.ok) return { error: stripAnsi(outcome.reason) };
        state.orgId = orgId;
        state.projects = outcome.projects;
        return { screen: { html: render(), standalone: true } };
      }

      if (view === 'project') {
        if (payload.__action !== 'select-project') {
          return { error: 'That is not an action this screen offers.' };
        }
        const projectId = typeof payload.projectId === 'string' ? payload.projectId : '';
        if (!state.projects!.some(pr => pr.id === projectId)) {
          return { error: 'That project is not in this organization.' };
        }
        return {
          done: true,
          result: { action: 'select-project', orgId: state.orgId!, projectId, cancelled: false },
        };
      }

      // first-project: the org has none, so switching to it means creating one.
      if (payload.__action !== 'create-project') {
        return { error: 'That is not an action this screen offers.' };
      }
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!name) return { error: 'Project name cannot be empty' };
      return {
        done: true,
        result: {
          action: 'create-project',
          orgId: state.orgId!,
          projectName: name,
          cancelled: false,
        },
      };
    },
  );
  return out as WebSwitchOrgResult;
}

/**
 * Ask only for the first project's name, on the same screen.
 *
 * The create-a-new-organization route arrives here having already answered the
 * organization question — it created the answer — so re-serving the picker
 * would ask which of one. Resolves null when the user cancelled, which is the
 * browser's version of answering no to the terminal's `Create the first project
 * in X here?`.
 */
export async function nameFirstProjectInBrowser(
  p: OrgScreenFacts & {
    /** The org the project will belong to. Already chosen; already created. */
    orgId: string;
    open?: boolean;
    onListen?: (url: string) => void;
    timeoutMs?: number;
  },
): Promise<string | null> {
  const state: SwitchOrgState = { orgId: p.orgId, projects: [] };
  const out = await runBrowserWizard(
    {
      title: 'First project',
      firstScreen: { html: '', standalone: true },
      open: p.open ?? true,
      onListen: p.onListen,
      timeoutMs: p.timeoutMs,
      doneMessage: 'Named — back to your terminal.',
      renderFirst: (nonce) =>
        renderScreen(
          'switch-organization',
          // `created`, because this window is only ever served after the create
          // route has been walked — the rail behind this question is history,
          // not a branch this run declined.
          buildSwitchOrganizationData({ ...p, state, created: true }, nonce),
        ),
    },
    async (_step, payload) => {
      if (payload.__action === 'cancel') return { done: true, result: { name: null } };
      if (payload.__action !== 'create-project') {
        return { error: 'That is not an action this screen offers.' };
      }
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!name) return { error: 'Project name cannot be empty' };
      return { done: true, result: { name } };
    },
  );
  const name = (out as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

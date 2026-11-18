/**
 * Which stored repo row a pull request goes to, when a project has more than one.
 *
 * A project's repo rows say where the project was seen: a repo and a folder. With one row there is nothing to choose.
 * With several, nothing here decides: the person is asked. `--pr-repo <project_id>=<owner/name[/folder]>` (repeatable)
 * is the answer on the command line; the screens ask with a list. In agent mode the question rides in a refusal
 * (`PR_REPO_AMBIGUOUS`, exit 3) as an elicitation, so the agent puts it to the human.
 *
 * Pure: no network, no git, no prompt. Only GitHub rows count (only they can get a PR); every other link passes through.
 */
import type { OrgRepoLink } from '../service/serviceClient';
import type { ElicitationForm } from '../ui/elicitation';
import { chooseRepoDisplay } from '../ui/elicitationDisplay';

const GITHUB_HOST = 'github.com';

export const PR_REPO_FLAG = '--pr-repo';

interface RowLike {
  readonly owner: string;
  readonly name: string;
  readonly path: string;
}

/** `owner/name` at the repo root, `owner/name/folder` otherwise: what the flag takes and what the person is shown. */
export const repoRowValue = (row: RowLike): string => (row.path === '.' ? `${row.owner}/${row.name}` : `${row.owner}/${row.name}/${row.path}`);

/** Case-insensitive on owner and name (as GitHub is), exact on the folder. */
const rowKeyOf = (row: RowLike): string => `${row.owner.toLowerCase()}/${row.name.toLowerCase()}\u0000${row.path}`;

const isGithub = (link: OrgRepoLink): boolean => link.host.toLowerCase() === GITHUB_HOST;

/** A project that is linked to more than one row, with the rows to choose between (as `repoRowValue`). */
export interface AmbiguousProject {
  readonly project_id: string;
  readonly project_name: string;
  readonly rows: readonly string[];
}

/** One `--pr-repo` answer. */
export interface PrRepoChoice {
  readonly project_id: string;
  readonly row: string;
}

export type ParsedPrRepoFlags =
  | { readonly ok: true; readonly choices: readonly PrRepoChoice[] }
  /** `token`: the first value that is not `<project_id>=<owner/name[/folder]>`. */
  | { readonly ok: false; readonly token: string };

function parseOne(token: string): PrRepoChoice | null {
  const at = token.indexOf('=');
  if (at <= 0) return null;
  const project_id = token.slice(0, at).trim();
  const row = token.slice(at + 1).trim();
  const parts = row.split('/');
  if (project_id === '' || parts.length < 2 || parts.some((p) => p === '')) return null;
  return { project_id, row };
}

/** The `--pr-repo` values as typed. */
export function parsePrRepoFlags(tokens: readonly string[]): ParsedPrRepoFlags {
  const parsed = tokens.map((token) => ({ token, choice: parseOne(token) }));
  const bad = parsed.find((p) => p.choice === null);
  if (bad !== undefined) return { ok: false, token: bad.token };
  return { ok: true, choices: parsed.flatMap((p) => (p.choice === null ? [] : [p.choice])) };
}

/** A flag value (`owner/name[/folder]`) as a row key. */
function keyOfValue(value: string): string {
  const [owner, name, ...folder] = value.split('/');
  return rowKeyOf({ owner, name, path: folder.length === 0 ? '.' : folder.join('/') });
}

/** The distinct GitHub rows of one project, in the order the service gave them. */
function rowsOf(links: readonly OrgRepoLink[], projectId: string): readonly OrgRepoLink[] {
  const mine = links.filter((l) => l.project_id === projectId && isGithub(l));
  return mine.filter((l, i) => mine.findIndex((o) => rowKeyOf(o) === rowKeyOf(l)) === i);
}

/** The projects among `projectIds` that are linked to more than one row. */
export function ambiguousProjects(links: readonly OrgRepoLink[], projectIds: readonly string[]): readonly AmbiguousProject[] {
  return [...new Set(projectIds)].flatMap((id) => {
    const rows = rowsOf(links, id);
    return rows.length > 1 ? [{ project_id: id, project_name: rows[0].project_name, rows: rows.map(repoRowValue) }] : [];
  });
}

export interface RowChoiceOutcome {
  /** The links a run plans from: a project with several rows keeps only the chosen ones. */
  readonly links: readonly OrgRepoLink[];
  /** The projects with several rows and no answer: the person must be asked. */
  readonly unanswered: readonly AmbiguousProject[];
  /** `--pr-repo` values that name no row of a project in this run. */
  readonly unmatched: readonly string[];
}

/**
 * Applies the answers. A project of this run with one row needs none. A project with several rows keeps the rows its
 * answers name (one or more); with no answer it is `unanswered` and its rows are left out of `links`.
 */
export function chooseRepoRows(
  links: readonly OrgRepoLink[],
  projectIds: readonly string[],
  choices: readonly PrRepoChoice[],
): RowChoiceOutcome {
  const ids = [...new Set(projectIds)];
  const chosenKeysOf = (id: string): ReadonlySet<string> => new Set(choices.filter((c) => c.project_id === id).map((c) => keyOfValue(c.row)));
  const unmatched = choices
    .filter((c) => !ids.includes(c.project_id) || !rowsOf(links, c.project_id).some((l) => rowKeyOf(l) === keyOfValue(c.row)))
    .map((c) => `${c.project_id}=${c.row}`);
  const ambiguous = ambiguousProjects(links, ids);
  const unanswered = ambiguous.filter((p) => chosenKeysOf(p.project_id).size === 0);
  const ambiguousIds = new Set(ambiguous.map((p) => p.project_id));
  const kept = links.filter((l) => {
    if (!isGithub(l) || !ambiguousIds.has(l.project_id)) return true;
    return chosenKeysOf(l.project_id).has(rowKeyOf(l));
  });
  return { links: kept, unanswered, unmatched };
}

// ── What a refusal carries ───────────────────────────────────────────────────

// COPY-FLAG: minimal and neutral, awaiting approval.
export const PR_REPO_AMBIGUOUS_MESSAGE = `A project is linked to more than one repo. Choose ${PR_REPO_FLAG} <project_id>=<owner/name[/folder]> for each.`;
const PR_REPO_QUESTION = 'Which repo gets the pull request?';

/** Shaped like the other `unanswered` stops: the stop, the flag that answers it, and what to choose between. */
export const prRepoStop = (unanswered: readonly AmbiguousProject[]) => [
  {
    id: 'pr_repo',
    flag: PR_REPO_FLAG,
    candidates: unanswered.map((p) => ({ project_id: p.project_id, project: p.project_name, repos: p.rows })),
  },
];

/** The same choice as lines for a person at a terminal (stderr). */
export const prRepoLines = (unanswered: readonly AmbiguousProject[]): readonly string[] =>
  unanswered.flatMap((p) => [`  ${p.project_name} (${p.project_id})`, ...p.rows.map((row) => `    ${PR_REPO_FLAG} ${p.project_id}=${row}`)]);

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The question for the human, handed to the agent: one field per project, its options the project's rows.
 * `rerun` is the same command with the answers still to fill in; the field of project N is `<repo_N>`.
 */
export function prRepoElicitation(unanswered: readonly AmbiguousProject[], rerunBase: string): ElicitationForm {
  const fieldOf = (i: number): string => `repo_${i + 1}`;
  return {
    kind: 'form',
    question: PR_REPO_QUESTION,
    details: { projects: unanswered.map((p) => ({ id: p.project_id, name: p.project_name, repos: p.rows })) },
    display: chooseRepoDisplay(unanswered.flatMap((p) => p.rows.map((row) => [p.project_name, row] as const))),
    fields: unanswered.map((p, i) => ({
      name: fieldOf(i),
      type: 'string' as const,
      pattern: `^(${p.rows.map(escapeRegex).join('|')})$`,
      question: `Which repo for ${p.project_name}?`, // COPY-FLAG
      options: p.rows.map((row) => ({ value: row, label: row })),
    })),
    answer: { rerun: [rerunBase, ...unanswered.map((p, i) => `${PR_REPO_FLAG} ${p.project_id}=<${fieldOf(i)}>`)].join(' ') },
  };
}

/** What a `PR_REPO_AMBIGUOUS` refusal carries next to its code. */
export const prRepoRefusalExtra = (unanswered: readonly AmbiguousProject[], rerunBase: string) => ({
  unanswered: prRepoStop(unanswered),
  elicitation: prRepoElicitation(unanswered, rerunBase),
});

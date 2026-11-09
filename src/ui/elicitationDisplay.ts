/**
 * The `display` of an elicitation: a markdown table the agent prints exactly as given, before it asks the question.
 * One renderer per elicitation, so every agent shows the human the same thing and none can shorten or reorder it.
 * Built from names and ids only, like `details`.
 */

/** A table cell: pipes escaped and line breaks flattened, so a name can never break the table. */
function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function table(headers: readonly [string, string], rows: readonly (readonly [string, string])[]): string {
  return [
    `| ${cell(headers[0])} | ${cell(headers[1])} |`,
    '| --- | --- |',
    ...rows.map(([a, b]) => `| ${cell(a)} | ${cell(b)} |`),
  ].join('\n');
}

export interface DeleteDisplayInput {
  readonly org: { readonly id: string; readonly name: string };
  readonly project: { readonly id: string; readonly name: string };
  readonly branches: readonly string[];
  readonly variables: ReadonlyArray<{ readonly name: string; readonly branches: readonly string[] }>;
  readonly liveDeployTokens: ReadonlyArray<{ readonly deploy_id: string; readonly label?: string | null }>;
  readonly unavailable: readonly ('branches' | 'variables')[];
}

// COPY-FLAG: every heading and placeholder below is minimal and neutral, awaiting approval.
const NONE = 'none';
const UNREADABLE = 'could not be read';

function branchesCell(input: DeleteDisplayInput): string {
  if (input.unavailable.includes('branches')) return UNREADABLE;
  return input.branches.length === 0 ? NONE : input.branches.join(', ');
}

function tokensCell(input: DeleteDisplayInput): string {
  if (input.liveDeployTokens.length === 0) return NONE;
  return input.liveDeployTokens.map((t) => (t.label ? `${t.deploy_id} (${t.label})` : t.deploy_id)).join(', ');
}

function variablesSection(input: DeleteDisplayInput): string {
  if (input.unavailable.includes('variables')) return `Variables: ${UNREADABLE}`;
  if (input.variables.length === 0) return `Variables: ${NONE}`;
  return table(
    ['Variable', 'Branches'],
    input.variables.map((v) => [v.name, v.branches.length === 0 ? NONE : v.branches.join(', ')] as const),
  );
}

/** The table for `capy org delete-project`: the project, then every variable, one row each, in keep.lock order. */
export function deleteProjectDisplay(input: DeleteDisplayInput): string {
  const summary = table(['', ''], [
    ['Org', input.org.name],
    ['Project', `${input.project.name} (${input.project.id})`],
    ['Branches', branchesCell(input)],
    ['Variables', input.unavailable.includes('variables') ? UNREADABLE : String(input.variables.length)],
    ['Live deploy tokens', tokensCell(input)],
  ]);
  return `${summary}\n\n${variablesSection(input)}`;
}

/** The table for a name that matches several projects: one numbered row per project, labelled as the options are. */
export function chooseProjectDisplay(labels: readonly string[]): string {
  return table(['', 'Project'], labels.map((label, i) => [String(i + 1), label] as const)); // COPY-FLAG
}

export interface CreateDisplayInput {
  readonly org: { readonly id: string; readonly name: string };
  /** The name already given, if any. */
  readonly name?: string;
  /** The branch already given, if any. */
  readonly branch?: string;
  /** What a branch is, shown under the table. */
  readonly branchDescription: string;
}

// COPY-FLAG: placeholder for a value still to be chosen.
const TO_CHOOSE = 'to choose';

/** The table for `capy org create-project` asking for its name and first branch: where it goes, what is chosen so far, and what a branch is. */
export function createProjectDisplay(input: CreateDisplayInput): string {
  const summary = table(['', ''], [
    ['Org', input.org.name],
    ['Project', input.name ?? TO_CHOOSE],
    ['First branch', input.branch ?? TO_CHOOSE], // COPY-FLAG
  ]);
  return `${summary}\n\n${input.branchDescription}`;
}

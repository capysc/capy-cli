/**
 * An elicitation: a question a command cannot answer, handed to the agent that ran it so the agent can put it
 * to the human. It rides inside a `--json` refusal (exit 3) next to the refusal's `code`, and never replaces it.
 *
 * Two kinds, one shape each:
 *   - `confirm`: a yes/no. `answer.yes` is the exact command to run when the human says yes.
 *   - `form`: one or more values. `fields` describes each; `answer.rerun` is the command to run with the values filled in.
 *
 * `details` is what the human needs to decide. It is built from names and ids only: never a value, a hash or ciphertext.
 * `display` is the same information as a markdown table (`ui/elicitationDisplay.ts`). The agent prints it exactly as
 * given before asking `question`, so every human sees the same list.
 */

export interface ElicitationField {
  readonly name: string;
  readonly type: 'string';
  /** A regular expression (as a string) the value must match. */
  readonly pattern: string;
  /** A value the human can accept as is. Absent when there is no sensible one. */
  readonly default?: string;
  /** What the field is, for the human. Absent when the name says it all. */
  readonly description?: string;
  /** When present, the answer must be one of these `value`s; `label` is what the human is shown. */
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

export interface ElicitationConfirm {
  readonly kind: 'confirm';
  readonly question: string;
  readonly details: Readonly<Record<string, unknown>>;
  /** Markdown. Print it exactly as given, then ask `question`. */
  readonly display: string;
  readonly answer: { readonly yes: string };
}

export interface ElicitationForm {
  readonly kind: 'form';
  readonly question: string;
  readonly details: Readonly<Record<string, unknown>>;
  /** Markdown. Print it exactly as given, then ask `question`. */
  readonly display: string;
  readonly fields: readonly ElicitationField[];
  readonly answer: { readonly rerun: string };
}

export type Elicitation = ElicitationConfirm | ElicitationForm;

/** What `capy help --json` says about elicitations (`conventions.elicitation`). */
export const ELICITATION_HELP =
  // COPY-FLAG: minimal and neutral.
  'A refusal with exit code 3 can carry an `elicitation` next to its `code`: a question for the human, never for you. End your reply with `display` (a markdown table) exactly as given, without shortening or reordering it, then the short `question`, and stop. Never use a question box or a preview for it; the human answers in chat. kind "confirm" is a yes/no ({kind, question, details, display, answer:{yes}}): ask the human; on yes, run the command in `answer.yes`; on no, stop. kind "form" asks for values ({kind, question, details, display, fields:[{name, type, pattern, default?, description?, options?:[{value, label}]}], answer:{rerun}}): ask the human for each field, then run `answer.rerun` with the values filled in. A field with `options` is a choice: the human picks a `label`, and you fill in its `value`. `details` holds names and ids only, never a value. Today: `capy org delete-project` without --yes refuses with CONFIRMATION_REQUIRED and a confirm (details: {org:{id,name}, project:{id,name}, branches:[name], variables:[{name, branches:[name]}], live_deploy_tokens:[{deploy_id, label}], unavailable?:["branches"|"variables"]}); `capy org create-project` missing the name or `--branch` in agent mode refuses with PROJECT_NAME_REQUIRED or BRANCH_NAME_REQUIRED and a form (fields: name, branch; details: {org:{id,name}}); `capy org delete-project` / `restore-project` with a name several projects share refuses with PROJECT_AMBIGUOUS and a form with one `project` field whose options are the projects (details: {org:{id,name}, matches:[{id, name, created_at, variables}]}). Never answer it yourself and never add --yes on your own.';

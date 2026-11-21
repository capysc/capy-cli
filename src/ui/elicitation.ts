/**
 * An elicitation: a question a command cannot answer, handed to the agent that ran it so the agent can put it
 * to the human. It rides inside a `--json` refusal (exit 3) next to the refusal's `code`, and never replaces it.
 *
 * Three kinds, one shape each:
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
  /** The question to ask the human for this field. Ask it, then its `description`. */
  readonly question?: string;
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

/**
 * `link`: the human must open `url` and approve there; `code` is the short code the page shows. Nothing is asked in chat.
 * `answer.wait` is the command to run at once, in the foreground: it returns when the human has approved, and says
 * "still waiting" (the same `link`, exit 3) when it has not yet, in which case it is run again.
 */
export interface ElicitationLinkQr {
  /** The QR of `url` as terminal text. Show it only in a real terminal with a monospace grid and no extra line spacing. */
  readonly text?: string;
  /** The QR of `url` as a PNG: `file` is a 0600 file on this machine; `data_uri` is the same bytes (absent from a wait response). */
  readonly image?: { readonly mime_type: 'image/png'; readonly file: string; readonly data_uri?: string };
}

export interface ElicitationLink {
  readonly kind: 'link';
  readonly url: string;
  /** The short code the human checks on the page (never the device code). */
  readonly code: string;
  readonly purpose: string;
  readonly expires_at: string;
  /** A QR of `url`, when there is one. It encodes `url` and nothing else. */
  readonly qr?: ElicitationLinkQr;
  readonly answer: { readonly wait: string };
}

export type Elicitation = ElicitationConfirm | ElicitationForm | ElicitationLink;

/** What `capy help --json` says about elicitations (`conventions.elicitation`). */
export const ELICITATION_HELP =
  // COPY-FLAG: minimal and neutral.
  'A refusal with exit code 3 can carry an `elicitation` next to its `code`: a question for the human, never for you. Write `display` (a markdown table) in your reply exactly as given, without shortening or reordering it and never inside the question. Then ask the short `question` as an elicitation with your question tool: one question per field, using the field\'s own `question` followed by its `description` when it has them, and its `options` or `default` as the choices; without a question tool, end your reply with the `question` and the human answers in chat. kind "confirm" is a yes/no ({kind, question, details, display, answer:{yes}}): ask the human; on yes, run the command in `answer.yes`; on no, stop. kind "form" asks for values ({kind, question, details, display, fields:[{name, type, pattern, question?, default?, description?, options?:[{value, label}]}], answer:{rerun}}): ask the human for each field, then run `answer.rerun` with the values filled in. A field with `options` is a choice: the human picks a `label`, and you fill in its `value`. A field without `options` is typed in. With a `default`, offer exactly two choices, the `default` and "Cancel"; the human types any other answer in your question tool\'s own free-text answer. With no `default`, leave it out of the question tool: after the other questions, ask its `question` in chat and wait for the human to type the answer. On "Cancel", stop. `details` holds names and ids only, never a value. Today: `capy project restore` without --yes refuses with CONFIRMATION_REQUIRED and a confirm (details: {org:{id,name}, project:{id,name,deleted_at}}); `capy project delete` without --yes refuses with CONFIRMATION_REQUIRED and a confirm (details: {org:{id,name}, project:{id,name}, branches:[name], variables:[{name, branches:[name]}], live_deploy_tokens:[{deploy_id, label}], unavailable?:["branches"|"variables"]}); `capy project create` missing the name, `--branch` or `--protected` in agent mode refuses with PROJECT_NAME_REQUIRED, BRANCH_NAME_REQUIRED or BRANCH_PROTECTION_REQUIRED and a form (fields: name, branch, protected (options yes/no); details: {org:{id,name}}); `capy project delete` / `project restore` with a name several projects share refuses with PROJECT_AMBIGUOUS and a form with one `project` field whose options are the projects (details: {org:{id,name}, matches:[{id, name, created_at, variables}]}); `capy kick <email>` without --yes refuses with CONFIRMATION_REQUIRED and a confirm (details: {org:{id,name}, member:{email}}); `capy projects rename` with no name refuses with PROJECT_NAME_REQUIRED and a form with one `name` field (details: {org:{id,name}, project:{id,name}}); `capy secrets set` / `capy secrets deploy` with a project that is linked to more than one repo refuses with PR_REPO_AMBIGUOUS and a form with one field per such project whose options are its repos (details: {projects:[{id, name, repos:[owner/name[/folder]]}]}); pass the same `--pr-repo` again on the run with `--confirm`. kind "link" hands the human a page to approve on ({kind, url, code, purpose, expires_at, qr?:{text?, image?:{mime_type, file, data_uri?}}, answer:{wait}}): show the human the `url` and the `code` (and the `qr` as `conventions.pairing` says), then run `answer.wait` at once in the foreground, and run it again whenever it exits 3 with PAIR_STILL_WAITING. Today `capy pair` in agent mode refuses with PAIR_EMAIL_REQUIRED and a form (field: email), then PAIR_APPROVAL_PENDING and a link; never fill in the email yourself. Bare `capy` in a folder that is not a project, in agent mode, with questions left refuses with INIT_INPUT_REQUIRED and one form that asks only what is unanswered: org (options: the organizations; asked first and alone when there are several), project (options: the existing projects, and `new`), then for a new project name, branch and protected (options yes/no); its `display` is the whole summary, so after the human answers, run `answer.rerun` with no further confirmation (details: {org?, orgs?, projects?, new_project_fields?, variables}; `variables` is a count). Never answer it yourself and never add --yes on your own.';

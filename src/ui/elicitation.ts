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
  /**
   * When present, the answer is one of these `value`s; `label` is what the human is shown, and `description` (when
   * there is one) says what picking it does, shown under the label.
   */
  readonly options?: ReadonlyArray<ElicitationOption>;
  /** With `options`: the human may also type an answer of their own ("Other"), which must match `pattern`. */
  readonly other?: boolean;
}

export interface ElicitationOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
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
  /** Fingerprint of this run's pairing key; the approval page shows the same value. */
  readonly fingerprint?: string;
  readonly purpose: string;
  readonly expires_at: string;
  /** A QR of `url`, when there is one. It encodes `url` and nothing else. */
  readonly qr?: ElicitationLinkQr;
  /** CAP-897: what to do next, the same fixed sentence on every link (`PAIR_LINK_INSTRUCTIONS`). */
  readonly instructions: string;
  readonly answer: { readonly wait: string };
}

export type Elicitation = ElicitationConfirm | ElicitationForm | ElicitationLink;

/** What `capy help --json` says about elicitations (`conventions.elicitation`). */
export const ELICITATION_HELP =
  // COPY-FLAG: minimal and neutral.
  'A refusal with exit code 3 can carry an `elicitation` next to its `code`: a question for the human, never for you. Write `display` (a markdown table) in your reply exactly as given, without shortening or reordering it and never inside the question. Then ask the short `question` as an elicitation with your question tool: one question per field, using the field\'s own `question` followed by its `description` when it has them, and its `options` or `default` as the choices; without a question tool, end your reply with the `question` and the human answers in chat. kind "confirm" is a yes/no ({kind, question, details, display, answer:{yes}}): ask the human; on yes, run the command in `answer.yes`; on no, stop. kind "form" asks for values ({kind, question, details, display, fields:[{name, type, pattern, question?, default?, description?, options?:[{value, label, description?}], other?}], answer:{rerun}}): ask the human for each field, then run `answer.rerun` with the values filled in. A field with `options` is a choice: the human picks a `label` (show an option\'s `description` under its label), and you fill in its `value`. With `other: true` add one more choice, "Other": when the human picks it, ask the field\'s `question` in chat and fill in what they type, as typed. A field without `options` is typed in. With a `default`, offer exactly two choices, the `default` and "Cancel"; the human types any other answer in your question tool\'s own free-text answer. With no `default`, leave it out of the question tool: after the other questions, ask its `question` in chat and wait for the human to type the answer. On "Cancel", stop. `details` holds names and ids only, never a value. Today: `capy project restore` without --yes refuses with CONFIRMATION_REQUIRED and a confirm (details: {org:{id,name}, project:{id,name,deleted_at}}); `capy project delete` without --yes refuses with CONFIRMATION_REQUIRED and a confirm (details: {org:{id,name}, project:{id,name}, branches:[name], variables:[{name, branches:[name]}], live_deploy_tokens:[{deploy_id, label}], unavailable?:["branches"|"variables"]}); `capy project create` missing the name, `--branch` or `--protected` in agent mode refuses with PROJECT_NAME_REQUIRED, BRANCH_NAME_REQUIRED or BRANCH_PROTECTION_REQUIRED and a form (fields: name, branch, protected (options yes/no); details: {org:{id,name}}); `capy project delete` / `project restore` with a name several projects share refuses with PROJECT_AMBIGUOUS and a form with one `project` field whose options are the projects (details: {org:{id,name}, matches:[{id, name, created_at, variables}]}); `capy kick <email>` without --yes refuses with CONFIRMATION_REQUIRED and a confirm (details: {org:{id,name}, member:{email}}); `capy projects rename` with no name refuses with PROJECT_NAME_REQUIRED and a form with one `name` field (details: {org:{id,name}, project:{id,name}}); `capy secrets set` / `capy secrets deploy` with a project that is linked to more than one repo refuses with PR_REPO_AMBIGUOUS and a form with one field per such project whose options are its repos (details: {projects:[{id, name, repos:[owner/name[/folder]]}]}); pass the same `--pr-repo` again on the run with `--confirm`. `capy branch -D NAME` without --yes in agent mode refuses with CONFIRMATION_REQUIRED and a confirm (details: {branch:{name}}); `capy remove NAME...` without --yes refuses with REMOVE_NEEDS_TTY and a confirm (details: {branch, variables:[name], removing_all}); `capy system rm NAME` without --yes refuses with SYSTEM_STORE_NEEDS_TTY and a confirm (details: {name, org?}); `capy connect vercel|dokploy` with --overwrite or --discover and without --yes refuses with VERCEL_CONFIRMATION_REQUIRED or DOKPLOY_CONFIRMATION_REQUIRED (exit 3) and a confirm whose `display` lists the terminal\'s lines (details: {import, replace, clear} or {folders}); `capy connect vercel` with nobody to ask refuses with VERCEL_TEAM_REQUIRED (form, one `team` field whose options are the team slugs; details: {teams:[{id, slug}]}), VERCEL_PROJECT_REQUIRED (form, one typed `project` field; details: {}) or VERCEL_ENVIRONMENT_REQUIRED (form, one `environment` field whose options are the environments; details: {branch, environments:[name]}), all exit 3; `capy connect dokploy` refuses with DOKPLOY_TARGET_AMBIGUOUS (form, one `target` field: each option\'s label is a saved target and its value that target\'s flags; details: {targets:[name]}) or DOKPLOY_SETTINGS_MISSING (form asking only what is missing: `base_url`, then `source` (option values `--application` / `--compose`) and `service_id`; details: {}); fill the values into `answer.rerun` as they are. With nobody at a terminal, these picks refuse with a form of one field whose options are the terminal\'s choices (exit 3): `capy rotate` with no variable, ROTATE_VARIABLE_REQUIRED (field `variable`; details: {branch, variables}); `capy rotate VAR` for an unmanaged variable with several integrations, ROTATE_PROVIDER_REQUIRED (field `provider`; details: {variable, providers}); `capy invite` for a role that needs project access, INVITE_PROJECT_REQUIRED (field `project`, one project; details: {role, projects:[{id, name}]}); `capy connect stripe` with several accounts, STRIPE_ACCOUNT_REQUIRED (field `account`; details: {accounts:[{name, account_id}]}); `capy connect stripe|workos` when the key\'s variable is unclear, CONNECTOR_VAR_REQUIRED (field `var`; details: {branch, variables}). `capy rotate` has no --json, so its `answer.rerun` ends with --non-tty. A command that works on an organization (users, projects, project create|delete|restore, projects rename, secrets, invite, kick, grant-branch, revoke-branch) with several organizations, no keep.lock and no --org refuses with ORG_SELECTION_REQUIRED (exit 3) and a form with one `org` field whose options are the org ids labelled by name (details: {orgs:[{id, name}]}); its rerun adds --org. `capy agents` (or `capy agents --remove`) without --yes in agent mode refuses with AGENTS_SETUP_NEEDS_TTY and a confirm asking the terminal\'s question (details: {files:[{path, action}]}); `capy checkout NAME -b --json` without --protected or --no-protected refuses with BRANCH_PROTECTION_REQUIRED and a form with one `protected` field whose option values are the flags `--protected` and `--no-protected` (details: {branch:{name}}); its `answer.rerun` uses --non-tty, because `-b --json` only describes the route. kind "link" hands the human a page to approve on ({kind, url, code, fingerprint?, purpose, expires_at, qr?:{text?, image?:{mime_type, file, data_uri?}}, instructions, answer:{wait}}): write the `url` as a clickable link, with the `code`, the `fingerprint` (the page shows the same one) and `expires_at`, as plain text, every time a link is shown (the `qr`, as `conventions.pairing` says, is only an addition, never the only way), then run `answer.wait` at once in the foreground (it can take up to 9 minutes, so give it a tool timeout of at least 10 minutes), and run it again whenever it exits 3 with PAIR_STILL_WAITING or your tool stopped it early; when it exits 3 with PAIR_LINK_RENEWED the old link expired and the elicitation is a new link: show it to the human the same way and run its `answer.wait` again. Its `instructions` say the same. Pass `--title` and `--description` to `capy pair` and `capy setup`: your own words for what you are doing and why, which Keep shows the human on the unlock request; `capy setup` refuses to start a pairing without them (SETUP_INTENT_REQUIRED, exit 1, with `next_command`). Today `capy pair` in agent mode asks nothing up front (no email, no keys choice: on a machine with no keys it asks for them, and Keep decides after sign-in between the organization keys and a new organization); it refuses with PAIR_APPROVAL_PENDING and a link; once the human approves, the wait refuses with PAIR_CODE_REQUIRED (or PAIR_CODE_MISMATCH after a wrong code) and a form (field: code; details: {attempts_left?}) for the one-time code Keep shows the human; never fill in the code yourself. Bare `capy` in a folder that is not a project, in agent mode, with questions left refuses with INIT_INPUT_REQUIRED and one form that asks only what is unanswered: first, alone, folder when no --folder was typed (options: this folder and every subfolder that holds a .env or a package file, those with a .env first, each option\'s description saying which it holds, with `other`; when there are more choices than your question tool takes, list every option with its description in chat and let the human answer there, never dropping one; the rerun adds --folder), then org (options: the organizations; asked before the project questions when there are several, with only share beside it), project (options: the existing projects, and `new`), then for a new project name and branch (its protection is not asked: the first branch starts open, as in the terminal, unless --protected was typed), and for an existing project branch (options: that project\'s branches, never chosen for the human even when there is one), or, when that project has no branches yet, branch for its first one (default development; the rerun creates it open to the project); and, inside a git repository, share (options yes: "Share the setup through Git", no: "Set up this folder only"; the rerun adds --share-setup); and, for a new project once its name and branch are known and the folder\'s .env has variables, encrypt (the terminal\'s "Encrypt these N secrets and push to {project} ({org}) on {branch}?", options yes/no; no creates nothing and leaves the .env as it is; the rerun adds --encrypt-env); while folder is asked its `display` only names the folder Capy runs in; otherwise its `display` is the whole summary, so after the human answers, run `answer.rerun` with no further confirmation (details: {folder?, org?, orgs?, projects?, project?, branches?, new_project_fields?, variables}; `variables` is a count). Never answer it yourself and never add --yes on your own.';

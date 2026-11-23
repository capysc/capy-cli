/**
 * GitHub Actions connector.
 *
 * Pushes _SECRETS_BLOB + _DEPLOY_KEY into the repo's GitHub Actions
 * secret store (repo-scoped or environment-scoped) so workflows can call
 * `capy run -- <deploy command>` without manual copy-paste.
 *
 * Auth model: `gh` CLI handoff. We never see a PAT — `gh auth status`
 * must already be green. No custom OAuth app, no device flow, no token
 * prompts. Per CAP-9, this is intentional for v1.
 *
 * Trust model: the deploy key is a random per-deploy key, not the project
 * key; the project key never leaves the developer's machine. Both secrets
 * land in GitHub as long-lived secrets. Revocation runs through
 * `capy deploy revoke <deployId>`, which stops the service answering for the
 * deploy: once revoked, the GitHub-stored blob and key are inert.
 *
 * Nothing is ever deleted: a re-deploy writes `_SECRETS_BLOB` + `_DEPLOY_KEY`
 * and leaves any other secret alone. The connector only PRINTS the workflow
 * patch, so removing the secrets an existing workflow still reads would leave
 * it running with empty values.
 */
import { spawnSync } from 'child_process';
import { resolveGh, ghInstalled } from '../utils/gh';
import { readFileSync } from 'fs';
import { join } from 'path';
import inquirer from 'inquirer';
import ora from '../ui/spinner';
import { ServiceClient } from '../service/serviceClient';
import { FileManager } from '../files/fileManager';
import { DEPLOY_KEY_RUNTIME_PAIR } from '../deploy/dokployApi';
import { mintDeployToken, EmptyEnvError, type MintedDeployToken } from './deployTokenCommand';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;

export interface GithubActionsConnectorDeps {
  serviceClient: ServiceClient;
  fm: FileManager;
  orgId: string;
  projectId: string;
  userId: string;
}

/** Non-interactive controls. Any option provided skips its prompt and
 * uses the provided value verbatim. Validation happens up front so a bad
 * flag combination fails fast before we mint anything. */
export interface GithubActionsConnectorOptions {
  /** Skip the repo-vs-env picker. */
  scope?: 'repo' | 'env';
  /** Required when scope==='env'. Created if it doesn't exist. */
  envName?: string;
  /** Skip the overwrite-existing-secret confirmation (assumes yes). */
  yes?: boolean;
}

interface GhRepoInfo {
  nameWithOwner: string;
}

interface GhEnvironment {
  name: string;
}

/** Read the shipping CLI version from package.json so the emitted YAML
 * snippet pins to whatever the user has installed today. Resolves the
 * file relative to the bundled `dist/commands/` location at runtime; npm
 * always ships package.json regardless of the `files` whitelist.
 * Exported for tests. */
export function readCliVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'latest';
  } catch {
    return 'latest';
  }
}

function ghAuthed(): boolean {
  const gh = resolveGh();
  return gh !== null && spawnSync(gh, ['auth', 'status'], { stdio: 'ignore' }).status === 0;
}

function getRepoInfo(): GhRepoInfo | null {
  const gh = resolveGh();
  if (!gh) return null;
  const r = spawnSync(gh, ['repo', 'view', '--json', 'nameWithOwner'], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function listEnvironments(repo: string): GhEnvironment[] | null {
  // gh api returns { total_count, environments: [{ name, ... }] }
  const gh = resolveGh();
  if (!gh) return null;
  const r = spawnSync(
    gh,
    ['api', `/repos/${repo}/environments`, '--jq', '.environments // []'],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
}

function createEnvironment(repo: string, name: string): boolean {
  // PUT /repos/{owner}/{repo}/environments/{name} is idempotent.
  const gh = resolveGh();
  if (!gh) return false;
  const r = spawnSync(
    gh,
    ['api', '--method', 'PUT', `/repos/${repo}/environments/${name}`],
    { stdio: 'ignore' },
  );
  return r.status === 0;
}

/** What the connector needs from `gh`: writing a secret. It has no way to delete one. */
export interface SecretIo {
  set(name: string, value: string, env: string | null): { ok: boolean; stderr: string };
}

const GH_MISSING = { ok: false, stderr: 'gh CLI not found' } as const;

/** The real `gh secret set`. Never reached from a test: tests pass their own `SecretIo`. */
const ghSecretIo: SecretIo = {
  set(name, value, env) {
    const args = ['secret', 'set', name, '--body', value, ...(env ? ['--env', env] : [])];
    const gh = resolveGh();
    if (!gh) return GH_MISSING;
    const r = spawnSync(gh, args, { encoding: 'utf-8' });
    return { ok: r.status === 0, stderr: r.stderr ?? '' };
  },
};

/** The last two lines of a `gh` failure, for a one-line report. */
const tailOf = (stderr: string): string => stderr.trim().split('\n').slice(-2).join(' | ');

export type PushResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly name: string; readonly stderr: string };

/**
 * Writes `_SECRETS_BLOB` then `_DEPLOY_KEY`. Exported for tests so the
 * names that land on the target, and what is pushed under each, can be pinned
 * without a real `gh`.
 */
export function pushRuntimePair(
  io: SecretIo,
  minted: Pick<MintedDeployToken, 'secretsBlob' | 'deployKey'>,
  envName: string | null,
): PushResult {
  const [blobName, keyName] = DEPLOY_KEY_RUNTIME_PAIR;
  const blobR = io.set(blobName, minted.secretsBlob, envName);
  if (!blobR.ok) return { ok: false, name: blobName, stderr: blobR.stderr };
  const keyR = io.set(keyName, minted.deployKey, envName);
  if (!keyR.ok) return { ok: false, name: keyName, stderr: keyR.stderr };
  return { ok: true };
}

/** Render the YAML patch the user pastes into their workflow. Exported
 * for tests so we can pin both shapes (repo vs environment) without
 * spinning up a full connector run. */
export function renderYamlPatch(version: string, env: string | null): string {
  const [blobName, keyName] = DEPLOY_KEY_RUNTIME_PAIR;
  const envHint = env
    ? `\n# Your deploy job must pin to environment: ${env}\n#   jobs:\n#     deploy:\n#       environment: ${env}\n`
    : '';
  return `${envHint}# Add before your deploy step:
- name: Install Capy CLI
  run: npm install -g @capysc/cli@${version}

# Wrap your existing deploy command, and add the env block:
- name: Deploy
  run: capy run -- <your existing deploy command>
  env:
    ${blobName}: \${{ secrets.${blobName} }}
    ${keyName}:  \${{ secrets.${keyName} }}
`;
}

/** Repo secrets, or one GitHub Actions environment's: the option, else the picker. */
async function resolveScope(options: GithubActionsConnectorOptions): Promise<'repo' | 'env'> {
  if (options.scope) return options.scope;
  const r = await inquirer.prompt([{
    type: 'list',
    name: 'scope',
    message: 'Where should the secrets live in GitHub?',
    choices: [
      {
        name: 'Repository secrets  (every workflow + every environment sees them)',
        value: 'repo',
        short: 'repo',
      },
      {
        name: 'Environment secrets (scoped to one GitHub Actions environment)',
        value: 'env',
        short: 'environment',
      },
    ],
    default: 'repo',
  }]);
  return r.scope;
}

type EnvResolution =
  | { readonly ok: true; readonly envName: string }
  | { readonly ok: false };

/** The environment to write to (created if missing): the option, else a pick or a new name. Prints its own failures. */
async function resolveEnvironment(repo: string, options: GithubActionsConnectorOptions): Promise<EnvResolution> {
  if (options.envName) {
    // Non-interactive: ensure the requested env exists. PUT is idempotent
    // so this is a no-op if it already does.
    const created = createEnvironment(repo, options.envName);
    if (!created) {
      console.error('');
      console.error(`  Failed to create or verify environment "${options.envName}".`);
      console.error('  Your gh token may lack the `repo` scope. Try `gh auth refresh -s repo`.');
      console.error('');
      return { ok: false };
    }
    return { ok: true, envName: options.envName };
  }
  const envs = listEnvironments(repo);
  if (envs === null) {
    console.error('');
    console.error('  Could not list environments. Your gh token may lack the');
    console.error('  `repo` scope. Try `gh auth refresh -s repo`.');
    console.error('');
    return { ok: false };
  }
  const choices: Array<{ name: string; value: string }> = [
    ...envs.map((e) => ({ name: e.name, value: e.name })),
    { name: DIM('— create new environment —'), value: '__new__' },
  ];
  const { pick } = await inquirer.prompt([{
    type: 'list',
    name: 'pick',
    message: envs.length === 0
      ? 'No environments exist yet. Create one?'
      : 'Pick an environment:',
    choices,
  }]);
  if (pick !== '__new__') return { ok: true, envName: pick };
  const { newName } = await inquirer.prompt([{
    type: 'input',
    name: 'newName',
    message: 'New environment name:',
    default: 'production',
    validate: (v: string) => v.trim().length > 0 || 'name required',
  }]);
  const created = createEnvironment(repo, newName.trim());
  if (!created) {
    console.error('');
    console.error(`  Failed to create environment "${newName}".`);
    console.error('');
    return { ok: false };
  }
  return { ok: true, envName: newName.trim() };
}

/** Names of the secrets already set in the chosen scope, or null when `gh` cannot say. */
function existingSecretNames(envName: string | null): ReadonlySet<string> | null {
  const ghBin = resolveGh();
  if (!ghBin) return null;
  const listArgs = ['secret', 'list', '--json', 'name', ...(envName ? ['--env', envName] : [])];
  const listR = spawnSync(ghBin, listArgs, { encoding: 'utf-8' });
  if (listR.status !== 0) return null;
  try {
    const existing = JSON.parse(listR.stdout) as Array<{ name: string }>;
    return new Set(existing.map((e) => e.name));
  } catch {
    // Non-fatal: if we can't parse, skip the overwrite prompt and let
    // `gh secret set` overwrite silently (its native behavior).
    return null;
  }
}

/** The confirmation question, asked of the user; rejects if the prompt is aborted (Ctrl+C). */
export type AskOverwrite = (message: string) => Promise<boolean>;

const askWithInquirer: AskOverwrite = async (message) => {
  const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message, default: true }]);
  return ok;
};

/**
 * Before minting: if `_SECRETS_BLOB` or `_DEPLOY_KEY` already exists in the
 * chosen scope, confirm overwriting it. Returns whether to go on. An aborted
 * prompt (Ctrl+C) rejects, so it never falls through to mint and push.
 */
export async function confirmOverwrite(
  names: ReadonlySet<string> | null,
  envName: string | null,
  options: Pick<GithubActionsConnectorOptions, 'yes'>,
  ask: AskOverwrite = askWithInquirer,
): Promise<boolean> {
  if (names === null) return true;
  const clash = DEPLOY_KEY_RUNTIME_PAIR.filter((n) => names.has(n));
  if (clash.length === 0) return true;
  const where = envName ? `environment "${envName}"` : 'repo secrets';
  if (options.yes) {
    console.log(`  ${clash.join(' + ')} already set in ${where} — overwriting (--yes).`);
    return true;
  }
  const ok = await ask(`${clash.join(' + ')} already set in ${where}. Overwrite?`);
  if (!ok) {
    console.log('');
    console.log('  Cancelled. No secrets pushed.');
    console.log('');
  }
  return ok;
}

/** Mints the pair behind a spinner; null once the failure is printed. */
async function mintWithSpinner(deps: GithubActionsConnectorDeps): Promise<MintedDeployToken | null> {
  const spinner = ora('Generating deploy credentials...').start();
  try {
    const minted = await mintDeployToken({
      serviceClient: deps.serviceClient,
      fm: deps.fm,
      orgId: deps.orgId,
      projectId: deps.projectId,
      userId: deps.userId,
    });
    spinner.succeed(`Deploy credentials generated (${minted.secretCount} secrets)`);
    return minted;
  } catch (err: any) {
    if (err instanceof EmptyEnvError) {
      spinner.fail(err.message);
    } else {
      spinner.fail(err?.message ?? 'Failed to generate deploy credentials');
    }
    return null;
  }
}

/**
 * Run the GitHub Actions connector. Returns the process exit code so the
 * caller can `process.exit(code)`. Throws only on truly unexpected errors
 * — expected failures (no gh, not authed, no repo, .env empty) print a
 * helpful message and return a non-zero code.
 */
export async function runGithubActionsConnector(
  deps: GithubActionsConnectorDeps,
  options: GithubActionsConnectorOptions = {},
): Promise<number> {
  // 0. Validate options up front so a bad CLI flag combination fails before
  // we mint anything.
  if (options.scope && options.scope !== 'repo' && options.scope !== 'env') {
    console.error(`  --scope must be 'repo' or 'env' (got '${options.scope}')`);
    return 1;
  }
  if (options.scope === 'env' && !options.envName) {
    console.error('  --scope env requires --env-name <name>');
    return 1;
  }
  if (options.envName && options.scope !== 'env') {
    console.error('  --env-name only applies when --scope env');
    return 1;
  }

  // 1. Preflight gh.
  if (!ghInstalled()) {
    console.error('');
    console.error(`  The ${B('gh')} CLI is not installed.`);
    console.error('');
    console.error('  Install it from https://cli.github.com and run:');
    console.error(`      ${B('gh auth login')}`);
    console.error('');
    console.error('  Then re-run `capy deploy`.');
    console.error('');
    return 1;
  }
  if (!ghAuthed()) {
    console.error('');
    console.error(`  ${B('gh')} is installed but not authenticated.`);
    console.error('');
    console.error(`  Run ${B('gh auth login')}, then re-run \`capy deploy\`.`);
    console.error('');
    return 1;
  }

  // 2. Resolve target repo from cwd's git remote (gh handles this).
  const repoInfo = getRepoInfo();
  if (!repoInfo) {
    console.error('');
    console.error('  Could not resolve a GitHub repo for this directory.');
    console.error('');
    console.error('  Make sure you are inside a git repo with a GitHub remote');
    console.error(`  (\`${B('gh repo view')}\` should work), then re-run \`capy deploy\`.`);
    console.error('');
    return 1;
  }
  const repo = repoInfo.nameWithOwner;
  console.log('');
  console.log(`  Target repo: ${B(repo)}`);
  console.log('');

  // 3. Resolve scope: option wins; otherwise prompt.
  const scope = await resolveScope(options);
  const envResolution = scope === 'env' ? await resolveEnvironment(repo, options) : null;
  if (envResolution !== null && !envResolution.ok) return 1;
  const envName = envResolution === null ? null : envResolution.envName;

  // 4. Overwrite-confirmation if either secret already exists in the chosen scope.
  // gh exits non-zero if the secret doesn't exist, so we list to check.
  const existing = existingSecretNames(envName);
  if (!(await confirmOverwrite(existing, envName, options))) return 0;

  // 5. Mint _SECRETS_BLOB + _DEPLOY_KEY.
  const minted = await mintWithSpinner(deps);
  if (minted === null) return 1;

  // 6. Push to GitHub.
  const push = ora(
    envName
      ? `Pushing secrets to ${repo} → env:${envName}`
      : `Pushing secrets to ${repo}`,
  ).start();
  const pushed = pushRuntimePair(ghSecretIo, minted, envName);
  if (!pushed.ok) {
    push.fail(`${pushed.name} push failed: ${tailOf(pushed.stderr)}`);
    return 1;
  }
  push.succeed('Secrets pushed to GitHub.');

  // 7. Emit the YAML patch the user adds to their workflow.
  const version = readCliVersion();
  console.log('');
  console.log(`  ${B('Add this to your .github/workflows/<deploy>.yml:')}`);
  console.log('');
  for (const line of renderYamlPatch(version, envName).split('\n')) {
    console.log(`    ${line}`);
  }
  console.log('');
  console.log(`  Deploy id: ${B(minted.deployId.slice(0, 12) + '...')}`);
  console.log(`  Revoke later with: ${B(`capy deploy revoke ${minted.deployId.slice(0, 12)}`)}`);
  console.log('');

  return 0;
}

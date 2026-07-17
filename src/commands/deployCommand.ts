/**
 * `capy deploy [target] [options]`
 *
 * Top-level deploy verb. Runs an interactive picker to set up a target on
 * first use, persists to `.capy/deploy.json`, then ships secrets + code to
 * the chosen vendor. Subsequent runs skip the picker.
 *
 * NOT to be confused with `capy deploy token …` — that's the legacy deploy-
 * token issuance flow (see deployTokenCommand.ts) used to inject secrets
 * into CI for `capy run` deployed mode. This command is the inverse: it
 * runs the deploy itself.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import inquirer from 'inquirer';
import { FileManager } from '../files/fileManager';
import {
  DeployAdapter,
  DeployContext,
  DeployMode,
  DeployResult,
  TargetConfig,
} from '../deploy/adapter';
import {
  isGitRepo,
  hasKeepLockChanges,
  stageAndCommit,
  currentBranch,
  checkoutBranch,
  discardPaths,
  stashOtherChanges,
  popStash,
  pushBranch,
  createPr,
  listLocalBranches,
  listAllBranches,
  fetchRemoteBranch,
  repoRelPath,
  readFileAtRef,
  worktreeAddNewBranch,
  worktreeRemove,
  deleteLocalBranch,
} from '../deploy/git';
import { buildDeployKeep, touchDeployKeep, reconcileVars } from '../deploy/keepGate';
import { KeepFile } from '../types/index';
import { tmpdir } from 'os';
import { ALL_ADAPTERS, getAdapter, listPlanned } from '../deploy/registry';
import { detectAwsRegion, leafFor } from '../deploy/adapters/awsSsm';
import { classify } from '../deploy/classify';
import { CHECKBOX_INSTRUCTIONS, CHECKBOX_THEME, LIST_THEME } from '../ui/promptStyle';
import { keypressConfirm } from '../ui/keypressConfirm';
import {
  getTarget,
  listTargets,
  removeTarget,
  upsertTarget,
} from '../deploy/config';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;

export interface DeployCliOptions {
  /** Skip picker; run by adapter id directly (CI-friendly). */
  target?: string;
  /** Skip all prompts (CI). */
  yes?: boolean;
  /** Preflight + show plan, do not push. */
  dryRun?: boolean;
  /** Force re-entry into the picker for an existing target. */
  edit?: boolean;
  /**
   * Force a deploy even when keep.lock is unchanged: bump keep.lock with a
   * deploy nonce so there's a change to commit + PR, triggering a fresh CI run.
   */
  force?: boolean;
  /**
   * Run against the dev service (capy-dev). Propagated to the auth/service
   * clients used for decryption — without it they default to prod
   * (api.capy.sc) and co-decrypt fails for dev-only orgs.
   */
  devMode?: boolean;
}

// ── Project-level keep.lock parsing ────────────────────────────────────────

interface KeepInfo {
  orgId: string;
  projectId: string;
  variables: string[];
  branches: string[];
}

function readKeep(cwd: string): KeepInfo | null {
  const p = join(cwd, 'keep.lock');
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    if (!raw.org_id || !raw.project_id) return null;
    const variables = Object.keys(raw.variables ?? {}).sort();
    const branches = new Set<string>();
    for (const entries of Object.values(raw.variables ?? {}) as any[]) {
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (e?.branch) branches.add(e.branch);
        }
      }
    }
    return {
      orgId: raw.org_id,
      projectId: raw.project_id,
      variables,
      branches: Array.from(branches).sort(),
    };
  } catch {
    return null;
  }
}

// ── Decryption (uses same path as `capy export` / `capy run`) ──────────────

async function decryptCurrentBranch(
  cwd: string,
  devMode: boolean = false,
): Promise<Record<string, string>> {
  const fm = new FileManager();
  const envFromFile = fm.readEnvFile();

  const out: Record<string, string> = {};
  const toDecrypt: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(envFromFile)) {
    if (typeof v !== 'string') continue;
    if (fm.isEncrypted(v)) toDecrypt.push([k, v]);
    else out[k] = v;
  }
  if (toDecrypt.length === 0) return out;

  const keep = readKeep(cwd);
  if (!keep) {
    throw new Error('no keep.lock — run `capy` to sync first.');
  }

  const { AuthService } = await import('../auth/authService');
  const { ServiceClient } = await import('../service/serviceClient');
  const { resolveProjectKey } = await import('../crypto/keyResolver');

  const auth = new AuthService(undefined, devMode);
  const result = await auth.authenticateSilent(keep.orgId);
  if (!result.success || !result.user_id) {
    throw new Error('not authenticated. Run `capy` to sign in.');
  }
  const svc = new ServiceClient(undefined, devMode);
  svc.setTokenProvider(() => auth.getValidToken());
  const keyServiceOps = {
    coDecrypt: (o: string, c: string) =>
      svc.coDecrypt(o, c).then((r) => r.plaintext),
    wrapOuterLayer: (o: string, p: string) =>
      svc.wrapOuterLayer(o, p).then((r) => r.ciphertext),
  };
  const projectKeyHex = await resolveProjectKey(
    keep.orgId,
    keep.projectId,
    result.user_id,
    keyServiceOps,
  );
  for (const [k, v] of toDecrypt) {
    out[k] = fm.decryptValue(v, projectKeyHex);
  }
  return out;
}

/**
 * Mint the SECRETS_BLOB + PROJECT_KEY pair for build-time injection (what
 * `capy run` consumes). Same devMode-aware auth as decryptCurrentBranch — so
 * under capy-dev it talks to the dev service, not prod.
 */
async function mintForDeploy(
  cwd: string,
  devMode: boolean = false,
): Promise<{ secretsBlob: string; projectKey: string }> {
  const keep = readKeep(cwd);
  if (!keep) throw new Error('no keep.lock — run `capy` to sync first.');

  const { AuthService } = await import('../auth/authService');
  const { ServiceClient } = await import('../service/serviceClient');
  const { mintDeployToken } = await import('./deployTokenCommand');

  const auth = new AuthService(undefined, devMode);
  const result = await auth.authenticateSilent(keep.orgId);
  if (!result.success || !result.user_id) {
    throw new Error('not authenticated. Run `capy` to sign in.');
  }
  const svc = new ServiceClient(undefined, devMode);
  svc.setTokenProvider(() => auth.getValidToken());
  const minted = await mintDeployToken({
    serviceClient: svc,
    fm: new FileManager(),
    orgId: keep.orgId,
    projectId: keep.projectId,
    userId: result.user_id,
  });
  return { secretsBlob: minted.secretsBlob, projectKey: minted.projectKey };
}

// ── Picker (interactive setup) ─────────────────────────────────────────────

/**
 * Ask which GIT branch the Vercel Preview environment is wired to, picking
 * from the repo's real branches (local + origin) rather than free text — a
 * typo or a capy branch name here fails at `vercel env add` with "Branch not
 * found in the connected Git repository". Free input stays available behind
 * an "other" choice for branches the local clone hasn't fetched.
 */
async function promptVercelGitBranch(
  cwd: string,
  preferred?: string,
): Promise<string> {
  const message = 'Which git branch is the Vercel Preview environment wired to?';
  const branches = listAllBranches(cwd);
  if (branches.length === 0) {
    const ans = await inquirer.prompt([
      {
        type: 'input',
        name: 'gitBranch',
        message,
        default: preferred,
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
    ]);
    return (ans.gitBranch as string).trim();
  }
  const fallback = ['main', 'master'].find((b) => branches.includes(b));
  const ans = await inquirer.prompt([
    {
      type: 'list',
      name: 'gitBranch',
      message,
      theme: LIST_THEME,
      choices: [
        ...branches.map((b) => ({ name: b, value: b })),
        new inquirer.Separator() as any,
        { name: 'Other — type a branch name', value: '__other__' },
      ],
      default:
        preferred && branches.includes(preferred)
          ? preferred
          : fallback ?? branches[0],
    } as any,
  ]);
  if (ans.gitBranch !== '__other__') return ans.gitBranch;
  const typed = await inquirer.prompt([
    {
      type: 'input',
      name: 'gitBranch',
      message,
      validate: (v: string) => (v.trim() ? true : 'required'),
    },
  ]);
  return (typed.gitBranch as string).trim();
}

async function runPicker(
  cwd: string,
  keep: KeepInfo,
  existing?: TargetConfig,
  /** When set, skip adapter-selection (caller has already picked). */
  preselectedAdapterId?: string,
): Promise<TargetConfig> {
  // Scope the picker to the ACTIVE branch's vars. keep.lock's `variables` is the
  // union across EVERY branch, so it would offer vars that only exist on
  // prod/development and then fail/skip at deploy. The materialized .env is the
  // active branch's var set — that's what actually gets deployed.
  const branchVarSet = new Set(Object.keys(new FileManager().readEnvFile()));
  const branchVars = keep.variables.filter((v) => branchVarSet.has(v));

  // 1. Pick adapter (when not pre-selected). Real adapters are selectable;
  // planned-but-not-shipped ones appear disabled with a fallback hint, so
  // the picker doubles as a roadmap and points users at `capy export` until
  // each adapter lands.
  let adapterChoice: string;
  if (existing) {
    adapterChoice = existing.kind;
  } else if (preselectedAdapterId) {
    adapterChoice = preselectedAdapterId;
  } else {
    const realChoices = ALL_ADAPTERS.map((a) => ({
      name: `${a.label}  ${DIM('— ' + a.description)}`,
      value: a.id,
      short: a.label,
    }));
    const planned = listPlanned().filter(
      (p) => !ALL_ADAPTERS.some((a) => a.id === p.id),
    );
    const plannedChoices = planned.map((p) => ({
      name: `${p.label}  ${DIM('(coming soon — ' + p.fallbackHint + ')')}`,
      value: p.id,
      short: p.label,
      disabled: 'use capy export until adapter lands',
    }));
    const choices: any[] = [...realChoices];
    if (plannedChoices.length > 0) {
      choices.push(new inquirer.Separator() as any, ...plannedChoices);
    }
    const ans: { kind: string } = (await inquirer.prompt([
      {
        type: 'list',
        name: 'kind',
        message: 'Where are you deploying?',
        theme: LIST_THEME,
        choices,
      } as any,
    ])) as any;
    adapterChoice = ans.kind;
  }

  const adapter = getAdapter(adapterChoice);
  if (!adapter) throw new Error(`Unknown adapter: ${adapterChoice}`);

  // 2. Detect defaults from cwd.
  const detected = await adapter.detect(cwd);
  if (detected.summary) {
    console.log(`  ${DIM('Detected:')} ${detected.summary}`);
  }

  // 3. Branch. Asked BEFORE adapter-specific options so adapters whose options
  // depend on the branch (e.g. Vercel scopes its Preview env to a git branch)
  // can default to and name it in their prompts.
  const branch = (await inquirer.prompt([
    {
      type: 'list',
      name: 'branch',
      message: 'Which capy branch ships to this target?',
      theme: LIST_THEME,
      choices: keep.branches.length > 0 ? keep.branches : ['development'],
      default: existing?.branch ?? (keep.branches.includes('production') ? 'production' : keep.branches[0]),
    } as any,
  ])).branch;

  // 4. Adapter-specific options.
  const detectedOpts = (detected.options ?? {}) as Record<string, string>;
  const existingOpts = (existing?.options ?? {}) as Record<string, string>;
  let options: Record<string, unknown> = {};
  if (adapter.id === 'cf-worker') {
    const ans = await inquirer.prompt([
      {
        type: 'input',
        name: 'workerName',
        message: 'Worker name (from wrangler.toml):',
        default: existingOpts.workerName ?? detectedOpts.workerName ?? '',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'input',
        name: 'workerDir',
        message: 'Worker directory (contains wrangler.toml):',
        default: existingOpts.workerDir ?? detectedOpts.workerDir ?? '.',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
    ]);
    options = ans;
  } else if (adapter.id === 'vercel') {
    // Vercel: code ships via the keep.lock PR (Vercel git CI builds on merge),
    // but capy pushes each var as a plaintext Environment Variable into the
    // chosen Vercel environment via the vercel CLI — so the build reads them
    // natively with no `capy run` decrypt step. Capture the app dir, which
    // Vercel environment these vars go to, and — for Preview — exactly which
    // git branch that Preview env is wired to. The Preview scope is a GIT
    // branch Vercel knows about, which is NOT a capy branch name nor necessarily
    // the branch you're checked out on, so we pick from the repo's real branches.
    const ans = await inquirer.prompt([
      {
        type: 'input',
        name: 'projectDir',
        message: 'Project directory (contains .vercel/project.json or package.json):',
        default: existingOpts.projectDir ?? detectedOpts.projectDir ?? '.',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'list',
        name: 'vercelEnv',
        message: 'Which Vercel environment should these secrets go to?',
        choices: [
          { name: 'Preview — scoped to a specific git branch', value: 'preview' },
          { name: 'Production', value: 'production' },
        ],
        default: existingOpts.vercelEnv ?? 'preview',
      },
    ]);
    // Drop gitBranch entirely for production — it has no meaning there.
    options =
      ans.vercelEnv === 'preview'
        ? {
            projectDir: ans.projectDir,
            vercelEnv: 'preview',
            gitBranch: await promptVercelGitBranch(cwd, existingOpts.gitBranch),
          }
        : { projectDir: ans.projectDir, vercelEnv: 'production' };
  } else if (adapter.id === 'cf-pages') {
    const ans = await inquirer.prompt([
      {
        type: 'input',
        name: 'projectName',
        message: 'Pages project name (from wrangler pages project list):',
        default: existingOpts.projectName ?? detectedOpts.projectName ?? '',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'input',
        name: 'buildCwd',
        message: 'Build directory (contains package.json):',
        default: existingOpts.buildCwd ?? detectedOpts.buildCwd ?? '.',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'input',
        name: 'buildCmd',
        message: 'Build command (run inside the build directory):',
        default:
          existingOpts.buildCmd ?? detectedOpts.buildCmd ?? 'bun run build',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'input',
        name: 'distDir',
        message: 'Dist directory (relative to build directory):',
        default: existingOpts.distDir ?? detectedOpts.distDir ?? 'dist',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
    ]);
    options = ans;
  } else if (adapter.id === 'aws-ssm') {
    // Show the live name transformation in the naming prompt so the
    // env-var ↔ parameter mapping is never abstract.
    const exampleVar =
      classify(branchVars).runtime[0] ?? 'DATABASE_URL';
    const ans = await inquirer.prompt([
      {
        type: 'input',
        name: 'region',
        message: 'AWS region:',
        default:
          existingOpts.region ?? detectedOpts.region ?? detectAwsRegion() ?? 'us-east-1',
        validate: (v: string) => (v.trim() ? true : 'required'),
      },
      {
        type: 'input',
        name: 'pathPrefix',
        message: 'Parameter path prefix:',
        default:
          existingOpts.pathPrefix ??
          detectedOpts.pathPrefix ??
          `/capy/${basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-')}/`,
        validate: (v: string) =>
          /^\/[a-zA-Z0-9_.\-/]*\/$/.test(v.trim())
            ? true
            : "must start and end with '/' (e.g. /capy/prod/)",
        filter: (v: string) => v.trim(),
      },
      {
        type: 'list',
        name: 'naming',
        message: 'Parameter naming:',
        theme: LIST_THEME,
        choices: [
          {
            name: `verbatim    ${DIM(`${exampleVar} → ${leafFor(exampleVar, 'verbatim')}`)}`,
            value: 'verbatim',
            short: 'verbatim',
          },
          {
            name: `kebab-case  ${DIM(`${exampleVar} → ${leafFor(exampleVar, 'kebab')}`)}`,
            value: 'kebab',
            short: 'kebab',
          },
        ],
        default: existingOpts.naming ?? detectedOpts.naming ?? 'verbatim',
      },
    ]);
    options = ans;
  }

  // 5. Var picking — show every var in keep.lock and pre-select the ones
  // most likely to be relevant for this adapter (runtime for cf-worker,
  // build-time prefixes for cf-pages). The user is the authority: they can
  // toggle anything in or out. No silent exclusion.
  const cls = classify(branchVars);
  const presumedRelevant = adapter.presumeVars
    ? adapter.presumeVars(cls)
    : adapter.varKind === 'build-time'
      ? cls.buildTime
      : cls.runtime;
  const defaultPicks = existing?.vars ?? presumedRelevant;
  const verb = adapter.varKind === 'build-time' ? 'inline into' : 'push to';
  const presetLabel = adapter.presumeVars
    ? 'all vars'
    : adapter.varKind === 'build-time'
      ? 'VITE_/NEXT_PUBLIC_/PUBLIC_/REACT_APP_'
      : 'non-public-prefixed';
  if (branchVars.length === 0) {
    throw new Error(
      `no variables on the active branch — run \`capy\` to sync, or switch branches.`,
    );
  }
  const varsAns = (await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'vars',
      message: `Which vars to ${verb} ${adapter.label}? (pre-selected: ${presetLabel})`,
      instructions: CHECKBOX_INSTRUCTIONS,
      theme: CHECKBOX_THEME,
      choices: branchVars.map((v) => ({
        name: v,
        value: v,
        checked: defaultPicks.includes(v),
      })),
      validate: (v: readonly string[]) =>
        v.length > 0 ? true : 'select at least one',
    } as any,
  ])) as { vars: string[] };
  const vars = varsAns.vars;

  // 6. Mode — direct vs CI/CD. Default comes from the adapter: vendors
  // with turnkey git CI (Vercel, etc.) default to 'ci'; vendors where capy
  // is the deploy actor default to 'direct'. Existing target's mode wins
  // over the adapter default on subsequent picker passes.
  //
  // CI-only adapters (Vercel) have no direct mode at all — capy never runs
  // their CLI — so skip the question and force 'ci'.
  let mode: DeployMode;
  if (adapter.ciOnly) {
    mode = 'ci';
  } else {
    const ciHelp =
      adapter.ciOnly
        ? `commit keep.lock on a branch + open PR; ${adapter.label}'s git CI deploys on merge`
        : `commit keep.lock on a branch + push secrets + open PR; CI deploys on merge`;
    mode = (await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'How should this target deploy?',
        theme: LIST_THEME,
        choices: [
          {
            name: `Via CI/CD        ${DIM('— ' + ciHelp)}`,
            value: 'ci',
            short: 'ci',
          },
          {
            name: `Deploy directly  ${DIM('— commit keep.lock + push secrets + deploy now')}`,
            value: 'direct',
            short: 'direct',
          },
        ],
        default: existing?.mode ?? adapter.defaultMode,
      } as any,
    ])).mode as DeployMode;
  }

  // 6b. CI mode only — type the git branch the deploy PR opens against.
  // Repos can have hundreds of branches, so a list picker is the wrong
  // shape. Text entry defaulting to the current branch (you usually open the
  // PR against the branch you're on), then the existing target's saved value,
  // then main/master.
  let gitBaseBranch: string | undefined;
  if (mode === 'ci') {
    const local = listLocalBranches(cwd);
    const fallback =
      currentBranch(cwd) ??
      existing?.gitBaseBranch ??
      (local.includes('main') ? 'main' : local.includes('master') ? 'master' : 'main');
    gitBaseBranch = (await inquirer.prompt([
      {
        type: 'input',
        name: 'gitBaseBranch',
        message: 'Open the deploy PR against which target branch?',
        default: fallback,
        validate: (v: string) =>
          v.trim().length > 0 ? true : 'enter a branch name',
      },
    ])).gitBaseBranch.trim();
  }

  // 7. Target name.
  const defaultName = existing?.name ?? `${adapter.id}-${branch}`;
  const name = (await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Save this target as:',
      default: defaultName,
      validate: (v: string) =>
        /^[a-z0-9][a-z0-9-]*$/.test(v.trim())
          ? true
          : 'lowercase alphanumeric + dashes only',
    },
  ])).name;

  return {
    name: name.trim(),
    kind: adapter.id,
    branch,
    vars,
    knownVars: branchVars,
    options,
    mode,
    gitBaseBranch,
  };
}

// ── Plan rendering ─────────────────────────────────────────────────────────

function renderPlan(target: TargetConfig, adapter: DeployAdapter): void {
  console.log('');
  console.log(`  ${B('Target:')}  ${target.name}  ${DIM(`(${adapter.label})`)}`);
  console.log(`  ${B('Branch:')}  ${target.branch}`);
  if (target.mode === 'ci' && target.gitBaseBranch) {
    console.log(`  ${B('PR base:')} ${target.gitBaseBranch}`);
  }
  for (const [k, v] of Object.entries(target.options)) {
    console.log(`  ${DIM(k.padEnd(7))}: ${String(v)}`);
  }
  console.log(`  ${B('Vars:')}    ${target.vars.join(', ')}`);
  console.log('');
}

function renderResult(result: DeployResult): void {
  console.log('');
  for (const step of result.steps) {
    const mark =
      step.status === 'ok' ? GREEN('✓') : step.status === 'fail' ? RED('✗') : DIM('·');
    const detail = step.detail ? `  ${DIM(step.detail)}` : '';
    const url = step.url ? `  ${step.url}` : '';
    console.log(`  ${mark} ${step.label}${detail}${url}`);
  }
  console.log('');
  if (result.epilogue) {
    console.log(result.epilogue);
    console.log('');
  }
}

// ── Subcommand: list / remove ──────────────────────────────────────────────

export async function deployList(cwd: string = process.cwd()): Promise<number> {
  const targets = listTargets(cwd);
  if (targets.length === 0) {
    console.log(`No targets configured. Run ${B('capy deploy')} to set one up.`);
    return 0;
  }
  console.log('');
  for (const t of targets) {
    const adapter = getAdapter(t.kind);
    const label = adapter ? adapter.label : t.kind;
    console.log(`  ${B(t.name)}  ${DIM(`(${label}, branch=${t.branch})`)}`);
    for (const [k, v] of Object.entries(t.options)) {
      console.log(`    ${DIM(k)}: ${String(v)}`);
    }
    console.log(`    ${DIM('vars')}: ${t.vars.join(', ')}`);
  }
  console.log('');
  return 0;
}

export async function deployRemove(
  name: string,
  cwd: string = process.cwd(),
): Promise<number> {
  const ok = removeTarget(cwd, name);
  if (!ok) {
    console.error(`No target named "${name}".`);
    return 1;
  }
  console.log(`Removed target ${B(name)}.`);
  return 0;
}

/**
 * Resolve which deploy target to use, setting one up interactively if needed —
 * but WITHOUT deploying. This is the side-effect-free "resolve" step callers
 * like `capy rotate` run before showing a plan: it guarantees a configured
 * target exists (running the picker + saving to `.capy/deploy.json` when none
 * does) and returns it, so the plan can name a real destination. The actual
 * deploy happens later via `deployCommand(target.name, …)`.
 *
 * Returns null only when resolution can't proceed (no keep.lock, or the user
 * cancels). Requires a TTY for the picker; callers in non-interactive contexts
 * should pre-resolve via a target name instead.
 */
export async function ensureDeployTarget(
  cwd: string = process.cwd(),
): Promise<TargetConfig | null> {
  const existing = listTargets(cwd);
  if (existing.length === 1) return existing[0];

  const keep = readKeep(cwd);
  if (!keep) {
    console.error(
      `No keep.lock in ${basename(cwd)}. Run ${B('capy')} here first to sync.`,
    );
    return null;
  }

  if (existing.length === 0) {
    const target = await runPicker(cwd, keep);
    upsertTarget(cwd, target);
    console.log(GREEN(`✓ Saved target "${target.name}" to .capy/deploy.json`));
    return target;
  }

  // Multiple saved targets — pick one (or set up a new one).
  const ans = await inquirer.prompt([
    {
      type: 'list',
      name: 'name',
      message: 'Which deploy target?',
      theme: LIST_THEME,
      choices: [
        ...existing.map((t) => ({
          name: `${t.name}  ${DIM(`(${t.kind}, branch=${t.branch})`)}`,
          value: t.name,
        })),
        new inquirer.Separator() as any,
        { name: '+ new target', value: '__new__' },
      ],
    } as any,
  ]);
  if (ans.name === '__new__') {
    const target = await runPicker(cwd, keep);
    upsertTarget(cwd, target);
    console.log(GREEN(`✓ Saved target "${target.name}" to .capy/deploy.json`));
    return target;
  }
  return existing.find((t) => t.name === ans.name) ?? null;
}

// ── Main: capy deploy [name] ───────────────────────────────────────────────

export async function deployCommand(
  nameArg?: string,
  options: DeployCliOptions = {},
  cwd: string = process.cwd(),
): Promise<number> {
  const keep = readKeep(cwd);
  if (!keep) {
    console.error(
      `No keep.lock in ${basename(cwd)}. Run ${B('capy')} here first to sync.`,
    );
    return 1;
  }

  // Resolve target: explicit name → load from config; --target=id → ad-hoc;
  // else picker (or confirm-last if a single target exists and no --edit).
  let target: TargetConfig | null = null;

  if (nameArg) {
    target = getTarget(cwd, nameArg);
    if (!target) {
      console.error(`No target named "${nameArg}". Run \`capy deploy list\`.`);
      return 1;
    }
  } else if (options.target) {
    const adapter = getAdapter(options.target);
    if (!adapter) {
      console.error(
        `Unknown adapter "${options.target}". Known: ${ALL_ADAPTERS.map((a) => a.id).join(', ')}`,
      );
      return 1;
    }
    if (options.yes) {
      // Ad-hoc CI path: build a transient target from auto-detected defaults.
      const detected = await adapter.detect(cwd);
      const cls = classify(keep.variables);
      target = {
        name: `${adapter.id}-adhoc`,
        kind: adapter.id,
        branch: keep.branches.includes('production') ? 'production' : keep.branches[0] ?? 'development',
        vars: adapter.presumeVars
          ? adapter.presumeVars(cls)
          : adapter.varKind === 'build-time'
            ? cls.buildTime
            : cls.runtime,
        options: detected.options ?? {},
        ...(adapter.ciOnly ? { mode: 'ci' as const } : {}),
      };
    } else {
      // Interactive but adapter is pre-chosen — handoff path from the
      // existing platform picker. If the user already saved targets for
      // this adapter, offer them first so day-2 doesn't re-fill the whole
      // picker. New target is always available as a "+ new" option.
      const sameKind = listTargets(cwd).filter((t) => t.kind === adapter.id);
      let chosen: TargetConfig | '__new__' = '__new__';
      if (sameKind.length === 1) {
        const ans = await inquirer.prompt([
          {
            type: 'list',
            name: 'pick',
            message: `Use saved target?`,
            theme: LIST_THEME,
            choices: [
              {
                name: `${sameKind[0].name}  ${DIM(`(branch=${sameKind[0].branch}, mode=${sameKind[0].mode ?? 'direct'})`)}`,
                value: '__use__',
              },
              { name: '+ new target (re-enter picker)', value: '__new__' },
            ],
            default: '__use__',
          } as any,
        ]);
        chosen = ans.pick === '__use__' ? sameKind[0] : '__new__';
      } else if (sameKind.length > 1) {
        const ans = await inquirer.prompt([
          {
            type: 'list',
            name: 'pick',
            message: `Use a saved ${adapter.label} target?`,
            theme: LIST_THEME,
            choices: [
              ...sameKind.map((t) => ({
                name: `${t.name}  ${DIM(`(branch=${t.branch}, mode=${t.mode ?? 'direct'})`)}`,
                value: t.name,
              })),
              new inquirer.Separator() as any,
              { name: '+ new target (re-enter picker)', value: '__new__' },
            ],
          } as any,
        ]);
        chosen =
          ans.pick === '__new__'
            ? '__new__'
            : sameKind.find((t) => t.name === ans.pick)!;
      }
      if (chosen !== '__new__') {
        target = chosen;
      } else {
        target = await runPicker(cwd, keep, undefined, adapter.id);
        upsertTarget(cwd, target);
        console.log(GREEN(`✓ Saved target "${target.name}" to .capy/deploy.json`));
      }
    }
  } else {
    // No name, no --target. Interactive.
    const targets = listTargets(cwd);
    if (targets.length === 0 || options.edit) {
      target = await runPicker(
        cwd,
        keep,
        options.edit && targets.length === 1 ? targets[0] : undefined,
      );
      upsertTarget(cwd, target);
      console.log(GREEN(`✓ Saved target "${target.name}" to .capy/deploy.json`));
    } else if (targets.length === 1) {
      target = targets[0];
    } else {
      const ans = await inquirer.prompt([
        {
          type: 'list',
          name: 'name',
          message: 'Which target?',
          theme: LIST_THEME,
          choices: [
            ...targets.map((t) => ({
              name: `${t.name}  ${DIM(`(${t.kind}, branch=${t.branch})`)}`,
              value: t.name,
            })),
            new inquirer.Separator() as any,
            { name: '+ new target', value: '__new__' },
          ],
        },
      ]);
      if (ans.name === '__new__') {
        target = await runPicker(cwd, keep);
        upsertTarget(cwd, target);
      } else {
        target = targets.find((t) => t.name === ans.name)!;
      }
    }
  }

  const adapter = getAdapter(target.kind);
  if (!adapter) {
    console.error(`Unknown adapter "${target.kind}" in target "${target.name}".`);
    return 1;
  }

  // Heal Vercel Preview targets saved before options.gitBranch existed. The
  // old fallback scoped the Preview env to the CAPY branch name, which fails
  // at `vercel env add` with "Branch not found in the connected Git
  // repository" whenever the names don't coincide. Ask once and persist.
  const targetOpts = target.options as Record<string, unknown>;
  if (
    target.kind === 'vercel' &&
    targetOpts.vercelEnv === 'preview' &&
    !targetOpts.gitBranch
  ) {
    if (options.yes) {
      console.error(
        `${RED('✗')} target "${target.name}" is missing options.gitBranch ` +
          `(the git branch its Vercel Preview env is wired to).`,
      );
      console.error(`\nRun \`capy deploy --edit\` once interactively to set it.`);
      return 1;
    }
    targetOpts.gitBranch = await promptVercelGitBranch(cwd);
    upsertTarget(cwd, target);
    console.log(
      GREEN(`✓ Saved gitBranch=${targetOpts.gitBranch} to target "${target.name}"`),
    );
  }

  // Var-set reconcile: the saved selection can go stale when the
  // project's variables change. Re-confirm rather than silently deploying a
  // stale set — dropping a newly-added secret, or shipping a removed one.
  {
    const branchVarSet = new Set(Object.keys(new FileManager(cwd).readEnvFile()));
    const currentVars = keep.variables.filter((v) => branchVarSet.has(v));
    // Legacy targets have no `knownVars` baseline; treat current as known so we
    // don't false-flag intentionally-unselected vars as "newly added".
    const known = target.knownVars ?? currentVars;
    const { added, removed, drifted } = reconcileVars(target.vars, known, currentVars);
    if (drifted) {
      if (added.length)
        console.log(`  ${YELLOW('!')} new project var(s) not in this target: ${B(added.join(', '))}`);
      if (removed.length)
        console.log(`  ${YELLOW('!')} target var(s) no longer in the project: ${B(removed.join(', '))}`);
      if (!options.yes && !options.dryRun && process.stdin.isTTY) {
        console.log(`  ${DIM('The project\'s variables changed — re-confirm this target.')}`);
        target = await runPicker(cwd, keep, target);
        upsertTarget(cwd, target);
        console.log(GREEN(`✓ Updated target "${target.name}" in .capy/deploy.json`));
      } else if (options.yes && added.length) {
        console.error(
          `${RED('✗')} the project gained variable(s) since this target was saved: ${added.join(', ')}.\n` +
            `    Re-run \`capy deploy ${target.name}\` interactively to include or skip them — refusing to silently drop a secret.`,
        );
        return 1;
      } else if (options.yes && removed.length) {
        // Non-interactive: a removed var can't be pushed; drop it and carry on.
        target = { ...target, vars: target.vars.filter((v) => currentVars.includes(v)), knownVars: currentVars };
      }
    }
  }

  renderPlan(target, adapter);

  // CI-only adapters (Vercel) always take the CI/PR path, even if a legacy or
  // ad-hoc target carries a stale 'direct' mode — capy never runs their CLI.
  const mode: DeployMode = adapter.ciOnly ? 'ci' : (target.mode ?? 'direct');

  // Preflight (fail BEFORE decryption).
  const preflight = await adapter.preflight(target, { cwd });
  if (!preflight.ok) {
    console.error(`${RED('✗')} preflight: ${preflight.reason}`);
    if (preflight.hint) console.error('\n' + preflight.hint);
    return 1;
  }

  // capy never blocks on uncommitted source changes. It only ever stages and
  // commits keep.lock — your work-in-progress is left exactly as it was.
  const gitOk = !options.dryRun && isGitRepo(cwd);
  const keepLockDirty = gitOk && hasKeepLockChanges(cwd);

  // Confirm-or-edit loop. Single-keypress picker (c/e/d/esc) so the user
  // can fix a saved target inline instead of having to abort, run
  // `capy deploy --edit`, then re-run.
  if (!options.yes && !options.dryRun) {
    while (true) {
      const summary =
        mode === 'ci'
          ? `Open a deploy PR (commit keep.lock + push secrets, no live deploy)?`
          : `Deploy now (commit keep.lock + ship from HEAD; your WIP is stashed and restored)?`;
      const action = await keypressConfirm({ message: summary });
      if (action === 'confirm') break;
      if (action === 'cancel') {
        console.log('Cancelled.');
        return 0;
      }
      if (action === 'delete') {
        // Only saved targets can be deleted; ad-hoc transient ones aren't on
        // disk. Either way, stop after delete — there's nothing left to do.
        const removed = removeTarget(cwd, target.name);
        if (removed) {
          console.log(`Removed target ${B(target.name)}.`);
        } else {
          console.log(`(target was not saved — nothing to delete)`);
        }
        return 0;
      }
      if (action === 'edit') {
        target = await runPicker(cwd, keep, target);
        upsertTarget(cwd, target);
        console.log(GREEN(`✓ Saved target "${target.name}" to .capy/deploy.json`));
        renderPlan(target, adapter);
        // Re-run preflight after edit — paths/options may have changed.
        const recheck = await adapter.preflight(target, { cwd });
        if (!recheck.ok) {
          console.error(`${RED('✗')} preflight: ${recheck.reason}`);
          if (recheck.hint) console.error('\n' + recheck.hint);
          return 1;
        }
        // Loop back to confirm prompt with the edited target.
        continue;
      }
    }
  }

  const msg = `chore(deploy): ${target.name} → ${target.branch} (${target.kind})`;
  const baseBranch = target.gitBaseBranch ?? 'main';

  // ── Decrypt the secrets we're about to push. In CI mode these same values
  //    drive the change-gate, so it measures exactly what ships.
  let env: Record<string, string> = {};
  let deployToken: { secretsBlob: string; projectKey: string } | undefined;
  if (options.dryRun) {
    console.log(YELLOW('  --dry-run: no secrets will be decrypted or pushed.'));
  } else if (adapter.needsDeployToken) {
    try {
      deployToken = await mintForDeploy(cwd, options.devMode);
    } catch (err: any) {
      console.error(`${RED('✗')} mint deploy token: ${err.message}`);
      return 1;
    }
  } else {
    try {
      env = await decryptCurrentBranch(cwd, options.devMode);
    } catch (err: any) {
      console.error(`${RED('✗')} decrypt: ${err.message}`);
      return 1;
    }
  }

  // ── CI change-gate ────────────────────────────────────────────
  // "Does this deploy change what's recorded on the target branch?" — keyed off
  // the decrypted values being pushed, folded into origin/<base>'s keep.lock,
  // NOT the local keep.lock file (which can lag .env). The folded keep IS what
  // we commit for the PR, so the gate and the committed artifact can't disagree.
  let keepLockChanged = false;
  let deployKeepContent = '';
  if (gitOk && mode === 'ci' && !options.dryRun) {
    const fetched = fetchRemoteBranch(cwd, baseBranch);
    if (!fetched.ok) {
      console.error(`${RED('✗')} git fetch origin ${baseBranch}: ${fetched.error}`);
      return 1;
    }
    const relKeep = repoRelPath(cwd, 'keep.lock');
    const baseRaw = readFileAtRef(cwd, `origin/${baseBranch}`, relKeep);
    let baseKeep: KeepFile;
    if (baseRaw) {
      baseKeep = JSON.parse(baseRaw);
    } else {
      // base branch has no keep.lock yet — scaffold identity from the local
      // keep with no variables, so the PR creates keep.lock from the deploy.
      const local = JSON.parse(readFileSync(join(cwd, 'keep.lock'), 'utf-8'));
      baseKeep = { ...local, variables: {} };
    }
    const nowIso = new Date().toISOString();
    const built = buildDeployKeep(baseKeep, env, target.vars, target.branch, nowIso);
    keepLockChanged = built.changed;
    deployKeepContent = built.content;

    // No secret change vs the target. --force (or an interactive confirm) touches
    // keep.lock's changed_at so there's a real diff to PR + re-trigger CI.
    if (!keepLockChanged) {
      let force = !!options.force;
      if (!force && !options.yes && process.stdin.isTTY) {
        const ans = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'force',
            message:
              `No secret changes vs origin/${baseBranch} — force a redeploy ` +
              `(touch keep.lock to re-trigger CI)?`,
            default: false,
          },
        ]);
        force = !!ans.force;
      }
      if (force) {
        deployKeepContent = touchDeployKeep(baseKeep, target.vars, target.branch, nowIso);
        keepLockChanged = true;
      }
    }
    if (!keepLockChanged) {
      console.log(
        `  ${DIM('·')} no secret changes vs origin/${baseBranch} — deploying secrets only (no PR). ${DIM('Use --force to re-trigger CI.')}`,
      );
    }
  }

  // ── Direct mode only: commit keep.lock on the current branch, stashing other
  //    WIP. CI mode never touches the user's tree — it builds the PR commit in
  //    an isolated worktree below.
  let directStashed = false;
  if (gitOk && mode === 'direct' && keepLockDirty) {
    const stash = stashOtherChanges(cwd);
    if (!stash.ok) {
      console.error(`${RED('✗')} git stash: ${stash.error}`);
      return 1;
    }
    directStashed = stash.stashed;
    if (directStashed) {
      console.log(`  ${GREEN('✓')} stash   set aside other working-tree changes (will restore)`);
    }
    const commit = stageAndCommit(cwd, ['keep.lock'], msg);
    if (!commit.ok) {
      console.error(`${RED('✗')} ${commit.error}`);
      await unwindGitState(cwd, null, directStashed);
      return 1;
    }
    console.log(`  ${GREEN('✓')} commit  ${msg}`);
  }

  // ── Push the secrets.
  const result = await adapter.deploy(target, {
    env,
    deployToken,
    dryRun: !!options.dryRun,
    secretsOnly: mode === 'ci',
    cwd,
  });
  renderResult(result);
  if (!result.ok) {
    await unwindGitState(cwd, null, directStashed);
    return 1;
  }
  if (mode === 'direct') await unwindGitState(cwd, null, directStashed);

  // ── CI mode: open the keep.lock PR in an ISOLATED git worktree.
  //    The user's working tree and current branch are NEVER touched — no stash,
  //    no checkout-back, nothing to strand on failure.
  if (mode === 'ci' && !options.dryRun && keepLockChanged) {
    const now = new Date();
    const ts =
      now.toISOString().slice(0, 10).replace(/-/g, '') + '-' +
      now.toISOString().slice(11, 19).replace(/:/g, '');
    const rand = Math.random().toString(36).slice(2, 6);
    const branchName = `capy-deploy-${ts}-${rand}`;
    const wt = join(tmpdir(), `capy-deploy-${ts}-${rand}`);

    const added = worktreeAddNewBranch(cwd, wt, branchName, `origin/${baseBranch}`);
    if (!added.ok) {
      console.error(`${RED('✗')} git worktree add (off origin/${baseBranch}): ${added.error}`);
      return 1;
    }

    let prUrl: string | undefined;
    let failed = false;
    try {
      const relKeep = repoRelPath(cwd, 'keep.lock');
      writeFileSync(join(wt, relKeep), deployKeepContent);
      const commit = stageAndCommit(wt, [relKeep], msg);
      if (!commit.ok) {
        console.error(`${RED('✗')} ${commit.error}`);
        failed = true;
      } else {
        const push = pushBranch(wt, branchName);
        if (!push.ok) {
          console.error(`${RED('✗')} git push: ${push.error}`);
          failed = true;
        } else {
          console.log(`  ${GREEN('✓')} push    ${branchName} ${DIM(`(off origin/${baseBranch})`)}`);
          const title = `deploy: ${target.name} → ${target.branch} (${target.kind})`;
          const body = buildDeployPrBody(target);
          const pr = createPr(wt, title, body, baseBranch);
          if (pr.ok) {
            prUrl = pr.url;
            console.log(`  ${GREEN('✓')} PR      ${pr.url ?? '(open)'}`);
          } else if (pr.manualHint) {
            console.log(`  ${YELLOW('!')} ${pr.manualHint}`);
          } else {
            console.error(`${RED('✗')} gh pr create: ${pr.error}`);
            failed = true;
          }
        }
      }
    } finally {
      // Always tear down the worktree + local branch ref (the branch lives on
      // origin once pushed). The user's tree was never touched, so there is
      // nothing to restore and nothing to strand.
      worktreeRemove(cwd, wt);
      deleteLocalBranch(cwd, branchName);
    }
    if (failed) return 1;

    console.log('');
    console.log(`  ${B('Review and merge to deploy:')}`);
    if (prUrl) console.log(`    ${prUrl}`);
    console.log(`    ${DIM('branch')}    ${branchName} ${DIM(`→ ${baseBranch}`)}`);
    console.log('');
  }

  return 0;
}

/**
 * Return the user to the branch they started on and pop any stash we made
 * during CI mode. Idempotent and best-effort — failures are logged but do
 * not propagate, since by the time we get here the PR has already been
 * opened (or the caller already errored). Stranding the user on a deploy
 * branch with stashed changes is worse than printing a hint.
 */
async function unwindGitState(
  cwd: string,
  originalBranch: string | null,
  stashedOthers: boolean,
): Promise<void> {
  if (originalBranch && currentBranch(cwd) !== originalBranch) {
    // The CI secrets-only path replays keep.lock onto the deploy branch without
    // committing it, so `git checkout <originalBranch>` aborts ("local changes
    // to keep.lock would be overwritten"). Drop that replayed copy first — the
    // user's real keep.lock is committed on originalBranch or in the stash we
    // made (popped just below). Best-effort: ignore if there's nothing to drop.
    discardPaths(cwd, ['keep.lock']);
    const co = checkoutBranch(cwd, originalBranch);
    if (co.ok) {
      console.log(`  ${DIM('↩')} back on ${originalBranch}`);
    } else {
      console.log(
        `  ${YELLOW('!')} could not return to ${originalBranch}: ${co.error}\n` +
          `    Run \`git checkout ${originalBranch}\` to switch back.`,
      );
    }
  }
  if (stashedOthers) {
    const pop = popStash(cwd);
    if (pop.ok) {
      console.log(`  ${DIM('↩')} restored stashed working-tree changes`);
    } else {
      console.log(
        `  ${YELLOW('!')} could not pop stash automatically: ${pop.error}\n` +
          `    Run \`git stash pop\` to restore your changes.`,
      );
    }
  }
}

function buildDeployPrBody(target: TargetConfig): string {
  const adapter = getAdapter(target.kind);
  const adapterLabel = adapter ? adapter.label : target.kind;
  const optionsTable = Object.entries(target.options)
    .map(([k, v]) => `- \`${k}\`: \`${String(v)}\``)
    .join('\n');
  const baseLine = target.gitBaseBranch
    ? `- **Git base:** \`${target.gitBaseBranch}\` — merging this PR is the deploy signal for that branch.`
    : '';

  // Secret-delivery wording depends on the adapter. Blob adapters (Vercel) push
  // SECRETS_BLOB + PROJECT_KEY and let the build decrypt via `capy run`; others
  // push the individual secrets into the vendor's store.
  const varsSection = adapter?.needsDeployToken
    ? [
        `Delivered to ${adapterLabel} as \`SECRETS_BLOB\` + \`PROJECT_KEY\` **before** this`,
        `PR was opened — the encrypted bundle of your secrets plus its build-time`,
        `key. Your individual secret values stay encrypted in the bundle and never`,
        `appear in git history; the build decrypts them with \`capy run\`:`,
        ``,
        `- \`SECRETS_BLOB\``,
        `- \`PROJECT_KEY\``,
      ].join('\n')
    : [
        `Already delivered to the vendor's secret store **before** this PR was`,
        `opened (e.g. \`wrangler secret bulk\` for cf-worker). Names only — values`,
        `stay in the vendor's store and never appear in git history:`,
        ``,
        target.vars.map((v) => `- \`${v}\``).join('\n'),
      ].join('\n');

  const mergeSection = adapter?.needsDeployToken
    ? [
        `Merging this PR is the deploy signal. ${adapterLabel}'s git CI builds on`,
        `merge, and \`capy run\` injects your secrets from \`SECRETS_BLOB\` at build`,
        `time. capy does **not** ship code from the local machine — only the`,
        `keep.lock pin lands here.`,
      ].join('\n')
    : adapter?.ciOnly
      ? [
          `Merging this PR is the deploy signal. ${adapterLabel}'s git integration`,
          `builds and deploys on merge, reading the env vars pushed above directly`,
          `from its store — no decrypt step at build. capy does **not** ship code`,
          `from the local machine — only the keep.lock pin lands here.`,
        ].join('\n')
      : [
          `Merging this PR is the deploy signal. Your CI pipeline runs the actual`,
          `code deploy (e.g. \`capy run -- wrangler deploy\` for cf-worker) using`,
          `the secrets that were pushed above. capy itself does **not** ship code`,
          `from the local machine in CI mode — only the keep.lock pin lands here.`,
        ].join('\n');

  return [
    `Automated deploy PR opened by \`capy deploy\`.`,
    ``,
    `## What this ships`,
    ``,
    `- **Target:** \`${target.name}\``,
    `- **Adapter:** ${adapterLabel} (\`${target.kind}\`)`,
    `- **Capy branch:** \`${target.branch}\` — secrets snapshot pinned by \`keep.lock\` in this commit.`,
    baseLine,
    optionsTable,
    ``,
    `## Vars pushed`,
    ``,
    varsSection,
    ``,
    `## What happens on merge`,
    ``,
    mergeSection,
    ``,
    `## Diff scope`,
    ``,
    `This PR touches at most one file: \`keep.lock\`. An empty diff means the`,
    `pinned snapshot already matched and this is a forced redeploy. Other`,
    `working-tree changes on the author's machine were not picked up.`,
    ``,
    `_Generated by \`capy deploy\`._`,
  ].join('\n');
}

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
import { existsSync, readFileSync } from 'fs';
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
  checkoutNewBranch,
  checkoutBranch,
  stashOtherChanges,
  popStash,
  pushBranch,
  createPr,
  listLocalBranches,
} from '../deploy/git';
import { ALL_ADAPTERS, getAdapter, listPlanned } from '../deploy/registry';
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

  const auth = new AuthService();
  const result = await auth.authenticateSilent(keep.orgId);
  if (!result.success || !result.user_id) {
    throw new Error('not authenticated. Run `capy` to sign in.');
  }
  const svc = new ServiceClient();
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

// ── Picker (interactive setup) ─────────────────────────────────────────────

async function runPicker(
  cwd: string,
  keep: KeepInfo,
  existing?: TargetConfig,
  /** When set, skip adapter-selection (caller has already picked). */
  preselectedAdapterId?: string,
): Promise<TargetConfig> {
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

  // 3. Adapter-specific options.
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
  }

  // 4. Branch.
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

  // 5. Var picking — show every var in keep.lock and pre-select the ones
  // most likely to be relevant for this adapter (runtime for cf-worker,
  // build-time prefixes for cf-pages). The user is the authority: they can
  // toggle anything in or out. No silent exclusion.
  const cls = classify(keep.variables);
  const presumedRelevant =
    adapter.varKind === 'build-time' ? cls.buildTime : cls.runtime;
  const defaultPicks = existing?.vars ?? presumedRelevant;
  const verb = adapter.varKind === 'build-time' ? 'inline into' : 'push to';
  if (keep.variables.length === 0) {
    throw new Error(`keep.lock has no variables — nothing to deploy.`);
  }
  const varsAns = (await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'vars',
      message: `Which vars to ${verb} ${adapter.label}? (pre-selected: ${adapter.varKind === 'build-time' ? 'VITE_/NEXT_PUBLIC_/PUBLIC_/REACT_APP_' : 'non-public-prefixed'})`,
      instructions: CHECKBOX_INSTRUCTIONS,
      theme: CHECKBOX_THEME,
      choices: keep.variables.map((v) => ({
        name: v,
        value: v,
        checked: defaultPicks.includes(v),
      })),
      validate: (v: readonly string[]) =>
        v.length > 0 ? true : 'select at least one',
    } as any,
  ])) as { vars: string[] };
  const vars = varsAns.vars;

  // 6. Mode — direct vs CI/CD.
  const mode = (await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'How should this target deploy?',
      theme: LIST_THEME,
      choices: [
        {
          name: `Deploy directly  ${DIM('— commit keep.lock + push secrets + deploy now')}`,
          value: 'direct',
          short: 'direct',
        },
        {
          name: `Via CI/CD        ${DIM('— commit keep.lock on a branch + push secrets + open PR; CI deploys on merge')}`,
          value: 'ci',
          short: 'ci',
        },
      ],
      default: existing?.mode ?? 'direct',
    } as any,
  ])).mode as DeployMode;

  // 6b. CI mode only — type the git branch the deploy PR opens against.
  // Repos can have hundreds of branches, so a list picker is the wrong
  // shape. Text entry with a sensible default (existing target's branch,
  // else `main` if it exists locally, else current branch).
  let gitBaseBranch: string | undefined;
  if (mode === 'ci') {
    const local = listLocalBranches(cwd);
    const fallback =
      existing?.gitBaseBranch ??
      (local.includes('main')
        ? 'main'
        : local.includes('master')
          ? 'master'
          : currentBranch(cwd) ?? 'main');
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
        vars: adapter.varKind === 'build-time' ? cls.buildTime : cls.runtime,
        options: detected.options ?? {},
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

  renderPlan(target, adapter);

  const mode: DeployMode = target.mode ?? 'direct';

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

  // Track state we'll need to unwind in CI mode after the PR is opened.
  let originalBranch: string | null = null;
  let stashedOthers = false;

  if (gitOk && keepLockDirty) {
    if (mode === 'ci') {
      // CI mode: branch off so the deploy PR doesn't land directly on the
      // user's working branch. Direct mode skips the branch step but still
      // does the stash + commit dance below — same shape, fewer steps.
      originalBranch = currentBranch(cwd);
      // Branch name format: `capy-deploy-YYYYMMDD-HHMMSS-<rand>` — sortable,
      // self-documenting, and avoids collisions when two deploys fire close
      // together. Flat name (no slashes) so it shows up cleanly in branch
      // pickers and `gh pr list` without nesting under a phantom directory.
      const now = new Date();
      const ts =
        now.toISOString().slice(0, 10).replace(/-/g, '') +
        '-' +
        now.toISOString().slice(11, 19).replace(/:/g, '');
      const rand = Math.random().toString(36).slice(2, 6);
      const branchName = `capy-deploy-${ts}-${rand}`;
      const co = checkoutNewBranch(cwd, branchName);
      if (!co.ok) {
        console.error(`${RED('✗')} git checkout -b ${branchName}: ${co.error}`);
        return 1;
      }
      console.log(`  ${GREEN('✓')} branch  ${branchName}`);
    }

    // BOTH modes: stash everything except keep.lock so the commit (and any
    // build that follows) sees a clean tree based on HEAD + the keep.lock
    // change only. Direct deploys will then ship from this clean state
    // instead of accidentally bundling the user's WIP.
    const stash = stashOtherChanges(cwd);
    if (!stash.ok) {
      console.error(`${RED('✗')} git stash: ${stash.error}`);
      return 1;
    }
    stashedOthers = stash.stashed;
    if (stashedOthers) {
      console.log(
        `  ${GREEN('✓')} stash   set aside other working-tree changes (will restore)`,
      );
    }

    const msg = `chore(deploy): bump keep.lock for ${target.name} (${target.branch})`;
    const commit = stageAndCommit(cwd, ['keep.lock'], msg);
    if (!commit.ok) {
      console.error(`${RED('✗')} ${commit.error}`);
      return 1;
    }
    console.log(`  ${GREEN('✓')} commit  ${msg}`);
  }

  // Decrypt the current branch — except in dry-run mode, where the adapter
  // short-circuits before using env, so we don't need to authenticate or
  // touch plaintext.
  let env: Record<string, string> = {};
  if (options.dryRun) {
    console.log(YELLOW('  --dry-run: no secrets will be decrypted or pushed.'));
  } else {
    try {
      env = await decryptCurrentBranch(cwd);
    } catch (err: any) {
      console.error(`${RED('✗')} decrypt: ${err.message}`);
      return 1;
    }
  }

  const result = await adapter.deploy(target, {
    env,
    dryRun: !!options.dryRun,
    secretsOnly: mode === 'ci',
    cwd,
  });
  renderResult(result);

  if (!result.ok) {
    // Even on failure, restore the user's WIP if we stashed it.
    await unwindGitState(cwd, originalBranch, stashedOthers);
    return 1;
  }

  // Direct mode: deploy is done. Pop the stash so the user's WIP is back
  // in their working tree. (CI mode does this after the PR step below.)
  if (mode === 'direct') {
    await unwindGitState(cwd, originalBranch, stashedOthers);
  }

  // CI mode: push the branch and open a PR for the keep.lock change. The
  // actual code deploy runs in the user's CI when the PR merges. After the
  // PR is opened (or fails), we always try to return the user to the branch
  // they started on and restore any changes we stashed — even on partial
  // failure — so a half-finished `capy deploy` never leaves them stranded.
  if (mode === 'ci' && !options.dryRun) {
    const branchNow = currentBranch(cwd);
    if (!branchNow) {
      console.error(`${RED('✗')} could not resolve current branch for push`);
      await unwindGitState(cwd, originalBranch, stashedOthers);
      return 1;
    }
    const push = pushBranch(cwd, branchNow);
    if (!push.ok) {
      console.error(`${RED('✗')} git push: ${push.error}`);
      await unwindGitState(cwd, originalBranch, stashedOthers);
      return 1;
    }
    console.log(`  ${GREEN('✓')} push    ${branchNow}`);

    const title = `deploy: ${target.name} → ${target.branch} (${target.kind})`;
    const body = buildDeployPrBody(target);
    const prBase = target.gitBaseBranch ?? 'main';
    const pr = createPr(cwd, title, body, prBase);

    let prUrl: string | undefined;
    if (pr.ok) {
      prUrl = pr.url;
      console.log(`  ${GREEN('✓')} PR      ${pr.url ?? '(open)'}`);
    } else if (pr.manualHint) {
      console.log(`  ${YELLOW('!')} ${pr.manualHint}`);
    } else {
      console.error(`${RED('✗')} gh pr create: ${pr.error}`);
      await unwindGitState(cwd, originalBranch, stashedOthers);
      return 1;
    }

    await unwindGitState(cwd, originalBranch, stashedOthers);

    // Final summary — make the PR link unmissable, since this is the
    // hand-off point. CI takes over once the user opens the PR.
    console.log('');
    console.log(`  ${B('Review and merge to deploy:')}`);
    if (prUrl) console.log(`    ${prUrl}`);
    console.log(`    ${DIM('branch')}    ${branchNow}`);
    if (originalBranch) {
      console.log(`    ${DIM('you are on')} ${currentBranch(cwd) ?? originalBranch}`);
    }
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
    `Already delivered to the vendor via \`wrangler secret bulk\` (or adapter`,
    `equivalent) **before** this PR was opened. Names only — values stay in`,
    `the vendor's secret store and never appear in git history:`,
    ``,
    target.vars.map((v) => `- \`${v}\``).join('\n'),
    ``,
    `## What happens on merge`,
    ``,
    `Merging this PR is the deploy signal. Your CI pipeline runs the actual`,
    `code deploy (e.g. \`capy run -- wrangler deploy\` for cf-worker) using`,
    `the secrets that were pushed above. capy itself does **not** ship code`,
    `from the local machine in CI mode — only the keep.lock pin lands here.`,
    ``,
    `## Diff scope`,
    ``,
    `This PR contains exactly one file change: \`keep.lock\`. Other working-`,
    `tree changes on the author's machine were not picked up.`,
    ``,
    `_Generated by \`capy deploy\`._`,
  ].join('\n');
}

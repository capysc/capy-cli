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
  guardWorkingTree,
  stageAndCommit,
  currentBranch,
  checkoutNewBranch,
  pushBranch,
  createPr,
} from '../deploy/git';
import { ALL_ADAPTERS, getAdapter, listPlanned } from '../deploy/registry';
import { classify } from '../deploy/classify';
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
        choices,
      },
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

  // 3. Adapter-specific options. Today only cf-worker.
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
  }

  // 4. Branch.
  const branch = (await inquirer.prompt([
    {
      type: 'list',
      name: 'branch',
      message: 'Which capy branch ships to this target?',
      choices: keep.branches.length > 0 ? keep.branches : ['development'],
      default: existing?.branch ?? (keep.branches.includes('production') ? 'production' : keep.branches[0]),
    },
  ])).branch;

  // 5. Var classification — show suggested split, let user adjust.
  const cls = classify(keep.variables);
  const defaultRuntime = existing?.vars ?? cls.runtime;
  if (cls.buildTime.length > 0) {
    console.log(
      `  ${DIM(`Build-time vars (${cls.buildTime.length}) auto-excluded from ${adapter.label}: ${cls.buildTime.join(', ')}`)}`,
    );
  }
  const varsAns = (await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'vars',
      message: `Which runtime vars to push to ${adapter.label}?`,
      choices: cls.runtime.map((v) => ({
        name: v,
        value: v,
        checked: defaultRuntime.includes(v),
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
    },
  ])).mode as DeployMode;

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
  };
}

// ── Plan rendering ─────────────────────────────────────────────────────────

function renderPlan(target: TargetConfig, adapter: DeployAdapter): void {
  console.log('');
  console.log(`  ${B('Target:')}  ${target.name}  ${DIM(`(${adapter.label})`)}`);
  console.log(`  ${B('Branch:')}  ${target.branch}`);
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
      target = {
        name: `${adapter.id}-adhoc`,
        kind: adapter.id,
        branch: keep.branches.includes('production') ? 'production' : keep.branches[0] ?? 'development',
        vars: classify(keep.variables).runtime,
        options: detected.options ?? {},
      };
    } else {
      // Interactive but adapter is pre-chosen — handoff path from existing
      // platform picker. Run the rest of the picker (worker name, branch,
      // vars) with the adapter pinned.
      target = await runPicker(cwd, keep, undefined, adapter.id);
      upsertTarget(cwd, target);
      console.log(GREEN(`✓ Saved target "${target.name}" to .capy/deploy.json`));
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

  // Working-tree guard (skip in dry-run — we don't mutate anything).
  // Both modes require: clean working tree except for keep.lock, which we
  // auto-commit since it has no secrets and changes naturally during deploy.
  let gitGuard: ReturnType<typeof guardWorkingTree> | null = null;
  if (!options.dryRun && isGitRepo(cwd)) {
    gitGuard = guardWorkingTree(cwd);
    if (!gitGuard.ok) {
      console.error(`${RED('✗')} working tree has uncommitted changes:`);
      for (const e of gitGuard.blockingChanges) {
        console.error(`    ${e.code} ${e.path}`);
      }
      console.error(
        `\nCommit or stash them, then re-run \`capy deploy\`.\n` +
          `(capy auto-commits keep.lock changes; everything else is yours.)`,
      );
      return 1;
    }
  }

  if (!options.yes && !options.dryRun) {
    const summary =
      mode === 'ci'
        ? `Open a deploy PR (commit keep.lock + push secrets, no live deploy)?`
        : `Deploy now (commit keep.lock + push secrets + ship code)?`;
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: summary,
        default: true,
      },
    ]);
    if (!confirm) {
      console.log('Cancelled.');
      return 0;
    }
  }

  // Auto-commit keep.lock (and switch to a deploy branch first if CI mode).
  if (!options.dryRun && gitGuard && gitGuard.autoCommitChanges.length > 0) {
    if (mode === 'ci') {
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const branchName = `capy-deploy/${target.name}-${ts}-${Math.random().toString(36).slice(2, 7)}`;
      const co = checkoutNewBranch(cwd, branchName);
      if (!co.ok) {
        console.error(`${RED('✗')} git checkout -b ${branchName}: ${co.error}`);
        return 1;
      }
      console.log(`  ${GREEN('✓')} branch  ${branchName}`);
    }
    const paths = gitGuard.autoCommitChanges.map((e) => e.path);
    const msg = `chore(deploy): bump keep.lock for ${target.name} (${target.branch})`;
    const commit = stageAndCommit(cwd, paths, msg);
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

  if (!result.ok) return 1;

  // CI mode: push the branch and open a PR for the keep.lock change. The
  // actual code deploy runs in the user's CI when the PR merges.
  if (mode === 'ci' && !options.dryRun) {
    const branchNow = currentBranch(cwd);
    if (!branchNow) {
      console.error(`${RED('✗')} could not resolve current branch for push`);
      return 1;
    }
    const push = pushBranch(cwd, branchNow);
    if (!push.ok) {
      console.error(`${RED('✗')} git push: ${push.error}`);
      return 1;
    }
    console.log(`  ${GREEN('✓')} push    ${branchNow}`);

    const title = `deploy: ${target.name} (${target.branch})`;
    const body =
      `Automated deploy PR opened by \`capy deploy\`.\n\n` +
      `- Target: \`${target.name}\` (${target.kind})\n` +
      `- Branch: \`${target.branch}\`\n` +
      `- Vars pushed: ${target.vars.join(', ')}\n\n` +
      `Secrets have already been pushed to the vendor via \`wrangler secret bulk\`. ` +
      `Merging this PR triggers the actual deploy in CI.`;
    const pr = createPr(cwd, title, body);
    if (pr.ok) {
      console.log(`  ${GREEN('✓')} PR      ${pr.url ?? '(open)'}`);
    } else if (pr.manualHint) {
      console.log(`  ${YELLOW('!')} ${pr.manualHint}`);
    } else {
      console.error(`${RED('✗')} gh pr create: ${pr.error}`);
      return 1;
    }
  }

  return 0;
}

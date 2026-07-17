import {
  resolveContext,
  writeAndSync,
  listManagedKeys,
  listAllVarsOnBranch,
  findManagedConnector,
} from './connectors/shared';
import { ConnectCommand, confirmLiveAction } from './connectCommand';
import { loadProvider, listProviders, RotateOpts } from './connectors/registry';
import { ProjectManager } from '../core/projectManager';
import { ConnectorMetadata, KeepFile } from '../types/index';
import { TargetConfig } from '../deploy/adapter';
import { isInteractive, refuseNonInteractive } from '../ui/interactive';
import { writeSync } from 'fs';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

interface PlanStop {
  label: string;
  detail: string;
  /**
   * A manual, user-driven stop (e.g. an interactive `stripe login`, or deploy
   * connector setup). Any track touching a manual stop — leaving it or
   * arriving at it — is drawn dotted, so the diagram visually separates "you
   * do this by hand" from the solid run of steps capy performs on its own.
   */
  manual?: boolean;
  /**
   * An unresolved stop — a blank in the plan. Rendered dimmed with a hollow
   * placeholder node so the user sees exactly what still needs an answer.
   * Resolution (selectors / agent needs-input) fills these before the Y/N.
   */
  blank?: boolean;
}

/**
 * Render the rotation plan as a vertical train-stop diagram: each stage is a
 * station (● intermediate, ○ terminal) joined by track, with a dimmed
 * one-line description. A track segment is dotted (┊) when either station it
 * connects is manual, else solid (│). It's a confirmation aid — the route the
 * rotation will travel — not a progress bar; the ✓ lines printed during
 * execution report what actually happened.
 */
function renderRotationPlan(stops: PlanStop[]): void {
  const width = Math.max(...stops.map((s) => s.label.length));
  const lines: string[] = ['', `  ${B('Rotation plan')}`, ''];
  stops.forEach((s, i) => {
    const last = i === stops.length - 1;
    const node = s.blank ? DIM('◌') : last ? CYAN('○') : CYAN('●');
    const label = s.blank ? DIM(s.label.padEnd(width)) : B(s.label.padEnd(width));
    lines.push(`  ${node}  ${label}   ${DIM(s.detail)}`);
    if (!last) {
      const dotted = s.manual || stops[i + 1].manual;
      lines.push(`  ${DIM(dotted ? '┊' : '│')}`);
    }
  });
  lines.push('');
  // Write synchronously to fd 1. A backgrounded run pipes stdout, where
  // console.log is buffered and would only flush AFTER the blocking
  // `stripe login` spawnSync — so the plan would be missing from the captured
  // output during the auth wait (when the agent reads it to relay the pairing
  // code). writeSync lands the whole plan now, before that block.
  writeSync(1, lines.join('\n') + '\n');
}

/** One-line description of how a configured target ships, for the Deploy stop. */
function describeDeploy(t: TargetConfig): string {
  const mode = t.mode ?? 'direct';
  // Vercel sets env vars (scoped to the Vercel environment) as part of deploy.
  if (t.kind === 'vercel') {
    const venv = (t.options as { vercelEnv?: string } | undefined)?.vercelEnv;
    const scope =
      venv === 'preview' ? `preview · branch=${t.branch}` : venv === 'production' ? 'production' : (venv ?? '?');
    const prBit =
      mode === 'ci' ? ` + open deploy PR${t.gitBaseBranch ? ` against ${t.gitBaseBranch}` : ''}` : '';
    return `push SECRETS_BLOB + PROJECT_KEY to Vercel ${scope}${prBit}`;
  }
  if (mode === 'ci') {
    const base = t.gitBaseBranch ? ` against ${t.gitBaseBranch}` : '';
    return `open a deploy PR for ${t.name}${base} (CI ships on merge)`;
  }
  return `ship directly to ${t.name}`;
}

export class RotateCommand {
  private devMode: boolean;

  constructor(devMode: boolean = false) {
    this.devMode = devMode;
  }

  async execute(
    varName: string | undefined,
    opts: RotateOpts & { all?: boolean; skipPrompts?: boolean; provider?: string },
  ): Promise<void> {
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    const branch = pm.deriveActiveBranch();

    if (!keep) {
      console.error('\n  No keep.lock found. Run `capy` first to initialize.\n');
      process.exit(1);
    }
    if (!branch) {
      console.error(`\n  No active branch. Run ${B('capy')} to select a branch.\n`);
      process.exit(1);
    }

    const managed = listManagedKeys(keep, branch);
    const allVars = listAllVarsOnBranch(keep, branch);

    // --all only operates on already-managed keys. We don't auto-promote
    // unmanaged vars in bulk — that needs per-var intent.
    if (opts.all) {
      if (managed.length === 0) {
        console.error('\n  No managed keys to rotate on this branch.');
        console.error(`  Connect one with ${B('capy connect <provider>')}, or run ${B('capy rotate')} to set up an existing var.\n`);
        process.exit(1);
      }
      await this.planAndRotate(managed, branch, opts);
      return;
    }

    // Resolve which (varName, connector|unmanaged) we're operating on.
    let target: { varName: string; connector: ConnectorMetadata } | { varName: string; unmanaged: true };

    if (varName) {
      const connector = findManagedConnector(keep, varName, branch);
      if (connector) {
        target = { varName, connector };
      } else if (allVars.includes(varName)) {
        target = { varName, unmanaged: true };
      } else {
        console.error(`\n  ${B(varName)} is not in your environment on branch ${branch}.`);
        if (allVars.length > 0) {
          console.error(`  Available: ${allVars.join(', ')}`);
        }
        console.error('');
        process.exit(1);
      }
    } else {
      if (allVars.length === 0) {
        console.error('\n  No variables on this branch yet.');
        console.error(`  Add one to .env and run ${B('capy')}, or run ${B('capy connect <provider>')}.\n`);
        process.exit(1);
      }
      if (!isInteractive(opts.nonTty)) {
        refuseNonInteractive(
          'no variable specified and the picker needs a prompt',
          `Pass the variable name: capy rotate <VAR> (available: ${allVars.join(', ')}).`,
        );
      }
      const inquirer = (await import('inquirer')).default;
      const { picked } = await inquirer.prompt([
        {
          type: 'list',
          name: 'picked',
          message: 'Which variable to rotate:',
          choices: buildRotatePickerChoices(allVars, keep, branch).map(
            ({ name, value }) => ({ name, value }),
          ),
        },
      ]);
      const connector = findManagedConnector(keep, picked, branch);
      target = connector ? { varName: picked, connector } : { varName: picked, unmanaged: true };
    }

    if ('unmanaged' in target) {
      await this.promoteAndConnect(target.varName, opts);
      return;
    }

    await this.planAndRotate([target], branch, opts);
  }

  /**
   * Unmanaged var picked for rotation → prompt for an integration and
   * delegate to ConnectCommand. That flow fetches a fresh key from the
   * provider, overwrites the existing value, and tags the keep.lock entry
   * as connector-managed for future rotations.
   */
  private async promoteAndConnect(
    varName: string,
    opts: RotateOpts & { provider?: string },
  ): Promise<void> {
    const providers = listProviders();
    if (providers.length === 0) {
      console.error('\n  No connectors are registered. Cannot promote.\n');
      process.exit(1);
    }

    let provider: string;
    if (!isInteractive(opts.nonTty)) {
      // Non-interactive: resolve the integration from --provider, or auto-pick
      // it only when there's exactly one registered (unambiguous). Otherwise
      // refuse — we won't silently guess which provider owns this credential.
      if (opts.provider) {
        if (!providers.some((p) => p.name === opts.provider)) {
          refuseNonInteractive(
            `unknown integration "${opts.provider}"`,
            `Known integrations: ${providers.map((p) => p.name).join(', ')}.`,
          );
        }
        provider = opts.provider;
      } else if (providers.length === 1) {
        provider = providers[0].name;
      } else {
        refuseNonInteractive(
          `${B(varName)} isn't connected to an integration yet, and several are available`,
          `Pass --provider <name> (one of: ${providers.map((p) => p.name).join(', ')}).`,
        );
      }
    } else {
      console.log('');
      console.log(`  ${B(varName)} isn't connected to a third-party integration yet.`);
      console.log('  Pick one and Capy will rotate it via the provider from here on.');
      console.log('');

      const inquirer = (await import('inquirer')).default;
      const picked = await inquirer.prompt([
        {
          type: 'list',
          name: 'provider',
          message: 'Integration:',
          choices: [
            ...providers.map((p) => ({ name: `${B(p.name)} — ${p.description}`, value: p.name })),
            new inquirer.Separator(),
            { name: 'Cancel', value: '__cancel__' },
          ],
        },
      ]);
      if (picked.provider === '__cancel__') {
        console.log('\n  Cancelled.\n');
        return;
      }
      provider = picked.provider;
    }

    const connect = new ConnectCommand(this.devMode);
    await connect.execute(provider, {
      var: varName,
      force: true,
      noPush: opts.noPush,
      nonTty: opts.nonTty,
    });
  }

  /**
   * Rotate one or more already-managed keys. Live-mode firewall in dev,
   * provider preflight, per-rotation confirmation in prod live mode.
   */
  private async rotateMany(
    targets: Array<{ varName: string; connector: ConnectorMetadata }>,
    opts: RotateOpts & { all?: boolean },
  ): Promise<string[]> {
    let toRotate = targets;

    if (this.devMode) {
      const liveOnes = toRotate.filter((m) => m.connector.mode === 'live');
      if (!opts.all && liveOnes.length > 0) {
        console.error(
          `\n  ${B(liveOnes[0].varName)} is configured for live mode.`,
        );
        console.error('  Rotate cannot run via capy-dev. Use the production `capy` binary.\n');
        process.exit(1);
      }
      if (opts.all && liveOnes.length > 0) {
        console.log('');
        for (const m of liveOnes) {
          console.log(
            `  \x1b[33m⚠ skipping ${m.varName} (live mode — not allowed in capy-dev)\x1b[0m`,
          );
        }
        toRotate = toRotate.filter((m) => m.connector.mode !== 'live');
        if (toRotate.length === 0) {
          console.error('\n  Nothing to rotate. All managed keys are live-mode.');
          process.exit(1);
        }
      }
    }

    const precheckedProviders = new Set<string>();
    for (const { connector } of toRotate) {
      if (precheckedProviders.has(connector.provider)) continue;
      precheckedProviders.add(connector.provider);
      const mod = await loadProvider(connector.provider);
      if (mod.precheck) mod.precheck();
    }

    const ctx = await resolveContext({ devMode: this.devMode });

    const succeeded: string[] = [];
    const failed: { name: string; err: any }[] = [];

    for (const { varName: name, connector } of toRotate) {
      try {
        // Prod live rotation normally gates on a human typing the account ID.
        // In assisted non-interactive mode we skip that echo: the rotation
        // re-runs `stripe login`, and completing that browser pairing is itself
        // the human-presence proof (see docs/rotate-deploy-agent-flow.md). The
        // typed confirmation only runs in an interactive terminal.
        if (!this.devMode && connector.mode === 'live' && isInteractive(opts.nonTty)) {
          const ok = await confirmLiveAction({
            action: 'rotate',
            varName: name,
            accountId: connector.account_id ?? '(unknown)',
            keyPrefix: connector.fingerprint?.slice(0, 8),
          });
          if (!ok) {
            console.log(`  Cancelled ${name}.`);
            failed.push({ name, err: new Error('confirmation declined') });
            if (opts.all) continue;
            process.exit(1);
          }
        }

        const mod = await loadProvider(connector.provider);
        const { value, entry: updated } = await mod.rotate(ctx, name, connector, {
          noPush: opts.noPush,
        });

        const freshCtx = await resolveContext({ devMode: this.devMode });
        await writeAndSync(freshCtx, name, value, { push: !opts.noPush, connector: updated });

        succeeded.push(name);
        console.log('');
        console.log(`  ✓ ${B(name)} rotated${opts.noPush ? ' (local only)' : ' and pushed'}.`);
        if (connector.source === 'cli') {
          console.log(
            `  ⚠ The previous key is now invalid. Teammates must run ${B('capy')} to pick up the new value.`,
          );
        }
        console.log('');
      } catch (err) {
        failed.push({ name, err });
        console.error('');
        console.error(`  ✗ Failed to rotate ${B(name)}: ${(err as Error).message}`);
        console.error('');
        if (opts.all) continue;
        process.exit(1);
      }
    }

    if (opts.all && (succeeded.length > 0 || failed.length > 0)) {
      console.log('');
      console.log(`  Rotated ${succeeded.length}/${toRotate.length} key(s).`);
      if (failed.length > 0) {
        console.log(`  Failed: ${failed.map((f) => f.name).join(', ')}`);
        process.exit(1);
      }
      console.log('');
    }

    return succeeded;
  }

  /**
   * Autorotation entrypoint for the managed-key path, modelled as
   * resolve → confirm → apply (see docs/rotate-deploy-agent-flow.md):
   *
   *   Resolve — gather every input the journey needs until the train-stop has
   *             no blanks. Side-effect-free. The deploy integration is set up
   *             inline here (picker), NOT as a confirmed action.
   *   Confirm — render the complete train-stop, take one Y/N.
   *   Apply   — rotate → push → deploy. Deploy is the automatic terminal step,
   *             never a separate, optional action.
   *
   * --no-push is local-only with nothing to ship, so it skips the diagram and
   * rotates directly.
   */
  private async planAndRotate(
    targets: Array<{ varName: string; connector: ConnectorMetadata }>,
    branch: string,
    opts: RotateOpts & { all?: boolean; skipPrompts?: boolean },
  ): Promise<void> {
    if (opts.noPush) {
      await this.rotateMany(targets, opts);
      return;
    }

    const isTTY = isInteractive(opts.nonTty);

    // ── Resolve: deploy target (gate 3) ─────────────────────────────────────
    // Branch (gate 1) is the active branch; the credential connector (gate 2)
    // is already managed by the time we reach here. The remaining gate is the
    // deploy target. Resolving it is side-effect-free; nothing ships until Apply.
    //
    // Deploy is NOT gated on dev-vs-prod: capy-dev opens CI/PR deploys too — a
    // deploy PR is just `git push` + `gh pr create`, not a vendor write. The
    // only dev restriction is the direct-ship guard below: capy-dev never
    // invokes a vendor CLI/API directly.
    const { listTargets } = await import('../deploy/config');
    const configuredTargets = listTargets(process.cwd());
    let deployTarget: TargetConfig | null = null;
    if (isTTY) {
      // Interactive: ensure a target exists, setting one up inline if needed.
      const { ensureDeployTarget } = await import('./deployCommand');
      deployTarget = await ensureDeployTarget(process.cwd());
      if (!deployTarget) {
        console.log('\n  Cancelled.\n');
        return;
      }
    } else if (configuredTargets.length === 1) {
      // Non-interactive: auto-resolve the unambiguous single target. With zero
      // or several we don't refuse — rotate + push still runs and the user is
      // kicked into the deploy flow afterward (deployTarget stays null).
      deployTarget = configuredTargets[0];
    }

    // Dev isolation: capy-dev may open a CI/PR deploy, but must never run a
    // direct vendor ship. Drop a resolved direct-mode target in dev.
    if (this.devMode && deployTarget && (deployTarget.mode ?? 'direct') !== 'ci') {
      console.log(
        `\n  \x1b[33m⚠ capy-dev skips the direct-mode deploy for ${deployTarget.name} (CI/PR only in dev).\x1b[0m`,
      );
      deployTarget = null;
    }

    // ── Build the (now fully resolved) train-stop ───────────────────────────
    const providers = Array.from(new Set(targets.map((t) => t.connector.provider)));
    const providerLabel = providers.map(cap).join(', ');
    const rotateDetail =
      targets.length === 1
        ? `fetch a fresh key from ${providerLabel}`
        : `fetch fresh keys for ${targets.length} credentials from ${providerLabel}`;

    // Providers that hand off to an interactive login (Stripe → `stripe
    // login`) get a leading, dotted "Auth" stop.
    const authProviders: string[] = [];
    for (const p of providers) {
      const mod = await loadProvider(p);
      if (mod.requiresAuth) authProviders.push(p);
    }

    const stops: PlanStop[] = [];
    if (authProviders.length > 0) {
      stops.push({
        label: 'Auth',
        detail: `authenticate with ${authProviders.map(cap).join(', ')} (requires manual user auth)`,
        manual: true,
      });
    }
    stops.push({ label: 'Rotate', detail: rotateDetail });
    stops.push({ label: 'Push', detail: `encrypt + push to Capy (branch: ${branch})` });
    // Deploy is always a stop — it's the terminal step of every rotation, dev
    // included. When unresolved it's a blank stop the user resolves via the
    // deploy flow after rotate + push.
    stops.push(
      deployTarget
        ? { label: 'Deploy', detail: describeDeploy(deployTarget) }
        : { label: 'Deploy', detail: 'set up a deploy target — opens a rollout PR (CI deploys on merge)', blank: true },
    );

    renderRotationPlan(stops);

    // ── Confirm: single Y/N gate ─────────────────────────────────────────────
    // Interactive only. Non-interactive (--non-tty / --skip-prompts / piped)
    // skips it; Apply still runs rotate → push → deploy when a target resolved,
    // else rotate + push and kick into the deploy flow.
    if (!opts.skipPrompts && isTTY) {
      const inquirer = (await import('inquirer')).default;
      const { proceed } = await inquirer.prompt([
        { type: 'confirm', name: 'proceed', message: 'Proceed?', default: true },
      ]);
      if (!proceed) {
        console.log('\n  Cancelled.\n');
        return;
      }
    }

    // ── Apply ────────────────────────────────────────────────────────────────
    const rotated = await this.rotateMany(targets, opts);
    if (rotated.length === 0) return;

    if (deployTarget) {
      const { deployCommand } = await import('./deployCommand');
      const code = await deployCommand(deployTarget.name, { yes: true, devMode: this.devMode });
      if (code !== 0) process.exit(code);
    } else {
      // No target resolved (none configured, several to disambiguate, or a
      // dev direct-mode target we skipped). The key is already rotated +
      // pushed; kick the user into the deploy flow to open the rollout PR.
      this.deployHint(configuredTargets.length);
    }
  }

  /**
   * Rotated + pushed, but we didn't ship — point the user into the deploy flow
   * to open the rollout PR. The key is already live in Capy; this is the
   * rollout step, not a leftover.
   */
  private deployHint(targetCount: number): void {
    if (targetCount === 0) {
      console.log(`  ✓ Rotated + pushed. No deploy target yet — set one up to open the rollout PR: ${B('capy deploy')}`);
    } else if (targetCount > 1) {
      console.log(`  ✓ Rotated + pushed. Pick a target to open the rollout PR: ${B('capy deploy <target>')}`);
    } else {
      console.log(`  ✓ Rotated + pushed. Deploy to open the rollout PR: ${B('capy deploy')}`);
    }
    console.log('');
  }
}

function formatChoice(name: string, c: ConnectorMetadata): string {
  const parts = [c.provider];
  if (c.fingerprint) parts.push(c.fingerprint);
  if (typeof c.expires_at === 'number') {
    const days = Math.floor((c.expires_at - Date.now() / 1000) / 86400);
    parts.push(days < 0 ? `expired ${-days}d ago` : days === 0 ? 'expires today' : `expires in ${days}d`);
  }
  return `${name}  (${parts.join(', ')})`;
}

/**
 * Shape the picker rows shown by `capy rotate` (no args). Managed vars get
 * the provider summary; unmanaged ones are annotated `(unmanaged)`. Order
 * matches the input order — caller controls sort.
 */
export function buildRotatePickerChoices(
  allVars: string[],
  keep: KeepFile,
  branch: string,
): Array<{ name: string; value: string; managed: boolean }> {
  return allVars.map((v) => {
    const c = findManagedConnector(keep, v, branch);
    return {
      name: c ? formatChoice(v, c) : `${v}  \x1b[90m(unmanaged)\x1b[0m`,
      value: v,
      managed: !!c,
    };
  });
}

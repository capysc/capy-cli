import {
  resolveContext,
  writeAndSync,
  listManagedKeys,
  listAllVarsOnBranch,
  findManagedConnector,
} from './connectors/shared';
import { ConnectCommand, confirmLiveAction, rotateLiveGateStops } from './connectCommand';
import { loadProvider, listProviders, RotateOpts } from './connectors/registry';
import { cap, rotationPlan, type RotationPlanInput } from './connectors/plans';
import { ProjectManager } from '../core/projectManager';
import { ConnectorMetadata, KeepFile } from '../types/index';
import { TargetConfig } from '../deploy/adapter';
import { isInteractive, refuseNonInteractive } from '../ui/interactive';
import { confirmLiveActionInBrowser } from '../ui/connectScreens';
import type {
  RotateAdvisory,
  RotateCandidate,
  RotateKeyResult,
  RotatePlanStop,
  RotateRunOutcome,
  RotateRunStep,
  RotateRunStop,
} from '../ui/screens/contract';
import { writeSync } from 'fs';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;

/** Browser paths honour this so a test never opens the developer's real browser. */
const shouldOpen = (): boolean => !process.env.CAPY_WEB_NO_OPEN;

/**
 * Render the rotation plan as a vertical train-stop diagram: each stage is a
 * station (✓ answered, ● intermediate, ○ terminal, ◌ blank, · never visited)
 * joined by track, with a dimmed one-line description. A track segment is
 * dotted (┊) when either station it connects is manual, else solid (│). It's a
 * confirmation aid — the route the rotation will travel — not a progress bar;
 * the ✓ lines printed during execution report what actually happened.
 *
 * The stops are `rotationPlan`'s, not this function's. They used to be built
 * inline here, printed and dropped, which is why the browser had no rail to
 * draw and `--json` had no route to emit — and why the diagram began at the
 * Auth stop, with the variable and the integration the user had just answered
 * missing from the picture of what they were agreeing to.
 */
export function rotationPlanLines(stops: RotatePlanStop[]): string[] {
  const width = Math.max(...stops.map((s) => s.label.length));
  const lines: string[] = ['', `  ${B('Rotation plan')}`, ''];
  stops.forEach((s, i) => {
    const last = i === stops.length - 1;
    const faint = s.blank || s.state === 'skipped';
    const node = s.blank
      ? DIM('◌')
      : s.state === 'skipped'
        ? DIM('·')
        : s.state === 'done'
          ? CYAN('✓')
          : last
            ? CYAN('○')
            : CYAN('●');
    const label = faint ? DIM(s.label.padEnd(width)) : B(s.label.padEnd(width));
    // An answered stop says what answered it. `Variable · STRIPE_SECRET_KEY`
    // with no marker is indistinguishable from a question still to come, and
    // the flag is the honest answer to "why was I never asked?".
    const settled = s.answer ? DIM(` · ${s.answer}${s.flag ? ` (${s.flag})` : ''}`) : '';
    lines.push(`  ${node}  ${label}   ${DIM(s.detail ?? '')}${settled}`);
    if (!last) {
      const dotted = s.manual || stops[i + 1].manual;
      lines.push(`  ${DIM(dotted ? '┊' : '│')}`);
    }
  });
  lines.push('');
  return lines;
}

function renderRotationPlan(stops: RotatePlanStop[]): void {
  // Write synchronously to fd 1. A backgrounded run pipes stdout, where
  // console.log is buffered and would only flush AFTER the blocking
  // `stripe login` spawnSync — so the plan would be missing from the captured
  // output during the auth wait (when the agent reads it to relay the pairing
  // code). writeSync lands the whole plan now, before that block.
  writeSync(1, rotationPlanLines(stops).join('\n') + '\n');
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
      // `--all` ignores a positional variable and says nothing about it. The
      // plan screen carries that as an advisory rather than letting the user
      // approve a run they think is about one credential.
      await this.planAndRotate(managed, branch, { ...opts, varIgnored: varName });
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
      let picked: string;
      if (opts.web) {
        const candidates = buildRotateCandidates(allVars, keep, branch);
        const { askRotateVariableInBrowser } = await import('../ui/rotateScreens');
        const answer = await askRotateVariableInBrowser({
          step: 'variable',
          projectName: keep.project_name,
          branch,
          devMode: this.devMode,
          all: false,
          noPush: opts.noPush === true,
          stops: await this.planStops(keep, branch, opts, { standing: 'variable' }),
          candidates,
          open: shouldOpen(),
        });
        if (answer.cancelled) {
          console.log('\n  Cancelled.\n');
          return;
        }
        picked = answer.variable;
      } else {
        if (!isInteractive(opts.nonTty)) {
          refuseNonInteractive(
            'no variable specified and the picker needs a prompt',
            `Pass the variable name: capy rotate <VAR> (available: ${allVars.join(', ')}).`,
          );
        }
        const inquirer = (await import('inquirer')).default;
        const answer = await inquirer.prompt([
          {
            type: 'list',
            name: 'picked',
            message: 'Which variable to rotate:',
            choices: buildRotatePickerChoices(allVars, keep, branch).map(
              ({ name, value }) => ({ name, value }),
            ),
          },
        ]);
        picked = answer.picked;
      }
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
    if (opts.web) {
      // Never pre-selected, however few are registered. Off a TTY the CLI
      // auto-picks the single provider with no output at all — for a variable
      // the user never associated with it — and what follows runs with
      // `force: true`, so the value in that variable is replaced rather than
      // rotated. The screen says that before the list, not after the write.
      const pm = new ProjectManager();
      const keep = pm.readKeepFile();
      const branch = pm.deriveActiveBranch() ?? '';
      const { askRotateIntegrationInBrowser } = await import('../ui/rotateScreens');
      const answer = await askRotateIntegrationInBrowser({
        step: 'integration',
        projectName: keep?.project_name ?? 'project',
        branch,
        devMode: this.devMode,
        all: false,
        noPush: opts.noPush === true,
        stops: keep
          ? await this.planStops(keep, branch, opts, {
              standing: 'integration',
              varName,
              needsIntegration: true,
            })
          : [],
        integrations: providers,
        varName,
        open: shouldOpen(),
      });
      if (answer.cancelled) {
        console.log('\n  Cancelled.\n');
        return;
      }
      provider = answer.provider;
    } else if (!isInteractive(opts.nonTty)) {
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
      // The connect flow takes over from here, and it has to keep serving
      // screens: dropping `--web` at the hand-off is how a browser flow ends
      // up at a TTY prompt nobody is watching.
      web: opts.web,
    });
  }

  /**
   * The route this run will travel, resolved before anything opens.
   *
   * One builder, so the diagram `renderRotationPlan` prints, the rail the
   * browser draws and the array `--json` would emit cannot describe different
   * journeys.
   */
  private async planStops(
    keep: KeepFile | null,
    branch: string,
    opts: RotateOpts & { all?: boolean; provider?: string },
    settled: Partial<RotationPlanInput> = {},
  ): Promise<RotatePlanStop[]> {
    const providers =
      settled.providers ??
      (keep
        ? Array.from(new Set(listManagedKeys(keep, branch).map((m) => m.connector.provider)))
        : []);
    const authProviders: string[] = [];
    for (const p of providers) {
      const mod = await loadProvider(p).catch(() => undefined);
      if (mod?.requiresAuth) authProviders.push(p);
    }
    return rotationPlan({
      branch,
      all: opts.all === true,
      noPush: opts.noPush === true,
      ...(opts.provider ? { integration: opts.provider, integrationFromFlag: true } : {}),
      ...settled,
      providers,
      authProviders,
    });
  }

  /**
   * Rotate one or more already-managed keys. Live-mode firewall in dev,
   * provider preflight, per-rotation confirmation in prod live mode.
   */
  private async rotateMany(
    targets: Array<{ varName: string; connector: ConnectorMetadata }>,
    opts: RotateOpts & { all?: boolean },
  ): Promise<RotateRunReport> {
    let toRotate = targets;
    const web = opts.web === true;
    // Every credential the run touched keeps a row, including the ones it
    // never reached. `Rotated 2/3 key(s).` says nothing about which of the
    // three never started, and that is the one the user still has to deal with.
    const keys: RotateKeyResult[] = [];
    let stopped = false;

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
          keys.push({
            name: m.varName,
            provider: m.connector.provider,
            outcome: 'skipped',
            skipReason: 'dev-live-firewall',
            mode: 'live',
          });
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
      if (stopped) {
        // The batch stopped at an earlier key, so this one never started —
        // which is a different fact from "it failed", and the terminal draws
        // neither.
        keys.push({
          name,
          provider: connector.provider,
          outcome: 'not-run',
          skipReason: 'batch-stopped',
          ...(connector.mode === 'test' || connector.mode === 'live' ? { mode: connector.mode } : {}),
        });
        continue;
      }
      try {
        // Prod live rotation normally gates on a human typing the account ID.
        // In assisted non-interactive mode we skip that echo: the rotation
        // re-runs `stripe login`, and completing that browser pairing is itself
        // the human-presence proof (see docs/rotate-deploy-agent-flow.md). The
        // typed confirmation only runs in an interactive terminal — or in a
        // browser, which is the only way an agent-driven run gets asked at all.
        if (!this.devMode && connector.mode === 'live' && (web || isInteractive(opts.nonTty))) {
          const ok = web
            ? await confirmLiveActionInBrowser({
                action: 'rotate',
                provider: connector.provider,
                projectName: ctx.keep.project_name,
                branch: ctx.branch,
                varName: name,
                accountId: connector.account_id ?? null,
                // NO `keyPrefix`. The gate's is `value.slice(0, 8)` — the
                // literal `rk_live_` the terminal prints as "Key type" — and a
                // rotation has no value to slice: the new key does not exist
                // yet and the old one was never stored. What keep.lock holds
                // is `fingerprint()`'s redacted `rk_…tst`, and passing its
                // first eight characters rendered as `rk_…tst…`, a key type
                // that does not exist. The screen omits the row when the field
                // is absent, which is the honest reading.
                //
                // REPORTED, not patched: `ConnectLiveGateData` has no field
                // for a fingerprint, so rotate's gate cannot say anything at
                // all about which key is being replaced. It should.
                push: !opts.noPush,
                pushFromFlag: opts.noPush === true,
                stops: rotateLiveGateStops({
                  provider: connector.provider,
                  branch: ctx.branch,
                  varName: name,
                  ...(connector.account_id ? { accountId: connector.account_id } : {}),
                  push: !opts.noPush,
                  pushFromFlag: opts.noPush === true,
                }),
                open: shouldOpen(),
              })
            : await confirmLiveAction({
                action: 'rotate',
                varName: name,
                accountId: connector.account_id ?? '(unknown)',
                keyPrefix: connector.fingerprint?.slice(0, 8),
              });
          if (!ok) {
            console.log(`  Cancelled ${name}.`);
            failed.push({ name, err: new Error('confirmation declined') });
            keys.push({
              name,
              provider: connector.provider,
              outcome: 'failed',
              mode: 'live',
              failureCode: 'declined-live-confirm',
              detail: 'the account ID was not confirmed, so nothing was fetched',
              retry: `capy rotate ${name}`,
            });
            if (opts.all) continue;
            if (web) {
              stopped = true;
              continue;
            }
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
        keys.push({
          name,
          provider: connector.provider,
          outcome: 'rotated',
          pushed: !opts.noPush,
          ...(updated.mode === 'test' || updated.mode === 'live' ? { mode: updated.mode } : {}),
          // A key Capy issued through the provider's CLI: every teammate's copy
          // stopped working the moment this ran.
          ...(connector.source === 'cli' ? { issuedByCapy: true } : {}),
        });
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
        keys.push({
          name,
          provider: connector.provider,
          outcome: 'failed',
          ...(connector.mode === 'test' || connector.mode === 'live' ? { mode: connector.mode } : {}),
          // No stable code to mint here: this is whatever the provider threw,
          // and the screen branches on `failureCode`, never on the sentence.
          failureCode: 'other',
          detail: (err as Error).message,
          retry: `capy rotate ${name}`,
        });
        console.error('');
        console.error(`  ✗ Failed to rotate ${B(name)}: ${(err as Error).message}`);
        console.error('');
        if (opts.all) continue;
        if (web) {
          stopped = true;
          continue;
        }
        process.exit(1);
      }
    }

    if (opts.all && (succeeded.length > 0 || failed.length > 0)) {
      console.log('');
      console.log(`  Rotated ${succeeded.length}/${toRotate.length} key(s).`);
      if (failed.length > 0) {
        console.log(`  Failed: ${failed.map((f) => f.name).join(', ')}`);
        // Under `--web` the caller still has a page to serve, and `process.exit`
        // would kill the loopback server before the browser could fetch it.
        if (!web) process.exit(1);
        stopped = true;
      } else {
        console.log('');
      }
    }

    return { succeeded, keys, stopped };
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
   * --no-push is local-only with nothing to ship, so in the terminal it skips
   * the diagram and rotates directly. Under `--web` it does not: it still
   * invalidates the old key at the provider, so the plan is drawn for that run
   * too, with the stops it will not travel struck through.
   */
  private async planAndRotate(
    targets: Array<{ varName: string; connector: ConnectorMetadata }>,
    branch: string,
    opts: RotateOpts & {
      all?: boolean;
      skipPrompts?: boolean;
      provider?: string;
      /** A positional variable `--all` dropped, so the plan can say so. */
      varIgnored?: string;
    },
  ): Promise<void> {
    const web = opts.web === true;

    if (opts.noPush && !web) {
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
    if (opts.noPush) {
      // `--no-push` ships nothing, so there is no target to resolve. The plan
      // is still drawn for that run — the destructive half is unchanged — with
      // the stops it will not travel struck through.
      deployTarget = null;
    } else if (web || isTTY) {
      // Ensure a target exists, setting one up inline if needed.
      //
      // `--web` HAS TO REACH THIS CALL, and for two reasons that are easy to
      // miss because everything downstream is already built and already
      // tested. `ensureDeployTarget` takes a `WebContext` and branches on it
      // twice — `pickTargetInBrowser` when several targets are saved, and
      // `runPicker(…, web)` when none is, which serves the adapter/branch/
      // settings/variables/delivery/name route through
      // `setUpDeployTargetInBrowser`. Called with no second argument the
      // context defaults to `{}`, every one of those branches is skipped, and
      // a run whose whole point is that nobody is watching the terminal stops
      // on `Where are you deploying?` at an inquirer prompt. The screens are
      // not missing; this call site was not asking for them.
      //
      // And the gate cannot stay `isTTY` alone. `--web` exists because the
      // caller is an agent, which is precisely the case with no TTY — so the
      // old condition sent exactly the intended caller down the branch that
      // silently resolves nothing.
      const { ensureDeployTarget } = await import('./deployCommand');
      deployTarget = await ensureDeployTarget(process.cwd(), web ? { web: true } : {});
      if (!deployTarget) {
        // A declined picker wrote nothing and that was the point, so this is a
        // 0 either way. Under `--web` the wizard has already closed on the
        // user's own cancel, so the line below is a terminal echo of a
        // decision they watched themselves make — not the only report of it.
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
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    const providers = Array.from(new Set(targets.map((t) => t.connector.provider)));
    const stops = await this.planStops(keep, branch, opts, {
      standing: 'plan',
      providers,
      targetCount: targets.length,
      needsIntegration: false,
      ...(opts.all ? {} : { varName: targets[0]?.varName }),
      ...(deployTarget ? { deployDetail: describeDeploy(deployTarget) } : {}),
    });

    renderRotationPlan(stops);

    // ── Confirm: single Y/N gate ─────────────────────────────────────────────
    // The one approval the whole rotate → push → deploy chain has, and in the
    // terminal `!opts.skipPrompts && isTTY` drops it the moment stdin is piped
    // — which is every agent-driven run. Under `--web` it is asked of every
    // caller, because a gate that disappears when nobody is watching is not a
    // gate.
    if (!opts.skipPrompts && web) {
      const { confirmRotatePlanInBrowser } = await import('../ui/rotateScreens');
      const proceed = await confirmRotatePlanInBrowser({
        step: 'plan',
        projectName: keep?.project_name ?? 'project',
        branch,
        devMode: this.devMode,
        all: opts.all === true,
        noPush: opts.noPush === true,
        stops,
        ...(keep
          ? { targets: buildRotateCandidates(targets.map((t) => t.varName), keep, branch) }
          : {}),
        ...(opts.all ? {} : { varName: targets[0]?.varName }),
        deployTargetCount: configuredTargets.length,
        advisories: this.advisories(targets, deployTarget, configuredTargets, opts),
        open: shouldOpen(),
      });
      if (!proceed) {
        console.log('\n  Cancelled.\n');
        return;
      }
    } else if (!opts.skipPrompts && isTTY) {
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
    //
    // EVERY `--web` ending below sets `process.exitCode` and returns; none of
    // them calls `process.exit`. The page each one serves comes off a loopback
    // server in THIS process, and exiting closes that socket microseconds
    // after it started listening — so the exit code arrived and the page that
    // explained it never did. `rotateMany` already carried this rule inside
    // itself (`stopped` instead of an inline exit); these are the call sites
    // that dropped it.
    const report = await this.rotateMany(targets, opts);
    if (report.succeeded.length === 0) {
      if (web) {
        await this.reportRun(keep?.project_name ?? 'project', branch, opts, report, stops, null, configuredTargets.length);
        if (report.keys.some((k) => k.outcome === 'failed')) process.exitCode = 1;
      }
      return;
    }

    let deployed: { name: string; ok: boolean } | null = null;
    if (deployTarget) {
      const { deployCommand } = await import('./deployCommand');
      const code = await deployCommand(deployTarget.name, { yes: true, devMode: this.devMode });
      deployed = { name: deployTarget.name, ok: code === 0 };
      if (code !== 0) {
        // The keys are already live in Capy and every running system still
        // holds the old ones. Under `--web` that state gets its own page
        // before the exit code, because re-running rotate here makes it worse
        // — and the page is the whole reason this branch exists, so the exit
        // waits for it rather than racing it.
        if (web) {
          await this.reportRun(keep?.project_name ?? 'project', branch, opts, report, stops, deployed, configuredTargets.length);
          process.exitCode = code;
          return;
        }
        process.exit(code);
      }
    } else if (!opts.noPush) {
      // No target resolved (none configured, several to disambiguate, or a
      // dev direct-mode target we skipped). The key is already rotated +
      // pushed; kick the user into the deploy flow to open the rollout PR.
      this.deployHint(configuredTargets.length);
    }

    if (web) {
      await this.reportRun(keep?.project_name ?? 'project', branch, opts, report, stops, deployed, configuredTargets.length);
      if (report.stopped) process.exitCode = 1;
    }
  }

  /**
   * The yellow lines the terminal prints above the plan — and the two it does
   * not print at all.
   *
   * `--provider` at a TTY and a positional variable under `--all` are both
   * accepted and then silently dropped, and a user who typed one is entitled to
   * know it did nothing before they approve a plan built as though they had not.
   */
  private advisories(
    targets: Array<{ varName: string; connector: ConnectorMetadata }>,
    deployTarget: TargetConfig | null,
    configuredTargets: TargetConfig[],
    opts: RotateOpts & { all?: boolean; provider?: string; varIgnored?: string },
  ): RotateAdvisory[] {
    const out: RotateAdvisory[] = [];
    if (this.devMode && targets.some((t) => t.connector.mode === 'live')) {
      out.push({
        code: 'dev-skips-live-key',
        detail: 'capy-dev refuses live keys, so they are left out of this run.',
      });
    }
    if (this.devMode && !deployTarget && configuredTargets.some((t) => (t.mode ?? 'direct') !== 'ci')) {
      out.push({
        code: 'dev-skips-direct-deploy',
        detail: 'capy-dev never runs a direct vendor ship, so the resolved target was dropped.',
      });
    }
    if (opts.provider && targets.length > 0) {
      out.push({
        code: 'provider-flag-ignored',
        detail: `--provider ${opts.provider} only applies to a variable with no integration yet. These are already managed.`,
      });
    }
    if (opts.all && opts.varIgnored) {
      out.push({
        code: 'var-ignored-with-all',
        detail: `--all rotates every managed credential on this branch, so ${opts.varIgnored} was not treated as the target.`,
      });
    }
    return out;
  }

  /** What the run actually did, as a page. Reports only — nothing here decides. */
  private async reportRun(
    projectName: string,
    branch: string,
    opts: RotateOpts & { all?: boolean },
    report: RotateRunReport,
    stops: RotatePlanStop[],
    deployed: { name: string; ok: boolean } | null,
    targetCount: number,
  ): Promise<void> {
    const rotated = report.keys.filter((k) => k.outcome === 'rotated');
    const failed = report.keys.filter((k) => k.outcome === 'failed');
    const outcome: RotateRunOutcome =
      rotated.length === 0
        ? 'failed'
        : failed.length > 0 || report.keys.some((k) => k.outcome === 'not-run')
          ? 'partial'
          : deployed && !deployed.ok
            ? 'deploy-failed'
            : deployed
              ? 'deployed'
              : opts.noPush
                ? 'rotated-local'
                : 'rotated';

    const steps: RotateRunStep[] = [
      {
        id: 'rotate',
        label: 'Rotate',
        state: rotated.length === 0 ? 'fail' : failed.length > 0 ? 'fail' : 'ok',
        detail: `${rotated.length}/${report.keys.length}`,
      },
      {
        id: 'push',
        label: 'Push',
        // `skip` and `pending` are different facts: a `--no-push` run skips the
        // push, while one queued behind a failed rotation never ran.
        state: opts.noPush ? 'skip' : rotated.length > 0 ? 'ok' : 'pending',
        detail: opts.noPush ? 'skipped by --no-push' : branch,
      },
      {
        id: 'deploy',
        label: 'Deploy',
        state: deployed ? (deployed.ok ? 'ok' : 'fail') : opts.noPush ? 'skip' : 'pending',
        ...(deployed
          ? { detail: deployed.name }
          : { detail: 'no target resolved', prose: true, fix: 'capy deploy' }),
      },
    ];

    const { showRotateProgressInBrowser } = await import('../ui/rotateScreens');
    await showRotateProgressInBrowser({
      outcome,
      projectName,
      branch,
      all: opts.all === true,
      noPush: opts.noPush === true,
      devMode: this.devMode,
      // The route TRAVELLED, which is what this screen's payload asks for —
      // not the route declared. Handing the plan over untouched drew Rotate,
      // Push and Deploy as stops still ahead of a run that had already been
      // through all three, on the one page whose subject is how far it got.
      stops: travelledStops(stops, steps),
      steps,
      keys: report.keys,
      deploy: {
        ...(deployed ? { targetName: deployed.name } : {}),
        targetCount,
      },
      open: shouldOpen(),
    });
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

/**
 * The same rows, for the browser.
 *
 * The terminal's are pre-formatted strings with ANSI in them — `STRIPE_KEY
 * (stripe, rk_…tst, expires in 30d)` — which a payload cannot use: the escapes
 * would render as literal `[90m`, and the expiry is glued into the sentence so
 * the screen could not pluralise it. Same facts, structured, from the same
 * keep.lock lookup — which is why this sits beside `buildRotatePickerChoices`
 * rather than in the screen module.
 *
 * NEVER key material. `fingerprint` is the redacted `abc…xyz` form keep.lock
 * already stores; no value has ever been in a connector entry.
 */
export function buildRotateCandidates(
  allVars: string[],
  keep: KeepFile,
  branch: string,
): RotateCandidate[] {
  return allVars.map((v) => {
    const c = findManagedConnector(keep, v, branch);
    if (!c) return { name: v, managed: false };
    return {
      name: v,
      managed: true,
      provider: c.provider,
      ...(c.fingerprint ? { fingerprint: c.fingerprint } : {}),
      ...(typeof c.expires_at === 'number'
        ? { expiresInDays: Math.floor((c.expires_at - Date.now() / 1000) / 86400) }
        : {}),
      ...(c.mode === 'test' || c.mode === 'live' ? { mode: c.mode } : {}),
      ...(c.account_id ? { accountId: c.account_id } : {}),
      // Issued by Capy through the provider's CLI, so rotating it invalidates
      // the copy every teammate is holding.
      ...(c.source === 'cli' ? { issuedByCapy: true } : {}),
    };
  });
}

/**
 * The declared route, redrawn as the route the run actually travelled.
 *
 * The rail on the progress page is documented as "the declared route, with the
 * stops travelled marked done", and the CLI was handing over the plan it built
 * BEFORE anything ran: on the `deploy-failed` page — the state this screen
 * exists for — Rotate, Push and Deploy all still read as stops ahead of the
 * traveller, next to a step log saying two of them were done and the third had
 * failed. A rail that contradicts the page it sits on is worse than no rail,
 * because it is the half that looks authoritative.
 *
 * The mapping is off `RotateRunStep.state`, which is a four-value enum, and
 * never off any of the prose beside it:
 *
 *   ok      → done
 *   skip    → skipped, the same struck-through station `--no-push` draws
 *   fail    → current: where the run stopped, and `blank` because the plan
 *             still has a hole there. `StopState` has no `failed`, and the
 *             other three would each say something untrue. REPORTED.
 *   pending → upcoming, which is exactly what it is: queued behind a failure.
 *
 * Stops with no step — Variable, Integration — are the questions, already
 * settled by the time the run began, and are passed through untouched.
 */
export function travelledStops(
  stops: RotatePlanStop[],
  steps: RotateRunStep[],
): RotateRunStop[] {
  const state = new Map(steps.map((s) => [s.id as string, s.state]));
  const rotateOk = state.get('rotate') === 'ok';
  return stops.map((stop) => {
    // The manual hand-off has no step of its own: `mod.rotate` runs `stripe
    // login` inside the Rotate step and only returns a key once the pairing
    // came back. So a rotation that produced one went through it, and a rail
    // still pointing at Auth would be telling the reader to go and do a thing
    // they have already done.
    if (stop.id === 'auth') {
      return rotateOk ? { ...stop, state: 'done' as const, answer: 'paired' } : stop;
    }
    const ran = state.get(stop.id);
    if (!ran) return stop;
    if (ran === 'ok') return { ...stop, state: 'done' as const };
    if (ran === 'skip') return { ...stop, state: 'skipped' as const };
    if (ran === 'fail') return { ...stop, state: 'current' as const, blank: true };
    return { ...stop, state: 'upcoming' as const };
  });
}

/** What one pass of `rotateMany` did, so the caller can report it and exit. */
interface RotateRunReport {
  /** Names that rotated. The terminal's own tally counts these. */
  succeeded: string[];
  /** One row per credential the run touched, including ones it never reached. */
  keys: RotateKeyResult[];
  /**
   * The run stopped rather than finishing. Under `--web` this replaces the
   * inline `process.exit(1)`: exiting there would kill the loopback server
   * before the browser could fetch the page that explains what happened.
   */
  stopped: boolean;
}

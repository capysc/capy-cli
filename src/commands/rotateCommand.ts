import { runWithInteraction, currentInteraction, prompt, interactionOrTerminal, InteractionCommandError, ExitPromptError } from '../ui/interaction';
import { human, humanError } from '../ui/webMode';
import { inspectRotateDeployment } from './rotateReadiness';
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
import { CapyError, ConnectorMetadata, ERROR_CODES, KeepFile } from '../types/index';
import { TargetConfig } from '../deploy/adapter';
import { refuseNonInteractive } from '../ui/interactive';
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
import type { AuthService } from '../auth/authService';
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
  const lines = stops.flatMap((s, i) => {
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
    const line = `  ${node}  ${label}   ${DIM(s.detail ?? '')}${settled}`;
    if (!last) {
      const dotted = s.manual || stops[i + 1].manual;
      return [line, `  ${DIM(dotted ? '┊' : '│')}`];
    }
    return [line];
  });
  return ['', `  ${B('Rotation plan')}`, '', ...lines, ''];
}

function renderRotationPlan(stops: RotatePlanStop[]): void {
  // Write synchronously to fd 1. A backgrounded run pipes stdout, where
  // console.log is buffered and would only flush AFTER the blocking
  // `stripe login` spawnSync — so the plan would be missing from the captured
  // output during the auth wait (when the agent reads it to relay the pairing
  // code). writeSync lands the whole plan now, before that block.
  const text = rotationPlanLines(stops).join('\n') + '\n';
  if (currentInteraction()) human(text);
  else writeSync(1, text);
}

/**
 * End the run on a refusal, wherever the caller is looking.
 *
 * Every early exit in this file used to be `console.error(…)` +
 * `process.exit(1)`. That is right in a terminal and empty under `--web`: the
 * flag exists because the caller is an agent, so the one fact that says what
 * to do next — the variable does not exist, the branch has nothing managed —
 * went to a stream with nobody on the other end. The exit code was correct and
 * the sentence was correct, and neither of them reached a surface.
 *
 * `displayErrorAndExit` is the CLI's single answer to that, and it already
 * does the three things this needs: the ANSI still goes to the terminal, a
 * `command-error` page is served under `--web` and HELD until the browser has
 * fetched it, and the process exits 1 either way. So these sites do not get a
 * second implementation of an ending — they get a typed code, which is also
 * the handle an agent branches on (cardinal Rule 4) instead of recognising a
 * sentence.
 *
 * `await refuse(…); return;` at every call site, and the `return` is not
 * decoration: `displayErrorAndExit` is `Promise<never>` but TypeScript does
 * not narrow across an awaited never, so the `return` is what tells the
 * compiler `keep` is non-null below — and what keeps the flow honest under a
 * test that stubs `process.exit` without throwing.
 */
async function refuse(
  error: CapyError,
  context: { projectName?: string; projectId?: string; branch?: string } = {},
): Promise<void> {
  if (currentInteraction()) throw error;
  const { displayErrorAndExit } = await import('../ui/errorScreen');
  await displayErrorAndExit(error, context);
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
  constructor(private readonly devMode: boolean = false) {}

  async execute(varName: string | undefined, opts: RotateOpts & { all?: boolean; skipPrompts?: boolean; provider?: string }): Promise<void> {
    const interaction = currentInteraction();
    if (!interaction) return this.executeSteps(varName, opts);
    try {
      await runWithInteraction({ ...interaction, output: event => interaction.output({ level: 'info', ...event }) },
        () => this.executeSteps(varName, { ...opts, web: false }));
    } catch (error) {
      const cancelled = error instanceof ExitPromptError;
      const safe = error instanceof InteractionCommandError || error instanceof CapyError;
      await interaction.goal({ status: cancelled ? 'cancelled' : 'failed',
        code: cancelled ? 'ROTATE_CANCELLED' : safe ? String(error.code) : 'ROTATE_FAILED',
        message: cancelled ? 'Rotation cancelled.' : safe ? error.message : 'Rotation could not complete. Check the provider and deployment state before retrying.' });
      if (!cancelled) process.exitCode = 1;
    }
  }

  private async executeSteps(
    varName: string | undefined,
    opts: RotateOpts & { all?: boolean; skipPrompts?: boolean; provider?: string },
  ): Promise<void> {
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    const branch = pm.deriveActiveBranch();

    if (!keep) {
      await refuse(new CapyError('No keep.lock found in this directory.', ERROR_CODES.NO_KEEP_FILE));
      return;
    }
    if (!branch) {
      await refuse(
        new CapyError('No active branch.', ERROR_CODES.NO_ACTIVE_BRANCH),
        { projectName: keep.project_name, projectId: keep.project_id },
      );
      return;
    }

    const managed = listManagedKeys(keep, branch);
    const allVars = listAllVarsOnBranch(keep, branch);

    // --all only operates on already-managed keys. We don't auto-promote
    // unmanaged vars in bulk — that needs per-var intent.
    if (opts.all) {
      if (managed.length === 0) {
        await refuse(
          new CapyError('No managed keys to rotate on this branch.', ERROR_CODES.NO_MANAGED_KEYS, {
            branch,
          }),
          { projectName: keep.project_name, projectId: keep.project_id, branch },
        );
        return;
      }
      // `--all` ignores a positional variable and says nothing about it. The
      // plan screen carries that as an advisory rather than letting the user
      // approve a run they think is about one credential.
      await this.planAndRotate(managed, branch, { ...opts, varIgnored: varName });
      return;
    }

    // Resolve which (varName, connector|unmanaged) we're operating on.
    const target = await (async (): Promise<{ varName: string; connector: ConnectorMetadata } | { varName: string; unmanaged: true } | undefined> => {

    if (varName) {
      const connector = findManagedConnector(keep, varName, branch);
      if (connector) {
        return { varName, connector };
      } else if (allVars.includes(varName)) {
        return { varName, unmanaged: true };
      } else {
        await refuse(
          new CapyError(
            `${varName} is not in your environment on branch ${branch}.`,
            ERROR_CODES.VARIABLE_NOT_FOUND,
            // The names that WOULD have worked travel with the refusal. An
            // agent that gets "not found" and nothing else has to guess or
            // shell out to read keep.lock; this is the answer it needed.
            { variable: varName, branch, available: allVars },
          ),
          { projectName: keep.project_name, projectId: keep.project_id, branch },
        );
        return;
      }
    } else {
      if (allVars.length === 0) {
        await refuse(
          new CapyError('No variables on this branch yet.', ERROR_CODES.NO_VARIABLES, { branch }),
          { projectName: keep.project_name, projectId: keep.project_id, branch },
        );
        return;
      }
      const picked = await (async (): Promise<string | undefined> => {
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
          human('\n  Cancelled.\n');
          if (currentInteraction()) throw new ExitPromptError('Rotation cancelled');
          return;
        }
        return answer.variable;
      } else {
        if (!interactionOrTerminal(opts.nonTty)) {
          refuseNonInteractive(
            'no variable specified and the picker needs a prompt',
            `Pass the variable name: capy rotate <VAR> (available: ${allVars.join(', ')}).`,
          );
        }
        const inquirer = (await import('inquirer')).default;
        const answer = await prompt([
          {
            type: 'list',
            name: 'picked',
            message: 'Which variable to rotate:',
            choices: buildRotatePickerChoices(allVars, keep, branch).map(
              ({ name, value }) => ({ name, value }),
            ),
          },
        ]);
        return answer.picked;
      }
      })();
      if (!picked) return;
      const connector = findManagedConnector(keep, picked, branch);
      return connector ? { varName: picked, connector } : { varName: picked, unmanaged: true };
    }

    })();
    if (!target) return;

    if ('unmanaged' in target) {
      await this.promoteAndConnect(target.varName, branch, opts);
      return;
    }

    await this.planAndRotate([target], branch, opts);
  }

  /**
   * Unmanaged var picked for rotation → ask which integration issues it, link
   * it through `ConnectCommand`, then rotate it.
   *
   * THE ROTATION IS THE POINT, and it used to happen by accident. `connect`
   * fetched a key from the provider and wrote it over the variable, so
   * promoting looked like a rotation without ever being one — and when
   * `connect` correctly stopped writing values, promoting silently stopped
   * changing anything at all. `capy rotate DATABASE_URL` recorded a link,
   * printed connect's own sign-off ("run `capy rotate DATABASE_URL` to replace
   * it" — the command already running), and returned with the credential
   * untouched.
   *
   * Nothing failed and nothing said so, which is why it survived: the rail
   * `rotationPlan` draws for this route has always shown Rotate, Push and
   * Deploy as stops still ahead. They were drawn and never travelled. So the
   * link is a step here, not an ending, and the run carries on to the stops it
   * promised.
   */
  private async promoteAndConnect(
    varName: string,
    branch: string,
    opts: RotateOpts & { provider?: string },
  ): Promise<void> {
    const providers = listProviders();
    if (providers.length === 0) {
      await refuse(new CapyError('No connectors are registered.', ERROR_CODES.NO_CONNECTORS));
      return;
    }

    const provider = await (async (): Promise<string | undefined> => {
    if (opts.web) {
      // Never pre-selected, however few are registered. Off a TTY the CLI
      // auto-picks the single provider with no output at all — for a variable
      // the user never associated with it — and the run that follows replaces
      // whatever is in that variable with a key the provider issues. The
      // screen says that before the list, not after the write.
      const pm = new ProjectManager();
      const keep = pm.readKeepFile();
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
        human('\n  Cancelled.\n');
          if (currentInteraction()) throw new ExitPromptError('Rotation cancelled');
        return;
      }
      return answer.provider;
    } else if (!interactionOrTerminal(opts.nonTty) || (currentInteraction() && opts.provider)) {
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
        return opts.provider;
      } else if (providers.length === 1) {
        return providers[0].name;
      } else {
        refuseNonInteractive(
          `${B(varName)} isn't connected to an integration yet, and several are available`,
          `Pass --provider <name> (one of: ${providers.map((p) => p.name).join(', ')}).`,
        );
      }
    } else {
      human('');
      human(`  ${B(varName)} isn't connected to a third-party integration yet.`);
      human('  Pick one and Capy will rotate it via the provider from here on.');
      human('');

      const inquirer = (await import('inquirer')).default;
      const picked = await prompt([
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
        human('\n  Cancelled.\n');
          if (currentInteraction()) throw new ExitPromptError('Rotation cancelled');
        return;
      }
      return picked.provider;
    }

    })();
    if (!provider) return;
    if (opts.flowProvider && provider !== opts.flowProvider) throw new InteractionCommandError('ROTATE_FLOW_WORKOS_REQUIRED', 'This Flow supports WorkOS credentials. Choose a WorkOS variable.');

    const connect = new ConnectCommand(this.devMode);
    const { linked } = await connect.execute(provider, {
      var: varName,
      expectedUserId: opts.expectedUserId,
      noPush: opts.noPush,
      nonTty: opts.nonTty,
      // The connect flow takes over from here, and it has to keep serving
      // screens: dropping `--web` at the hand-off is how a browser flow ends
      // up at a TTY prompt nobody is watching.
      web: opts.web,
      // A step, not the run. Suppresses connect's success ENDING so the
      // rotation that follows is not preceded by a page announcing the run is
      // over — and stops it signing off with the command we are inside.
      subStep: true,
    });
    // A decline or a failed push already served its own ending and said why.
    if (!linked) { if (currentInteraction()) throw new ExitPromptError('Connect was not completed'); return; }

    // The connector `connect` just recorded, read back rather than assumed:
    // it carries the provider's fingerprint and key type, and `rotateMany`
    // needs both to tell a real rotation from the provider handing back the
    // same key.
    const keep = new ProjectManager().readKeepFile();
    const connector = keep ? findManagedConnector(keep, varName, branch) : undefined;
    if (!connector) {
      // Nothing to rotate through. `connect` reported success, so this is a
      // state we do not expect rather than a refusal — say so plainly instead
      // of returning as though the run had finished its journey.
      await refuse(
        new CapyError(
          `${varName} was linked to ${provider}, but no connector was recorded on branch ${branch}.`,
          ERROR_CODES.NO_MANAGED_KEYS,
          { branch },
        ),
        { branch },
      );
      return;
    }

    // `promotedVia` so the rail can mark the Integration stop ANSWERED. The
    // plain plan declares it skipped, which is right for a variable that was
    // already managed and a contradiction here: the stop would name `stripe`
    // and carry the never-visited marker beside it.
    await this.planAndRotate([{ varName, connector }], branch, { ...opts, promotedVia: provider });
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
    const authProviders = (await Promise.all(providers.map(async provider => {
      const mod = await loadProvider(provider).catch(() => undefined);
      return mod?.requiresAuth ? [provider] : [];
    }))).flat();
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
    const web = opts.web === true;
    const live = this.devMode ? targets.filter(target => target.connector.mode === 'live') : [];
    const skipped: RotateKeyResult[] = opts.all ? live.map(target => ({ name: target.varName,
      provider: target.connector.provider, outcome: 'skipped', skipReason: 'dev-live-firewall', mode: 'live' })) : [];
    if (!opts.all && live.length) {
      await refuse(new CapyError(`${live[0].varName} is configured for live mode.`, ERROR_CODES.DEV_LIVE_FIREWALL,
        { variables: live.map(target => target.varName), nothingLeft: false }));
      return { succeeded: [], keys: [], stopped: true };
    }
    for (const target of live) human(`  Skipping ${target.varName} (live mode — not allowed in capy-dev).`);
    const selected = this.devMode && opts.all ? targets.filter(target => target.connector.mode !== 'live') : targets;
    if (!selected.length && live.length) {
      await refuse(new CapyError('Nothing to rotate. All managed keys are live-mode.', ERROR_CODES.DEV_LIVE_FIREWALL,
        { variables: live.map(target => target.varName), nothingLeft: true }));
      return { succeeded: [], keys: skipped, stopped: true };
    }
    for (const provider of new Set(selected.map(target => target.connector.provider))) {
      const mod = await loadProvider(provider);
      mod.precheck?.();
    }
    const ctx = await resolveContext({ devMode: this.devMode });
    if (opts.expectedUserId && ctx.userId !== opts.expectedUserId) throw new InteractionCommandError('AUTH_ACCOUNT_MISMATCH');
    type State = Readonly<{ succeeded: readonly string[]; keys: readonly RotateKeyResult[]; failed: readonly string[]; stopped: boolean }>;
    const run = async (index: number, state: State): Promise<State> => {
      const target = selected[index];
      if (!target) return state;
      const { varName: name, connector } = target;
      const mode: Pick<RotateKeyResult, 'mode'> = connector.mode === 'test' || connector.mode === 'live' ? { mode: connector.mode } : {};
      if (state.stopped) return run(index + 1, { ...state, keys: [...state.keys, {
        name, provider: connector.provider, outcome: 'not-run', skipReason: 'batch-stopped', ...mode,
      }] });
      const failed = (detail: string, failureCode: 'other' | 'declined-live-confirm'): Promise<State> => {
        humanError(`\n  Failed to rotate ${name}: ${detail}\n`);
        if (!opts.all && !web && !currentInteraction()) process.exit(1);
        return run(index + 1, { ...state, stopped: !opts.all, failed: [...state.failed, name], keys: [...state.keys, {
          name, provider: connector.provider, outcome: 'failed', ...mode, failureCode, detail, retry: `capy rotate ${name}`,
        }] });
      };
      try {
        if (!this.devMode && connector.mode === 'live' && (web || interactionOrTerminal(opts.nonTty))) {
          const approved = web ? await confirmLiveActionInBrowser({ action: 'rotate', provider: connector.provider,
            projectName: ctx.keep.project_name, branch: ctx.branch, varName: name, accountId: connector.account_id ?? null,
            push: !opts.noPush, pushFromFlag: opts.noPush === true,
            stops: rotateLiveGateStops({ provider: connector.provider, branch: ctx.branch, varName: name,
              ...(connector.account_id ? { accountId: connector.account_id } : {}), push: !opts.noPush, pushFromFlag: opts.noPush === true }),
            open: shouldOpen(), authService: ctx.authService,
          }) : await confirmLiveAction({ action: 'rotate', varName: name, accountId: connector.account_id ?? '(unknown)',
            keyPrefix: connector.fingerprint?.slice(0, 8) });
          if (!approved) return failed('The account ID was not confirmed; nothing was fetched.', 'declined-live-confirm');
        }
        const mod = await loadProvider(connector.provider);
        const result = await mod.rotate(ctx, name, connector, opts);
        try {
          const fresh = await resolveContext({ devMode: this.devMode });
          if (opts.expectedUserId && fresh.userId !== opts.expectedUserId) throw new InteractionCommandError('AUTH_ACCOUNT_MISMATCH');
          await writeAndSync(fresh, name, result.value, { push: !opts.noPush, connector: result.entry });
        } catch (error) {
          if (!currentInteraction()) throw error;
          throw new InteractionCommandError('ROTATE_WRITE_SYNC_FAILED',
            'A replacement key was created and provider expiration handling has already run, but writing or syncing failed. Deployment did not run. Check the provider and local state before retrying rotation.');
        }
        human(`\n  ✓ ${B(name)} rotated${opts.noPush ? ' (local only)' : ' and pushed'}.`);
        if (connector.source === 'cli' && connector.provider !== 'workos') human(`  The previous key is now invalid. Teammates must run ${B('capy')} to pick up the new value.`);
        const updatedMode: Pick<RotateKeyResult, 'mode'> = result.entry.mode === 'test' || result.entry.mode === 'live' ? { mode: result.entry.mode } : {};
        return run(index + 1, { ...state, succeeded: [...state.succeeded, name], keys: [...state.keys, {
          name, provider: connector.provider, outcome: 'rotated', pushed: !opts.noPush, ...updatedMode,
          ...(connector.source === 'cli' ? { issuedByCapy: true } : {}),
        }] });
      } catch (error) {
        // A provider's fatal exit must halt --all as it did in a terminal. It
        // must never become an ordinary failed item followed by deployment.
        if (error instanceof InteractionCommandError || error instanceof ExitPromptError) throw error;
        return failed(currentInteraction() ? 'The provider operation failed. Check its state before retrying.'
          : error instanceof Error ? error.message : String(error), 'other');
      }
    };
    const result = await run(0, { succeeded: [], keys: skipped, failed: [], stopped: false });
    if (opts.all && (result.succeeded.length || result.failed.length)) {
      human(`\n  Rotated ${result.succeeded.length}/${selected.length} key(s).`);
      if (result.failed.length) {
        human(`  Failed: ${result.failed.join(', ')}`);
        if (!web && !currentInteraction()) process.exit(1);
      }
    }
    return { succeeded: [...result.succeeded], keys: [...result.keys], stopped: result.stopped || result.failed.length > 0, authService: ctx.authService };
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
      /**
       * This run reached here by PROMOTING an unmanaged variable through the
       * named integration, which is an answer the rail has to show rather than
       * a stop it can strike through.
       */
      promotedVia?: string;
    },
  ): Promise<void> {
    if (opts.flowProvider && targets.some(target => target.connector.provider !== opts.flowProvider)) throw new InteractionCommandError('ROTATE_FLOW_WORKOS_REQUIRED', 'This Flow supports WorkOS credentials. Choose a WorkOS variable.');
    const web = opts.web === true;

    if (opts.noPush && !web && !currentInteraction()) {
      await this.rotateMany(targets, opts);
      return;
    }

    const isTTY = interactionOrTerminal(opts.nonTty);

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
    const resolvedDeployTarget = await (async (): Promise<TargetConfig | null> => {
    if (opts.noPush) {
      // `--no-push` ships nothing, so there is no target to resolve. The plan
      // is still drawn for that run — the destructive half is unchanged — with
      // the stops it will not travel struck through.
      return null;
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
      const deployTarget = opts.deployTarget ? configuredTargets.find(target => target.name === opts.deployTarget) ?? null
        : await ensureDeployTarget(process.cwd(), web ? { web: true } : {}, opts.deployKind);
      if (!deployTarget) {
        // A declined picker wrote nothing and that was the point, so this is a
        // 0 either way. Under `--web` the wizard has already closed on the
        // user's own cancel, so the line below is a terminal echo of a
        // decision they watched themselves make — not the only report of it.
        human('\n  Cancelled.\n');
          if (currentInteraction()) throw new ExitPromptError('Rotation cancelled');
        return null;
      }
      return deployTarget;
    } else if (configuredTargets.length === 1) {
      // Non-interactive: auto-resolve the unambiguous single target. With zero
      // or several we don't refuse — rotate + push still runs and the user is
      // kicked into the deploy flow afterward (deployTarget stays null).
      return configuredTargets[0];
    }

    return null;
    })();
    const deployTarget = this.devMode && resolvedDeployTarget && (resolvedDeployTarget.mode ?? 'direct') !== 'ci'
      ? null : resolvedDeployTarget;
    if (resolvedDeployTarget && !deployTarget) human(`capy-dev skips the direct-mode deploy for ${resolvedDeployTarget.name} (CI/PR only in dev).`);
    if (currentInteraction() && deployTarget) {
      const readiness = await inspectRotateDeployment({ deployTarget: deployTarget.name, devMode: this.devMode });
      const missing = readiness.checks.filter(check => !check.ready);
      if (missing.length) throw new InteractionCommandError('ROTATE_DEPLOYMENT_NOT_READY', missing.map(check => [check.detail, check.remedy].filter(Boolean).join(' ')).join('\n'));
    }

    // ── Build the (now fully resolved) train-stop ───────────────────────────
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    const providers = Array.from(new Set(targets.map((t) => t.connector.provider)));
    const stops = await this.planStops(keep, branch, opts, {
      standing: 'plan',
      providers,
      targetCount: targets.length,
      ...(opts.promotedVia
        ? {
            needsIntegration: true,
            integration: opts.promotedVia,
            integrationFromFlag: Boolean(opts.provider),
          }
        : { needsIntegration: false }),
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
        human('\n  Cancelled.\n');
          if (currentInteraction()) throw new ExitPromptError('Rotation cancelled');
        return;
      }
    } else if (!opts.skipPrompts && isTTY) {
      const inquirer = (await import('inquirer')).default;
      const { proceed } = await prompt([
        { type: 'confirm', name: 'proceed', message: 'Proceed?', default: true },
      ]);
      if (!proceed) {
        human('\n  Cancelled.\n');
          if (currentInteraction()) throw new ExitPromptError('Rotation cancelled');
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
      if (currentInteraction()) throw new InteractionCommandError('ROTATE_NO_KEYS_ROTATED', 'No keys were rotated. Review the preceding results.');
      if (web) {
        await this.reportRun(keep?.project_name ?? 'project', branch, opts, report, stops, null, configuredTargets.length);
        if (report.keys.some((k) => k.outcome === 'failed')) process.exitCode = 1;
      }
      return;
    }

    if (currentInteraction() && report.stopped) throw new InteractionCommandError('ROTATE_BATCH_FAILED', 'Rotation stopped with failed keys. Deployment did not run. Review the completed rotations before retrying.');
    const deployed = await (async (): Promise<{ name: string; ok: boolean } | null> => {
      if (!deployTarget) {
        if (!opts.noPush) this.deployHint(configuredTargets.length);
        return null;
      }
      const { deployCommand } = await import('./deployCommand');
      const code = await deployCommand(deployTarget.name, { yes: true, devMode: this.devMode });
      const result = { name: deployTarget.name, ok: code === 0 };
      if (code !== 0) {
        if (currentInteraction()) throw new InteractionCommandError('ROTATE_DEPLOY_FAILED', 'Rotation and sync completed, but deployment failed. Retry deployment rather than rotating again.');
        if (web) {
          await this.reportRun(keep?.project_name ?? 'project', branch, opts, report, stops, result, configuredTargets.length);
          process.exitCode = code;
          return result;
        }
        process.exit(code);
      }
      return result;
    })();
    if (deployed && !deployed.ok) return;
    if (currentInteraction()) await currentInteraction()!.goal({ status: 'succeeded', code: 'ROTATE_COMPLETE',
      message: deployed ? `Rotation, sync and deployment to ${deployed.name} completed.` : opts.noPush ? 'Rotation completed locally. Sync and deployment were skipped.' : 'Rotation and sync completed. Deployment remains outstanding.' });

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
    return [
      ...(this.devMode && targets.some((t) => t.connector.mode === 'live') ? [{
        code: 'dev-skips-live-key',
        detail: 'capy-dev refuses live keys, so they are left out of this run.',
      } satisfies RotateAdvisory] : []),
      ...(this.devMode && !deployTarget && configuredTargets.some((t) => (t.mode ?? 'direct') !== 'ci') ? [{
        code: 'dev-skips-direct-deploy',
        detail: 'capy-dev never runs a direct vendor ship, so the resolved target was dropped.',
      } satisfies RotateAdvisory] : []),
      ...(opts.provider && targets.length > 0 ? [{
        code: 'provider-flag-ignored',
        detail: `--provider ${opts.provider} only applies to a variable with no integration yet. These are already managed.`,
      } satisfies RotateAdvisory] : []),
      ...(opts.all && opts.varIgnored ? [{
        code: 'var-ignored-with-all',
        detail: `--all rotates every managed credential on this branch, so ${opts.varIgnored} was not treated as the target.`,
      } satisfies RotateAdvisory] : [])
    ];
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
      // `authService` opts this call into the keep-hosted transport when
      // CAPY_KEEP_SCREENS=1 (W2-B) — surfaced from `rotateMany`'s own
      // `resolveContext()` call via `RotateRunReport.authService`, not a
      // second auth construction. Undefined on the two live-mode-firewall
      // early-return paths, which is an unremarkable "fall back to loopback".
      authService: report.authService,
    });
  }

  /**
   * Rotated + pushed, but we didn't ship — point the user into the deploy flow
   * to open the rollout PR. The key is already live in Capy; this is the
   * rollout step, not a leftover.
   */
  private deployHint(targetCount: number): void {
    if (targetCount === 0) {
      human(`  ✓ Rotated + pushed. No deploy target yet — set one up to open the rollout PR: ${B('capy deploy')}`);
    } else if (targetCount > 1) {
      human(`  ✓ Rotated + pushed. Pick a target to open the rollout PR: ${B('capy deploy <target>')}`);
    } else {
      human(`  ✓ Rotated + pushed. Deploy to open the rollout PR: ${B('capy deploy')}`);
    }
    human('');
  }
}

function formatChoice(name: string, c: ConnectorMetadata): string {
  const expiry = (() => {
  if (typeof c.expires_at === 'number') {
    const days = Math.floor((c.expires_at - Date.now() / 1000) / 86400);
    return [days < 0 ? `expired ${-days}d ago` : days === 0 ? 'expires today' : `expires in ${days}d`];
  }
  return [];
  })();
  const parts = [c.provider, ...(c.fingerprint ? [c.fingerprint] : []), ...expiry];
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
  /**
   * Surfaced from `resolveContext()` for `reportRun`'s keep-hosted dispatch
   * (W2-B) — undefined on the two live-mode-firewall early returns above,
   * which exit before `resolveContext` runs; `reportRun` degrades to the
   * loopback path exactly like any other missing `authService`, so this is
   * never a second auth construction, only surfacing the one `rotateMany`
   * already made.
   */
  authService?: AuthService;
}

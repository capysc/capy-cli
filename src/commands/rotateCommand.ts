import {
  resolveContext,
  writeAndSync,
  listManagedKeys,
  listAllVarsOnBranch,
  findManagedConnector,
  ResolvedContext,
} from './connectors/shared';
import { ConnectCommand, confirmLiveAction } from './connectCommand';
import { loadProvider, listProviders, RotateOpts } from './connectors/registry';
import { cap, rotationPlan, type RotationPlanInput } from './connectors/plans';
import { ProjectManager } from '../core/projectManager';
import { CapyError, ConnectorMetadata, ERROR_CODES, KeepFile } from '../types/index';
import { TargetConfig } from '../deploy/adapter';
import { staleTargets } from '../deploy/targetsGate';
import { isInteractive, refuseNonInteractive } from '../ui/interactive';
import type { RotatePlanStop } from '../ui/screens/contract';
import { writeSync } from 'fs';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;

/**
 * Render the rotation plan as a vertical train-stop diagram: each stage is a
 * station (✓ answered, ● intermediate, ○ terminal, ◌ blank, · never visited)
 * joined by track, with a dimmed one-line description. A track segment is
 * dotted (┊) when either station it connects is manual, else solid (│). It's a
 * confirmation aid — the route the rotation will travel — not a progress bar;
 * the ✓ lines printed during execution report what actually happened.
 *
 * The stops are `rotationPlan`'s, not this function's, so the diagram begins
 * with the variable and the integration the user had just answered.
 */
export function rotationPlanLines(stops: RotatePlanStop[]): string[] {
  const width = Math.max(...stops.map((s) => s.label.length));
  const stopLines = stops.flatMap((s, i) => {
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
    if (last) return [line];
    const dotted = s.manual || stops[i + 1].manual;
    return [line, `  ${DIM(dotted ? '┊' : '│')}`];
  });
  return ['', `  ${B('Rotation plan')}`, '', ...stopLines, ''];
}

function renderRotationPlan(stops: RotatePlanStop[]): void {
  // Write synchronously to fd 1. A backgrounded run pipes stdout, where
  // console.log is buffered and would only flush AFTER the blocking
  // `stripe login` spawnSync — so the plan would be missing from the captured
  // output during the auth wait (when the agent reads it to relay the pairing
  // code). writeSync lands the whole plan now, before that block.
  writeSync(1, rotationPlanLines(stops).join('\n') + '\n');
}

/** The providers (in order) whose connector module requires auth. */
async function providersRequiringAuth(providerNames: readonly string[]): Promise<string[]> {
  if (providerNames.length === 0) return [];
  const [first, ...rest] = providerNames;
  const mod = await loadProvider(first).catch(() => undefined);
  const restAuth = await providersRequiringAuth(rest);
  return mod?.requiresAuth ? [first, ...restAuth] : restAuth;
}

/**
 * The first provider (in order) whose connector module is import-kind — the
 * check `rotateMany` needs before it dares call `resolveContext()`. Prechecks
 * every OTHER provider it passes along the way, same as the loop this
 * replaces, and stops (like the loop's own early `return`) the moment it
 * finds one.
 */
async function findImportOnlyProvider(providerNames: readonly string[]): Promise<string | null> {
  if (providerNames.length === 0) return null;
  const [first, ...rest] = providerNames;
  const mod = await loadProvider(first);
  if (mod.kind === 'import') return first;
  if (mod.precheck) mod.precheck();
  return findImportOnlyProvider(rest);
}

/**
 * End the run on a refusal: prints it and exits 1 via `displayErrorAndExit`,
 * with a typed code (the handle an agent branches on) rather than a sentence.
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
  const { displayErrorAndExit } = await import('../ui/errorScreen');
  await displayErrorAndExit(error, context);
}

/**
 * capy-dev may open a CI/PR deploy, but must never run a direct vendor ship.
 * Drops a resolved direct-mode target in dev, printing why; returns `target`
 * unchanged otherwise.
 */
function devDirectModeGuard(devMode: boolean, target: TargetConfig | null): TargetConfig | null {
  if (!devMode || !target || (target.mode ?? 'direct') === 'ci') return target;
  console.log(
    `\n  \x1b[33m⚠ capy-dev skips the direct-mode deploy for ${target.name} (CI/PR only in dev).\x1b[0m`,
  );
  return null;
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
      // `--all` ignores a positional variable.
      await this.planAndRotate(managed, branch, opts);
      return;
    }

    // Resolve which (varName, connector|unmanaged) we're operating on, as one
    // value rather than a reassigned local — `resolution.stop` is set on
    // every path that already printed its own refusal and needs this method to
    // return without doing anything else.
    type Target = { varName: string; connector: ConnectorMetadata } | { varName: string; unmanaged: true };
    const resolution: { target: Target } | { stop: true } = await (async (): Promise<{ target: Target } | { stop: true }> => {
      if (varName) {
        const connector = findManagedConnector(keep, varName, branch);
        if (connector) return { target: { varName, connector } };
        if (allVars.includes(varName)) return { target: { varName, unmanaged: true } };
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
        return { stop: true };
      }

      if (allVars.length === 0) {
        await refuse(
          new CapyError('No variables on this branch yet.', ERROR_CODES.NO_VARIABLES, { branch }),
          { projectName: keep.project_name, projectId: keep.project_id, branch },
        );
        return { stop: true };
      }
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
      const picked: string = answer.picked;
      const connector = findManagedConnector(keep, picked, branch);
      return { target: connector ? { varName: picked, connector } : { varName: picked, unmanaged: true } };
    })();

    if ('stop' in resolution) return;
    const { target } = resolution;

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
  private async choosePromoteProvider(
    varName: string,
    opts: RotateOpts & { provider?: string },
    providers: { name: string; description: string }[],
    linkableProviders: { name: string; description: string }[],
  ): Promise<string | null> {
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
        return opts.provider;
      }
      if (linkableProviders.length === 1) return linkableProviders[0].name;
      refuseNonInteractive(
        `${B(varName)} isn't connected to an integration yet, and several are available`,
        `Pass --provider <name> (one of: ${linkableProviders.map((p) => p.name).join(', ')}).`,
      );
    }

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
          ...linkableProviders.map((p) => ({ name: `${B(p.name)} — ${p.description}`, value: p.name })),
          new inquirer.Separator(),
          { name: 'Cancel', value: '__cancel__' },
        ],
      },
    ]);
    return picked.provider === '__cancel__' ? null : picked.provider;
  }

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

    // An explicitly named provider is refused here, before ANY network call,
    // when it's import-only (CAP-662: `dokploy`) — keyed off the module's
    // `kind`, never off the provider's name string (cardinal Rule 4). This
    // is the same check `rotateMany` makes for an already-linked variable;
    // here the variable isn't linked yet, so the refusal has to come before
    // `connect.execute()` below ever runs the import.
    if (opts.provider) {
      const namedMod = await loadProvider(opts.provider).catch(() => undefined);
      if (namedMod?.kind === 'import') {
        await refuse(
          new CapyError(
            `${opts.provider} is import-only; there is nothing to rotate through it. Re-run \`capy connect ${opts.provider}\` to re-import instead.`,
            ERROR_CODES.ROTATE_NOT_SUPPORTED_IMPORTED,
            { provider: opts.provider },
          ),
        );
        return;
      }
    }

    // The link-first picker (below, non-interactive or interactive) only ever offers a provider that can actually link ONE
    // variable — an import-kind connector pulls many at once and has no
    // rotate() to promote into, so it never belongs in this list.
    const linkableProviders = (
      await Promise.all(providers.map(async (p) => ({ ...p, kind: (await loadProvider(p.name)).kind })))
    ).filter((p) => p.kind !== 'import');
    if (linkableProviders.length === 0) {
      await refuse(new CapyError('No connectors support linking a variable directly.', ERROR_CODES.NO_CONNECTORS));
      return;
    }

    const chosenProvider = await this.choosePromoteProvider(varName, opts, providers, linkableProviders);
    if (chosenProvider === null) {
      console.log('\n  Cancelled.\n');
      return;
    }
    const provider = chosenProvider;

    const connect = new ConnectCommand(this.devMode);
    const { linked } = await connect.execute(provider, {
      var: varName,
      noPush: opts.noPush,
      nonTty: opts.nonTty,
      // A step, not the run: stops connect signing off with the command we
      // are inside.
      subStep: true,
    });
    if (!linked) return;

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

  /** The route this run will travel, resolved before anything runs. */
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
    const authProviders = await providersRequiringAuth(providers);
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
   * provider preflight, per-rotation confirmation in prod live mode. Returns
   * the names that rotated.
   */
  private async rotateMany(
    targets: Array<{ varName: string; connector: ConnectorMetadata }>,
    opts: RotateOpts & { all?: boolean },
  ): Promise<string[]> {
    const liveFilter = await this.filterLiveInDevMode(targets, opts);
    if (liveFilter.kind === 'stop') return [];
    const { toRotate } = liveFilter;

    // Each unique provider (in first-appearance order), prechecked once and
    // refused early if it's import-kind — keyed off the connector module's
    // `kind`, not off the provider's name string (cardinal Rule 4): an
    // import-kind connector (CAP-662) pulls many vars in ONE TIME and has no
    // rotate() worth calling. Refusing here happens before `resolveContext()`
    // below makes the first network call.
    const uniqueProviders = [...new Set(toRotate.map(({ connector }) => connector.provider))];
    const importOnlyProvider = await findImportOnlyProvider(uniqueProviders);
    if (importOnlyProvider) {
      await refuse(
        new CapyError(
          `${importOnlyProvider} is import-only; there is nothing to rotate through it. Re-run \`capy connect ${importOnlyProvider}\` to re-import instead.`,
          ERROR_CODES.ROTATE_NOT_SUPPORTED_IMPORTED,
          { provider: importOnlyProvider },
        ),
      );
      return [];
    }

    const ctx = await resolveContext({ devMode: this.devMode });

    const result = await this.rotateSequentially(toRotate, ctx, opts, { succeeded: [], failed: [] });

    if (opts.all && (result.succeeded.length > 0 || result.failed.length > 0)) {
      console.log('');
      console.log(`  Rotated ${result.succeeded.length}/${toRotate.length} key(s).`);
      if (result.failed.length > 0) {
        console.log(`  Failed: ${result.failed.map((f) => f.name).join(', ')}`);
        process.exit(1);
      } else {
        console.log('');
      }
    }

    return [...result.succeeded];
  }

  /**
   * The dev-mode live-key firewall, applied once before any rotation starts:
   * `capy-dev` refuses live keys outright — `--all` skips them and carries
   * on, without it the whole batch is refused. Returns the filtered list to
   * rotate, or a `stop` when nothing is left to rotate.
   */
  private async filterLiveInDevMode(
    targets: readonly { varName: string; connector: ConnectorMetadata }[],
    opts: RotateOpts & { all?: boolean },
  ): Promise<
    | { kind: 'ok'; toRotate: readonly { varName: string; connector: ConnectorMetadata }[] }
    | { kind: 'stop' }
  > {
    if (!this.devMode) return { kind: 'ok', toRotate: targets };

    const liveOnes = targets.filter((m) => m.connector.mode === 'live');
    if (!opts.all && liveOnes.length > 0) {
      await refuse(
        new CapyError(`${liveOnes[0].varName} is configured for live mode.`, ERROR_CODES.DEV_LIVE_FIREWALL, {
          variables: liveOnes.map((m) => m.varName),
          nothingLeft: false,
        }),
      );
      return { kind: 'stop' };
    }
    if (opts.all && liveOnes.length > 0) {
      console.log('');
      liveOnes.forEach((m) => {
        console.log(`  \x1b[33m⚠ skipping ${m.varName} (live mode — not allowed in capy-dev)\x1b[0m`);
      });
      const filtered = targets.filter((m) => m.connector.mode !== 'live');
      if (filtered.length === 0) {
        await refuse(
          new CapyError('Nothing to rotate. All managed keys are live-mode.', ERROR_CODES.DEV_LIVE_FIREWALL, {
            variables: liveOnes.map((m) => m.varName),
            nothingLeft: true,
          }),
        );
        return { kind: 'stop' };
      }
      return { kind: 'ok', toRotate: filtered };
    }
    return { kind: 'ok', toRotate: targets };
  }

  /**
   * Rotates `items` one at a time, threading `succeeded`/`failed` through
   * return values instead of mutating shared variables across the loop.
   */
  private async rotateSequentially(
    items: readonly { varName: string; connector: ConnectorMetadata }[],
    ctx: ResolvedContext,
    opts: RotateOpts & { all?: boolean },
    state: RotateLoopState,
  ): Promise<RotateLoopState> {
    if (items.length === 0) return state;
    const [{ varName: name, connector }, ...rest] = items;

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
          const declinedState: RotateLoopState = {
            ...state,
            failed: [...state.failed, { name, err: new Error('confirmation declined') }],
          };
          if (opts.all) return this.rotateSequentially(rest, ctx, opts, declinedState);
          process.exit(1);
        }
      }

      const mod = await loadProvider(connector.provider);
      const { value, entry: updated } = await mod.rotate(ctx, name, connector, {
        noPush: opts.noPush,
      });

      const freshCtx = await resolveContext({ devMode: this.devMode });
      await writeAndSync(freshCtx, name, value, { push: !opts.noPush, connector: updated });

      const succeededState: RotateLoopState = {
        ...state,
        succeeded: [...state.succeeded, name],
      };
      console.log('');
      console.log(`  ✓ ${B(name)} rotated${opts.noPush ? ' (local only)' : ' and pushed'}.`);
      if (connector.source === 'cli') {
        console.log(
          `  ⚠ The previous key is now invalid. Teammates must run ${B('capy')} to pick up the new value.`,
        );
      }
      console.log('');
      return this.rotateSequentially(rest, ctx, opts, succeededState);
    } catch (err) {
      const failState: RotateLoopState = {
        ...state,
        failed: [...state.failed, { name, err }],
      };
      console.error('');
      console.error(`  ✗ Failed to rotate ${B(name)}: ${(err as Error).message}`);
      console.error('');
      if (opts.all) return this.rotateSequentially(rest, ctx, opts, failState);
      process.exit(1);
    }
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
    opts: RotateOpts & {
      all?: boolean;
      skipPrompts?: boolean;
      provider?: string;
      /**
       * This run reached here by PROMOTING an unmanaged variable through the
       * named integration, which is an answer the plan has to show rather than
       * a stop it can strike through.
       */
      promotedVia?: string;
    },
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
    // Resolved as one value rather than a reassigned local — `stop` marks the
    // one path (a declined picker) that already printed its own
    // cancellation and needs this method to return without doing anything else.
    const targetResolution: { target: TargetConfig | null; stop?: true } = await (async () => {
      if (isTTY) {
        // Ensure a target exists, setting one up inline if needed.
        const { ensureDeployTarget } = await import('./deployCommand');
        const resolved = await ensureDeployTarget(process.cwd());
        if (!resolved) {
          // A declined picker wrote nothing and that was the point, so this is a 0.
          console.log('\n  Cancelled.\n');
          return { target: null, stop: true as const };
        }
        return { target: resolved };
      }
      // Non-interactive: auto-resolve the unambiguous single target. With zero
      // or several we don't refuse — rotate + push still runs and the user is
      // kicked into the deploy flow afterward (target stays null).
      return { target: configuredTargets.length === 1 ? configuredTargets[0] : null };
    })();
    if (targetResolution.stop) return;

    // Dev isolation: capy-dev may open a CI/PR deploy, but must never run a
    // direct vendor ship. Drop a resolved direct-mode target in dev.
    const deployTarget = devDirectModeGuard(this.devMode, targetResolution.target);

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
    // The one approval the whole rotate → push → deploy chain has; it is
    // dropped the moment stdin is piped (`!opts.skipPrompts && isTTY`).
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
    const succeeded = await this.rotateMany(targets, opts);
    if (succeeded.length === 0) return;

    // ── Stale targets (CAP-679) ───────────────────────────────────────────
    // The rotate above already pushed — re-read to see which `targets`
    // elements now disagree with the fresh value_hash, and report them.
    // Kept deliberately separate from `deployTarget`'s own auto-redeploy
    // above/below: THIS is "does any configured target still hold the OLD
    // value", regardless of whether a single unambiguous target happened to
    // be resolved for the redeploy-after-rotate flow.
    await this.reportStaleTargets(branch, succeeded, opts, isTTY);

    if (!deployTarget) {
      // No target resolved (none configured, several to disambiguate, or
      // a dev direct-mode target we skipped). The key is already rotated
      // + pushed; kick the user into the deploy flow to open the rollout PR.
      this.deployHint(configuredTargets.length);
      return;
    }
    const { deployCommand } = await import('./deployCommand');
    const code = await deployCommand(deployTarget.name, { yes: true, devMode: this.devMode });
    if (code !== 0) process.exit(code);
  }

  /**
   * CAP-679: after a successful rotate + push, list every configured target
   * whose keep.lock record now disagrees with the fresh value — i.e. a
   * platform that still holds the OLD value. Report-only without a plain
   * terminal (`offerRedeploy=false`) or with `--skip-prompts`/`--yes`: this
   * never prompts — it reuses the same rotate→deploy plumbing
   * (`deployCommand`) as the single-target auto-redeploy above, one call per
   * stale target, only when a human at a real TTY says yes.
   */
  private async reportStaleTargets(
    branch: string,
    rotatedVars: readonly string[],
    opts: RotateOpts & { skipPrompts?: boolean },
    offerRedeploy: boolean,
  ): Promise<void> {
    if (rotatedVars.length === 0) return;
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    if (!keep) return;

    type StaleGroup = { provider: string; target: string; vars: readonly string[] };
    const staleHits = rotatedVars.flatMap((varName) => {
      const entry = (keep.variables[varName] ?? []).find((e) => (e.branch ?? '') === branch);
      return entry ? staleTargets(entry).map((t) => ({ varName, provider: t.provider, target: t.target })) : [];
    });
    const staleByTarget = staleHits.reduce((acc, hit) => {
      const key = `${hit.provider}\u0000${hit.target}`;
      const existing = acc.get(key);
      const group: StaleGroup = existing
        ? { ...existing, vars: [...existing.vars, hit.varName] }
        : { provider: hit.provider, target: hit.target, vars: [hit.varName] };
      return new Map([...acc, [key, group]]);
    }, new Map<string, StaleGroup>());
    if (staleByTarget.size === 0) return;

    console.log(`\n  \x1b[33m!\x1b[0m Stale on ${staleByTarget.size} target(s) — the value(s) changed since last delivered:`);
    for (const { provider, target, vars } of staleByTarget.values()) {
      console.log(`    - ${target} (${provider}): ${vars.join(', ')}`);
    }

    if (!offerRedeploy || opts.skipPrompts) {
      console.log('    Run `capy deploy <target>` to redeploy the ones you need.');
      return;
    }

    const { listTargets } = await import('../deploy/config');
    const configured = listTargets(process.cwd());
    const inquirer = (await import('inquirer')).default;
    for (const { target: targetName } of staleByTarget.values()) {
      const target = configured.find((t) => t.name === targetName);
      if (!target) continue;
      const { proceed } = await inquirer.prompt([
        { type: 'confirm', name: 'proceed', message: `Redeploy stale target "${targetName}" now?`, default: true },
      ]);
      if (!proceed) continue;
      const { deployCommand } = await import('./deployCommand');
      await deployCommand(target.name, { yes: true, devMode: this.devMode });
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

/**
 * `rotateSequentially`'s accumulator, threaded through the recursion instead
 * of the `succeeded`/`failed` mutable locals the original `for` loop closed
 * over. `failed` never leaves this file.
 */
interface RotateLoopState {
  readonly succeeded: readonly string[];
  readonly failed: ReadonlyArray<{ name: string; err: any }>;
}

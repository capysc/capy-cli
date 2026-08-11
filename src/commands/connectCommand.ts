import { resolveContext, writeAndSync, listManagedKeys } from './connectors/shared';
import { listProviders, loadProvider, ConnectOpts, ConnectorModule } from './connectors/registry';
import { connectPlan } from './connectors/plans';
import { isInteractive } from '../ui/interactive';
import { ProjectManager } from '../core/projectManager';
import { confirmLiveActionInBrowser } from '../ui/connectScreens';
import type {
  ConnectLiveGateStop,
  ConnectorChoice,
  ConnectOutcome,
  ConnectResultData,
} from '../ui/screens/contract';
import type { AuthService } from '../auth/authService';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** Browser paths honour this so a test never opens the developer's real browser. */
const shouldOpen = (): boolean => !process.env.CAPY_WEB_NO_OPEN;

/**
 * The connector list, with the three things the terminal's two columns cannot
 * say until it is too late: that the connector wants a binary you may not have,
 * that it hands you off to a browser pairing, and how many variables on this
 * branch it already owns.
 *
 * Exported so a test can assert the shape without a browser. The keep.lock read
 * is best-effort: `capy connect` runs outside an initialised project too, and a
 * missing count is not a reason to refuse the list.
 */
export async function describeConnectors(): Promise<ConnectorChoice[]> {
  let managed: Record<string, number> = {};
  try {
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    const branch = pm.deriveActiveBranch();
    if (keep && branch) {
      for (const { connector } of listManagedKeys(keep, branch)) {
        managed[connector.provider] = (managed[connector.provider] ?? 0) + 1;
      }
    }
  } catch {
    managed = {};
  }

  const out: ConnectorChoice[] = [];
  for (const p of listProviders()) {
    const mod = await loadProvider(p.name);
    const found = mod.toolInstalled ? mod.toolInstalled() : undefined;
    out.push({
      id: p.name,
      description: p.description,
      ...(mod.requiresAuth ? { requiresAuth: true } : {}),
      ...(mod.requiresTool ? { requiresTool: mod.requiresTool } : {}),
      ...(found === undefined ? {} : { toolFound: found }),
      // The identical refusal `capy connect <id>` would run into, previewed
      // here rather than discovered one command later. Same object, so the two
      // cannot word one condition differently.
      ...(found === false && mod.toolMissing ? { blocked: mod.toolMissing } : {}),
      ...(managed[p.name] ? { managedCount: managed[p.name] } : {}),
    });
  }
  return out;
}

/**
 * What the result page's Push stop should say, given how the run ended.
 *
 * One mapping, keyed off the outcome enum rather than off prose, so the rail
 * and the body of the page cannot disagree: a `push-failed` page that reads
 * "The push did not land" beside a rail drawing Push as a stop still ahead of
 * the traveller is the drift the declared plan exists to remove.
 */
export function pushOutcomeFor(outcome: ConnectOutcome): 'landed' | 'failed' | 'not-reached' {
  if (outcome === 'pushed') return 'landed';
  if (outcome === 'push-failed') return 'failed';
  // `local-only` never attempted it, `write-failed` never got that far, and
  // `cancelled` stopped at the gate before it.
  return 'not-reached';
}

export class ConnectCommand {
  private devMode: boolean;

  constructor(devMode: boolean = false) {
    this.devMode = devMode;
  }

  /**
   * `capy connect` with no provider.
   *
   * In the terminal this prints a catalogue and stops: the user reads two
   * columns and then types a second command. Under `--web` the catalogue is
   * the picker, and picking a row continues into the same connect.
   */
  async list(opts: ConnectOpts = {}): Promise<void> {
    if (opts.web) {
      const picked = await this.chooseProviderInBrowser(opts);
      if (!picked) {
        console.log('\n  No connector selected — nothing changed.\n');
        return;
      }
      await this.execute(picked, opts);
      return;
    }

    console.log('');
    console.log('  Available connectors:');
    for (const p of listProviders()) {
      console.log(`    ${B(p.name).padEnd(20)} ${p.description}`);
    }
    console.log('');
  }

  /** Serve the connector list and return the pick, or null on cancel. */
  private async chooseProviderInBrowser(
    opts: ConnectOpts,
    unknownProvider?: string,
  ): Promise<string | null> {
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    const { chooseConnectorInBrowser } = await import('../ui/connectScreens');
    const picked = await chooseConnectorInBrowser({
      projectName: keep?.project_name ?? 'project',
      branch: pm.deriveActiveBranch() ?? '',
      connectors: await describeConnectors(),
      ...(unknownProvider ? { unknownProvider } : {}),
      open: shouldOpen(),
    });
    return picked.cancelled ? null : picked.provider;
  }

  /**
   * Returns whether the link was actually recorded.
   *
   * A caller that has more journey after this one — `capy rotate` promoting an
   * unmanaged variable — has to know whether to carry on, and the honest
   * signal is a return value rather than re-reading keep.lock and inferring it.
   * A decline and a failed push both leave `linked: false`; every path that
   * ends in `process.exit` never returns at all.
   */
  async execute(provider: string, opts: ConnectOpts): Promise<{ linked: boolean }> {
    // Live-mode firewall: capy-dev never touches a live key.
    if (this.devMode && opts.live) {
      console.error('\n  Live mode is not allowed in dev mode.');
      console.error('  Use the production `capy` binary against your real Capy service.\n');
      process.exit(1);
    }

    // The mode question needs to know it is running under capy-dev so it can
    // say live is refused beside the option, rather than accepting it and
    // exiting two screens later.
    const effective: ConnectOpts = { ...opts, devMode: this.devMode };

    let mod: ConnectorModule;
    try {
      mod = await loadProvider(provider);
    } catch (err) {
      if (opts.web) {
        // The terminal answers a bad provider with `Unknown connector: x` and a
        // pointer back to the bare `capy connect`, which is a second command
        // for a list the CLI could have shown with the mistake. Here it does.
        const picked = await this.chooseProviderInBrowser(opts, provider);
        if (picked) {
          // RETURN, never `process.exit(0)`: the run that just finished served
          // its own ending page from a loopback server in this process, and
          // exiting here would close the socket underneath it. Returning lets
          // the process end on its own once that page has been read, carrying
          // whatever exit code the inner run set.
          return await this.execute(picked, opts);
        }
      }
      console.error(`\n  ${(err as Error).message}`);
      console.error('  Run `capy connect` to see available providers.\n');
      process.exit(1);
    }

    if (mod.precheck) mod.precheck();

    const ctx = await resolveContext({ devMode: this.devMode });
    const { varName, value, entry } = await mod.connect(ctx, effective);

    // Belt-and-suspenders: if a provider returned mode:'live' (e.g. via an
    // interactive prompt rather than --live), still refuse in dev mode.
    if (this.devMode && entry.mode === 'live') {
      console.error('\n  Live mode is not allowed in dev mode.');
      console.error('  Use the production `capy` binary against your real Capy service.\n');
      process.exit(1);
    }

    // Confirmation gate for live mode in prod: a human typing the account ID.
    // In assisted non-interactive mode we skip the typed echo — when connect
    // ran `stripe login`, completing that browser pairing is the human-presence
    // proof. The typed confirmation only runs in an interactive terminal, or in
    // a browser when one was asked for.
    if (!this.devMode && entry.mode === 'live' && (opts.web || isInteractive(opts.nonTty))) {
      const ok = opts.web
        ? await confirmLiveActionInBrowser({
            action: 'connect',
            provider,
            projectName: ctx.keep.project_name,
            branch: ctx.branch,
            varName,
            accountId: entry.account_id ?? null,
            // Read off the recorded metadata, not off a value: `connect` no
            // longer carries one. `key_prefix` exists for exactly this — the
            // fingerprint keeps three characters, which cannot tell `sk_test_`
            // from `sk_live_` at the confirmation that exists to tell them
            // apart.
            ...(entry.key_prefix ? { keyPrefix: entry.key_prefix } : {}),
            push: !opts.noPush,
            pushFromFlag: opts.noPush === true,
            accountFromFlag: Boolean(opts.account),
            varFromFlag: Boolean(opts.var),
            stops: connectPlan({
              provider,
              branch: ctx.branch,
              requiresTool: mod.requiresTool,
              requiresAuth: mod.requiresAuth,
              standing: null,
              varName,
              varFromFlag: Boolean(opts.var),
              mode: 'live',
              modeFromFlag: Boolean(opts.live),
              account: entry.account_id,
              accountFromFlag: Boolean(opts.account),
              alreadySignedIn: true,
              push: !opts.noPush,
              pushFromFlag: opts.noPush === true,
            }),
            open: shouldOpen(),
                })
        : await confirmLiveAction({
            action: 'connect',
            varName,
            accountId: entry.account_id ?? '(unknown)',
            keyPrefix: entry.key_prefix ?? '(unknown)',
          });
      if (!ok) {
        console.log('  Cancelled.');
        // The terminal path is unchanged: nothing was written, and the command
        // is over.
        if (!opts.web) process.exit(0);
        // Under `--web` the decline gets a page saying what it left behind —
        // and that page is served from THIS process, so the run ends by
        // returning rather than by exiting. `process.exit(0)` here closed the
        // loopback server microseconds after it started listening, which made
        // the ending unreachable and the refusal indistinguishable from a
        // successful connect.
        await this.showResult(ctx.keep.project_name, ctx.branch, provider, mod.requiresTool, opts, {
          outcome: 'cancelled',
          varName,
          mode: entry.mode as 'test' | 'live' | undefined,
          requiresAuth: mod.requiresAuth === true,
        }, ctx.authService);
        return { linked: false };
      }
    }

    // A push that fails after the local write leaves .env holding a key nobody
    // else has, and the terminal reports that as a stack trace. The two states
    // need different next moves, so the browser result names which one happened.
    let outcome: ConnectOutcome = opts.noPush ? 'local-only' : 'pushed';
    let detail: string | undefined;
    try {
      await writeAndSync(ctx, varName, value, { push: !opts.noPush, connector: entry });
    } catch (err) {
      if (!opts.web) throw err;
      outcome = opts.noPush ? 'write-failed' : 'push-failed';
      detail = err instanceof Error ? err.message : String(err);
    }

    // The terminal's own lines first, then the page. The other order made the
    // whole summary wait on a human loading a browser tab, because the ending
    // page holds the run open until it has been delivered.
    const failed = outcome === 'push-failed' || outcome === 'write-failed';
    console.log('');
    if (failed) {
      console.error(`  ✗ ${B(varName)}: ${detail}`);
      console.log('');
    } else if (opts.noPush) {
      // Say what moved AND what did not. The old wording — "wrote VAR to .env"
      // — described a value write that no longer happens, and a success line
      // that overstates its own reach is how a user learns the wrong model of
      // the command.
      console.log(`  ✓ ${B(varName)} is now managed by ${B(provider)} (not pushed).`);
      console.log(
        opts.subStep
          ? '  Its value is unchanged — rotating it now.'
          : `  Its value is unchanged. Run ${B('capy push')} to share the link with teammates.`,
      );
      console.log('');
    } else {
      console.log(`  ✓ ${B(varName)} is now managed by ${B(provider)} (branch: ${ctx.branch}).`);
      // Inside `capy rotate` the usual next step IS what is already running,
      // and telling someone to run the command they are inside is how a flow
      // reads as a loop.
      console.log(
        opts.subStep
          ? '  Its value is unchanged — rotating it now.'
          : `  Its value is unchanged — run ${B(`capy rotate ${varName}`)} to replace it.`,
      );
      console.log('');
    }

    // No ending page for a step that is not the end. `showResult` serves a
    // page that says the run is over and holds the process until a browser has
    // read it; between the link and the rotation it would be a false ending
    // and a second window. The failure endings below this branch are a
    // different case — the outer command stops there, so the page is the only
    // report there is.
    if (opts.web && (failed || !opts.subStep)) {
      await this.showResult(ctx.keep.project_name, ctx.branch, provider, mod.requiresTool, opts, {
        outcome,
        varName,
        mode: entry.mode as 'test' | 'live' | undefined,
        accountId: entry.account_id,
        ...(entry.key_prefix ? { keyPrefix: entry.key_prefix } : {}),
        fingerprint: entry.fingerprint,
        expiresAt: entry.expires_at,
        detail,
        requiresAuth: mod.requiresAuth === true,
      }, ctx.authService);
    }

    // `process.exitCode`, never `process.exit`. The failure endings above are
    // only reachable under `--web` (without it the throw propagates), and the
    // page explaining them is served from this process — an exit here is what
    // made "the push did not land" a page nobody could open. The code is
    // delivered when the loop drains, which is after the browser has the page.
    if (failed) process.exitCode = 1;
    return { linked: !failed };
  }

  /** The tail of the command, as a page. Reports only — nothing here decides. */
  private async showResult(
    projectName: string,
    branch: string,
    provider: string,
    requiresTool: string | undefined,
    opts: ConnectOpts,
    run: {
      outcome: ConnectOutcome;
      varName: string;
      mode?: 'test' | 'live';
      accountId?: string;
      keyPrefix?: string;
      fingerprint?: string;
      expiresAt?: number;
      detail?: string;
      /** The provider's own flag, not an assumption about every connector. */
      requiresAuth: boolean;
    },
    /** `authService` opts this call into the keep-hosted transport when
     *  CAPY_KEEP_SCREENS=1 (W2-B) — omitted, this is unreachable and the flow
     *  is the loopback-only path unchanged. Both call sites already hold
     *  `ctx` from `resolveContext()`. */
    authService?: AuthService,
  ): Promise<void> {
    const { showConnectResultInBrowser } = await import('../ui/connectScreens');
    const expiresInDays =
      typeof run.expiresAt === 'number'
        ? Math.floor((run.expiresAt - Date.now() / 1000) / 86400)
        : undefined;
    const stops: ConnectResultData['stops'] = connectPlan({
      provider,
      branch,
      requiresTool,
      requiresAuth: run.requiresAuth,
      standing: null,
      varName: run.varName,
      varFromFlag: Boolean(opts.var),
      ...(run.mode ? { mode: run.mode } : {}),
      modeFromFlag: Boolean(opts.live),
      ...(run.accountId ? { account: run.accountId } : {}),
      accountFromFlag: Boolean(opts.account),
      // Every outcome this page reports arrives AFTER `mod.connect()` returned
      // a key, so the provider session existed by then however it got there.
      // Drawing "Sign in" as still upcoming on a finished run is the same
      // drift as drawing Push as upcoming on a run that pushed.
      signedIn: true,
      push: !opts.noPush,
      pushFromFlag: opts.noPush === true,
      pushOutcome: pushOutcomeFor(run.outcome),
    });
    await showConnectResultInBrowser({
      outcome: run.outcome,
      provider,
      projectName,
      branch,
      varName: run.varName,
      ...(run.mode ? { mode: run.mode } : {}),
      ...(run.accountId ? { accountId: run.accountId } : {}),
      ...(run.keyPrefix ? { keyPrefix: run.keyPrefix } : {}),
      ...(run.fingerprint ? { fingerprint: run.fingerprint } : {}),
      ...(expiresInDays !== undefined ? { expiresInDays } : {}),
      ...(run.detail ? { detail: run.detail } : {}),
      stops,
      open: shouldOpen(),
      authService,
    });
  }
}

/**
 * The route a rotation's live gate draws.
 *
 * Rotation reaches `confirmLiveAction` with the variable and the account
 * already settled — the variable positionally, the account off the keep.lock
 * entry — so both stops are `done`. The variable stop carries no `flag`
 * deliberately: `capy rotate` takes the variable positionally, and naming a
 * flag would be the rail telling the reader to retype an argument the command
 * would reject.
 */
export function rotateLiveGateStops(args: {
  provider: string;
  branch: string;
  varName: string;
  accountId?: string;
  push: boolean;
  pushFromFlag?: boolean;
}): ConnectLiveGateStop[] {
  return connectPlan({
    provider: args.provider,
    branch: args.branch,
    requiresTool: args.provider === 'stripe' ? 'stripe' : undefined,
    requiresAuth: true,
    standing: null,
    varName: args.varName,
    mode: 'live',
    ...(args.accountId ? { account: args.accountId } : {}),
    alreadySignedIn: true,
    push: args.push,
    ...(args.pushFromFlag ? { pushFromFlag: true } : {}),
  });
}

/**
 * Block the call until the user types the account_id exactly. Returns true
 * on confirm, false on any mismatch / cancel. Prod live-mode actions only.
 */
export async function confirmLiveAction(args: {
  action: 'connect' | 'rotate';
  varName: string;
  accountId: string;
  keyPrefix?: string;
}): Promise<boolean> {
  const { action, varName, accountId, keyPrefix } = args;
  console.log('');
  console.log(`  \x1b[31m⚠⚠⚠ LIVE MODE — REAL STRIPE ACCOUNT\x1b[0m`);
  console.log('');
  console.log(`    Account:  ${accountId}`);
  console.log(`    Action:   ${action} ${varName}`);
  if (keyPrefix) console.log(`    Key type: ${keyPrefix}…`);
  console.log('');
  console.log('  This affects real customers and real money. Source-A rotation re-runs');
  console.log('  `stripe login`, which invalidates your existing live key IMMEDIATELY —');
  console.log('  anything currently using it will start failing within seconds.');
  console.log('');

  const inquirer = (await import('inquirer')).default;
  const { typed } = await inquirer.prompt([
    {
      type: 'input',
      name: 'typed',
      message: `Type the account ID to confirm (${accountId}):`,
    },
  ]);
  return typed === accountId;
}

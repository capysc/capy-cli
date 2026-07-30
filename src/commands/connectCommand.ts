import { resolveContext, writeAndSync, listManagedKeys } from './connectors/shared';
import { listProviders, loadProvider, ConnectOpts } from './connectors/registry';
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

  async execute(provider: string, opts: ConnectOpts): Promise<void> {
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

    const mod = await loadProvider(provider).catch(async (err) => {
      if (opts.web) {
        // The terminal answers a bad provider with `Unknown connector: x` and a
        // pointer back to the bare `capy connect`, which is a second command
        // for a list the CLI could have shown with the mistake. Here it does.
        const picked = await this.chooseProviderInBrowser(opts, provider);
        if (picked) {
          await this.execute(picked, opts);
          process.exit(0);
        }
      }
      console.error(`\n  ${err.message}`);
      console.error('  Run `capy connect` to see available providers.\n');
      process.exit(1);
    });

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
            keyPrefix: value.slice(0, 8),
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
              refreshOffered: false,
              push: !opts.noPush,
              pushFromFlag: opts.noPush === true,
            }),
            open: shouldOpen(),
                })
        : await confirmLiveAction({
            action: 'connect',
            varName,
            accountId: entry.account_id ?? '(unknown)',
            keyPrefix: value.slice(0, 8),
          });
      if (!ok) {
        console.log('  Cancelled.');
        if (opts.web) {
          await this.showResult(ctx.keep.project_name, ctx.branch, provider, mod.requiresTool, opts, {
            outcome: 'cancelled',
            varName,
            mode: entry.mode as 'test' | 'live' | undefined,
          });
        }
        process.exit(0);
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

    if (opts.web) {
      await this.showResult(ctx.keep.project_name, ctx.branch, provider, mod.requiresTool, opts, {
        outcome,
        varName,
        mode: entry.mode as 'test' | 'live' | undefined,
        accountId: entry.account_id,
        keyPrefix: value.slice(0, 8),
        fingerprint: entry.fingerprint,
        expiresAt: entry.expires_at,
        detail,
      });
    }

    console.log('');
    if (outcome === 'push-failed' || outcome === 'write-failed') {
      console.error(`  ✗ ${B(varName)}: ${detail}`);
      console.log('');
      process.exit(1);
    }
    if (opts.noPush) {
      console.log(`  ✓ wrote ${B(varName)} to .env (encrypted, not pushed).`);
      console.log(`  Run ${B('capy push')} to share with teammates.`);
    } else {
      console.log(`  ✓ ${B(varName)} written, encrypted, and pushed (branch: ${ctx.branch}).`);
    }
    console.log('');
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
    },
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
      requiresAuth: true,
      standing: null,
      varName: run.varName,
      varFromFlag: Boolean(opts.var),
      ...(run.mode ? { mode: run.mode } : {}),
      modeFromFlag: Boolean(opts.live),
      ...(run.accountId ? { account: run.accountId } : {}),
      accountFromFlag: Boolean(opts.account),
      push: !opts.noPush,
      pushFromFlag: opts.noPush === true,
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
    refreshOffered: false,
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

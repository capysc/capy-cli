import { resolveContext, writeAndSync } from './connectors/shared';
import { listProviders, loadProvider, ConnectOpts } from './connectors/registry';
import { isInteractive } from '../ui/interactive';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class ConnectCommand {
  private devMode: boolean;

  constructor(devMode: boolean = false) {
    this.devMode = devMode;
  }

  async list(): Promise<void> {
    console.log('');
    console.log('  Available connectors:');
    for (const p of listProviders()) {
      console.log(`    ${B(p.name).padEnd(20)} ${p.description}`);
    }
    console.log('');
  }

  async execute(provider: string, opts: ConnectOpts): Promise<void> {
    // Live-mode firewall: capy-dev never touches a live key.
    if (this.devMode && opts.live) {
      console.error('\n  Live mode is not allowed in dev mode.');
      console.error('  Use the production `capy` binary against your real Capy service.\n');
      process.exit(1);
    }

    const mod = await loadProvider(provider).catch((err) => {
      console.error(`\n  ${err.message}`);
      console.error('  Run `capy connect` to see available providers.\n');
      process.exit(1);
    });

    if (mod.precheck) mod.precheck();

    const ctx = await resolveContext({ devMode: this.devMode });
    const { varName, value, entry } = await mod.connect(ctx, opts);

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
    // proof. The typed confirmation only runs in an interactive terminal.
    if (!this.devMode && entry.mode === 'live' && isInteractive(opts.nonTty)) {
      const ok = await confirmLiveAction({
        action: 'connect',
        varName,
        accountId: entry.account_id ?? '(unknown)',
        keyPrefix: value.slice(0, 8),
      });
      if (!ok) {
        console.log('  Cancelled.');
        process.exit(0);
      }
    }

    await writeAndSync(ctx, varName, value, { push: !opts.noPush, connector: entry });

    console.log('');
    if (opts.noPush) {
      console.log(`  ✓ wrote ${B(varName)} to .env (encrypted, not pushed).`);
      console.log(`  Run ${B('capy push')} to share with teammates.`);
    } else {
      console.log(`  ✓ ${B(varName)} written, encrypted, and pushed (branch: ${ctx.branch}).`);
    }
    console.log('');
  }
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

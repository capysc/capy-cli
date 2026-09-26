import { resolveContext, writeAndSync, writeImportOutcome, listManagedKeys, ResolvedContext } from './connectors/shared';
import { listProviders, loadProvider, ConnectOpts, ConnectorModule, ConnectResult } from './connectors/registry';
import { connectPlan } from './connectors/plans';
import { isInteractive } from '../ui/interactive';
import { ProjectManager } from '../core/projectManager';
import { resolveOrgContext } from '../core/orgContext';
import { confirmLiveActionInBrowser } from '../ui/connectScreens';
import type { DiscoveryContext } from './connectors/dokployDiscovery';
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
/** Managed-variable counts per provider, on the active branch. `{}` on any failure (see `describeConnectors`'s own doc) — never partial. */
function computeManagedCounts(): Record<string, number> {
  try {
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    const branch = pm.deriveActiveBranch();
    if (!keep || !branch) return {};
    return listManagedKeys(keep, branch).reduce<Record<string, number>>(
      (acc, { connector }) => ({ ...acc, [connector.provider]: (acc[connector.provider] ?? 0) + 1 }),
      {},
    );
  } catch {
    return {};
  }
}

export async function describeConnectors(): Promise<ConnectorChoice[]> {
  const managed = computeManagedCounts();
  return Promise.all(
    listProviders().map(async (p) => {
      const mod = await loadProvider(p.name);
      const found = mod.toolInstalled ? mod.toolInstalled() : undefined;
      return {
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
      };
    }),
  );
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

/**
 * Discovery's own context — org + auth + serviceClient, exactly what
 * `resolveOrgContext` already gives org-level commands (`invite`, `kick`,
 * the system store) that don't require a project either. Deliberately NOT
 * `resolveContext()`: that function exits "No keep.lock found" outside an
 * already-initialized project, and requires a project key + `.env` decrypt
 * neither of which discovery's PLAN phase needs — a discovered folder only
 * resolves its own project key during APPLY, once that folder's project is
 * known to exist (see `DiscoveryApplyDeps.ensureProject`).
 */
async function resolveDiscoveryContext(devMode: boolean): Promise<DiscoveryContext> {
  const { orgId, userId, authService, serviceClient } = await resolveOrgContext(undefined, devMode);
  return { orgId, userId, authService, serviceClient };
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
   * Loads the named connector, or — under `--web` with an unknown provider —
   * lets the browser picker choose a real one and finishes the WHOLE command
   * from there, which is why the failure path returns a `shortCircuit`
   * carrying `execute`'s own result rather than just a module.
   */
  private async resolveProviderOrShortCircuit(
    provider: string,
    opts: ConnectOpts,
  ): Promise<{ kind: 'ok'; mod: ConnectorModule } | { kind: 'shortCircuit'; result: { linked: boolean } }> {
    try {
      return { kind: 'ok', mod: await loadProvider(provider) };
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
          return { kind: 'shortCircuit', result: await this.execute(picked, opts) };
        }
      }
      console.error(`\n  ${(err as Error).message}`);
      console.error('  Run `capy connect` to see available providers.\n');
      process.exit(1);
    }
  }

  /**
   * `writeAndSync`, mapped down to the two states `execute`'s ending needs: a
   * push that fails after the local write leaves `.env` holding a key nobody
   * else has, which is a different next move than a clean write, so the
   * outcome (and, on failure, the detail string) come back rather than being
   * assigned onto a variable the try/catch closes over.
   */
  private async writeConnectResult(
    ctx: ResolvedContext,
    opts: ConnectOpts,
    result: Pick<ConnectResult, 'varName' | 'value' | 'entry' | 'also'>,
  ): Promise<{ outcome: ConnectOutcome; detail?: string }> {
    const initialOutcome: ConnectOutcome = opts.noPush ? 'local-only' : 'pushed';
    try {
      await writeAndSync(ctx, result.varName, result.value, {
        push: !opts.noPush,
        connector: result.entry,
        alsoConnect: result.also,
      });
      return { outcome: initialOutcome };
    } catch (err) {
      if (!opts.web) throw err;
      return {
        outcome: opts.noPush ? 'write-failed' : 'push-failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
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

    const resolved = await this.resolveProviderOrShortCircuit(provider, opts);
    if (resolved.kind === 'shortCircuit') return resolved.result;
    const mod = resolved.mod;

    if (mod.precheck) mod.precheck();

    // Discovery mode (CAP-657 follow-up, `dokploy` only): finds every
    // matching Dokploy service itself rather than importing one named id.
    // Checked BEFORE `resolveContext()` below, not after: `resolveContext`
    // exits "No keep.lock found" outside an already-initialized project, but
    // discovery's whole point is running from exactly the opposite — an
    // uninitialized clone, or a parent folder of several repos, neither of
    // which has (or needs) a keep.lock yet. Discovery gets its OWN, lighter
    // context instead: org + auth + serviceClient only, no project key, no
    // `.env` decrypt — see `resolveDiscoveryContext`'s own doc.
    if (effective.discover && mod.discover) {
      const discoveryCtx = await resolveDiscoveryContext(this.devMode);
      return await this.executeDiscovery(mod, provider, discoveryCtx, effective);
    }

    const ctx = await resolveContext({ devMode: this.devMode });

    // Import-kind connectors (CAP-662: `dokploy`) pull MANY variables in one
    // run rather than linking one existing one, so they skip the var-picking
    // and live-mode questions below entirely — they never apply to a pull.
    if (mod.kind === 'import') {
      return await this.executeImport(mod, provider, ctx, effective);
    }

    const { varName, value, entry, also } = await mod.connect(ctx, effective);

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
        });
        return { linked: false };
      }
    }

    // A push that fails after the local write leaves .env holding a key nobody
    // else has, and the terminal reports that as a stack trace. The two states
    // need different next moves, so the browser result names which one happened.
    const { outcome, detail } = await this.writeConnectResult(ctx, opts, { varName, value, entry, also });

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
      });
    }

    // `process.exitCode`, never `process.exit`. The failure endings above are
    // only reachable under `--web` (without it the throw propagates), and the
    // page explaining them is served from this process — an exit here is what
    // made "the push did not land" a page nobody could open. The code is
    // delivered when the loop drains, which is after the browser has the page.
    if (failed) process.exitCode = 1;
    return { linked: !failed };
  }

  /**
   * `capy connect <import-connector>` — pulls the provider's variables into
   * `.env` in one pass, then reports. No browser ending page exists for this
   * yet (no screen has been built for an import run); `--json` and the
   * terminal are the only two surfaces today.
   *
   * Names and codes only, everywhere — never a value. `outcome.imported`
   * carries the actual values (needed for the write below); every printed or
   * JSON line below maps it down to `.varName` before it is ever rendered.
   */
  private async executeImport(
    mod: ConnectorModule,
    provider: string,
    ctx: ResolvedContext,
    opts: ConnectOpts,
  ): Promise<{ linked: boolean }> {
    const outcome = await mod.import!(ctx, opts);

    if (!outcome.ok) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, code: outcome.code, message: outcome.message }));
      } else {
        console.error(`\n  ${outcome.message}\n`);
      }
      process.exitCode = 1;
      return { linked: false };
    }

    // Vince's rule: a dry run changes nothing. Under `opts.dryRun`,
    // `outcome.imported`/`outcome.cleared` are a PLAN (what a real run
    // WOULD import/clear) — never actually written, locally or to Capy.
    const dryRun = !!opts.dryRun;

    // Under `--json`, stdout must be exactly one JSON object — the
    // "keep.lock committed" line autoCommitKeep would otherwise print goes
    // to stderr instead (see autoCommitKeep.ts's `quiet` option).
    const { wrote } = await writeImportOutcome(ctx, outcome, { push: !opts.noPush, quiet: opts.json, dryRun });
    const pushed = !opts.noPush && wrote;
    const cleared = outcome.cleared ?? [];
    const hasChange = outcome.imported.length > 0 || cleared.length > 0;

    if (opts.json) {
      console.log(
        JSON.stringify({
          ok: true,
          dryRun,
          provider,
          ...(outcome.source ? { source: outcome.source } : {}),
          // Additive, application-only back-compat — see `ImportOutcome.applicationId`.
          ...(outcome.applicationId !== undefined ? { applicationId: outcome.applicationId } : {}),
          imported: outcome.imported.map((e) => e.varName),
          ...(outcome.replacedNames ? { replacedNames: outcome.replacedNames } : {}),
          ...(outcome.cleared ? { cleared: outcome.cleared } : {}),
          unchanged: outcome.unchanged,
          ...(outcome.wouldAsk ? { wouldAsk: outcome.wouldAsk } : {}),
          skipped: outcome.skipped,
          warnings: outcome.warnings,
          pushed,
          deployTargetSaved: outcome.deployTargetSaved,
        }),
      );
      return { linked: wrote };
    }

    console.log('');
    if (dryRun) console.log('  Dry run — nothing written.');
    if (!hasChange) {
      console.log(dryRun ? '  Nothing to import.' : '  Nothing new to import.');
    } else if (dryRun) {
      if (outcome.imported.length > 0) {
        console.log(`  Would import ${outcome.imported.map((e) => B(e.varName)).join(', ')} from Dokploy.`);
      }
      if (cleared.length > 0) {
        console.log(`  Would clear: ${cleared.join(', ')}`);
      }
    } else {
      if (outcome.imported.length > 0) {
        console.log(
          `  ✓ Imported ${outcome.imported.map((e) => B(e.varName)).join(', ')} from Dokploy` +
            `${pushed ? ' and pushed' : ' (not pushed)'}.`,
        );
      } else {
        console.log(`  ✓ Cleared from Dokploy${pushed ? ' and pushed' : ' (not pushed)'}.`);
      }
      if (cleared.length > 0) {
        console.log(`  Cleared: ${cleared.join(', ')}`);
      }
    }
    if (outcome.replacedNames && outcome.replacedNames.length > 0) {
      console.log(`  Replaced: ${outcome.replacedNames.join(', ')}`);
    }
    if (outcome.unchanged.length > 0) {
      console.log(`  Unchanged (already matched locally): ${outcome.unchanged.join(', ')}`);
    }
    if (outcome.wouldAsk && outcome.wouldAsk.length > 0) {
      console.log(`  Conflicts (would ask): ${outcome.wouldAsk.join(', ')}`);
    }
    if (outcome.skipped.length > 0) {
      console.log(`  Skipped: ${outcome.skipped.map((s) => `${s.name} (${s.code})`).join(', ')}`);
    }
    for (const w of outcome.warnings) {
      console.log(`  ⚠ ${w.code}: ${w.names.join(', ')}`);
    }
    if (outcome.deployTargetSaved) {
      console.log(`  Saved a Dokploy deploy target for application ${outcome.applicationId}.`);
    }
    console.log('');
    return { linked: wrote };
  }

  /**
   * `capy connect dokploy --discover` (CAP-657 follow-up) — reports the plan
   * (names/counts only, never a value), then — for a real, confirmed,
   * non-empty run — what was actually written. No browser ending page exists
   * for this yet, same as `executeImport`.
   */
  private async executeDiscovery(
    mod: ConnectorModule,
    provider: string,
    ctx: DiscoveryContext,
    opts: ConnectOpts,
  ): Promise<{ linked: boolean }> {
    const outcome = await mod.discover!(ctx, opts);

    if (!outcome.ok) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, code: outcome.code, message: outcome.message }));
      } else {
        console.error(`\n  ${outcome.message}\n`);
      }
      process.exitCode = 1;
      return { linked: false };
    }

    const planForOutput = {
      ...(outcome.plan.environmentFilter ? { environmentFilter: outcome.plan.environmentFilter } : {}),
      folders: outcome.plan.folders.map((f) => ({
        repoDir: f.repoDir,
        folder: f.folder || '.',
        dokployProject: f.projectName,
        service: f.serviceName,
        initialized: f.initialized,
        ...(f.mergedServices
          ? { mergedServices: f.mergedServices.map((m) => ({ dokployProject: m.projectName, service: m.serviceName, branches: m.environmentNames })) }
          : {}),
        environments: f.environments.map((e) => ({
          branch: e.environmentName,
          variableCount: e.variableCount,
          skippedCount: e.skippedCount,
          // Preview only (see `DiscoveryPlanEnv.branchExists`'s own doc) —
          // undefined for an uninitialized folder, where it isn't knowable
          // yet. The real run always re-checks for itself regardless.
          ...(e.branchExists !== undefined ? { branchExists: e.branchExists } : {}),
          willAutoOverwrite: e.willAutoOverwrite,
        })),
      })),
      collisions: outcome.plan.collisions.map((c) => ({
        folder: c.folder || '.',
        branch: c.environmentName,
        candidates: c.candidates.map((cand) => `${cand.projectName}/${cand.serviceName}`),
      })),
      unmatched: outcome.plan.unmatched.map((u) => ({
        dokployProject: u.projectName,
        service: u.serviceName,
        reason: u.reason,
      })),
      // Repos git itself refused to read (e.g. "dubious ownership") — shown
      // PROMINENTLY: a repo here means every one of its services silently
      // would have come back `no_remote_match` before this defect fix.
      unreadableRepos: outcome.plan.unreadableRepos.map((r) => ({ repoDir: r.repoDir, code: r.code, message: r.message })),
    };
    const appliedForOutput = outcome.applied?.map((f) =>
      f.ok
        ? {
            repoDir: f.repoDir,
            folder: f.folder || '.',
            ok: true as const,
            projectCreated: f.projectCreated,
            activeBranch: f.activeBranch,
            environments: f.environments.map((e) => ({
              branch: e.environmentName,
              branchCreated: e.branchCreated,
              overwrote: e.overwrote,
              imported: e.outcome.imported.map((i) => i.varName),
              ...(e.outcome.replacedNames ? { replacedNames: e.outcome.replacedNames } : {}),
              ...(e.outcome.cleared ? { cleared: e.outcome.cleared } : {}),
              unchanged: e.outcome.unchanged,
              skipped: e.outcome.skipped,
            })),
          }
        : {
            repoDir: f.repoDir,
            folder: f.folder || '.',
            ok: false as const,
            code: f.code,
            message: f.message,
            environments: f.environments.map((e) => ({
              branch: e.environmentName,
              branchCreated: e.branchCreated,
              overwrote: e.overwrote,
              imported: e.outcome.imported.map((i) => i.varName),
              ...(e.outcome.replacedNames ? { replacedNames: e.outcome.replacedNames } : {}),
              ...(e.outcome.cleared ? { cleared: e.outcome.cleared } : {}),
              unchanged: e.outcome.unchanged,
              skipped: e.outcome.skipped,
            })),
          },
    );
    const commitsForOutput = outcome.commits?.map((c) =>
      c.ok
        ? c.dryRun
          ? { repoDir: c.repoDir, ok: true as const, dryRun: true as const, branch: c.branch, wouldCommitFiles: c.wouldCommitFiles }
          : { repoDir: c.repoDir, ok: true as const, dryRun: false as const, branch: c.branch, sha: c.sha, committedFiles: c.committedFiles }
        : { repoDir: c.repoDir, ok: false as const, code: c.code, message: c.message },
    );
    const linked =
      !!outcome.applied &&
      outcome.applied.some((f) =>
        f.environments.some((e) => e.outcome.imported.length > 0 || (e.outcome.cleared?.length ?? 0) > 0),
      );
    // A per-folder failure still lets the OTHER folders' steps run (see
    // `runDiscoverySequences`) — but the run as a whole did not fully
    // succeed, so CI watching the exit code still sees it.
    if (outcome.applied?.some((f) => !f.ok)) process.exitCode = 1;

    if (opts.json) {
      console.log(
        JSON.stringify({
          ok: true,
          provider,
          dryRun: outcome.dryRun,
          cancelled: !!outcome.cancelled,
          plan: planForOutput,
          ...(appliedForOutput ? { applied: appliedForOutput } : {}),
          ...(commitsForOutput ? { commits: commitsForOutput } : {}),
        }),
      );
      return { linked };
    }

    console.log('');
    const filterNote = planForOutput.environmentFilter ? ` (--environment ${planForOutput.environmentFilter.join(',')})` : '';
    console.log(outcome.dryRun ? `  Dry run — nothing written.${filterNote}` : `  Discovery plan:${filterNote}`);
    if (planForOutput.unreadableRepos.length > 0) {
      // Shown BEFORE the folders — a repo git itself refused to read means
      // every one of its services would otherwise silently look unmatched.
      console.log('  ⚠ Repos git could not read:');
      for (const r of planForOutput.unreadableRepos) {
        console.log(`    ${r.repoDir} (${r.code}): ${r.message}`);
      }
    }
    if (planForOutput.folders.length === 0) {
      console.log('  No matching Dokploy services found.');
    }
    for (const f of planForOutput.folders) {
      console.log(`  ${B(f.folder)}  (${f.dokployProject} / ${f.service})${f.initialized ? '' : ' — capy (init)'}`);
      for (const m of f.mergedServices ?? []) {
        console.log(`    + ${m.dokployProject} / ${m.service} → ${f.folder} (branch ${m.branches.join(', ')})`);
      }
      for (const e of f.environments) {
        const checkoutCmd = e.branchExists === true ? `checkout ${e.branch}` : `checkout -b ${e.branch}`;
        console.log(
          `    ${checkoutCmd}: ${e.variableCount} var(s), ${e.skippedCount} skipped${e.willAutoOverwrite ? ' [auto-overwrite]' : ''}`,
        );
      }
    }
    if (planForOutput.collisions.length > 0) {
      console.log('  Collisions:');
      for (const c of planForOutput.collisions) {
        console.log(`    ${c.folder} / ${c.branch}: ${c.candidates.join(', ')}`);
      }
    }
    if (planForOutput.unmatched.length > 0) {
      console.log('  Unmatched:');
      for (const u of planForOutput.unmatched) {
        console.log(`    ${u.dokployProject} / ${u.service} (${u.reason})`);
      }
    }
    if (outcome.cancelled) {
      console.log('  Cancelled — nothing written.');
    } else if (appliedForOutput) {
      for (const f of appliedForOutput) {
        console.log(`  ${B(f.folder)}${f.ok && f.projectCreated ? ' (new project)' : ''}`);
        for (const e of f.environments) {
          const clearedCount = e.cleared?.length ?? 0;
          console.log(
            `    ${e.branch}${e.branchCreated ? ' (new branch)' : ''}${e.overwrote ? ' (--overwrite)' : ''}: ` +
              `imported ${e.imported.length}, unchanged ${e.unchanged.length}, skipped ${e.skipped.length}` +
              (clearedCount > 0 ? `, cleared ${clearedCount}` : ''),
          );
        }
        if (!f.ok) {
          console.log(`    ✗ ${f.code}: ${f.message}`);
        } else if (f.activeBranch) {
          // Names only — which branch the folder's LOCAL .env/.capy/branch
          // ended on (Vince: "folder is on branch X").
          console.log(`    folder is on branch ${f.activeBranch}`);
        }
      }
    }
    if (commitsForOutput && commitsForOutput.length > 0) {
      console.log('  Commit:');
      for (const c of commitsForOutput) {
        if (!c.ok) {
          console.log(`    ${c.repoDir}: ✗ ${c.code}: ${c.message}`);
        } else if (c.dryRun) {
          console.log(`    ${c.repoDir}: would commit ${c.wouldCommitFiles.length} file(s) onto ${c.branch}`);
        } else {
          console.log(`    ${c.repoDir}: committed ${c.committedFiles.length} file(s) onto ${c.branch} (${c.sha.slice(0, 8)})`);
        }
      }
    }
    console.log('');
    return { linked };
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

import { resolveContext, writeAndSync, writeImportOutcome, ResolvedContext } from './connectors/shared';
import { listProviders, loadProvider, ConnectOpts, ConnectorModule } from './connectors/registry';
import { EXIT_NEEDS_INPUT, isInteractive } from '../ui/interactive';
import { resolveOrgContext } from '../core/orgContext';
import type { DiscoveryContext } from './connectors/dokployDiscovery';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** A refusal that only a flag (or a person) can answer exits `EXIT_NEEDS_INPUT`, so an agent branches on it; every other refusal exits 1. */
function exitCodeForRefusalCode(code: string): number {
  return code === 'DOKPLOY_SETTINGS_MISSING' ? EXIT_NEEDS_INPUT : 1;
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

  /** `capy connect` with no provider: prints the catalogue and stops. */
  async list(): Promise<void> {
    console.log('');
    console.log('  Available connectors:');
    for (const p of listProviders()) {
      console.log(`    ${B(p.name).padEnd(20)} ${p.description}`);
    }
    console.log('');
  }

  /** Loads the named connector; an unknown provider exits 1 with a pointer back to the catalogue. */
  private async resolveProvider(provider: string): Promise<ConnectorModule> {
    try {
      return await loadProvider(provider);
    } catch (err) {
      console.error(`\n  ${(err as Error).message}`);
      console.error('  Run `capy connect` to see available providers.\n');
      process.exit(1);
    }
  }

  /**
   * Returns whether the link was actually recorded.
   *
   * A caller that has more journey after this one — `capy rotate` promoting an
   * unmanaged variable — has to know whether to carry on, and the honest
   * signal is a return value rather than re-reading keep.lock and inferring it.
   * Every path that ends in `process.exit` never returns at all.
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

    const mod = await this.resolveProvider(provider);

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
      // Discover mode (Vince, 2026-10-03): ALWAYS prints exactly what
      // `--json` prints, in a terminal or not, and never prompts — every
      // choice comes from flags (`--base-url`, `--yes`, …) or is refused
      // with a code.
      const discoveryOpts: ConnectOpts = { ...effective, json: true, nonTty: true };
      const discoveryCtx = await resolveDiscoveryContext(this.devMode);
      return await this.executeDiscovery(mod, provider, discoveryCtx, discoveryOpts);
    }

    const ctx = await resolveContext({ devMode: this.devMode, dryRun: effective.dryRun === true });

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
    // proof. The typed confirmation only runs in an interactive terminal.
    if (!this.devMode && entry.mode === 'live' && isInteractive(opts.nonTty)) {
      const ok = await confirmLiveAction({
        action: 'connect',
        varName,
        accountId: entry.account_id ?? '(unknown)',
        keyPrefix: entry.key_prefix ?? '(unknown)',
      });
      if (!ok) {
        console.log('  Cancelled.');
        // Nothing was written, and the command is over.
        process.exit(0);
      }
    }

    await writeAndSync(ctx, varName, value, {
      push: !opts.noPush,
      connector: entry,
      alsoConnect: also,
    });

    console.log('');
    if (opts.noPush) {
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

    return { linked: true };
  }

  /**
   * `capy connect <import-connector>` — pulls the provider's variables into
   * `.env` in one pass, then reports (`--json` or the terminal).
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
        console.log(
          JSON.stringify({
            ok: false,
            code: outcome.code,
            message: outcome.message,
            ...(outcome.unanswered === undefined ? {} : { unanswered: outcome.unanswered }),
          }),
        );
      } else {
        console.error(`\n  ${outcome.message}`);
        // The refusal says what is still needed, as flags: print each hint beside it.
        (outcome.unanswered ?? []).forEach((u) => console.error(`  ${u.flag}: ${u.hint}`));
        console.error('');
      }
      process.exitCode = exitCodeForRefusalCode(outcome.code);
      return { linked: false };
    }

    // Vince's rule: a dry run changes nothing. Under `opts.dryRun`,
    // `outcome.imported`/`outcome.cleared` are a PLAN (what a real run
    // WOULD import/clear) — never actually written, locally or to Capy.
    const dryRun = !!opts.dryRun;

    // Under `--json`, stdout must be exactly one JSON object.
    // `writeImportOutcome` never auto-commits keep.lock and never prints
    // anything itself, so there is nothing left for a `quiet` flag to
    // suppress here.
    const { wrote } = await writeImportOutcome(ctx, outcome, { push: !opts.noPush, dryRun });
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
    console.log('');
    return { linked: wrote };
  }

  /**
   * `capy connect dokploy --discover` (CAP-657 follow-up) — reports the plan
   * (names/counts only, never a value), then — for a real, confirmed,
   * non-empty run — what was actually written.
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
        console.log(
          JSON.stringify({
            ok: false,
            code: outcome.code,
            message: outcome.message,
            ...(outcome.unanswered === undefined ? {} : { unanswered: outcome.unanswered }),
          }),
        );
      } else {
        console.error(`\n  ${outcome.message}\n`);
      }
      process.exitCode = exitCodeForRefusalCode(outcome.code);
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
              warnings: e.outcome.warnings,
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
              warnings: e.outcome.warnings,
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
          ...(outcome.saved === undefined ? {} : { saved: outcome.saved }),
          ...(outcome.notices === undefined ? {} : { notices: outcome.notices }),
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
          for (const w of e.warnings) {
            console.log(`      ⚠ ${w.code}: ${w.names.join(', ')}`);
          }
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

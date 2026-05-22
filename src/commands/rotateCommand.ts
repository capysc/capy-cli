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

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class RotateCommand {
  private devMode: boolean;

  constructor(devMode: boolean = false) {
    this.devMode = devMode;
  }

  async execute(varName: string | undefined, opts: RotateOpts & { all?: boolean }): Promise<void> {
    const pm = new ProjectManager();
    const keep = pm.readKeepFile();
    const branch = pm.readActiveBranch();

    if (!keep) {
      console.error('\n  No keep.lock found. Run `capy` first to initialize.\n');
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
      await this.rotateMany(managed, opts);
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

    await this.rotateMany([target], opts);
  }

  /**
   * Unmanaged var picked for rotation → prompt for an integration and
   * delegate to ConnectCommand. That flow fetches a fresh key from the
   * provider, overwrites the existing value, and tags the keep.lock entry
   * as connector-managed for future rotations.
   */
  private async promoteAndConnect(varName: string, opts: RotateOpts): Promise<void> {
    const providers = listProviders();
    if (providers.length === 0) {
      console.error('\n  No connectors are registered. Cannot promote.\n');
      process.exit(1);
    }

    console.log('');
    console.log(`  ${B(varName)} isn't connected to a third-party integration yet.`);
    console.log('  Pick one and Capy will rotate it via the provider from here on.');
    console.log('');

    const inquirer = (await import('inquirer')).default;
    const { provider } = await inquirer.prompt([
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

    if (provider === '__cancel__') {
      console.log('\n  Cancelled.\n');
      return;
    }

    const connect = new ConnectCommand(this.devMode);
    await connect.execute(provider, {
      var: varName,
      force: true,
      noPush: opts.noPush,
    });
  }

  /**
   * Rotate one or more already-managed keys. Live-mode firewall in dev,
   * provider preflight, per-rotation confirmation in prod live mode.
   */
  private async rotateMany(
    targets: Array<{ varName: string; connector: ConnectorMetadata }>,
    opts: RotateOpts & { all?: boolean },
  ): Promise<void> {
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
        if (!this.devMode && connector.mode === 'live') {
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

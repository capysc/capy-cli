/**
 * `capy push` — save this folder's changes to Keep.
 *
 * Bare `capy` is the one place a folder's changes meet Capy's (docs/conflict-resolution.md): it compares the
 * folder's `keep.lock` (pinned), its `.env` (local) and Capy's latest (remote), shows every difference, and
 * "Commit and push all local values" is the push. So `capy push` IS bare `capy`'s sync, run as the first step it
 * always is, and then there is nothing of its own left to apply: the folder and Capy agree.
 *
 * Off a terminal (`--non-tty`, an agent, CI) the differences are reported with a `conflict_id` and the rerun's
 * `--resolve NAME=local` pushes them; there is no push-everything flag.
 */
import { isLocalOnly } from '../config/profileConfig';
import { gateFirst, type GateOptions } from '../sync/gate';
import { conflictFlagsOrExit, type RawConflictFlags } from '../sync/conflicts';
import { printExpiryWarnings, resolveContext } from './connectors/shared';

export interface PushOpts {
  /** Treat stdin as not a terminal even when it is one: the differences are then reported, not asked. */
  nonTty?: boolean;
  /** `--resolve` / `--conflict` as typed (CAP-717). */
  conflictFlags?: RawConflictFlags;
}

export class PushCommand {
  private devMode: boolean;

  constructor(devMode: boolean = false) {
    this.devMode = devMode;
  }

  async execute(opts: PushOpts = {}): Promise<void> {
    // A bad --resolve / --conflict is refused before anything is read or authenticated.
    conflictFlagsOrExit(opts.conflictFlags ?? {}, false);
    const gate: GateOptions = { devMode: this.devMode, nonTty: opts.nonTty, conflictFlags: opts.conflictFlags };
    // Bare `capy` is the push. (A failure of the sync itself ends the command inside the gate, with its code.)
    await gateFirst(gate);
    try {
      // CAP-697: report which repo/folder holds this keep.lock (never blocks past its budget). Local-only mode has no server.
      if (!isLocalOnly()) await resolveContext({ devMode: this.devMode, gate });

      printExpiryWarnings();
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      await displayErrorAndExit(error);
    }
  }
}

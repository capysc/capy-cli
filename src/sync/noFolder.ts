/**
 * Writes with no folder (CAP-717; docs/conflict-resolution.md, "Commands with no folder"): `capy secrets set`, the
 * `capy secrets` edit screens and the batch deploy write straight to Capy, so there is no `keep.lock`, no `.env`
 * and no bare `capy` to run first. For each value written the SAME three versions are compared with
 * `compareSecrets`:
 *
 *   pinned = the fingerprint the row listed (the value the person was shown),
 *   local  = the value being written,
 *   remote = what Capy holds at that location now.
 *
 * Capy unchanged since it was shown (remote = pinned), or already holding the new value, needs no decision: the
 * value is written (or there is nothing to write). Capy moved since it was shown to something else is a row with
 * the same four choices as bare `capy`, answered before anything is written:
 *
 *   local  → write the new value over it,
 *   remote → leave that location as it is (keep Capy's latest),
 *   pinned → write back the value the person was shown. The listing holds its fingerprint only, so the caller supplies the
 *            plaintext: the edit screen has it decrypted; the CLI reads it from another location of the same row that still
 *            holds that fingerprint. Not recoverable: refused with `SECRETS_RESOLVE_INVALID`, never guessed,
 *   delete → remove the variable at that location (through the shared upload).
 *
 * Fingerprints only, never a value.
 */
import { CapyError, ERROR_CODES } from '../types/index';
import { compareSecrets } from './compareSecrets';
import { sourceRowsOf, type ConflictView, type Resolution, type SourceConflict } from './conflicts';

/** One value about to be written at one location. */
export interface WriteComparison {
  readonly name: string;
  readonly project: string;
  readonly branch: string;
  /** The fingerprint the row listed: the value the person was shown (`undefined`: none). */
  readonly shown: string | undefined;
  /** The fingerprint of the new value. */
  readonly local: string;
  /** The fingerprint of what the location holds now (`undefined`: the location no longer has the variable). */
  readonly remote: string | undefined;
  /** The server's keep hash for the branch at that read: what the `conflict_id` binds. */
  readonly serverKeepHash: string;
}

/** A name `compareSecrets` is given so that "Capy has data" is true even when the location lost the variable. */
const PRESENT = '\u0000present';

/**
 * The row for this write, or `undefined` when no decision is needed (the location is as it was shown, or already
 * holds the new value). Decided by `compareSecrets` over the three fingerprints.
 */
export function movedRow(w: WriteComparison): SourceConflict | undefined {
  const { diffs } = compareSecrets(
    w.shown === undefined ? {} : { [w.name]: w.shown },
    { [w.name]: w.local },
    w.remote === undefined ? { [PRESENT]: '' } : { [w.name]: w.remote },
  );
  const row = diffs.find((d) => d.variable === w.name);
  if (row === undefined || row.remote === row.pinned || row.remote === row.local) return undefined;
  const view: ConflictView = { project: w.project, branch: w.branch, serverKeepHash: w.serverKeepHash };
  return sourceRowsOf([row], view)[0];
}

/** What an answer does at a location. */
export type LocationAction = 'write' | 'leave' | 'restore' | 'remove';

/**
 * `local` writes the new value, `remote` leaves the location as it is, `pinned` writes back the value that was shown
 * (`restore`), `delete` removes the variable there (`remove`). Total: all four of bare `capy`'s choices mean something.
 */
export function actionFor(choice: Resolution): LocationAction {
  if (choice === 'local') return 'write';
  if (choice === 'remote') return 'leave';
  return choice === 'pinned' ? 'restore' : 'remove';
}

/** The refusal for a `pinned` answer whose shown value cannot be recovered here (it would write nothing or guess). Names only. */
export const shownValueUnavailable = (name: string): CapyError =>
  new CapyError(`${name}: the value you were shown cannot be recovered here, so pinned cannot be written back. Answer local, remote or delete.`, ERROR_CODES.SECRETS_RESOLVE_INVALID, { names: [name] }); // COPY-FLAG

/** An answer that holds only for the state it was made against: the location still holds what the person saw. */
export interface BoundAnswer {
  readonly choice: Resolution;
  /** What the location held (`null`: nothing) and what was being written, when the person answered. */
  readonly remote: string | null;
  readonly local: string | null;
}

export const bindAnswer = (choice: Resolution, row: SourceConflict): BoundAnswer => ({ choice, remote: row.remote, local: row.local });

/** Whether `answer` was made against exactly the state `row` describes. */
export const holdsFor = (answer: BoundAnswer | undefined, row: SourceConflict): answer is BoundAnswer =>
  answer !== undefined && answer.remote === row.remote && answer.local === row.local;

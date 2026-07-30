/**
 * The route `capy recover` will travel, computed before anything opens.
 *
 * ONE function, for the reason `branchCreatePlan` gives: the rail a person
 * reads and the array a headless caller would parse have to be the same object,
 * and two builders make that a promise nobody can keep past the first
 * divergence. `capy recover` has no `--json` today; when it grows one, this is
 * what it prints.
 *
 * The route matters more here than on most commands because `recover` is five
 * questions deep and the terminal announces none of them. You sign in, you are
 * asked which organization, and then — only if this device already holds a key
 * for the one you picked — a destructive confirm appears that nothing warned
 * you about. Drawing the whole route first is what turns that ambush into a
 * station you could see coming.
 *
 * Two of the stops carry a modifier the base `Stop` does not:
 *
 *   manual  the sign-in is a browser tab the user finishes themselves, so its
 *           track is dotted — but only while it is still theirs to finish. A
 *           sign-in already `done` is history, and dotted track over history
 *           says "over to you" about something that is not.
 *   blank   the overwrite gate exists only if the organization you pick
 *           already holds a key on this device. Until the organization stop
 *           settles that, it is a blank the plan still needs an answer for —
 *           drawn ◌ rather than left out, because a stop that appears
 *           mid-flow is exactly what this rail exists to prevent.
 */
import type { RecoverMasterKeyStop } from '../ui/screens/contract';

export interface RecoverPlanInput {
  /**
   * The session this run signed in with. `recover` authenticates before it
   * asks anything — silently if it can, with a browser tab if it cannot — so
   * by the time a screen is served this is true.
   */
  signedIn: boolean;
  /** Who it signed in as, shown on the finished sign-in stop. */
  userEmail?: string;
  /** The organization chosen at the org stop. Empty until one is. */
  orgName?: string;
  /**
   * Whether the CHOSEN organization already holds a wrapped key on this
   * device. `undefined` while no organization has been chosen: the overwrite
   * gate is a blank the org stop fills in, not a stop the plan can commit to.
   */
  hasKeyOnThisDevice?: boolean;
  /** The overwrite gate has been agreed to. */
  overwriteAgreed?: boolean;
  /**
   * A phrase has been entered and accepted as well-formed. Set on the fork
   * where the trial decryption could not run, which is the only state in which
   * the run stands at the write stop with a screen still open.
   */
  phraseEntered?: boolean;
  /**
   * How many words this run expects. The rail counts them, and the field
   * builds that many boxes from the same number — so it is the command's, and
   * never hardcoded in either surface.
   */
  wordCount: number;
}

export function recoverPlan(input: RecoverPlanInput): RecoverMasterKeyStop[] {
  const orgAnswered = typeof input.orgName === 'string' && input.orgName.trim() !== '';
  // The gate is only real for an organization this device already holds a key
  // for. `false` strikes the stop out; `undefined` leaves it blank.
  const gateOpen = input.hasKeyOnThisDevice === true && input.overwriteAgreed !== true;
  const pastGate = orgAnswered && !gateOpen;

  const auth: RecoverMasterKeyStop = input.signedIn
    ? {
        id: 'auth',
        label: 'Sign in',
        state: 'done',
        detail: 'so Capy knows which organizations you can reach',
        answer: input.userEmail,
      }
    : {
        id: 'auth',
        label: 'Sign in',
        state: 'current',
        detail: 'so Capy knows which organizations you can reach',
        manual: true,
      };

  const organization: RecoverMasterKeyStop = orgAnswered
    ? {
        id: 'organization',
        label: 'Organization',
        state: 'done',
        // The CLI's own question, shortened to a station label. Never
        // inherited from keep.lock: that is the bug `recover` exists to undo.
        detail: 'which organization this recovery phrase is for',
        answer: input.orgName!.trim(),
      }
    : {
        id: 'organization',
        label: 'Organization',
        state: input.signedIn ? 'current' : 'upcoming',
        detail: 'which organization this recovery phrase is for',
      };

  const overwriteDetail = 'replace the wrapped key this device already holds';
  let overwrite: RecoverMasterKeyStop;
  if (input.hasKeyOnThisDevice === undefined) {
    overwrite = {
      id: 'overwrite',
      label: 'Overwrite',
      state: 'upcoming',
      detail: overwriteDetail,
      blank: true,
    };
  } else if (!input.hasKeyOnThisDevice) {
    // Nothing on this device to destroy, so this run never visits the stop —
    // and the rail says so rather than quietly dropping a station.
    overwrite = { id: 'overwrite', label: 'Overwrite', state: 'skipped', detail: overwriteDetail };
  } else if (input.overwriteAgreed) {
    overwrite = {
      id: 'overwrite',
      label: 'Overwrite',
      state: 'done',
      detail: overwriteDetail,
      answer: 'replace it',
    };
  } else {
    overwrite = {
      id: 'overwrite',
      label: 'Overwrite',
      state: orgAnswered ? 'current' : 'upcoming',
      detail: overwriteDetail,
    };
  }

  const phrase: RecoverMasterKeyStop = {
    id: 'phrase',
    label: 'Recovery phrase',
    state: input.phraseEntered ? 'done' : pastGate ? 'current' : 'upcoming',
    detail: `all ${input.wordCount} words`,
  };

  return [
    auth,
    organization,
    overwrite,
    phrase,
    {
      id: 'write',
      label: 'Write the key',
      // Reached with a screen still open only on the fork where the trial
      // decryption could not run and the user is asked to write anyway. On
      // every other run the phrase stop verifies and writes in one move.
      state: input.phraseEntered ? 'current' : 'upcoming',
      detail: 'verify it against this organization’s own ciphertext, then save it here',
    },
  ];
}

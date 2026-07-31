/**
 * The route `capy decrypt` travels, computed before the phrase box opens.
 *
 * Same rule as `branchCreatePlan`: one builder, so the rail a person reads and
 * the array a headless caller parses cannot describe different runs.
 *
 * Two of the three details are per-run and could never be a constant — the
 * phrase stop counts the words this run expects, and the write stop names the
 * file the plaintext lands in. A run with no active branch has no path to
 * name, and that stop then carries no detail rather than an empty one.
 *
 * `phrase` is `skipped`, not dropped, when a recovery session already holds the
 * master key. The terminal skips it silently — it reuses a cached key with no
 * prompt and no mention — and a route that simply omitted the station would
 * make the browser silent in the same way.
 */
import type { SeedPhraseDecryptStop } from '../ui/screens/contract';

export interface DecryptPlanInput {
  /** How many words the phrase step expects. 24 in the CLI; never assumed. */
  wordCount: number;
  /** `.env.{branch}.decrypted`, or null when there is no active branch to name. */
  outputFile: string | null;
  /** An unexpired recovery session already holds the key, so nothing is typed. */
  usingSession: boolean;
  /** The run has written (or refused to write) the file. */
  finished?: boolean;
}

export function decryptPlan(input: DecryptPlanInput): SeedPhraseDecryptStop[] {
  const phrase: SeedPhraseDecryptStop = {
    id: 'phrase',
    label: 'Phrase',
    state: input.finished
      ? input.usingSession
        ? 'skipped'
        : 'done'
      : input.usingSession
        ? 'skipped'
        : 'current',
    detail: `${input.wordCount} words, typed here`,
  };

  const decrypt: SeedPhraseDecryptStop = {
    id: 'decrypt',
    label: 'Decrypt',
    state: input.finished ? 'done' : input.usingSession ? 'current' : 'upcoming',
    detail: 'try each key version against this .env',
  };

  const write: SeedPhraseDecryptStop = {
    id: 'write',
    label: 'Write',
    state: input.finished ? 'done' : 'upcoming',
    // A stop with nothing to say says nothing rather than saying "".
    ...(input.outputFile ? { detail: input.outputFile } : {}),
  };

  return [phrase, decrypt, write];
}

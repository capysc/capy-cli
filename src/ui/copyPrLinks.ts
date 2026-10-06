// The `c` key on the two batch result screens (the deploy result and the edit result): copy the
// PR links shown there to the clipboard. Pure: this file only builds the effect, the outcome and
// the screen line; the screen driver performs the copy (`copyToClipboard`, see `clipboard.ts`).
//
// The links come from the structured result the flow already holds (a PR's url field), never from
// the rendered text, and nothing here branches on a string.

export type CopyEffect = { readonly type: 'copyToClipboard'; readonly text: string };

/** What the last copy did: `ok`, and how many links it held. Absent on the flow until `c` was pressed. */
export interface CopyOutcome {
  readonly ok: boolean;
  readonly count: number;
}

/** The footer's pair for the key; only offered when there is something to copy. */
export const COPY_HINT_PAIR = ['c', 'copy PRs'] as const; // COPY-FLAG

/** The links, once each, in the order they were found. */
export const uniqueUrls = (urls: readonly string[]): readonly string[] => [...new Set(urls)];

export const isCopyKey = (token: string): boolean => token === 'c' || token === 'C';

/** One link per line, nothing else. */
export const copyEffectFor = (urls: readonly string[]): CopyEffect => ({ type: 'copyToClipboard', text: urls.join('\n') });

export const copiedLine = (outcome: CopyOutcome): string =>
  outcome.ok
    ? `Copied ${outcome.count} PR link${outcome.count === 1 ? '' : 's'}` // COPY-FLAG
    : 'Could not copy to clipboard'; // COPY-FLAG

// Generates install scripts for releases that were published before the release
// workflow did it. Pure logic with injected IO; it never uploads anything.
import { InstallScriptError, renderInstallScripts } from './render';

export type BackfillSkipCode =
  | 'BAD_TAG'
  | 'TAG_NOT_FOUND'
  | 'CHECKSUMS_FILE_MISSING'
  | 'CHECKSUMS_FETCH_FAILED'
  | 'BAD_VERSION'
  | 'BAD_COMMIT'
  | 'CHECKSUM_MISSING'
  | 'CHECKSUM_MALFORMED'
  | 'CHECKSUM_CONFLICT'
  | 'PLACEHOLDER_UNFILLED';

export type BackfillOutcome =
  | { readonly tag: string; readonly status: 'written'; readonly files: readonly string[] }
  | { readonly tag: string; readonly status: 'skipped'; readonly code: BackfillSkipCode; readonly detail: string };

export type BackfillDeps = {
  // HTTP status and body of a GET; a network failure rejects.
  readonly fetchText: (url: string) => Promise<{ readonly status: number; readonly text: string }>;
  // The commit a tag points at, or undefined when the tag does not exist.
  readonly resolveCommit: (tag: string) => string | undefined;
  // Writes the two scripts for the tag and returns the paths written.
  readonly writeScripts: (tag: string, scripts: { readonly sh: string; readonly ps1: string }) => readonly string[];
  readonly shTemplate: string;
  readonly ps1Template: string;
};

const TAG_PATTERN = /^v(\d+(\.\d+)+)$/;

export const checksumsUrl = (tag: string, version: string): string =>
  `https://github.com/capysc/capy-cli/releases/download/${tag}/checksums-${version}.txt`;

const skipped = (tag: string, code: BackfillSkipCode, detail: string): BackfillOutcome => ({
  tag,
  status: 'skipped',
  code,
  detail,
});

async function fetchChecksums(
  deps: BackfillDeps,
  tag: string,
  version: string,
): Promise<{ readonly text: string } | BackfillOutcome> {
  try {
    const response = await deps.fetchText(checksumsUrl(tag, version));
    if (response.status === 404) {
      return skipped(tag, 'CHECKSUMS_FILE_MISSING', `no checksums-${version}.txt on the release`);
    }
    if (response.status !== 200) {
      return skipped(tag, 'CHECKSUMS_FETCH_FAILED', `HTTP ${response.status}`);
    }
    return { text: response.text };
  } catch (error) {
    return skipped(tag, 'CHECKSUMS_FETCH_FAILED', error instanceof Error ? error.message : 'network error');
  }
}

export async function backfillTag(deps: BackfillDeps, tag: string): Promise<BackfillOutcome> {
  const match = TAG_PATTERN.exec(tag);
  if (match === null) return skipped(tag, 'BAD_TAG', 'a tag looks like v0.9.7');
  const version = match[1] ?? '';
  const commit = deps.resolveCommit(tag);
  if (commit === undefined) return skipped(tag, 'TAG_NOT_FOUND', 'the tag does not exist in this checkout');
  const fetched = await fetchChecksums(deps, tag, version);
  if (!('text' in fetched)) return fetched;
  try {
    const scripts = renderInstallScripts({
      version,
      commit,
      checksumsText: fetched.text,
      shTemplate: deps.shTemplate,
      ps1Template: deps.ps1Template,
    });
    return { tag, status: 'written', files: deps.writeScripts(tag, scripts) };
  } catch (error) {
    if (error instanceof InstallScriptError) return skipped(tag, error.code, error.message);
    throw error;
  }
}

export function backfillTags(deps: BackfillDeps, tags: readonly string[]): Promise<readonly BackfillOutcome[]> {
  return Promise.all(tags.map((tag) => backfillTag(deps, tag)));
}

export function formatOutcome(outcome: BackfillOutcome): string {
  return outcome.status === 'written'
    ? `${outcome.tag}\twritten\t${outcome.files.join(' ')}`
    : `${outcome.tag}\tskipped\t${outcome.code}\t${outcome.detail}`;
}

// Fills the install script templates with one release's version, source commit
// and archive checksums. Pure functions only: the caller reads and writes files.

export type InstallScriptErrorCode =
  | 'BAD_VERSION'
  | 'BAD_COMMIT'
  | 'CHECKSUM_MISSING'
  | 'CHECKSUM_MALFORMED'
  | 'CHECKSUM_CONFLICT'
  | 'PLACEHOLDER_UNFILLED';

export class InstallScriptError extends Error {
  readonly code: InstallScriptErrorCode;

  constructor(code: InstallScriptErrorCode, message: string) {
    super(message);
    this.name = 'InstallScriptError';
    this.code = code;
  }
}

type ArchiveTarget = {
  readonly placeholder: string;
  readonly archiveName: (version: string) => string;
};

// One entry per published archive. The placeholder is the name used in the templates.
export const ARCHIVE_TARGETS: readonly ArchiveTarget[] = [
  { placeholder: 'SHA256_DARWIN_ARM64', archiveName: (version) => `capy-darwin-arm64-${version}.tar.gz` },
  { placeholder: 'SHA256_DARWIN_X64', archiveName: (version) => `capy-darwin-x64-${version}.tar.gz` },
  { placeholder: 'SHA256_LINUX_X64', archiveName: (version) => `capy-linux-x64-${version}.tar.gz` },
  { placeholder: 'SHA256_LINUX_ARM64', archiveName: (version) => `capy-linux-arm64-${version}.tar.gz` },
  { placeholder: 'SHA256_WIN_X64', archiveName: (version) => `capy-win-x64-${version}.zip` },
];

const VERSION_PATTERN = /^\d+(\.\d+)+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LEFTOVER_PLACEHOLDER_PATTERN = /@@[A-Z0-9_]+@@/g;

type ChecksumEntry = { readonly hash: string; readonly fileName: string };

// A checksum line is `<hash>  <file name>` (text mode) or `<hash> *<file name>` (binary mode).
function parseChecksumLine(line: string): ChecksumEntry | undefined {
  const match = /^(\S+)[ \t]+\*?(\S.*)$/.exec(line.trim());
  if (match === null) return undefined;
  const fileName = (match[2] ?? '').split('/').pop() ?? '';
  return { hash: (match[1] ?? '').toLowerCase(), fileName };
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const entries = text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      const entry = parseChecksumLine(line);
      return entry === undefined ? [] : [entry];
    });
  const conflict = entries.find((entry) =>
    entries.some((other) => other.fileName === entry.fileName && other.hash !== entry.hash),
  );
  if (conflict !== undefined) {
    throw new InstallScriptError('CHECKSUM_CONFLICT', `${conflict.fileName} is listed with different checksums`);
  }
  return new Map(entries.map((entry) => [entry.fileName, entry.hash]));
}

function requiredChecksum(
  checksums: ReadonlyMap<string, string>,
  target: ArchiveTarget,
  version: string,
): readonly [string, string] {
  const fileName = target.archiveName(version);
  const hash = checksums.get(fileName);
  if (hash === undefined) {
    throw new InstallScriptError('CHECKSUM_MISSING', `no checksum listed for ${fileName}`);
  }
  if (!SHA256_PATTERN.test(hash)) {
    throw new InstallScriptError('CHECKSUM_MALFORMED', `checksum for ${fileName} is not 64 hex characters`);
  }
  return [target.placeholder, hash];
}

export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const filled = Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`@@${name}@@`, () => value),
    template,
  );
  const leftover = filled.match(LEFTOVER_PLACEHOLDER_PATTERN);
  if (leftover !== null) {
    throw new InstallScriptError('PLACEHOLDER_UNFILLED', `unfilled placeholder: ${leftover[0]}`);
  }
  return filled;
}

export type RenderInput = {
  readonly version: string;
  readonly commit: string;
  readonly checksumsText: string;
  readonly shTemplate: string;
  readonly ps1Template: string;
};

export type RenderedScripts = { readonly sh: string; readonly ps1: string };

export function renderInstallScripts(input: RenderInput): RenderedScripts {
  const { version, commit, checksumsText, shTemplate, ps1Template } = input;
  if (!VERSION_PATTERN.test(version)) {
    throw new InstallScriptError('BAD_VERSION', `version must be digits and dots: ${version}`);
  }
  if (!COMMIT_PATTERN.test(commit)) {
    throw new InstallScriptError('BAD_COMMIT', 'commit must be 40 lowercase hex characters');
  }
  const checksums = parseChecksums(checksumsText);
  const values: Readonly<Record<string, string>> = {
    VERSION: version,
    COMMIT: commit,
    ...Object.fromEntries(ARCHIVE_TARGETS.map((target) => requiredChecksum(checksums, target, version))),
  };
  return {
    sh: fillTemplate(shTemplate, values),
    ps1: fillTemplate(ps1Template, values),
  };
}

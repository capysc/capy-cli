// Generates install.sh and install.ps1 for releases that have none. Local files
// only: nothing is uploaded.
//
//   bun scripts/install/backfill-release-scripts.ts --out /tmp/backfill v0.9.7 v0.9.8
//
// For each tag it downloads that release's checksums-<version>.txt, resolves the
// tag's commit with `git rev-list -n 1 <tag>`, runs the generator and writes
// <out>/<tag>/install.sh and <out>/<tag>/install.ps1. It prints one line per tag:
// the files written, or a coded reason the tag was skipped.
// Options: --repo <dir> (the checkout holding the tags, default: current dir),
//          --git <path> (git executable, default: git).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BackfillDeps, backfillTags, formatOutcome } from './backfill';

const here = dirname(fileURLToPath(import.meta.url));

const VALUE_FLAGS = ['out', 'repo', 'git'] as const;

type Parsed = { readonly flags: Readonly<Record<string, string>>; readonly tags: readonly string[] };

function parseArgs(argv: readonly string[]): Parsed {
  const flagIndexes = argv.flatMap((arg, index) =>
    arg.startsWith('--') && VALUE_FLAGS.some((name) => name === arg.slice(2)) ? [index, index + 1] : [],
  );
  return {
    flags: Object.fromEntries(
      argv.flatMap((arg, index) => (arg.startsWith('--') ? [[arg.slice(2), argv[index + 1] ?? ''] as const] : [])),
    ),
    tags: argv.filter((_, index) => !flagIndexes.includes(index)),
  };
}

function fail(message: string): never {
  process.stderr.write(`backfill-release-scripts: ${message}\n`);
  return process.exit(1);
}

async function main(): Promise<void> {
  const { flags, tags } = parseArgs(process.argv.slice(2));
  if ((flags.out ?? '') === '' || tags.length === 0) {
    fail('usage: --out <dir> [--repo <dir>] [--git <path>] <tag>...');
  }
  const outDir = resolve(flags.out ?? '');
  const repo = resolve(flags.repo ?? '.');
  const git = flags.git ?? 'git';
  const deps: BackfillDeps = {
    fetchText: async (url) => {
      const response = await fetch(url, { redirect: 'follow' });
      return { status: response.status, text: await response.text() };
    },
    resolveCommit: (tag) => {
      const result = spawnSync(git, ['-C', repo, 'rev-list', '-n', '1', tag], { encoding: 'utf8' });
      const sha = result.stdout.trim();
      return result.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
    },
    writeScripts: (tag, scripts) => {
      const dir = join(outDir, tag);
      mkdirSync(dir, { recursive: true });
      const sh = join(dir, 'install.sh');
      const ps1 = join(dir, 'install.ps1');
      writeFileSync(sh, scripts.sh, { mode: 0o755 });
      writeFileSync(ps1, scripts.ps1);
      return [sh, ps1];
    },
    shTemplate: readFileSync(join(here, 'install.sh.tmpl'), 'utf8'),
    ps1Template: readFileSync(join(here, 'install.ps1.tmpl'), 'utf8'),
  };
  const outcomes = await backfillTags(deps, tags);
  const exitCode = outcomes.some((outcome) => outcome.status === 'skipped') ? 1 : 0;
  process.stdout.write(`${outcomes.map(formatOutcome).join('\n')}\n`, () => process.exit(exitCode));
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : 'unexpected error'));

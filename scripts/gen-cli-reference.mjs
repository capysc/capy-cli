#!/usr/bin/env node
// Regenerates docs/cli-reference.md from `capy help --json` (CAP-681), so the
// committed reference can never drift from the real command tree — it is
// rendered from the exact same document Commander itself would print, read
// off the actual built binary rather than a hand-maintained list.
//
// Usage: node scripts/gen-cli-reference.mjs [--check]
//   --check exits non-zero (and writes nothing) if the committed file is stale.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(here, '..');
const distEntry = path.join(cliDir, 'dist', 'index.js');
const outFile = path.join(cliDir, 'docs', 'cli-reference.md');

function buildDoc() {
  if (!existsSync(distEntry)) {
    console.error(`Missing ${path.relative(cliDir, distEntry)} — run \`bun run build\` first.`);
    process.exit(1);
  }
  const stdout = execFileSync(process.execPath, [distEntry, 'help', '--json'], {
    encoding: 'utf-8',
    cwd: cliDir,
  });
  return JSON.parse(stdout);
}

async function renderMarkdown(doc) {
  const rendererPath = path.join(cliDir, 'dist', 'core', 'cliReferenceMarkdown.js');
  const { renderCliReferenceMarkdown } = await import(pathToFileURL(rendererPath).href);
  return renderCliReferenceMarkdown(doc);
}

async function main() {
  const check = process.argv.includes('--check');
  const doc = buildDoc();
  const markdown = await renderMarkdown(doc);

  if (check) {
    const committed = existsSync(outFile) ? readFileSync(outFile, 'utf-8') : null;
    if (committed !== markdown) {
      console.error('docs/cli-reference.md is stale. Run `bun run docs:cli` to regenerate.');
      process.exit(1);
    }
    console.log('docs/cli-reference.md is up to date.');
    return;
  }

  writeFileSync(outFile, markdown, 'utf-8');
  console.log(`Wrote ${path.relative(cliDir, outFile)}.`);
}

main();

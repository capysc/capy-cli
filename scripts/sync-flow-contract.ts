/**
 * Vendors the flow contract into `src/flows/contract/`.
 *
 * The contract (step vocabulary + observation schema) is authored in the capy
 * monorepo under `shared/flows/`. This repository is standalone and published
 * on its own, so it cannot import across that boundary at install time — the
 * bytes are vendored instead, and divergence is made a build failure rather
 * than a review item.
 *
 * What is vendored, and what deliberately is not: `steps.json`,
 * `observations.json` and `version`. The predicate TABLE is not vendored and
 * must never be. A client validates the VOCABULARY of a step it is handed; it
 * does not evaluate the tree, because the tree is the server's decision and
 * shipping a copy of it would put that decision back in the client.
 *
 * Two gates, both mechanical:
 *   --check WITH the source present  → byte-compares; fails on ANY drift.
 *   --check WITHOUT it (this repo's  → re-hashes the vendored files against
 *   own CI, a fresh box)               SOURCES.json; fails on a hand-edit.
 *
 * Point at a checkout with CAPY_MONOREPO_ROOT=/path/to/capy; the default is
 * `../..` , which is where this package sits when checked out inside it.
 *
 *   bun run scripts/sync-flow-contract.ts
 *   bun run scripts/sync-flow-contract.ts --check
 *
 * Vendored output is generated: never hand-edited.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const MONOREPO = process.env.CAPY_MONOREPO_ROOT ?? resolve(PKG_ROOT, '../..');
const SOURCE = join(MONOREPO, 'shared/flows');
const OUT_DIR = join(PKG_ROOT, 'src/flows/contract');
const MANIFEST = join(OUT_DIR, 'SOURCES.json');

/** `version` is vendored as JSON so the compiled bundle can import it. The TABLE is never vendored — see the header. */
const JSON_FILES = ['steps.json', 'observations.json'];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const check = process.argv.includes('--check');
const haveSource = existsSync(SOURCE);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!check) {
  if (!haveSource) fail(`flow contract source not found at ${SOURCE} — set CAPY_MONOREPO_ROOT.`);
  mkdirSync(OUT_DIR, { recursive: true });
  const version = readFileSync(join(SOURCE, 'version'), 'utf8').trim();
  const manifest: Record<string, { source: string; sha256: string }> = {};

  for (const file of JSON_FILES) {
    const body = readFileSync(join(SOURCE, file), 'utf8');
    const parsed = JSON.parse(body) as { contract_version?: string };
    if (parsed.contract_version !== version) {
      fail(`${file} declares contract_version ${parsed.contract_version}, but version says ${version}.`);
    }
    writeFileSync(join(OUT_DIR, file), body);
    manifest[file] = { source: `shared/flows/${file}`, sha256: sha(body) };
  }

  const versionBody = JSON.stringify({ contract_version: version }, null, 2) + '\n';
  writeFileSync(join(OUT_DIR, 'version.json'), versionBody);
  manifest['version.json'] = { source: 'shared/flows/version', sha256: sha(versionBody) };

  writeFileSync(
    MANIFEST,
    JSON.stringify({ generatedFrom: 'shared/flows', contractVersion: version, files: manifest }, null, 2) + '\n',
  );
  console.log(`flow contract: vendored ${Object.keys(manifest).length} files at contract version ${version}.`);
  process.exit(0);
}

if (!existsSync(MANIFEST)) fail(`${MANIFEST} is missing — run: bun run scripts/sync-flow-contract.ts`);
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
  contractVersion: string;
  files: Record<string, { sha256: string }>;
};

let failed = false;
for (const file of Object.keys(manifest.files)) {
  const outPath = join(OUT_DIR, file);
  if (!existsSync(outPath)) {
    console.error(`missing vendored file: src/flows/contract/${file}`);
    failed = true;
    continue;
  }
  const vendored = readFileSync(outPath, 'utf8');
  // Gate 1 (always): the vendored copy still hashes to what the sync wrote.
  if (manifest.files[file]?.sha256 !== sha(vendored)) {
    console.error(`hand-edited vendored file: src/flows/contract/${file}`);
    failed = true;
    continue;
  }
  // Gate 2 (only with the source present): still byte-identical to canonical.
  if (haveSource && file !== 'version.json' && readFileSync(join(SOURCE, file), 'utf8') !== vendored) {
    console.error(`DRIFT from shared/flows/${file} — run: bun run scripts/sync-flow-contract.ts`);
    failed = true;
  }
}

if (haveSource) {
  const version = readFileSync(join(SOURCE, 'version'), 'utf8').trim();
  if (version !== manifest.contractVersion) {
    console.error(`DRIFT: contract version is ${version}, vendored copy is ${manifest.contractVersion}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(
  `flow contract: in sync (contract version ${manifest.contractVersion}${haveSource ? '' : ', manifest-only'}).`,
);

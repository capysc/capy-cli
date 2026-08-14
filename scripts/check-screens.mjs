#!/usr/bin/env node
// CI guards for the embedded browser screens (run: node scripts/check-screens.mjs).
//
// 1. Dependency freeze: runtime deps must stay within ALLOWED_DEPS. The
//    screens feature must not grow the CLI's dependency tree — screens are
//    embedded static HTML served with node's http module.
// 2. Zero external requests: the embedded screen HTML must contain no
//    non-localhost URLs (XML namespace identifiers excepted — never fetched).
// 3. Every embedded screen must carry the __CAPY_DATA__ placeholder so
//    serve-time injection cannot silently no-op.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_DEPS = [
  '@napi-rs/keyring',
  'commander',
  'dotenv',
  'inquirer',
  'open',
  'proper-lockfile',
  'qrcode-terminal',
];

const URL_ALLOWLIST = [
  /^https?:\/\/(127\.0\.0\.1|localhost)(?=[:/"'\s]|$)/,
  // XML namespace identifiers and doc links inside Svelte's thrown error
  // messages — plain strings, never fetched at runtime.
  /^http:\/\/www\.w3\.org\//,
  /^https:\/\/svelte\.dev\/e\//,
];

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`  ✗ ${msg}`);
};

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  if (!ALLOWED_DEPS.includes(dep)) {
    fail(`runtime dependency "${dep}" is not in the allowlist (scripts/check-screens.mjs)`);
  }
}

const generatedPath = resolve(pkgRoot, 'src/ui/screens/generated.ts');
const generated = readFileSync(generatedPath, 'utf8');

for (const match of generated.matchAll(/\bhttps?:\/\/[^\s"'`<>\\)]+/g)) {
  if (URL_ALLOWLIST.some((re) => re.test(match[0]))) continue;
  fail(`embedded screens contain external URL: ${match[0]}`);
}

// No private leakage: embedded artifacts must be minified output only —
// no source maps, no private filesystem paths from the build machine.
for (const needle of ['sourceMappingURL', '/Users/', '/home/', 'conductor/workspaces']) {
  if (generated.includes(needle)) {
    fail(`embedded screens contain "${needle}"`);
  }
}

const docCount = (generated.match(/'[\w-]+': "/g) ?? []).length;
const placeholderCount = (generated.match(/\/\*__CAPY_DATA__\*\/ null/g) ?? []).length;
if (docCount === 0) fail('no embedded screens found in src/ui/screens/generated.ts');
if (placeholderCount < docCount) {
  fail(`only ${placeholderCount}/${docCount} embedded screens carry the __CAPY_DATA__ placeholder`);
}

if (failures > 0) {
  console.error(`\n${failures} screen check(s) failed.`);
  process.exit(1);
}
console.log(`  ✓ deps within allowlist (${Object.keys(pkg.dependencies ?? {}).length}/${ALLOWED_DEPS.length} used)`);
console.log(`  ✓ ${docCount} embedded screens: no external URLs, placeholders intact`);

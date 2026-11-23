// Writes a copy of pkg's Windows Node base binary that carries Capy's own
// version information instead of Node's, into a private pkg cache folder.
//
//   bun scripts/windows/prepare-node-base.ts --version 0.9.19 --cache .pkg-cache-win
//   PKG_CACHE_PATH=.pkg-cache-win pkg . --target node22-win-x64 --output capy.exe
//
// Why: @yao-pkg/pkg builds capy.exe by appending our bundle to Node's
// node.exe, so Windows (Properties > Details, SmartScreen, antivirus) and the
// code-signing service saw "Node.js" as the product. SignPath requires the
// signed file's product name and version to be ours.
//
// Why the base and not capy.exe: pkg records where it appended the bundle as
// absolute offsets. Rewriting resources in the finished capy.exe can move
// those bytes and break the binary. Editing the base first keeps pkg's own
// layout untouched.
//
// How pkg finds it: pkg-fetch looks in PKG_CACHE_PATH for a downloaded base
// ("fetched-…"), then a locally built one ("built-…"), and only then downloads.
// We leave no "fetched-…" Windows file in the private cache and write ours as
// "built-…", so pkg uses it. (PKG_NODE_PATH is not usable: it also replaces
// the host Node pkg runs on, so it cannot cross-build from Linux.)
//
// The original base is fetched with pkg-fetch into the default cache, which
// checks it against pkg's pinned SHA-256 before we touch it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { need } from '@yao-pkg/pkg-fetch';
import * as PE from 'pe-library';
import * as ResEdit from 'resedit';

const NODE_RANGE = 'node22';
const PRODUCT_NAME = 'Capy';
const COMPANY_NAME = 'Incentv Technologies Inc.';
const FILE_DESCRIPTION = 'Capy CLI';
const COPYRIGHT = 'Copyright Incentv Technologies Inc. AGPL-3.0. Includes Node.js (MIT).';
const LANG_EN_US = 1033;
const CODEPAGE_UNICODE = 1200;

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? '' : (process.argv[index + 1] ?? '');
  if (!value) fail(`--${name} is required`);
  return value;
}

function fail(message: string): never {
  process.stderr.write(`prepare-node-base: ${message}\n`);
  return process.exit(1);
}

function versionParts(version: string): [number, number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) fail(`--version must look like 1.2.3, got "${version}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), 0];
}

export function brandExecutable(bytes: Buffer, version: string): Buffer {
  const parts = versionParts(version);
  const exe = PE.NtExecutable.from(bytes);
  const res = PE.NtExecutableResource.from(exe);
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (!info) fail('the Node base binary has no version resource');

  const lang = { lang: LANG_EN_US, codepage: CODEPAGE_UNICODE };
  for (const existing of info.getAllLanguagesForStringValues()) {
    if (existing.lang !== lang.lang || existing.codepage !== lang.codepage) {
      info.removeAllStringValues(existing);
    }
  }
  info.setFileVersion(...parts, LANG_EN_US);
  info.setProductVersion(...parts, LANG_EN_US);
  info.setStringValues(lang, {
    CompanyName: COMPANY_NAME,
    ProductName: PRODUCT_NAME,
    FileDescription: FILE_DESCRIPTION,
    FileVersion: version,
    ProductVersion: version,
    OriginalFilename: 'capy.exe',
    InternalName: 'capy',
    LegalCopyright: COPYRIGHT,
  });
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

async function main(): Promise<void> {
  const version = flag('version');
  const cache = resolve(flag('cache'));
  if (process.env.PKG_CACHE_PATH && resolve(process.env.PKG_CACHE_PATH) === cache) {
    fail('run this without PKG_CACHE_PATH set to --cache; the original base must come from the default cache');
  }
  const fetched = await need({ nodeRange: NODE_RANGE, platform: 'win', arch: 'x64' });
  const name = basename(fetched);
  if (!name.startsWith('fetched-')) fail(`unexpected pkg-fetch file name "${name}"`);
  const out = join(cache, basename(dirname(fetched)), name.replace(/^fetched-/, 'built-'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, brandExecutable(readFileSync(fetched), version), { mode: 0o755 });
  process.stdout.write(`${out}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
}

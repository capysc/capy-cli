// Writes install.sh and install.ps1 for one release.
//
//   bun scripts/install/build-install-scripts.ts \
//     --version 0.9.17 --commit <40-hex sha> --checksums dist/checksums-0.9.17.txt --out dist
//
// Exits non-zero, writing nothing, when a checksum is missing or malformed or a
// placeholder is left unfilled.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstallScriptError, renderInstallScripts } from './render';

const here = dirname(fileURLToPath(import.meta.url));

const FLAG_NAMES = ['version', 'commit', 'checksums', 'out'] as const;

function readFlags(argv: readonly string[]): Readonly<Record<string, string>> {
  const pairs = argv.flatMap((arg, index) =>
    arg.startsWith('--') ? [[arg.slice(2), argv[index + 1] ?? ''] as const] : [],
  );
  return Object.fromEntries(pairs);
}

function fail(message: string): never {
  process.stderr.write(`build-install-scripts: ${message}\n`);
  return process.exit(1);
}

function main(): void {
  const flags = readFlags(process.argv.slice(2));
  const missing = FLAG_NAMES.filter((name) => (flags[name] ?? '') === '' || (flags[name] ?? '').startsWith('--'));
  if (missing.length > 0) {
    fail(`missing ${missing.map((name) => `--${name}`).join(', ')}`);
  }
  const rendered = (() => {
    try {
      return renderInstallScripts({
        version: flags.version ?? '',
        commit: flags.commit ?? '',
        checksumsText: readFileSync(resolve(flags.checksums ?? ''), 'utf8'),
        shTemplate: readFileSync(join(here, 'install.sh.tmpl'), 'utf8'),
        ps1Template: readFileSync(join(here, 'install.ps1.tmpl'), 'utf8'),
      });
    } catch (error) {
      return error instanceof InstallScriptError
        ? fail(`${error.code}: ${error.message}`)
        : fail(error instanceof Error ? error.message : 'unexpected error');
    }
  })();
  const outDir = resolve(flags.out ?? '');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'install.sh'), rendered.sh, { mode: 0o755 });
  writeFileSync(join(outDir, 'install.ps1'), rendered.ps1);
  process.stdout.write(`wrote ${join(outDir, 'install.sh')} and ${join(outDir, 'install.ps1')}\n`);
}

main();

// Bundles the CLI into a single CommonJS file ready to be wrapped by @yao-pkg/pkg.
// Mirrors dotenvx's pattern: emit build/index.cjs + a stripped build/package.json
// whose `pkg` block is what @yao-pkg/pkg actually consumes.
import { build } from 'esbuild';
import { mkdir, rm, stat, writeFile, readFile } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'build');
const outFile = path.join(outDir, 'index.cjs');

// Shared with scripts/gen-third-party-notices.mjs, which runs the same build
// with a metafile to learn exactly which packages end up inside the binary.
export const bundleOptions = {
  entryPoints: [path.join(here, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  minify: false,
  // Keep bundled dependencies' copyright/license comments — the binary
  // redistributes their code, so their notices ride along with it.
  // THIRD-PARTY-NOTICES.md is the human-readable copy shipped beside it.
  legalComments: 'eof',
  logOverride: { 'direct-eval': 'silent' },
};

async function emptyDir(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

async function printSize(file) {
  const { size } = await stat(file);
  console.log(`Bundle: ${(size / 1024 / 1024).toFixed(2)} MB`);
}

async function main() {
  const pkgJson = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));

  await emptyDir(outDir);

  await build({ ...bundleOptions, outfile: outFile });

  await printSize(outFile);

  // Stripped manifest for pkg. pkg reads `bin` + `pkg` from this manifest.
  const stripped = {
    name: pkgJson.name,
    version: pkgJson.version,
    description: pkgJson.description,
    license: pkgJson.license,
    bin: 'index.cjs',
    main: 'index.cjs',
    pkg: {
      scripts: ['index.cjs'],
      assets: [],
    },
  };

  await writeFile(
    path.join(outDir, 'package.json'),
    JSON.stringify(stripped, null, 2) + '\n',
  );

  console.log(`Wrote ${outFile} and ${path.join(outDir, 'package.json')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

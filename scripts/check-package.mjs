import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const before = readFileSync(join(root, 'package.json'), 'utf8');
const out = mkdtempSync(join(tmpdir(), 'capy-cli-pack-'));

try {
  const tarball = execFileSync('npm', ['pack', '--pack-destination', out, '--silent'], {
    cwd: root,
    encoding: 'utf8',
  }).trim().split('\n').at(-1);
  if (!tarball) throw new Error('npm pack did not return a tarball name');

  const entries = execFileSync('tar', ['-tzf', join(out, tarball)], { encoding: 'utf8' });
  for (const forbidden of ['package/bin/capy-dev', 'package/bin/capy-staging', 'index-dev.']) {
    if (entries.includes(forbidden)) throw new Error(`production package contains ${forbidden}`);
  }

  // The staging entrypoint pins its origins as literals. Shipping either string
  // would mean a published build carries a staging target, so assert the whole
  // tarball is free of them — not just that the bin file is absent.
  const contents = execFileSync('tar', ['-xOzf', join(out, tarball)], {
    encoding: 'utf8',
    // The whole tarball streams through here; the default 1 MB buffer overflows
    // on the LICENSE alone.
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const origin of ['staging-api.capy.sc', 'staging-keep.capy.sc']) {
    if (contents.includes(origin)) throw new Error(`production package references ${origin}`);
  }

  const packedManifest = JSON.parse(
    execFileSync('tar', ['-xOzf', join(out, tarball), 'package/package.json'], { encoding: 'utf8' }),
  );
  if (packedManifest.bin?.['capy-dev'] || packedManifest.bin?.['capy-staging']) {
    throw new Error('production package manifest exposes a dev or staging binary');
  }

  const after = readFileSync(join(root, 'package.json'), 'utf8');
  if (after !== before) throw new Error('npm pack mutated the source package.json');

  console.log(`verified ${tarball}: production-only bins; source manifest restored`);
} finally {
  rmSync(out, { recursive: true, force: true });
}

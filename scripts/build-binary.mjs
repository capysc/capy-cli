// Local-dev driver: bundle with esbuild then wrap with @yao-pkg/pkg for the
// host platform only. CI uses .github/workflows/release.yml for the full
// cross-compile matrix.
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(here, '..');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

function hostTarget() {
  const { platform, arch } = process;
  const archMap = { x64: 'x64', arm64: 'arm64' };
  const a = archMap[arch];
  if (!a) throw new Error(`Unsupported host arch: ${arch}`);
  if (platform === 'darwin') return `node20-macos-${a}`;
  if (platform === 'linux') return `node20-linuxstatic-${a}`;
  if (platform === 'win32') return `node20-win-${a}`;
  throw new Error(`Unsupported host platform: ${platform}`);
}

async function main() {
  const target = process.env.PKG_TARGET || hostTarget();
  const outName = process.platform === 'win32' ? 'capy.exe' : 'capy';
  const outPath = path.join(cliDir, 'bin-pkg', outName);

  await run('node', [path.join(cliDir, 'build.esbuild.mjs')], { cwd: cliDir });
  await run(
    'bunx',
    [
      '@yao-pkg/pkg',
      '.',
      '--public-packages',
      '*',
      '--public',
      '--target',
      target,
      '--output',
      outPath,
    ],
    { cwd: path.join(cliDir, 'build') },
  );

  console.log(`\nBinary: ${outPath} (target ${target})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

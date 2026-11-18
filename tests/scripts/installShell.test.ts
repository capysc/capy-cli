// Runs the GENERATED install.sh and the root loader under a plain `sh`, with fake
// curl and uname first on PATH and everything inside a temp HOME. The fake curl
// serves a small local tarball whose real sha256 is written into the generated
// script, so the real checksum path runs. Nothing here touches the machine's
// own PATH or install directories.
//
// Run: bun test tests/scripts/installShell.test.ts
// Another shell: CAPY_TEST_SHELL=/bin/dash bun test tests/scripts/installShell.test.ts
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ARCHIVE_TARGETS, renderInstallScripts } from '../../scripts/install/render';

const root = resolve(import.meta.dir, '../..');
const installDir = join(root, 'scripts', 'install');
const version = '9.9.9';
const commit = '0123456789abcdef0123456789abcdef01234567';
const archiveUrl = `https://github.com/capysc/capy-cli/releases/download/v${version}/capy-linux-x64-${version}.tar.gz`;

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

// Absolute path of a host tool, found with the shell's own lookup.
const hostTool = (name: string): string | undefined => {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const path = found.stdout.trim();
  return found.status === 0 && path !== '' ? path : undefined;
};

const sandboxRoot = (): string => realpath(mkdtempSync(join(tmpdir(), 'capy-install-sh-')));
const realpath = (path: string): string => spawnSync('sh', ['-c', `cd "$1" && pwd -P`, 'sh', path], { encoding: 'utf8' }).stdout.trim();

const withSandbox = <T>(use: (dir: string) => T): T => {
  const dir = sandboxRoot();
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const writeExecutable = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

// A tarball holding a fake `capy` that reports `reportedVersion`.
const makeTarball = (dir: string, name: string, reportedVersion: string): string => {
  const content = join(dir, `${name}-content`);
  writeExecutable(join(content, 'capy'), `#!/bin/sh\nprintf '%s\\n' '${reportedVersion}'\n`);
  writeFileSync(join(content, 'LICENSE'), 'license\n');
  writeFileSync(join(content, 'THIRD-PARTY-NOTICES.md'), 'notices\n');
  const tarball = join(dir, `${name}.tar.gz`);
  const made = spawnSync('tar', ['-czf', tarball, '-C', content, '.']);
  if (made.status !== 0) throw new Error('tar failed');
  return tarball;
};

// Generates install.sh the way the release does: real checksum for linux-x64.
const generateInstaller = (dir: string, linuxX64Hash: string): string => {
  const checksumsText = ARCHIVE_TARGETS.map((target, index) => {
    const hash = target.placeholder === 'SHA256_LINUX_X64' ? linuxX64Hash : String(index + 1).repeat(64);
    return `${hash}  ${target.archiveName(version)}`;
  }).join('\n');
  const { sh } = renderInstallScripts({
    version,
    commit,
    checksumsText,
    shTemplate: readFileSync(join(installDir, 'install.sh.tmpl'), 'utf8'),
    ps1Template: readFileSync(join(installDir, 'install.ps1.tmpl'), 'utf8'),
  });
  const path = join(dir, 'install.sh');
  writeFileSync(path, sh);
  return path;
};

type ToolBinOptions = {
  readonly servedTarball: string;
  readonly hashTool: 'sha256sum' | 'shasum' | 'none';
  readonly binName?: string;
};

// A directory with only the tools the installer needs, plus fake curl and uname.
const makeToolBin = (dir: string, options: ToolBinOptions): string => {
  const bin = join(dir, options.binName ?? 'toolbin');
  mkdirSync(bin, { recursive: true });
  const linked = ['tar', 'gzip', 'mktemp', 'rm', 'mkdir', 'cp', 'chmod', 'mv', 'dirname', 'readlink']
    .flatMap((name) => {
      const path = hostTool(name);
      return path === undefined ? [] : [[name, path] as const];
    });
  linked.forEach(([name, path]) => symlinkSync(path, join(bin, name)));
  const hashTools = options.hashTool === 'none' ? [] : [options.hashTool];
  hashTools.forEach((name) => {
    const path = hostTool(name);
    if (path === undefined) throw new Error(`${name} is not available on this machine`);
    symlinkSync(path, join(bin, name));
  });
  writeExecutable(
    join(bin, 'uname'),
    `#!/bin/sh\ncase "$1" in -s) printf 'Linux\\n' ;; -m) printf 'x86_64\\n' ;; *) printf 'Linux\\n' ;; esac\n`,
  );
  writeExecutable(
    join(bin, 'curl'),
    [
      '#!/bin/sh',
      'out=""',
      'url=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out=$2; shift ;;',
      '    -*) ;;',
      '    *) url=$1 ;;',
      '  esac',
      '  shift',
      'done',
      `printf '%s\\n' "$url" >> "${join(dir, 'curl-urls.log')}"`,
      `cp "${options.servedTarball}" "$out"`,
      '',
    ].join('\n'),
  );
  return bin;
};

type RunResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

const runInstaller = (
  installer: string,
  home: string,
  pathEntries: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): RunResult => {
  // CAPY_TEST_SHELL picks another POSIX shell to run the scripts under, e.g. /bin/dash.
  const shell = process.env.CAPY_TEST_SHELL ?? hostTool('sh') ?? '/bin/sh';
  const result = spawnSync(shell, [installer], {
    encoding: 'utf8',
    cwd: home,
    env: { HOME: home, TMPDIR: join(home, 'tmp'), PATH: pathEntries.join(':'), ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const prepare = (dir: string, hashTool: ToolBinOptions['hashTool'] = hostTool('sha256sum') === undefined ? 'shasum' : 'sha256sum') => {
  const home = join(dir, 'home');
  mkdirSync(join(home, 'tmp'), { recursive: true });
  const good = makeTarball(dir, 'good', version);
  const installer = generateInstaller(dir, sha256(good));
  const toolBin = makeToolBin(dir, { servedTarball: good, hashTool });
  return { home, good, installer, toolBin };
};

const filesIn = (path: string): readonly string[] => (existsSync(path) ? readdirSync(path) : []);

describe('generated install.sh', () => {
  test('fresh install goes to ~/.local/bin and downloads the pinned archive over https', () => {
    withSandbox((dir) => {
      const { home, installer, toolBin } = prepare(dir);
      const result = runInstaller(installer, home, [toolBin]);
      expect(result.status).toBe(0);
      const installed = join(home, '.local', 'bin', 'capy');
      expect(spawnSync(installed, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(version);
      expect(existsSync(join(home, '.local', 'share', 'capy', 'LICENSE'))).toBe(true);
      expect(result.stdout).toContain(`Add this directory to your PATH: ${join(home, '.local', 'bin')}`);
      expect(readFileSync(join(dir, 'curl-urls.log'), 'utf8').trim()).toBe(archiveUrl);
      expect(filesIn(join(home, '.local', 'bin'))).toEqual(['capy']);
    });
  });

  test('CAPY_INSTALL_DIR overrides the destination, even with an existing Homebrew capy', () => {
    withSandbox((dir) => {
      const { home, installer, toolBin } = prepare(dir);
      const cellar = join(dir, 'opt', 'homebrew', 'Cellar', 'capy', '1.0', 'bin', 'capy');
      writeExecutable(cellar, '#!/bin/sh\necho old\n');
      mkdirSync(join(dir, 'opt', 'homebrew', 'bin'), { recursive: true });
      symlinkSync('../Cellar/capy/1.0/bin/capy', join(dir, 'opt', 'homebrew', 'bin', 'capy'));
      const target = join(dir, 'custom', 'bin');
      const result = runInstaller(installer, home, [join(dir, 'opt', 'homebrew', 'bin'), toolBin], { CAPY_INSTALL_DIR: target });
      expect(result.status).toBe(0);
      expect(spawnSync(join(target, 'capy'), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(version);
      expect(existsSync(join(home, '.local', 'bin', 'capy'))).toBe(false);
    });
  });

  test('a checksum mismatch installs nothing', () => {
    withSandbox((dir) => {
      const { home, installer } = prepare(dir);
      const otherBin = makeToolBin(dir, {
        servedTarball: makeTarball(dir, 'other', '0.0.1'),
        hashTool: hostTool('sha256sum') === undefined ? 'shasum' : 'sha256sum',
        binName: 'otherbin',
      });
      const result = runInstaller(installer, home, [otherBin]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Checksum verification failed; nothing was installed.');
      expect(existsSync(join(home, '.local'))).toBe(false);
    });
  });

  test('an existing regular-file capy is replaced where it is', () => {
    withSandbox((dir) => {
      const { home, installer, toolBin } = prepare(dir);
      const existingBin = join(dir, 'existing', 'bin');
      writeExecutable(join(existingBin, 'capy'), '#!/bin/sh\necho old\n');
      const result = runInstaller(installer, home, [existingBin, toolBin]);
      expect(result.status).toBe(0);
      expect(spawnSync(join(existingBin, 'capy'), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(version);
      expect(existsSync(join(home, '.local', 'bin', 'capy'))).toBe(false);
      expect(filesIn(existingBin)).toEqual(['capy']);
      expect(result.stdout).toContain('Run capy --help to get started.');
    });
  });

  test('an existing capy in a folder that cannot be written stops', () => {
    if (process.getuid?.() === 0) return;
    withSandbox((dir) => {
      const { home, installer, toolBin } = prepare(dir);
      const lockedBin = join(dir, 'locked', 'bin');
      writeExecutable(join(lockedBin, 'capy'), '#!/bin/sh\necho old\n');
      chmodSync(lockedBin, 0o555);
      try {
        const result = runInstaller(installer, home, [lockedBin, toolBin]);
        expect(result.status).not.toBe(0);
        expect(spawnSync(join(lockedBin, 'capy'), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('old');
        expect(existsSync(join(home, '.local'))).toBe(false);
      } finally {
        chmodSync(lockedBin, 0o755);
      }
    });
  });

  test('a link into a Homebrew Cellar stops and nothing is installed', () => {
    withSandbox((dir) => {
      const { home, installer, toolBin } = prepare(dir);
      writeExecutable(join(dir, 'opt', 'homebrew', 'Cellar', 'capy', '1.0', 'bin', 'capy'), '#!/bin/sh\necho old\n');
      mkdirSync(join(dir, 'opt', 'homebrew', 'bin'), { recursive: true });
      symlinkSync('../Cellar/capy/1.0/bin/capy', join(dir, 'opt', 'homebrew', 'bin', 'capy'));
      const result = runInstaller(installer, home, [join(dir, 'opt', 'homebrew', 'bin'), toolBin]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('brew upgrade capy');
      expect(existsSync(join(home, '.local'))).toBe(false);
      expect(filesIn(join(dir, 'opt', 'homebrew', 'bin'))).toEqual(['capy']);
      expect(existsSync(join(dir, 'curl-urls.log'))).toBe(false);
    });
  });

  test('a link into node_modules stops and nothing is installed', () => {
    withSandbox((dir) => {
      const { home, installer, toolBin } = prepare(dir);
      writeExecutable(join(dir, 'prefix', 'lib', 'node_modules', '@capysc', 'cli', 'bin', 'capy'), '#!/bin/sh\necho old\n');
      mkdirSync(join(dir, 'prefix', 'bin'), { recursive: true });
      symlinkSync('../lib/node_modules/@capysc/cli/bin/capy', join(dir, 'prefix', 'bin', 'capy'));
      const result = runInstaller(installer, home, [join(dir, 'prefix', 'bin'), toolBin]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('npm install -g @capysc/cli');
      expect(existsSync(join(home, '.local'))).toBe(false);
      expect(existsSync(join(dir, 'curl-urls.log'))).toBe(false);
    });
  });

  test('a link to somewhere else stops and nothing is installed', () => {
    withSandbox((dir) => {
      const { home, installer, toolBin } = prepare(dir);
      writeExecutable(join(dir, 'somewhere', 'capy'), '#!/bin/sh\necho old\n');
      mkdirSync(join(dir, 'links'), { recursive: true });
      symlinkSync(join(dir, 'somewhere', 'capy'), join(dir, 'links', 'capy'));
      const result = runInstaller(installer, home, [join(dir, 'links'), toolBin]);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(home, '.local'))).toBe(false);
      expect(existsSync(join(dir, 'curl-urls.log'))).toBe(false);
    });
  });

  test('a Cellar link that goes through a relative second link is still recognised', () => {
    withSandbox((dir) => {
      const { home, installer, toolBin } = prepare(dir);
      writeExecutable(join(dir, 'x', 'Cellar', 'capy', '1.0', 'libexec', 'bin', 'capy'), '#!/bin/sh\necho old\n');
      mkdirSync(join(dir, 'x', 'bin'), { recursive: true });
      symlinkSync('../Cellar/capy/1.0/libexec/bin/capy', join(dir, 'x', 'bin', 'capy'));
      const result = runInstaller(installer, home, [join(dir, 'x', 'bin'), toolBin]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('brew upgrade capy');
    });
  });

  test('without sha256sum or shasum it stops and installs nothing', () => {
    withSandbox((dir) => {
      const { home, installer, toolBin } = prepare(dir, 'none');
      const result = runInstaller(installer, home, [toolBin]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Install sha256sum or shasum to verify this download.');
      expect(existsSync(join(home, '.local'))).toBe(false);
    });
  });

  test('a binary that reports another version installs nothing', () => {
    withSandbox((dir) => {
      const wrong = makeTarball(dir, 'wrong', '0.0.1');
      const installer = generateInstaller(dir, sha256(wrong));
      const home = join(dir, 'home');
      mkdirSync(join(home, 'tmp'), { recursive: true });
      const toolBin = makeToolBin(dir, {
        servedTarball: wrong,
        hashTool: hostTool('sha256sum') === undefined ? 'shasum' : 'sha256sum',
      });
      const result = runInstaller(installer, home, [toolBin]);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(home, '.local'))).toBe(false);
    });
  });
});

describe('install.sh loader at the repo root', () => {
  const loader = join(root, 'install.sh');

  // A fake curl that records the URL and serves a stub installer which echoes a marker.
  const prepareLoader = (dir: string, curlExitCode: number) => {
    const home = join(dir, 'home');
    mkdirSync(join(home, 'tmp'), { recursive: true });
    const bin = join(dir, 'loaderbin');
    mkdirSync(bin, { recursive: true });
    ['mktemp', 'rm', 'sh'].forEach((name) => {
      const path = hostTool(name);
      if (path !== undefined) symlinkSync(path, join(bin, name));
    });
    writeExecutable(
      join(bin, 'curl'),
      [
        '#!/bin/sh',
        'out=""',
        'url=""',
        'flags=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o) out=$2; shift ;;',
        '    -*) flags="$flags $1" ;;',
        '    *) url=$1 ;;',
        '  esac',
        '  shift',
        'done',
        `printf '%s|%s\\n' "$url" "$flags" >> "${join(dir, 'loader-urls.log')}"`,
        `[ ${curlExitCode} -eq 0 ] || exit ${curlExitCode}`,
        `printf '%s\\n' 'echo stub-installer-ran' > "$out"`,
        '',
      ].join('\n'),
    );
    return { home, bin };
  };

  const loadedUrl = (dir: string): string => readFileSync(join(dir, 'loader-urls.log'), 'utf8').split('|')[0] ?? '';

  test('fetches the latest release installer by default, over https only, and runs it', () => {
    withSandbox((dir) => {
      const { home, bin } = prepareLoader(dir, 0);
      const result = runInstaller(loader, home, [bin]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('stub-installer-ran');
      expect(loadedUrl(dir)).toBe('https://github.com/capysc/capy-cli/releases/latest/download/install.sh');
      const flags = readFileSync(join(dir, 'loader-urls.log'), 'utf8');
      expect(flags).toContain('--proto');
      expect(flags).toContain('--tlsv1.2');
      expect(filesIn(join(home, 'tmp'))).toEqual([]);
    });
  });

  test('CAPY_VERSION pins the release, with or without a leading v', () => {
    withSandbox((dir) => {
      const { home, bin } = prepareLoader(dir, 0);
      expect(runInstaller(loader, home, [bin], { CAPY_VERSION: '0.9.16' }).status).toBe(0);
      expect(loadedUrl(dir)).toBe('https://github.com/capysc/capy-cli/releases/download/v0.9.16/install.sh');
    });
    withSandbox((dir) => {
      const { home, bin } = prepareLoader(dir, 0);
      expect(runInstaller(loader, home, [bin], { CAPY_VERSION: 'v0.9.16' }).status).toBe(0);
      expect(loadedUrl(dir)).toBe('https://github.com/capysc/capy-cli/releases/download/v0.9.16/install.sh');
    });
  });

  test('a CAPY_VERSION that is not digits and dots is refused before any download', () => {
    ['0.9.16; rm -rf ~', '../../x', 'latest', '1..2', '.1', '1.'].forEach((bad) => {
      withSandbox((dir) => {
        const { home, bin } = prepareLoader(dir, 0);
        const result = runInstaller(loader, home, [bin], { CAPY_VERSION: bad });
        expect(result.status).not.toBe(0);
        expect(existsSync(join(dir, 'loader-urls.log'))).toBe(false);
      });
    });
  });

  test('a failed download stops, runs nothing and cleans up', () => {
    withSandbox((dir) => {
      const { home, bin } = prepareLoader(dir, 22);
      const result = runInstaller(loader, home, [bin]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('stub-installer-ran');
      expect(filesIn(join(home, 'tmp'))).toEqual([]);
    });
  });
});

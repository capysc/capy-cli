import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ARCHIVE_TARGETS,
  InstallScriptError,
  renderInstallScripts,
} from '../../scripts/install/render';

const root = resolve(import.meta.dir, '../..');
const installDir = join(root, 'scripts', 'install');
const shTemplate = readFileSync(join(installDir, 'install.sh.tmpl'), 'utf8');
const ps1Template = readFileSync(join(installDir, 'install.ps1.tmpl'), 'utf8');

const version = '1.2.3';
const commit = 'ef7b1173f3c03796cf119a531894ca9cf3f6d16f';
const hashFor = (index: number): string => String(index + 1).repeat(64).slice(0, 64);
const checksumLines = ARCHIVE_TARGETS.map(
  (target, index) => `${hashFor(index)}  ${target.archiveName(version)}`,
);
const checksumsText = `${checksumLines.join('\n')}\n`;

const render = (overrides: Partial<Parameters<typeof renderInstallScripts>[0]> = {}) =>
  renderInstallScripts({ version, commit, checksumsText, shTemplate, ps1Template, ...overrides });

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof InstallScriptError ? error.code : 'OTHER';
  }
};

describe('renderInstallScripts', () => {
  test('writes the version, commit and checksums into both scripts', () => {
    const { sh, ps1 } = render();
    expect(sh).toContain(`# Capy ${version}, ${commit}`);
    expect(sh).toContain(`releases/download/v${version}`);
    expect(sh).toContain(`darwin-arm64) expected=${hashFor(0)} ;;`);
    expect(sh).toContain(`darwin-x64) expected=${hashFor(1)} ;;`);
    expect(sh).toContain(`linux-x64) expected=${hashFor(2)} ;;`);
    expect(sh).toContain(`linux-arm64) expected=${hashFor(3)} ;;`);
    expect(ps1).toContain(`$version = '${version}'`);
    expect(ps1).toContain(`$expectedHash = '${hashFor(4)}'`);
    expect(`${sh}${ps1}`).not.toMatch(/@@[A-Z0-9_]+@@/);
  });

  test('accepts binary-mode lines, upper-case hashes and directory prefixes', () => {
    const text = ARCHIVE_TARGETS.map(
      (target, index) => `${hashFor(index).toUpperCase()} *dist/${target.archiveName(version)}`,
    ).join('\r\n');
    expect(render({ checksumsText: text }).sh).toContain(`linux-x64) expected=${hashFor(2)} ;;`);
  });

  test('fails when an archive checksum is missing', () => {
    const withoutWindows = checksumLines.slice(0, 4).join('\n');
    expect(codeOf(() => render({ checksumsText: withoutWindows }))).toBe('CHECKSUM_MISSING');
  });

  test('fails when a checksum belongs to another version', () => {
    expect(codeOf(() => render({ version: '1.2.4' }))).toBe('CHECKSUM_MISSING');
  });

  test('fails when a checksum is not 64 hex characters', () => {
    const tooShort = checksumLines.map((line, index) => (index === 2 ? line.replace(hashFor(2), 'abc123') : line));
    expect(codeOf(() => render({ checksumsText: tooShort.join('\n') }))).toBe('CHECKSUM_MALFORMED');
    const notHex = checksumLines.map((line, index) => (index === 0 ? line.replace(hashFor(0), 'z'.repeat(64)) : line));
    expect(codeOf(() => render({ checksumsText: notHex.join('\n') }))).toBe('CHECKSUM_MALFORMED');
  });

  test('fails when one file is listed with two different checksums', () => {
    const twice = `${checksumsText}${hashFor(7)}  ${ARCHIVE_TARGETS[0]?.archiveName(version)}\n`;
    expect(codeOf(() => render({ checksumsText: twice }))).toBe('CHECKSUM_CONFLICT');
  });

  test('fails when a placeholder is left unfilled', () => {
    expect(codeOf(() => render({ shTemplate: `${shTemplate}\n# @@SOMETHING_NEW@@\n` }))).toBe('PLACEHOLDER_UNFILLED');
    expect(codeOf(() => render({ ps1Template: `${ps1Template}\n# @@SOMETHING_NEW@@\n` }))).toBe('PLACEHOLDER_UNFILLED');
  });

  test('fails on a bad version or commit', () => {
    expect(codeOf(() => render({ version: 'v1.2.3' }))).toBe('BAD_VERSION');
    expect(codeOf(() => render({ commit: 'main' }))).toBe('BAD_COMMIT');
  });
});

describe('build-install-scripts command', () => {
  const run = (args: readonly string[]) =>
    spawnSync('bun', [join(installDir, 'build-install-scripts.ts'), ...args], { encoding: 'utf8' });

  const withTempDir = <T>(use: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'capy-install-gen-'));
    try {
      return use(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('writes install.sh and install.ps1 to the output directory', () => {
    withTempDir((dir) => {
      const checksums = join(dir, `checksums-${version}.txt`);
      writeFileSync(checksums, checksumsText);
      const out = join(dir, 'out');
      const result = run(['--version', version, '--commit', commit, '--checksums', checksums, '--out', out]);
      expect(result.status).toBe(0);
      expect(readFileSync(join(out, 'install.sh'), 'utf8')).toContain(`# Capy ${version}, ${commit}`);
      expect(readFileSync(join(out, 'install.ps1'), 'utf8')).toContain(`$version = '${version}'`);
    });
  });

  test('exits non-zero and writes nothing when a checksum is missing', () => {
    withTempDir((dir) => {
      const checksums = join(dir, 'checksums.txt');
      writeFileSync(checksums, checksumLines.slice(0, 3).join('\n'));
      const out = join(dir, 'out');
      const result = run(['--version', version, '--commit', commit, '--checksums', checksums, '--out', out]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('CHECKSUM_MISSING');
      expect(spawnSync('ls', [out]).status).not.toBe(0);
    });
  });

  test('exits non-zero when a flag is missing', () => {
    expect(run(['--version', version]).status).not.toBe(0);
  });
});

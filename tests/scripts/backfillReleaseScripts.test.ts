import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BackfillDeps, backfillTag, backfillTags, checksumsUrl, formatOutcome } from '../../scripts/install/backfill';
import { ARCHIVE_TARGETS } from '../../scripts/install/render';

const installDir = resolve(import.meta.dir, '../../scripts/install');
const commit = '0123456789abcdef0123456789abcdef01234567';

const checksumsFor = (version: string, skip: readonly string[] = []): string =>
  ARCHIVE_TARGETS.filter((target) => !skip.includes(target.placeholder))
    .map((target, index) => `${String(index + 1).repeat(64)}  ${target.archiveName(version)}`)
    .join('\n');

const makeDeps = (overrides: Partial<BackfillDeps> = {}): BackfillDeps => ({
  fetchText: async (url) => ({ status: 200, text: checksumsFor(/checksums-(.+)\.txt$/.exec(url)?.[1] ?? '') }),
  resolveCommit: () => commit,
  writeScripts: (tag) => [`/out/${tag}/install.sh`, `/out/${tag}/install.ps1`],
  shTemplate: readFileSync(join(installDir, 'install.sh.tmpl'), 'utf8'),
  ps1Template: readFileSync(join(installDir, 'install.ps1.tmpl'), 'utf8'),
  ...overrides,
});

describe('backfillTag', () => {
  test('writes both scripts for a release with all five checksums', async () => {
    expect(await backfillTag(makeDeps(), 'v0.9.7')).toEqual({
      tag: 'v0.9.7',
      status: 'written',
      files: ['/out/v0.9.7/install.sh', '/out/v0.9.7/install.ps1'],
    });
  });

  test('fills the script with the tag version and the resolved commit', async () => {
    const written = await backfillTag(
      makeDeps({ writeScripts: (_tag, scripts) => [scripts.sh] }),
      'v0.9.7',
    );
    expect(written.status === 'written' ? written.files[0] : '').toContain(`# Capy 0.9.7, ${commit}`);
  });

  test('downloads checksums-<version>.txt from the tag', async () => {
    expect(checksumsUrl('v0.9.7', '0.9.7')).toBe(
      'https://github.com/capysc/capy-cli/releases/download/v0.9.7/checksums-0.9.7.txt',
    );
  });

  test('skips a release without a checksums file', async () => {
    const outcome = await backfillTag(makeDeps({ fetchText: async () => ({ status: 404, text: '' }) }), 'v0.9.0');
    expect(outcome).toMatchObject({ status: 'skipped', code: 'CHECKSUMS_FILE_MISSING' });
  });

  test('skips when the download fails', async () => {
    expect(await backfillTag(makeDeps({ fetchText: async () => ({ status: 500, text: '' }) }), 'v0.9.7')).toMatchObject({
      status: 'skipped',
      code: 'CHECKSUMS_FETCH_FAILED',
    });
    const rejecting = makeDeps({
      fetchText: async () => {
        throw new Error('offline');
      },
    });
    expect(await backfillTag(rejecting, 'v0.9.7')).toMatchObject({ status: 'skipped', code: 'CHECKSUMS_FETCH_FAILED' });
  });

  test('skips a release that lacks one of the five archives', async () => {
    const outcome = await backfillTag(
      makeDeps({ fetchText: async () => ({ status: 200, text: checksumsFor('0.9.7', ['SHA256_WIN_X64']) }) }),
      'v0.9.7',
    );
    expect(outcome).toMatchObject({ status: 'skipped', code: 'CHECKSUM_MISSING' });
  });

  test('skips an unknown tag and a badly named tag', async () => {
    expect(await backfillTag(makeDeps({ resolveCommit: () => undefined }), 'v9.9.9')).toMatchObject({
      status: 'skipped',
      code: 'TAG_NOT_FOUND',
    });
    expect(await backfillTag(makeDeps(), 'latest')).toMatchObject({ status: 'skipped', code: 'BAD_TAG' });
  });

  test('reports every tag, in order, and formats one line each', async () => {
    const outcomes = await backfillTags(makeDeps(), ['v0.9.7', 'nope']);
    expect(outcomes.map((outcome) => outcome.tag)).toEqual(['v0.9.7', 'nope']);
    expect(outcomes.map(formatOutcome)).toEqual([
      'v0.9.7\twritten\t/out/v0.9.7/install.sh /out/v0.9.7/install.ps1',
      'nope\tskipped\tBAD_TAG\ta tag looks like v0.9.7',
    ]);
  });
});

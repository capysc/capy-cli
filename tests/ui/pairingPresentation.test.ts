import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync } from 'fs';
import { mkdtemp, readFile, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { PAIRING_PRESENTATION, PAIRING_QR_IMAGE_RULE, PAIR_LINK_INSTRUCTIONS, PAIR_LINK_TEXT_RULE, createPairingQrImage, removePairingQrImage } from '../../src/ui/pairingPresentation';
import { ELICITATION_HELP } from '../../src/ui/elicitation';
import { AGENTS_BLOCK } from '../../src/core/agentsBlockPlan';

describe('pairing QR image', () => {
  test('is an independently decodable PNG of exactly the URL, a 0600 file in a 0700 directory, and a data URI of the same bytes', async () => {
    const url = 'https://keep.capy.sc/device?code=ABCD-EFGH';
    const image = await createPairingQrImage(url);
    try {
      const bytes = await readFile(image.file);
      const png = PNG.sync.read(bytes);
      expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(url);
      expect(image.mime_type).toBe('image/png');
      expect(image.data_uri).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
      expect((await stat(image.file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(image.file))).mode & 0o777).toBe(0o700);
    } finally {
      removePairingQrImage(image.file);
    }
    expect(await stat(image.file).catch(() => null)).toBeNull();
    expect(await stat(path.dirname(image.file)).catch(() => null)).toBeNull();
  });

  test('removing a file that is already gone is not an error', async () => {
    const image = await createPairingQrImage('https://keep.capy.sc/device?code=ABCD-EFGH');
    removePairingQrImage(image.file);
    expect(() => removePairingQrImage(image.file)).not.toThrow();
  });

  test('removes only what createPairingQrImage makes: another file, or another directory, is left alone', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'not-ours-'));
    const other = path.join(directory, 'pair.png');
    await writeFile(other, 'x');
    removePairingQrImage(other);
    expect(await stat(other).catch(() => null)).not.toBeNull();
    const ours = await createPairingQrImage('https://keep.capy.sc/device?code=ABCD-EFGH');
    const sibling = path.join(path.dirname(ours.file), 'other.txt');
    await writeFile(sibling, 'x');
    removePairingQrImage(sibling);
    expect(await stat(sibling).catch(() => null)).not.toBeNull();
    removePairingQrImage(ours.file);
    expect(await stat(ours.file).catch(() => null)).toBeNull();
    // The directory still holds the sibling, so it stays (it is only removed when empty).
    expect(await stat(path.dirname(ours.file)).catch(() => null)).not.toBeNull();
    // The sibling keeps that directory, and the other directory is ours to make: take both out.
    rmSync(path.dirname(ours.file), { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('removePairingQrImage touches only its own file in the OS temp folder', () => {
  const realTemp = realpathSync(tmpdir());

  /** A victim file inside a fresh directory, and the cleanup of that directory; the directory is made under `parent`. */
  function victimIn(parent: string, directoryName: string, fileName: string): { readonly root: string; readonly file: string } {
    const root = mkdtempSync(path.join(parent, 'victim-'));
    const directory = path.join(root, directoryName);
    mkdirSync(directory);
    const file = path.join(directory, fileName);
    writeFileSync(file, 'victim');
    return { root, file };
  }
  const intact = (file: string): boolean => existsSync(file) && readFileSync(file, 'utf8') === 'victim';

  test('a genuine image is removed and reported removed; a second call reports nothing removed', async () => {
    const image = await createPairingQrImage('https://keep.capy.sc/device?code=ABCD-EFGH');
    expect(removePairingQrImage(image.file)).toBe(true);
    expect(existsSync(image.file)).toBe(false);
    expect(existsSync(path.dirname(image.file))).toBe(false);
    expect(removePairingQrImage(image.file)).toBe(false);
  });

  test('a directory named pair.png is not removed, and nothing throws', () => {
    const directory = mkdtempSync(path.join(realTemp, 'capy-pair-'));
    const blocker = path.join(directory, 'pair.png');
    mkdirSync(blocker);
    try {
      expect(removePairingQrImage(blocker)).toBe(false);
      expect(lstatSync(blocker).isDirectory()).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a file outside the temp folder is left alone, even with the right names', () => {
    const outside = mkdtempSync(path.join(process.cwd(), '.pairing-outside-'));
    try {
      const { file } = victimIn(outside, 'capy-pair-x', 'pair.png');
      expect(removePairingQrImage(file)).toBe(false);
      expect(intact(file)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a capy-pair- directory that is not a direct child of the temp folder is left alone', () => {
    const nested = mkdtempSync(path.join(realTemp, 'elsewhere-'));
    try {
      const { file } = victimIn(nested, 'capy-pair-x', 'pair.png');
      expect(removePairingQrImage(file)).toBe(false);
      expect(intact(file)).toBe(true);
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  test('a relative path is left alone, even when it resolves to a qualifying file', () => {
    const directory = mkdtempSync(path.join(realTemp, 'capy-pair-'));
    try {
      const file = path.join(directory, 'pair.png');
      writeFileSync(file, 'victim');
      const relative = path.relative(process.cwd(), file);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(removePairingQrImage(relative)).toBe(false);
      expect(intact(file)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a symlinked directory is left alone, whether it points outside the temp folder or at another capy-pair- directory', () => {
    const outside = mkdtempSync(path.join(realTemp, 'elsewhere-'));
    const sibling = mkdtempSync(path.join(realTemp, 'capy-pair-'));
    const toOutside = path.join(realTemp, `capy-pair-link-${path.basename(outside)}`);
    const toSibling = path.join(realTemp, `capy-pair-link-${path.basename(sibling)}`);
    try {
      const victim = victimIn(outside, 'capy-pair-x', 'pair.png');
      symlinkSync(path.dirname(victim.file), toOutside);
      writeFileSync(path.join(sibling, 'pair.png'), 'victim');
      symlinkSync(sibling, toSibling);
      expect(removePairingQrImage(path.join(toOutside, 'pair.png'))).toBe(false);
      expect(removePairingQrImage(path.join(toSibling, 'pair.png'))).toBe(false);
      expect(intact(victim.file)).toBe(true);
      expect(intact(path.join(sibling, 'pair.png'))).toBe(true);
    } finally {
      rmSync(toOutside, { force: true });
      rmSync(toSibling, { force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test('a pair.png that is a symlink is left alone, and so is what it points at', () => {
    const outside = mkdtempSync(path.join(realTemp, 'elsewhere-'));
    const directory = mkdtempSync(path.join(realTemp, 'capy-pair-'));
    try {
      const victim = path.join(outside, 'victim.txt');
      writeFileSync(victim, 'victim');
      const link = path.join(directory, 'pair.png');
      symlinkSync(victim, link);
      expect(removePairingQrImage(link)).toBe(false);
      expect(intact(victim)).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a name that does not match is left alone: another file name, or another directory prefix', () => {
    const anotherFile = mkdtempSync(path.join(realTemp, 'capy-pair-'));
    const anotherDirectory = mkdtempSync(path.join(realTemp, 'not-ours-'));
    try {
      writeFileSync(path.join(anotherFile, 'other.png'), 'victim');
      writeFileSync(path.join(anotherDirectory, 'pair.png'), 'victim');
      expect(removePairingQrImage(path.join(anotherFile, 'other.png'))).toBe(false);
      expect(removePairingQrImage(path.join(anotherDirectory, 'pair.png'))).toBe(false);
      expect(intact(path.join(anotherFile, 'other.png'))).toBe(true);
      expect(intact(path.join(anotherDirectory, 'pair.png'))).toBe(true);
    } finally {
      rmSync(anotherFile, { recursive: true, force: true });
      rmSync(anotherDirectory, { recursive: true, force: true });
    }
  });
});

describe('pairing contract', () => {
  const text = PAIRING_PRESENTATION.instructions.join('\n');

  test('names the one command and the QR order: image, then text in a real terminal, then say it cannot be shown', () => {
    expect(PAIRING_PRESENTATION.command).toBe('capy pair --json');
    expect(text.indexOf('show the PNG')).toBeGreaterThan(-1);
    expect(text.indexOf('show `qr.text` only if your client is a real terminal')).toBeGreaterThan(text.indexOf('show the PNG'));
    expect(text.indexOf('say plainly that the QR cannot be shown here')).toBeGreaterThan(text.indexOf('qr.text'));
    expect(text).toContain('Never send the pairing link to an external QR service.');
  });

  test('says the same thing as the agents block, the elicitation help and the README: no email is asked, show url, code and expires_at, how the wait is repeated, the mismatch, the sign-in-only result', () => {
    const readme = readFileSync(path.join(import.meta.dir, '../../README.md'), 'utf8');
    const readmeSection = readme.slice(readme.indexOf('### Pairing from an agent'), readme.indexOf('## Syncing'));
    expect(text).toContain('without asking the human anything first');
    expect(text).not.toMatch(/email/i);
    expect(text).toContain('Always show the human its `url`, `code`, `fingerprint` and `expires_at`.');
    expect(text).toContain('Run it again whenever it exits 3 with PAIR_STILL_WAITING');
    // CAP-900: the link always reaches the human as text, in the same sentence everywhere; the QR is only an addition.
    for (const source of [text, AGENTS_BLOCK, PAIR_LINK_INSTRUCTIONS, readmeSection.replace(/\s*\n\s*/g, ' ')]) {
      expect(source).toContain(PAIR_LINK_TEXT_RULE);
    }
    expect(PAIR_LINK_INSTRUCTIONS.startsWith(PAIR_LINK_TEXT_RULE)).toBe(true);
    // The other two places an agent learns how to show a link say the same: the elicitation help and `capy pair --help`.
    expect(ELICITATION_HELP).toContain('write the `url` as a clickable link');
    expect(ELICITATION_HELP).toContain('only an addition, never the only way');
    const cli = readFileSync(path.join(import.meta.dir, '../../src/index.ts'), 'utf8');
    const pairHelp = cli.slice(cli.indexOf('Agents: run `capy pair --json`'), cli.indexOf('\n', cli.indexOf('Agents: run `capy pair --json`')));
    expect(pairHelp).toContain('write the url as a clickable link, with the code, fingerprint and expires_at, as plain text');
    expect(pairHelp).toContain('PAIR_LINK_RENEWED');
    expect(PAIR_LINK_TEXT_RULE).toContain('clickable link');
    expect(PAIR_LINK_TEXT_RULE).toContain('never the only way');
    // CAP-899: one wait can take up to 9 minutes, and every source says to give it a long enough tool timeout.
    for (const source of [text, AGENTS_BLOCK, ELICITATION_HELP, PAIR_LINK_INSTRUCTIONS]) {
      expect(source).toContain('up to 9 minutes');
      expect(source).toContain('tool timeout of at least 10 minutes');
    }
    expect(readmeSection.replace(/\s+/g, ' ')).toContain('give it a tool timeout of at least 10 minutes');
    const help = readFileSync(path.join(import.meta.dir, '../../src/index.ts'), 'utf8');
    const waitHelp = help.slice(help.indexOf(".option('--wait'"), help.indexOf('\n', help.indexOf(".option('--wait'")));
    expect(waitHelp).toContain('up to 9 minutes');
    expect(waitHelp).toContain('tool timeout of at least 10 minutes');
    expect(text).toContain('"keys": "already_present"');
    expect(AGENTS_BLOCK).toContain('run `capy pair --json`. Do not ask the human anything first, and add no flags.');
    expect(AGENTS_BLOCK).not.toContain('--signup');
    expect(text).not.toContain('--signup');
    expect(AGENTS_BLOCK).toContain('show the human its `url`, `code`, `fingerprint` and `expires_at`');
    // CAP-877: the one-time code Keep shows the approver comes from the human, never from the agent.
    expect(text).toContain('PAIR_CODE_REQUIRED');
    expect(text).toContain('Never fill in the code yourself');
    expect(AGENTS_BLOCK).toContain('capy pair --wait --code <code>');
    expect(AGENTS_BLOCK).toContain('Never fill in the code yourself');
    expect(AGENTS_BLOCK).not.toContain('email will approve');
    expect(ELICITATION_HELP).toContain('PAIR_CODE_REQUIRED');
    expect(readmeSection).toContain('capy pair --wait --code <code>');
    expect(AGENTS_BLOCK).toContain('"keys": "already_present"');
    expect(ELICITATION_HELP).toContain('write the `url` as a clickable link, with the `code`, the `fingerprint` (the page shows the same one) and `expires_at`, as plain text');
    expect(readmeSection).toContain('Run `capy pair --json` without asking the human anything first, and add no');
    expect(readmeSection).not.toContain('PAIR_ACCOUNT_MISMATCH');
    expect(readmeSection).toContain('`"keys": "already_present"`');
  });

  // CAP-888: in run 7 the agent followed "attach or send `qr.image.file`" and the human got a file they could not scan,
  // while the AGENTS block said to show the image inline. The three texts must carry one rule, word for word.
  test('the AGENTS block, conventions.pairing and the README all say to show the QR inline as an image, and none says to attach the file', () => {
    const readme = readFileSync(path.join(import.meta.dir, '../../README.md'), 'utf8');
    const readmeSection = readme.slice(readme.indexOf('### Pairing from an agent'), readme.indexOf('## Syncing'));
    const flat = (s: string): string => s.replace(/\s+/g, ' ');
    expect(PAIRING_QR_IMAGE_RULE).toContain('show the PNG inline with `qr.image.data_uri` as the image source');
    expect(PAIRING_QR_IMAGE_RULE).toContain('An attached file, a download link or a file path is not showing the QR.');
    for (const source of [text, AGENTS_BLOCK, flat(readmeSection)]) {
      expect(source).toContain(PAIRING_QR_IMAGE_RULE);
      expect(source).not.toMatch(/attach or send/i);
      expect(source).not.toMatch(/\battach (the|`qr\.image\.file`)/i);
      // The image comes before the terminal text.
      expect(source.indexOf(PAIRING_QR_IMAGE_RULE)).toBeLessThan(source.indexOf('`qr.text` only'));
    }
  });

  test('the PNG stays scannable on any theme: opaque black on white, at least 256 px, decoding to the link', async () => {
    const url = 'https://staging-keep.capy.sc/transport/pair?code=Z400-2MWM';
    const image = await createPairingQrImage(url);
    try {
      const png = PNG.sync.read(await readFile(image.file));
      expect(png.width).toBeGreaterThanOrEqual(256);
      expect(png.height).toBe(png.width);
      const colors = new Set<string>();
      for (let i = 0; i < png.data.length; i += 4) {
        expect(png.data[i + 3]).toBe(255);
        colors.add(`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`);
      }
      expect([...colors].sort()).toEqual(['0,0,0', '255,255,255']);
      // The quiet zone: the corner pixel is white, so the code stands out on a dark chat background.
      expect([png.data[0], png.data[1], png.data[2]]).toEqual([255, 255, 255]);
      expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(url);
    } finally {
      removePairingQrImage(image.file);
    }
  });

  test('no longer describes the removed long-running handoff', () => {
    expect(text).not.toContain('Keep this command running');
    expect(text).not.toContain('The account is not known yet');
    expect(text).not.toContain('pairing_required');
    expect(text).not.toContain('Never auto-confirm');
  });
});

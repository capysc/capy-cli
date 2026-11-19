import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { PAIRING_PRESENTATION, createPairingQrImage, removePairingQrImage } from '../../src/ui/pairingPresentation';

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
  });
});

describe('pairing contract', () => {
  const text = PAIRING_PRESENTATION.instructions.join('\n');

  test('names the one command and the QR order: image, then text in a real terminal, then say it cannot be shown', () => {
    expect(PAIRING_PRESENTATION.command).toBe('capy pair --email <email> --json');
    expect(text.indexOf('show the PNG')).toBeGreaterThan(-1);
    expect(text.indexOf('show `qr.text` only if your client is a real terminal')).toBeGreaterThan(text.indexOf('show the PNG'));
    expect(text.indexOf('say plainly that the QR cannot be shown here')).toBeGreaterThan(text.indexOf('qr.text'));
    expect(text).toContain('Never send the pairing link to an external QR service.');
  });

  test('no longer describes the removed long-running handoff', () => {
    expect(text).not.toContain('Keep this command running');
    expect(text).not.toContain('The account is not known yet');
    expect(text).not.toContain('pairing_required');
    expect(text).not.toContain('Never auto-confirm');
  });
});

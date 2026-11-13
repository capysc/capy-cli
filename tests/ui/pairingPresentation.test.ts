import { describe, expect, test } from 'bun:test';
import { readFile, stat } from 'fs/promises';
import path from 'path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { createPairingHandoff, removePairingHandoff } from '../../src/ui/pairingPresentation';

describe('pairing presentation contract', () => {
  test('returns an independently decodable PNG plus complete metadata and display instructions', async () => {
    const url = 'https://keep.capy.sc/device?code=ABCD-EFGH';
    const handoff = await createPairingHandoff({
      approvalUrl: url,
      userCode: 'ABCD-EFGH',
      expiresInSeconds: 600,
      requestedAtMs: Date.parse('2026-11-13T12:00:00Z'),
    });
    try {
      const png = PNG.sync.read(await readFile(handoff.qr.file));
      const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
      expect(decoded?.data).toBe(url);
      expect(handoff.qr.data_uri).toBe(`data:image/png;base64,${(await readFile(handoff.qr.file)).toString('base64')}`);
      expect(handoff.event).toBe('pairing_required');
      expect(handoff.status).toBe('pending');
      expect(handoff.expires_at).toBe('2026-11-13T12:10:00.000Z');
      expect(handoff.account.status).toBe('not_yet_confirmed');
      expect(handoff.display.markdown).toContain(`![Scan to pair this runtime](<${handoff.qr.file}>)`);
      expect(handoff.display.markdown).toContain(`[Approve pairing](${url})`);
      expect(handoff.display.markdown).toContain('ABCD-EFGH');
      expect(handoff.display.markdown).toContain(handoff.expires_at);
      expect(handoff.display.markdown).toContain(handoff.purpose);
      expect(handoff.display.markdown).toContain(handoff.runtime.hostname);
      expect(handoff.agent_instructions.join('\n')).toContain('Do not return only a link and code.');
      expect(handoff.agent_instructions.join('\n')).toContain('Never auto-confirm.');
      expect(handoff.agent_instructions.join('\n')).toContain('remote runtime');
      expect(handoff.agent_instructions.join('\n')).toContain('cannot display images');
      expect((await stat(handoff.qr.file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(handoff.qr.file))).mode & 0o777).toBe(0o700);
    } finally {
      await removePairingHandoff(handoff);
    }
    expect(await stat(handoff.qr.file).catch(() => null)).toBeNull();
  });
});

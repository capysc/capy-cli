import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPairingPresentation, pairingQrPng } from '../../src/ui/pairingPresentation';

describe('agent pairing handoff', () => {
  const url = 'https://staging-keep.capy.sc/device?code=ABCD-EFGH';
  test('renders an actual PNG for the current device route', () => {
    const png = pairingQrPng(url);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20));
  });
  test('carries purpose, canonical link, QR image, code and service expiry together', () => {
    const expiresAt = '2026-10-11T01:45:53.670Z';
    const result = createPairingPresentation(url, 'ABCD-EFGH', { purpose: 'Pair this CLI.', expiresAt, expiresInSeconds: 600 });
    try {
      expect(result.expiresAt).toBe(expiresAt);
      expect(result.presentation.markdown).toContain(`Access through: [Open in Keep](${url})`);
      expect(result.presentation.markdown).toContain(`![Pair with Capy](${result.qrCode.path})`);
      expect(result.presentation.markdown).toContain('Verification code: ABCD-EFGH');
      expect(result.presentation.markdown).toContain('Purpose: Pair this CLI.');
      expect(result.presentation.markdown).toContain(`Expires: ${expiresAt}`);
      expect(readFileSync(result.qrCode.path).subarray(0, 8)).toEqual(pairingQrPng(url).subarray(0, 8));
      expect(result.presentation.instructions).toContain('End the turn');
    } finally {
      rmSync(dirname(result.qrCode.path), { recursive: true });
    }
  });
  test('uses the issued TTL when an older service omits an absolute expiry', () => {
    const result = createPairingPresentation(url, 'ABCD-EFGH', { purpose: 'Pair this CLI.', expiresInSeconds: 600 });
    try {
      expect(result).not.toHaveProperty('expiresAt');
      expect(result.presentation.markdown).toContain('Expires in: 600 seconds');
    } finally {
      rmSync(dirname(result.qrCode.path), { recursive: true });
    }
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { buildTerminalQr } from './terminalQr';

const word = (value: number): Buffer => Buffer.from([
  value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255,
]);
const crcBit = (value: number): number => (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
const crcByte = (value: number): number => Array.from({ length: 8 }).reduce<number>(crcBit, value);
const chunk = (type: string, data: Buffer): Buffer => {
  const content = Buffer.concat([Buffer.from(type), data]);
  const crc = [...content].reduce((value, byte) => crcByte(value ^ byte), 0xffffffff) ^ 0xffffffff;
  return Buffer.concat([word(data.length), content, word(crc >>> 0)]);
};

/** Rasterize the existing encoder, including a four-module quiet zone. */
export const pairingQrPng = (url: string): Buffer => {
  const qr = buildTerminalQr(url);
  const lines = qr.text.trimEnd().split('\n');
  const modules = qr.width - 2;
  const scale = 6;
  const width = (modules + 8) * scale;
  const pixels = Buffer.from(Array.from({ length: width * (width + 1) }, (_, index) => {
    const x = index % (width + 1);
    if (x === 0) return 0;
    const column = Math.floor((x - 1) / scale) - 4;
    const row = Math.floor(Math.floor(index / (width + 1)) / scale) - 4;
    if (column < 0 || row < 0 || column >= modules || row >= modules) return 255;
    const cell = lines[Math.floor(row / 2) + 1]?.[column + 1];
    const black = cell === ' ' || cell === (row % 2 === 0 ? '▄' : '▀');
    return black ? 0 : 255;
  }));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.concat([word(width), word(width), Buffer.from([8, 0, 0, 0, 0])])),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

export const createPairingPresentation = (url: string, userCode: string, details: Readonly<{
  purpose: string;
  expiresInSeconds: number;
  expiresAt?: string;
}>) => {
  const path = join(mkdtempSync(join(tmpdir(), 'capy-pairing-')), 'pairing.png');
  writeFileSync(path, pairingQrPng(url), { mode: 0o600 });
  const accessThrough = `Access through: [Open in Keep](${url})`;
  const expiry = details.expiresAt ? `Expires: ${details.expiresAt}` : `Expires in: ${details.expiresInSeconds} seconds`;
  return {
    accessThrough,
    ...details,
    qrCode: { path, mimeType: 'image/png' as const },
    presentation: {
      markdown: `Purpose: ${details.purpose}\n\n![Pair with Capy](${path})\n\n${accessThrough}\n\nVerification code: ${userCode}\n\n${expiry}`,
      instructions: 'Return the purpose, QR image, Access through link, verification code and expiry in a finished chat message immediately. End the turn and wait for the user. Keep this CLI process alive; do not run setup or additional polling commands before handing off.',
    },
  } as const;
};

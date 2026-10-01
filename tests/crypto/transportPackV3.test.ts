/**
 * Transport link v3 (CAP-692) — packed binary payload.
 *
 * 1. Reproduces the shared test vector (`transport-v3-vector.json`, fake
 *    keys) exactly: sealing the vector's inputs with its fixed S/iv must
 *    give byte-for-byte the same `fragment`, and opening that fragment must
 *    give back the same inputs and the same `key_enc_file` string.
 * 2. A REAL round trip through `saveMasterKey`/`readOrgKeyFileRaw` (the
 *    property, not shape): generate a master key, write it for real, pack →
 *    seal → open → unpack, and check the rebuilt `key.enc` is byte-identical
 *    to the raw file AND that decrypting it with k_local recovers the
 *    original master key.
 * 3. Each listed fallback condition packs to `null` (v2 link).
 * 4. Tampering (a flipped byte, or the wrong transport id) fails to open.
 * 5. A realistic v3 URL fits in 520 chars and its QR fits a 42-row terminal.
 */
import { describe, test, expect } from 'bun:test';
import { randomBytes, createDecipheriv } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packTransportV3,
  unpackTransportV3,
  sealTransportV3,
  openTransportV3,
} from '../../src/crypto/transportPackV3';
import type { PairingEntry } from '../../src/crypto/pairingPayload';
import { buildTerminalQr } from '../../src/ui/terminalQr';

// --- Shared vector (fake keys) — see CAP-692 / transport-v3-vector.mjs ---
const VECTOR = {
  transport_id: '213a6f14-41e0-4e52-9e62-28c784dfab53',
  org_id: '07f81eaa-d4fa-4dde-914f-49636a0e5d5a',
  user_id: 'user_01M3CVHW1TQPTXGWJCS2GGQ4QQ',
  k_local_b64url: 'ERERERERERERERERERERERERERERERERERERERERERE',
  key_enc_file:
    '{\n  "version": "2.0",\n  "org_id": "07f81eaa-d4fa-4dde-914f-49636a0e5d5a",\n  "encrypted_master_key": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX",\n  "wrapping_method": "local_root",\n  "created_at": "2026-09-29T17:52:03.123Z"\n}',
  S_b64url: 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI',
  iv_b64url: 'MzMzMzMzMzMzMzMz',
  fragment:
    '3.ITpvFEHgTlKeYijHhN-rUw.MzMzMzMzMzMzMzMzd8LBEmuGopJFMwo_XLJnnHj7aieBCJnLt2LwhNJHo3YZH75G4CrFlVa8JOPGv63bkYy4mOePrBCqQxXJqD8LCw7ObdXWbjvZumfkAFdAXQVKboetliFPBHetzsKAvWC3on4vZ4ZHtcq6l9RnZ95GA3jSo7cDuq5rI3VYmzfZOuVldBfxC5GW43TF9v_gw9GIVk-hkReZMQ7W3LbmtMcFs63Rx8VgDAaCyNnm-7TrbNrugtRW3q2p1ZhqVfPYV2iSpSvHXh5wl82lEV2J1ux1HpLB6RJQZpzmEK0YRrMQrBOdWA4iEYaPn-yj_56zV4oYvc2D0SeOw-zHUIRmnXEQlf-xCgRdLydHSg2rXUVZkQnZ6_LnC8C3Zrtd41GWSD5Wm_PDa-HEwaZbBsFRizjY_N2s',
};

function vectorEntry(): PairingEntry {
  return {
    org_id: VECTOR.org_id,
    user_id: VECTOR.user_id,
    k_local: VECTOR.k_local_b64url,
    key_enc: VECTOR.key_enc_file,
  };
}

describe('shared test vector', () => {
  test('sealing the vector inputs with its fixed S/iv reproduces the exact fragment', () => {
    const packed = packTransportV3(vectorEntry());
    expect(packed).not.toBeNull();
    const S = Buffer.from(VECTOR.S_b64url, 'base64url');
    const iv = Buffer.from(VECTOR.iv_b64url, 'base64url');
    const fragment = sealTransportV3(packed as Buffer, S, VECTOR.transport_id, iv);
    expect(fragment).toBe(VECTOR.fragment);
  });

  test('opening the vector fragment reproduces the exact inputs and key_enc_file string', () => {
    const S = Buffer.from(VECTOR.S_b64url, 'base64url');
    const { id, plaintext } = openTransportV3(VECTOR.fragment, S);
    expect(id).toBe(VECTOR.transport_id);
    const entry = unpackTransportV3(plaintext);
    expect(entry.org_id).toBe(VECTOR.org_id);
    expect(entry.user_id).toBe(VECTOR.user_id);
    expect(entry.k_local).toBe(VECTOR.k_local_b64url);
    expect(entry.key_enc).toBe(VECTOR.key_enc_file);
  });
});

// --- Real round trip through the real saveMasterKey/readOrgKeyFileRaw ---

describe('real round trip (property, not shape)', () => {
  test('pack -> seal -> open -> unpack rebuilds key.enc byte-for-byte and decrypts to the original master key', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'capy-transport-v3-'));
    const prevHome = process.env.HOME;
    const prevGlobalDirName = process.env.CAPY_GLOBAL_DIR_NAME;
    process.env.HOME = tmpHome;
    delete process.env.CAPY_GLOBAL_DIR_NAME;
    try {
      // Re-import so getGlobalCapyDir() (which reads homedir() lazily, but
      // os.homedir() itself is cached by some platforms) resolves under the
      // temp HOME — globalConfig re-reads env/homedir on every call per its
      // own header comment, so a fresh dynamic import is not required, but
      // doing it anyway keeps this test independent of import order.
      const { saveMasterKey, readOrgKeyFileRaw, saveLocalRoot, readLocalRoot } = await import(
        '../../src/config/globalConfig'
      );

      const orgId = '9f1c2b3a-0000-4000-8000-000000000001';
      const userId = `user_${'01ARZ3NDEKTSV4RRFFQ69G5FAV'}`;
      const masterKey = randomBytes(32);
      const kLocal = randomBytes(32);

      // A realistic `encrypted_master_key`: AES-256-GCM(masterKey) under
      // kLocal — this is what local_root wrapping actually produces (iv +
      // ciphertext + tag, base64).
      const { createCipheriv } = await import('node:crypto');
      const encIv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', kLocal, encIv, { authTagLength: 16 });
      const ct = Buffer.concat([cipher.update(masterKey), cipher.final()]);
      const tag = cipher.getAuthTag();
      const encryptedBlob = Buffer.concat([encIv, ct, tag]).toString('base64');

      saveLocalRoot(orgId, kLocal, userId);
      saveMasterKey(orgId, encryptedBlob, userId);

      const rawFile = readOrgKeyFileRaw(orgId, userId);
      expect(rawFile).not.toBeNull();
      const storedKLocal = readLocalRoot(orgId, userId);
      expect(storedKLocal).not.toBeNull();

      const entry: PairingEntry = {
        org_id: orgId,
        user_id: userId,
        k_local: (storedKLocal as Buffer).toString('base64url'),
        key_enc: rawFile as string,
      };

      const packed = packTransportV3(entry);
      expect(packed).not.toBeNull();

      const S = randomBytes(32);
      const transportId = '213a6f14-41e0-4e52-9e62-28c784dfab53';
      const fragment = sealTransportV3(packed as Buffer, S, transportId);

      const opened = openTransportV3(fragment, S);
      expect(opened.id).toBe(transportId);
      const rebuiltEntry = unpackTransportV3(opened.plaintext);

      expect(rebuiltEntry.key_enc).toBe(rawFile);
      expect(rebuiltEntry.org_id).toBe(orgId);
      expect(rebuiltEntry.user_id).toBe(userId);
      expect(rebuiltEntry.k_local).toBe(entry.k_local);

      // Decrypt the rebuilt key.enc's encrypted_master_key with k_local and
      // check it recovers the exact original master key — the actual
      // property this whole pipeline exists to preserve.
      const rebuiltParsed = JSON.parse(rebuiltEntry.key_enc) as { encrypted_master_key: string };
      const rebuiltBlob = Buffer.from(rebuiltParsed.encrypted_master_key, 'base64');
      const rebuiltIv = rebuiltBlob.subarray(0, 12);
      const rebuiltTag = rebuiltBlob.subarray(rebuiltBlob.length - 16);
      const rebuiltCt = rebuiltBlob.subarray(12, rebuiltBlob.length - 16);
      const rebuiltKLocal = Buffer.from(rebuiltEntry.k_local, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', rebuiltKLocal, rebuiltIv, { authTagLength: 16 });
      decipher.setAuthTag(rebuiltTag);
      const decrypted = Buffer.concat([decipher.update(rebuiltCt), decipher.final()]);
      expect(decrypted.equals(masterKey)).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevGlobalDirName === undefined) delete process.env.CAPY_GLOBAL_DIR_NAME;
      else process.env.CAPY_GLOBAL_DIR_NAME = prevGlobalDirName;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// --- Fallback cases: each must pack to null ---

describe('fallback to v2 (packTransportV3 returns null)', () => {
  function baseEntry(): PairingEntry {
    return vectorEntry();
  }

  test('non-ULID user id', () => {
    const entry = { ...baseEntry(), user_id: 'user_not-a-ulid-at-all' };
    expect(packTransportV3(entry)).toBeNull();
  });

  test('wrapping_method other than local_root', () => {
    const parsed = JSON.parse(baseEntry().key_enc);
    const key_enc = JSON.stringify({ ...parsed, wrapping_method: 'passphrase' }, null, 2);
    expect(packTransportV3({ ...baseEntry(), key_enc })).toBeNull();
  });

  test('version other than 2.0', () => {
    const parsed = JSON.parse(baseEntry().key_enc);
    const key_enc = JSON.stringify({ ...parsed, version: '1.0' }, null, 2);
    expect(packTransportV3({ ...baseEntry(), key_enc })).toBeNull();
  });

  test('non-canonical base64 in encrypted_master_key', () => {
    const parsed = JSON.parse(baseEntry().key_enc);
    // "QQ" decodes leniently (Node pads missing bits) to one byte, but its
    // OWN canonical re-encoding is "QQ==" (with padding) — not equal to
    // "QQ", so the canonical-base64 gate correctly rejects it.
    const key_enc = JSON.stringify({ ...parsed, encrypted_master_key: 'QQ' }, null, 2);
    expect(packTransportV3({ ...baseEntry(), key_enc })).toBeNull();
  });

  test('created_at with non-ms (sub-millisecond-losing) precision mismatch', () => {
    const parsed = JSON.parse(baseEntry().key_enc);
    // A created_at string Date.parse normalizes differently on re-stringify
    // (missing milliseconds -> toISOString() always adds .000, so this
    // never matches the gate's created_at === new Date(ms).toISOString()).
    const key_enc = JSON.stringify({ ...parsed, created_at: '2026-09-29T17:52:03Z' }, null, 2);
    expect(packTransportV3({ ...baseEntry(), key_enc })).toBeNull();
  });

  test('extra field in the raw JSON file', () => {
    const parsed = JSON.parse(baseEntry().key_enc);
    const key_enc = JSON.stringify({ ...parsed, extra_field: 'surprise' }, null, 2);
    expect(packTransportV3({ ...baseEntry(), key_enc })).toBeNull();
  });

  test('reordered fields in the raw JSON file (same fields, different key order)', () => {
    const parsed = JSON.parse(baseEntry().key_enc);
    const key_enc = JSON.stringify(
      {
        org_id: parsed.org_id,
        version: parsed.version,
        wrapping_method: parsed.wrapping_method,
        encrypted_master_key: parsed.encrypted_master_key,
        created_at: parsed.created_at,
      },
      null,
      2,
    );
    expect(packTransportV3({ ...baseEntry(), key_enc })).toBeNull();
  });

  test('malformed (non-JSON) key.enc', () => {
    expect(packTransportV3({ ...baseEntry(), key_enc: 'not json at all' })).toBeNull();
  });
});

// --- Tamper tests ---

describe('tamper resistance', () => {
  test('flipping a byte in the blob fails to open', () => {
    const packed = packTransportV3(vectorEntry()) as Buffer;
    const S = randomBytes(32);
    const id = '213a6f14-41e0-4e52-9e62-28c784dfab53';
    const fragment = sealTransportV3(packed, S, id);
    const [v, idPart, blobPart] = fragment.split('.');
    const blobBytes = Buffer.from(blobPart, 'base64url');
    blobBytes[blobBytes.length - 1] ^= 0xff;
    const tampered = `${v}.${idPart}.${blobBytes.toString('base64url')}`;
    expect(() => openTransportV3(tampered, S)).toThrow();
  });

  test('using a different transport id fails to open (AAD binding)', () => {
    const packed = packTransportV3(vectorEntry()) as Buffer;
    const S = randomBytes(32);
    const id = '213a6f14-41e0-4e52-9e62-28c784dfab53';
    const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const fragment = sealTransportV3(packed, S, id);
    const [, , blobPart] = fragment.split('.');
    const otherIdBytes = Buffer.from(otherId.replace(/-/g, ''), 'hex').toString('base64url');
    const swapped = `3.${otherIdBytes}.${blobPart}`;
    expect(() => openTransportV3(swapped, S)).toThrow();
  });
});

// --- Size: a v3 URL fits a terminal ---

describe('size: v3 URL and QR fit a terminal', () => {
  test('a realistic v3 URL is <= 520 chars and its QR is <= 42 rows', () => {
    const packed = packTransportV3(vectorEntry()) as Buffer;
    const S = randomBytes(32);
    const id = '213a6f14-41e0-4e52-9e62-28c784dfab53';
    const fragment = sealTransportV3(packed, S, id);
    const url = `https://keep.capy.sc/transport#${fragment}`;
    expect(url.length).toBeLessThanOrEqual(520);

    const qr = buildTerminalQr(url);
    expect(qr.height).toBeLessThanOrEqual(42);
  });
});

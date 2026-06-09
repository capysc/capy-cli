// CAP-55 regression: multi-line secret values (PEM private keys, certs, JSON
// blobs) must round-trip byte-for-byte through the encrypted .env that backs
// `capy run` local mode. The cosmetic value snippet spliced around the
// ciphertext used to be able to embed a raw newline into the .env line, which
// dotenv truncates at — corrupting decryption of values whose leading bytes
// include a newline.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseDotenv } from 'dotenv';
import { FileManager } from '../../src/files/fileManager';
import { dotenvEscape } from '../../src/commands/exportCommand';

const PEM = readFileSync(join(__dirname, '../fixtures/rsa_test_key.pem'), 'utf-8');
const KEY = 'a'.repeat(64);

describe('multiline secrets round-trip through encrypted .env (CAP-55)', () => {
  let dir: string;
  let envPath: string;
  let fm: FileManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capy-multiline-'));
    envPath = join(dir, '.env');
    fm = new FileManager(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function roundtrip(vars: Record<string, string>): Record<string, string> {
    fm.writeEncryptedEnvFile(vars, KEY, envPath, null, 'main');
    return fm.readEncryptedEnvFile(KEY, envPath);
  }

  it('round-trips a real multi-line RSA PEM byte-for-byte', () => {
    const back = roundtrip({ RSA_KEY: PEM, OTHER: 'plainval' });
    expect(back.RSA_KEY).toBe(PEM);
    expect(back.OTHER).toBe('plainval');
  });

  it('keeps every encrypted variable on a single physical .env line', () => {
    fm.writeEncryptedEnvFile({ RSA_KEY: PEM }, KEY, envPath, null, 'main');
    const content = readFileSync(envPath, 'utf-8');
    const valueLines = content.split('\n').filter((l) => l.startsWith('RSA_KEY='));
    expect(valueLines.length).toBe(1);
  });

  it('round-trips a value whose leading bytes are newlines', () => {
    // The snippet preview takes the first chars of the value; a newline there
    // is exactly what used to corrupt the line.
    const val = '\n\n-----BEGIN-----\nbody\n-----END-----';
    const back = roundtrip({ LEADER: val });
    expect(back.LEADER).toBe(val);
  });

  it('round-trips a multi-line value containing "="', () => {
    const val = 'line1=foo\nline2=bar\nline3';
    const back = roundtrip({ KV: val });
    expect(back.KV).toBe(val);
  });

  // Vince's proposed test on the CAP-55 call: "have a .env file with multiple
  // lines". A multi-line secret authored in a *plaintext* .env must import
  // (read → encrypt) and decrypt back byte-for-byte. dotenv only preserves a
  // multi-line value when it is quoted, so the supported authoring form is a
  // double-quoted value (raw unquoted multi-line is truncated by dotenv itself).
  it('imports a quoted multi-line PEM from a plaintext .env and round-trips it', () => {
    // Author a plaintext .env the way a user migrating a key would (quoted).
    writeFileSync(envPath, `RSA_KEY=${dotenvEscape(PEM)}\nDB=postgres://u:p@h/d\n`, 'utf-8');

    // Import path: this is exactly what `capy` reads on first sync.
    const imported = fm.readEnvFile(envPath);
    expect(imported.RSA_KEY).toBe(PEM);

    // Encrypt it, then read it back — full local pipeline.
    fm.writeEncryptedEnvFile(imported, KEY, envPath, null, 'main');
    const back = fm.readEncryptedEnvFile(KEY, envPath);
    expect(back.RSA_KEY).toBe(PEM);
    expect(back.DB).toBe('postgres://u:p@h/d');
  });

  // `capy decrypt` writes .env.{branch}.decrypted; that file must be re-readable
  // as a faithful .env. Bare `KEY=value` lines truncated multi-line secrets.
  it('writes a decrypted multi-line value that dotenv can re-read faithfully', () => {
    const decrypted = { RSA_KEY: PEM, DB: 'postgres://u:p@h/d' };
    const content = Object.entries(decrypted)
      .map(([k, v]) => `${k}=${dotenvEscape(v)}`)
      .join('\n');
    const outPath = join(dir, '.env.main.decrypted');
    writeFileSync(outPath, content + '\n', 'utf-8');

    const reread = parseDotenv(readFileSync(outPath, 'utf-8'));
    expect(reread.RSA_KEY).toBe(PEM);
    expect(reread.DB).toBe('postgres://u:p@h/d');
  });
});

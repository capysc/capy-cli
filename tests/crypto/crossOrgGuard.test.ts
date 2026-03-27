import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { Encryptor } from '../../src/crypto/encryptor';
import { FileManager } from '../../src/files/fileManager';
import { deriveResourceId } from '../../src/crypto/resourceId';

describe('Cross-Org Exfiltration Guard', () => {
  const testDir = join(__dirname, '.test-cross-org');
  let fileManager: FileManager;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    fileManager = new FileManager(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('Encryptor.canDecrypt returns true for matching key', () => {
    const key = Encryptor.generateKey();
    const encrypted = Encryptor.encrypt('my-secret', key);
    expect(Encryptor.canDecrypt(encrypted, key)).toBe(true);
  });

  it('Encryptor.canDecrypt returns false for wrong key', () => {
    const keyA = Encryptor.generateKey();
    const keyB = Encryptor.generateKey();
    const encrypted = Encryptor.encrypt('my-secret', keyA);
    expect(Encryptor.canDecrypt(encrypted, keyB)).toBe(false);
  });

  it('writeEncryptedEnvFile rejects values encrypted with a foreign key', () => {
    const orgAKey = Encryptor.generateKey();
    const orgBKey = Encryptor.generateKey();

    // Encrypt a value with Org A's key
    const encrypted = Encryptor.encrypt('secret-value', orgAKey);
    const resourceId = deriveResourceId('', 'API_KEY');
    const orgAValue = `capy:${resourceId}:${encrypted}`;

    // Try to write it with Org B's key — should throw
    const variables = { API_KEY: orgAValue };
    expect(() => {
      fileManager.writeEncryptedEnvFile(variables, orgBKey);
    }).toThrow();
  });

  it('writeEncryptedEnvFile passes through values encrypted with the correct key', () => {
    const key = Encryptor.generateKey();

    // Encrypt a value with the correct key
    const encrypted = Encryptor.encrypt('secret-value', key);
    const resourceId = deriveResourceId('', 'API_KEY');
    const correctValue = `capy:${resourceId}:${encrypted}`;

    // Should not throw
    const variables = { API_KEY: correctValue };
    expect(() => {
      fileManager.writeEncryptedEnvFile(variables, key);
    }).not.toThrow();
  });

  it('writeEncryptedEnvFile encrypts plaintext values normally', () => {
    const key = Encryptor.generateKey();
    const variables = { API_KEY: 'plain-secret' };

    fileManager.writeEncryptedEnvFile(variables, key);

    // Read back and verify it's encrypted
    const raw = fileManager.readEnvFile();
    expect(raw.API_KEY).toMatch(/^capy:/);
  });

  it('readEncryptedEnvFile rejects capy: values encrypted with wrong key', () => {
    const orgAKey = Encryptor.generateKey();
    const orgBKey = Encryptor.generateKey();

    // Write an .env with values encrypted by Org A's key
    const encrypted = Encryptor.encrypt('secret-value', orgAKey);
    const resourceId = deriveResourceId('', 'DB_URL');
    const envContent = `DB_URL=capy:${resourceId}:${encrypted}\n`;
    writeFileSync(join(testDir, '.env'), envContent);

    // Try to read with Org B's key — should throw
    expect(() => {
      fileManager.readEncryptedEnvFile(orgBKey);
    }).toThrow();
  });

  it('decryptValue throws on capy: value with wrong key', () => {
    const orgAKey = Encryptor.generateKey();
    const orgBKey = Encryptor.generateKey();

    const encrypted = Encryptor.encrypt('secret', orgAKey);
    const resourceId = deriveResourceId('', 'KEY');
    const value = `capy:${resourceId}:${encrypted}`;

    // Should throw, not silently return the raw value
    expect(() => {
      fileManager.decryptValue(value, orgBKey);
    }).toThrow();
  });

  it('init flow rejects .env with capy: values encrypted for a different org', () => {
    const orgAKey = Encryptor.generateKey();
    const orgBKey = Encryptor.generateKey();
    const encrypted = Encryptor.encrypt('secret', orgAKey);
    const resourceId = deriveResourceId('', 'SECRET');

    const envContent = `SECRET=capy:${resourceId}:${encrypted}\nPLAINTEXT=hello\n`;
    writeFileSync(join(testDir, '.env'), envContent);

    const rawEnv = fileManager.readEnvFile();

    // Simulate init guard: check encrypted values against the NEW project's key
    const encryptedEntries = Object.entries(rawEnv)
      .filter(([_, value]) => value.startsWith('capy:'));
    const foreignKeys: string[] = [];
    for (const [key, value] of encryptedEntries) {
      try {
        fileManager.decryptValue(value, orgBKey);
      } catch {
        foreignKeys.push(key);
      }
    }

    expect(foreignKeys).toEqual(['SECRET']);
  });

  it('init flow allows .env with capy: values encrypted for the same org', () => {
    const orgAKey = Encryptor.generateKey();
    const encrypted = Encryptor.encrypt('secret', orgAKey);
    const resourceId = deriveResourceId('', 'SECRET');

    const envContent = `SECRET=capy:${resourceId}:${encrypted}\nPLAINTEXT=hello\n`;
    writeFileSync(join(testDir, '.env'), envContent);

    const rawEnv = fileManager.readEnvFile();

    // Same key — should pass (user lost metadata but re-inited to same project)
    const encryptedEntries = Object.entries(rawEnv)
      .filter(([_, value]) => value.startsWith('capy:'));
    const foreignKeys: string[] = [];
    for (const [key, value] of encryptedEntries) {
      try {
        fileManager.decryptValue(value, orgAKey);
      } catch {
        foreignKeys.push(key);
      }
    }

    expect(foreignKeys).toEqual([]);
  });
});

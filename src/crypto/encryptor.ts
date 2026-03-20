import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// Readable alphabet for resource IDs (no ambiguous chars: 0/O, 1/l/I)
const RESOURCE_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RESOURCE_ID_LENGTH = 5;

export class Encryptor {
  private static readonly algorithm = 'aes-256-gcm';
  private static readonly keyLength = 32;
  private static readonly ivLength = 12;
  private static readonly authTagLength = 16;
  private static readonly prefix = 'capy:';

  /**
   * Encrypts a value using AES-256-GCM with the provided key.
   * Format: capy:{resourceId}:{base64(iv + ciphertext + authTag)}
   */
  static encrypt(value: string, key: string, resourceId?: string): string {
    try {
      const id = resourceId ?? this.generateResourceId();
      const iv = randomBytes(this.ivLength);
      const derivedKey = this.deriveKey(key);

      const cipher = createCipheriv(this.algorithm, derivedKey, iv, {
        authTagLength: this.authTagLength,
      });
      const encrypted = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      const combined = Buffer.concat([iv, encrypted, authTag]);
      return `${this.prefix}${id}:${combined.toString('base64')}`;
    } catch (error) {
      throw new Error(`Failed to encrypt value: ${error}`);
    }
  }

  /**
   * Decrypts a value using AES-256-GCM with the provided key.
   * Expects format: capy:{resourceId}:{base64(iv + ciphertext + authTag)}
   */
  static decrypt(encryptedValue: string, key: string): string {
    try {
      if (!encryptedValue.startsWith(this.prefix)) {
        throw new Error('Invalid encrypted value format');
      }

      const afterPrefix = encryptedValue.slice(this.prefix.length);
      const colonIdx = afterPrefix.indexOf(':');
      if (colonIdx === -1) {
        throw new Error('Invalid encrypted value format: missing resource ID');
      }

      const base64Data = afterPrefix.slice(colonIdx + 1);
      const combined = Buffer.from(base64Data, 'base64');

      if (combined.length < this.ivLength + this.authTagLength) {
        throw new Error('Invalid encrypted value format');
      }

      const iv = combined.subarray(0, this.ivLength);
      const authTag = combined.subarray(combined.length - this.authTagLength);
      const encrypted = combined.subarray(this.ivLength, combined.length - this.authTagLength);

      const derivedKey = this.deriveKey(key);

      const decipher = createDecipheriv(this.algorithm, derivedKey, iv, {
        authTagLength: this.authTagLength,
      });
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);

      return decrypted.toString('utf8');
    } catch (error) {
      throw new Error(`Failed to decrypt value: ${error}`);
    }
  }

  /**
   * Derives a consistent key from the provided string
   */
  private static deriveKey(key: string): Buffer {
    return createHash('sha256').update(key).digest().subarray(0, this.keyLength);
  }

  /**
   * Generates a random encryption key
   */
  static generateKey(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Generates a readable 5-character resource ID for referencing in .keep files
   */
  static generateResourceId(): string {
    const bytes = randomBytes(RESOURCE_ID_LENGTH);
    let id = '';
    for (let i = 0; i < RESOURCE_ID_LENGTH; i++) {
      id += RESOURCE_ID_ALPHABET[bytes[i] % RESOURCE_ID_ALPHABET.length];
    }
    return id;
  }

  /**
   * Extracts the resource ID from an encrypted value
   */
  static extractResourceId(encryptedValue: string): string | null {
    if (!encryptedValue.startsWith(this.prefix)) return null;
    const afterPrefix = encryptedValue.slice(this.prefix.length);
    const colonIdx = afterPrefix.indexOf(':');
    if (colonIdx === -1) return null;
    return afterPrefix.slice(0, colonIdx);
  }

  /**
   * Checks if a value appears to be encrypted: capy:{resourceId}:{base64}
   */
  static isEncrypted(value: string): boolean {
    if (!value.startsWith(this.prefix)) return false;

    const afterPrefix = value.slice(this.prefix.length);
    const colonIdx = afterPrefix.indexOf(':');
    if (colonIdx === -1) return false;

    const base64Data = afterPrefix.slice(colonIdx + 1);
    if (!/^[A-Za-z0-9+/]+=*$/.test(base64Data)) return false;

    const decoded = Buffer.from(base64Data, 'base64');
    return decoded.length >= this.ivLength + this.authTagLength;
  }
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export class Encryptor {
  private static readonly algorithm = 'aes-256-gcm';
  private static readonly keyLength = 32;
  private static readonly ivLength = 12;
  private static readonly authTagLength = 16;

  /**
   * Encrypts a value using AES-256-GCM.
   * Returns base64(iv + ciphertext + authTag).
   */
  static encrypt(value: string, key: string): string {
    try {
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
      return combined.toString('base64');
    } catch (error) {
      throw new Error(`Failed to encrypt value: ${error}`);
    }
  }

  /**
   * Decrypts a base64(iv + ciphertext + authTag) value using AES-256-GCM.
   */
  static decrypt(encryptedValue: string, key: string): string {
    try {
      const combined = Buffer.from(encryptedValue, 'base64');

      if (combined.length < this.ivLength + this.authTagLength) {
        throw new Error('Encrypted payload too short');
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
   * Derives a consistent AES-256 key from the provided string.
   */
  private static deriveKey(key: string): Buffer {
    return createHash('sha256').update(key).digest().subarray(0, this.keyLength);
  }

  /**
   * Generates a random encryption key.
   */
  static generateKey(): string {
    return randomBytes(32).toString('hex');
  }
}

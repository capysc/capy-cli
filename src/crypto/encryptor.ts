import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export class Encryptor {
  private static readonly algorithm = 'aes-256-gcm';
  private static readonly keyLength = 32;
  private static readonly ivLength = 12;
  private static readonly authTagLength = 16;
  private static readonly prefix = 'capy:';

  /**
   * Encrypts a value using AES-256-GCM with the provided key
   */
  static encrypt(value: string, key: string): string {
    try {
      // Generate a random IV for each encryption
      const iv = randomBytes(this.ivLength);

      // Derive a proper key from the provided key
      const derivedKey = this.deriveKey(key);

      const cipher = createCipheriv(this.algorithm, derivedKey, iv, {
        authTagLength: this.authTagLength,
      });
      const encrypted = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      // Format: capy:base64(iv + ciphertext + authTag)
      const combined = Buffer.concat([iv, encrypted, authTag]);
      return this.prefix + combined.toString('base64');
    } catch (error) {
      throw new Error(`Failed to encrypt value: ${error}`);
    }
  }

  /**
   * Decrypts a value using AES-256-GCM with the provided key
   */
  static decrypt(encryptedValue: string, key: string): string {
    try {
      if (!encryptedValue.startsWith(this.prefix)) {
        throw new Error('Invalid encrypted value format');
      }

      const combined = Buffer.from(encryptedValue.slice(this.prefix.length), 'base64');

      if (combined.length < this.ivLength + this.authTagLength) {
        throw new Error('Invalid encrypted value format');
      }

      const iv = combined.subarray(0, this.ivLength);
      const authTag = combined.subarray(combined.length - this.authTagLength);
      const encrypted = combined.subarray(this.ivLength, combined.length - this.authTagLength);

      // Derive the same key
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
   * Checks if a value appears to be encrypted (capy: prefix with base64 data)
   */
  static isEncrypted(value: string): boolean {
    if (!value.startsWith(this.prefix)) return false;

    const data = value.slice(this.prefix.length);
    // Must be valid base64 and long enough to contain IV + auth tag at minimum
    if (!/^[A-Za-z0-9+/]+=*$/.test(data)) return false;

    const decoded = Buffer.from(data, 'base64');
    return decoded.length >= this.ivLength + this.authTagLength;
  }
}

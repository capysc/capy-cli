import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

export class Encryptor {
  private static readonly algorithm = 'aes-256-cbc';
  private static readonly keyLength = 32;
  private static readonly ivLength = 16;

  /**
   * Encrypts a value using AES-256-CBC with the provided key
   */
  static encrypt(value: string, key: string): string {
    try {
      // Generate a random IV for each encryption
      const iv = randomBytes(this.ivLength);
      
      // Derive a proper key from the provided key
      const derivedKey = this.deriveKey(key);
      
      const cipher = createCipheriv(this.algorithm, derivedKey, iv);
      let encrypted = cipher.update(value, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      // Prepend IV to the encrypted data
      return iv.toString('hex') + ':' + encrypted;
    } catch (error) {
      throw new Error(`Failed to encrypt value: ${error}`);
    }
  }

  /**
   * Decrypts a value using AES-256-CBC with the provided key
   */
  static decrypt(encryptedValue: string, key: string): string {
    try {
      // Split IV and encrypted data
      const parts = encryptedValue.split(':');
      if (parts.length !== 2) {
        throw new Error('Invalid encrypted value format');
      }
      
      const iv = Buffer.from(parts[0], 'hex');
      const encrypted = parts[1];
      
      // Derive the same key
      const derivedKey = this.deriveKey(key);
      
      const decipher = createDecipheriv(this.algorithm, derivedKey, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      throw new Error(`Failed to decrypt value: ${error}`);
    }
  }

  /**
   * Derives a consistent key from the provided string
   */
  private static deriveKey(key: string): Buffer {
    // Use a simple hash-based approach for consistent key derivation
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(key).digest().slice(0, this.keyLength);
  }

  /**
   * Generates a random encryption key
   */
  static generateKey(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Checks if a value appears to be encrypted (IV:encrypted format)
   */
  static isEncrypted(value: string): boolean {
    // Check for our IV:encrypted format
    const parts = value.split(':');
    if (parts.length !== 2) return false;
    
    // IV should be 32 hex chars (16 bytes), encrypted should be hex
    const ivPart = parts[0];
    const encryptedPart = parts[1];
    
    return /^[0-9a-f]{32}$/i.test(ivPart) && /^[0-9a-f]{16,}$/i.test(encryptedPart);
  }
}
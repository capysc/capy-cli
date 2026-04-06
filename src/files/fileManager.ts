import { readFileSync, writeFileSync, existsSync, appendFileSync, chmodSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { EnvVariable, KeepFile, DecryptKey, SyncState, CapyError, ERROR_CODES } from '../types/index';
import { parse as parseDotenv } from 'dotenv';
import { Encryptor } from '../crypto/encryptor';
import { deriveResourceId } from '../crypto/resourceId';

export class FileManager {
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
  }

  readEnvFile(path?: string): Record<string, string> {
    const envPath = path || join(this.projectRoot, '.env');

    if (!existsSync(envPath)) {
      return {};
    }

    try {
      const content = readFileSync(envPath, 'utf-8');
      return parseDotenv(content);
    } catch (error) {
      throw new CapyError(
        `Failed to read .env file at ${envPath}`,
        ERROR_CODES.PERMISSION_DENIED,
        { error, path: envPath }
      );
    }
  }

  readEnvMeta(path?: string): { org_id?: string; project_id?: string; branch?: string } {
    const envPath = path || join(this.projectRoot, '.env');
    if (!existsSync(envPath)) return {};

    const content = readFileSync(envPath, 'utf-8');
    const meta: { org_id?: string; project_id?: string; branch?: string } = {};
    for (const line of content.split('\n')) {
      if (!line.startsWith('# capy:')) break;
      const match = line.match(/^# capy:(\w+)=(.+)$/);
      if (match) {
        const [, key, value] = match;
        if (key === 'org_id' || key === 'project_id' || key === 'branch') {
          meta[key] = value;
        }
      }
    }
    return meta;
  }

  readEncryptedEnvFile(decryptionKey: string, path?: string): Record<string, string> {
    const envPath = path || join(this.projectRoot, '.env');

    if (!existsSync(envPath)) {
      return {};
    }

    try {
      const content = readFileSync(envPath, 'utf-8');
      const parsed = parseDotenv(content);
      
      const decrypted: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        try {
          decrypted[key] = this.decryptValue(value, decryptionKey);
        } catch (decryptError) {
          if (value.startsWith('capy:')) {
            throw new CapyError(
              `Cannot decrypt "${key}": encrypted with a different project's key. This value cannot be transferred between orgs.`,
              ERROR_CODES.PERMISSION_DENIED,
              { variable: key }
            );
          }
          // Non-capy value that failed — keep as-is (likely plaintext)
          decrypted[key] = value;
        }
      }
      return decrypted;
    } catch (error) {
      throw new CapyError(
        `Failed to read encrypted .env file at ${envPath}`,
        ERROR_CODES.PERMISSION_DENIED,
        { error, path: envPath }
      );
    }
  }

  writeEnvFile(variables: Record<string, string>, path?: string): void {
    const envPath = path || join(this.projectRoot, '.env');
    console.log(`Writing ${Object.keys(variables).length} variables to ${envPath}`);
    const backup = this.createBackup(envPath);

    try {
      const content = Object.entries(variables)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

      this.ensureDirectoryExists(dirname(envPath));
      writeFileSync(envPath, content + '\n', 'utf-8');
      console.log(`Successfully wrote .env file`);

      if (backup) {
        this.removeBackup(backup);
      }
    } catch (error) {
      if (backup) {
        this.restoreBackup(backup, envPath);
      }
      throw new CapyError(
        `Failed to write .env file at ${envPath}`,
        ERROR_CODES.PERMISSION_DENIED,
        { error, path: envPath }
      );
    }
  }

  writeEncryptedEnvFile(variables: Record<string, string>, encryptionKey: string, path?: string, keep?: KeepFile | null, branch?: string): void {
    const envPath = path || join(this.projectRoot, '.env');
    console.log(`Encrypting and writing ${Object.keys(variables).length} variables to ${envPath}`);
    const backup = this.createBackup(envPath);

    try {
      const encryptedVariables: Record<string, string> = {};

      for (const [key, value] of Object.entries(variables)) {
        let finalValue: string;

        if (value.startsWith('capy:') || this.isSnippetEncrypted(value)) {
          // Already encrypted — verify it belongs to THIS project's key
          try {
            this.decryptValue(value, encryptionKey);
          } catch {
            throw new CapyError(
              `Cannot write "${key}": encrypted with a different project's key. This value cannot be transferred between orgs.`,
              ERROR_CODES.PERMISSION_DENIED,
              { variable: key }
            );
          }
          finalValue = value;
        } else {
          // Encrypt the plain text value
          const encrypted = Encryptor.encrypt(value, encryptionKey);
          const snippetValue = this.createSnippetWithEncryption(value, encrypted);
          const resourceId = deriveResourceId(branch || '', key);
          finalValue = `capy:${resourceId}:${snippetValue}`;
        }
        
        encryptedVariables[key] = finalValue;
      }

      const metaLines: string[] = [];
      if (keep) {
        metaLines.push(`# capy:org_id=${keep.org_id}`);
        metaLines.push(`# capy:project_id=${keep.project_id}`);
      }
      if (branch) {
        metaLines.push(`# capy:branch=${branch}`);
      }
      const header = metaLines.length > 0 ? metaLines.join('\n') + '\n\n' : '';
      const content = header + Object.entries(encryptedVariables)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

      this.ensureDirectoryExists(dirname(envPath));
      writeFileSync(envPath, content + '\n', 'utf-8');
      console.log(`Successfully wrote encrypted .env file`);

      if (backup) {
        this.removeBackup(backup);
      }
    } catch (error) {
      if (backup) {
        this.restoreBackup(backup, envPath);
      }
      throw new CapyError(
        `Failed to write encrypted .env file at ${envPath}`,
        ERROR_CODES.PERMISSION_DENIED,
        { error, path: envPath }
      );
    }
  }

  parseEnvContent(content: string): Record<string, string> {
    return parseDotenv(content);
  }

  writeKeepFile(keep: KeepFile): void {
    const keepPath = join(this.projectRoot, 'keep.lock');
    const backup = this.createBackup(keepPath);

    try {
      // Deterministic output: fixed key order, sorted variables
      const sorted: Record<string, any> = {
        version: keep.version,
        org_id: keep.org_id,
        project_id: keep.project_id,
        project_name: keep.project_name,
        variables: {} as Record<string, any[]>,
      };
      for (const key of Object.keys(keep.variables).sort()) {
        sorted.variables[key] = [...keep.variables[key]].sort((a, b) =>
          (a.branch ?? '').localeCompare(b.branch ?? '')
        );
      }
      const content = JSON.stringify(sorted, null, 2);
      writeFileSync(keepPath, content + '\n', 'utf-8');

      if (backup) {
        this.removeBackup(backup);
      }
    } catch (error) {
      if (backup) {
        this.restoreBackup(backup, keepPath);
      }
      throw new CapyError(
        'Failed to write keep.lock file',
        ERROR_CODES.PERMISSION_DENIED,
        { error, path: keepPath }
      );
    }
  }

  writeDecryptKey(decryptKey: DecryptKey): void {
    const capyDir = join(this.projectRoot, '.capy');
    this.ensureDirectoryExists(capyDir);
    
    const decryptPath = join(capyDir, 'decrypt');
    const backup = this.createBackup(decryptPath);

    try {
      const content = JSON.stringify(decryptKey, null, 2);
      writeFileSync(decryptPath, content + '\n', { encoding: 'utf-8', mode: 0o600 });

      if (backup) {
        this.removeBackup(backup);
      }
    } catch (error) {
      if (backup) {
        this.restoreBackup(backup, decryptPath);
      }
      throw new CapyError(
        'Failed to write decrypt file',
        ERROR_CODES.PERMISSION_DENIED,
        { error, path: decryptPath }
      );
    }
  }

  writeSyncState(syncState: SyncState): void {
    const capyDir = join(this.projectRoot, '.capy');
    this.ensureDirectoryExists(capyDir);
    
    const syncStatePath = join(capyDir, 'sync-state');
    const backup = this.createBackup(syncStatePath);

    try {
      const content = JSON.stringify(syncState, null, 2);
      writeFileSync(syncStatePath, content + '\n', { encoding: 'utf-8', mode: 0o600 });

      if (backup) {
        this.removeBackup(backup);
      }
    } catch (error) {
      if (backup) {
        this.restoreBackup(backup, syncStatePath);
      }
      throw new CapyError(
        'Failed to write sync-state file',
        ERROR_CODES.PERMISSION_DENIED,
        { error, path: syncStatePath }
      );
    }
  }

  updateGitignore(entries: string[]): void {
    const gitignorePath = join(this.projectRoot, '.gitignore');
    let existingContent = '';

    if (existsSync(gitignorePath)) {
      existingContent = readFileSync(gitignorePath, 'utf-8');
    }

    const existingLines = new Set(
      existingContent.split('\n').map(line => line.trim()).filter(Boolean)
    );

    const newEntries: string[] = [];
    for (const entry of entries) {
      if (!existingLines.has(entry)) {
        newEntries.push(entry);
      }
    }

    if (newEntries.length === 0) {
      return;
    }

    try {
      const contentToAppend = newEntries.join('\n');
      if (existingContent && !existingContent.endsWith('\n')) {
        appendFileSync(gitignorePath, '\n', 'utf-8');
      }

      if (newEntries.length > 0) {
        appendFileSync(gitignorePath, '\n# Capy\n', 'utf-8');
        appendFileSync(gitignorePath, contentToAppend + '\n', 'utf-8');
      }
    } catch (error) {
      throw new CapyError(
        'Failed to update .gitignore',
        ERROR_CODES.PERMISSION_DENIED,
        { error, path: gitignorePath }
      );
    }
  }

  private createBackup(filePath: string): string | null {
    if (!existsSync(filePath)) {
      return null;
    }

    const backupPath = `${filePath}.backup`;
    try {
      const content = readFileSync(filePath, 'utf-8');
      writeFileSync(backupPath, content, 'utf-8');
      return backupPath;
    } catch {
      return null;
    }
  }

  private restoreBackup(backupPath: string, originalPath: string): void {
    try {
      const content = readFileSync(backupPath, 'utf-8');
      writeFileSync(originalPath, content, 'utf-8');
      this.removeBackup(backupPath);
    } catch {
      // Silent fail on backup restore
    }
  }

  private removeBackup(backupPath: string): void {
    try {
      if (existsSync(backupPath)) {
        unlinkSync(backupPath);
      }
    } catch {
      // Silent fail on backup removal
    }
  }

  private ensureDirectoryExists(dirPath: string): void {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }

  ensureCapyGitignore(): void {
    const requiredEntries = ['.env', '.capy'];
    this.updateGitignore(requiredEntries);
  }

  /**
   * If the .env file contains plaintext secrets (not capy-encrypted),
   * save a backup as .env.pre-capy.old with all values commented out,
   * and add .env.pre-capy.old to .gitignore.
   */
  backupPlaintextEnv(path?: string): boolean {
    const envPath = path || join(this.projectRoot, '.env');
    if (!existsSync(envPath)) return false;

    const content = readFileSync(envPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));

    // Check if any values are already encrypted
    const hasPlaintext = lines.some(line => {
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return false;
      const value = line.substring(eqIdx + 1);
      return !value.startsWith('capy:');
    });

    if (!hasPlaintext) return false;

    // Comment out all lines
    const commented = content.split('\n').map(line => {
      if (line.trim() && !line.startsWith('#')) {
        return `# ${line}`;
      }
      return line;
    }).join('\n');

    const oldPath = envPath.replace(/\.env$/, '.env.pre-capy.old');
    const header = '# From Capy: These are your old secrets, which we have saved for you.\n# We recommend deleting this file or putting it somewhere safe because the values are unencrypted.\n\n';
    writeFileSync(oldPath, header + commented, 'utf-8');
    this.updateGitignore(['.env.pre-capy.old']);
    console.log(`Saved plaintext backup to ${oldPath}`);
    return true;
  }

  /**
   * Creates a snippet-enhanced encrypted value for better usability
   * Shows partial original value for identification while maintaining security
   */
  private createSnippetWithEncryption(originalValue: string, encryptedValue: string): string {
    const valueLength = originalValue.length;
    
    if (valueLength <= 4) {
      // ≤4 chars: ...X (last 1 char)
      const snippet = originalValue.slice(-1);
      return `${encryptedValue}...${snippet}`;
    } else if (valueLength <= 8) {
      // ≤8 chars: X...X (first 1 char, last 1 char)
      const firstSnippet = originalValue.slice(0, 1);
      const lastSnippet = originalValue.slice(-1);
      return `${firstSnippet}...${encryptedValue}...${lastSnippet}`;
    } else if (valueLength <= 16) {
      // 9-16 chars: X...XXX (first 1 char, last 3 chars)
      const firstSnippet = originalValue.slice(0, 1);
      const lastSnippet = originalValue.slice(-3);
      return `${firstSnippet}...${encryptedValue}...${lastSnippet}`;
    } else if (valueLength <= 24) {
      // 16-24 chars: XX...XXXXXX (first 2...last 6)
      const firstSnippet = originalValue.slice(0, 2);
      const lastSnippet = originalValue.slice(-6);
      return `${firstSnippet}...${encryptedValue}...${lastSnippet}`;
    } else {
      // >24 chars: XXXX...XXXXXX (first 4...last 6)
      const firstSnippet = originalValue.slice(0, 4);
      const lastSnippet = originalValue.slice(-6);
      return `${firstSnippet}...${encryptedValue}...${lastSnippet}`;
    }
  }

  /**
   * Checks if a value is in snippet-enhanced encrypted format
   */
  isSnippetEncrypted(value: string): boolean {
    const parts = value.split('...');
    return parts.length === 2 || parts.length === 3;
  }

  /**
   * Extracts the actual encrypted data from a snippet-enhanced value using positional logic
   */
  private extractEncryptedFromSnippet(value: string): string | null {
    const parts = value.split('...');
    
    if (parts.length === 2) {
      // Format: encryptedData...snippet
      return parts[0];
    } else if (parts.length === 3) {
      // Format: snippet...encryptedData...snippet
      return parts[1];
    }
    
    return null; // Invalid format
  }

  /**
   * Checks if a value is in the capy:{resourceId}:{payload} encrypted format.
   */
  isEncrypted(value: string): boolean {
    if (!value.startsWith('capy:')) return false;
    const afterPrefix = value.slice(5);
    const colonIdx = afterPrefix.indexOf(':');
    return colonIdx !== -1;
  }

  /**
   * Decrypts a single value. Handles capy:{id}:{payload}, snippet-wrapped, and plaintext.
   */
  decryptValue(value: string, decryptionKey: string): string {
    // Strip capy:{resource_id}: prefix if present
    let payload = value;
    if (value.startsWith('capy:')) {
      const parts = value.split(':');
      if (parts.length >= 3) {
        payload = parts.slice(2).join(':');
      } else {
        return value; // Not a valid encrypted format, return as-is
      }
    }

    if (this.isSnippetEncrypted(payload)) {
      const extracted = this.extractEncryptedFromSnippet(payload);
      if (extracted) {
        return Encryptor.decrypt(extracted, decryptionKey);
      }
      throw new Error('Could not extract encrypted data from snippet');
    }

    // Try decrypting as raw base64
    return Encryptor.decrypt(payload, decryptionKey);
  }
}

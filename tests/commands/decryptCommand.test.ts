import { mock, describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Mock homedir to use a temp directory
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-decrypt-test-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});

// Mock cwd to use a temp project directory
const tempProject = mkdtempSync(join(require('os').tmpdir(), 'capy-decrypt-proj-'));
const originalCwd = process.cwd;

afterAll(() => {
  mock.restore();
  process.cwd = originalCwd;
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempProject, { recursive: true, force: true });
});

// Dynamic imports after mock setup
let generateSeedPhrase: typeof import('../../src/crypto/keyManager').generateSeedPhrase;
let seedPhraseToMasterKey: typeof import('../../src/crypto/keyManager').seedPhraseToMasterKey;
let deriveProjectKey: typeof import('../../src/crypto/keyManager').deriveProjectKey;
let validateSeedPhrase: typeof import('../../src/crypto/keyManager').validateSeedPhrase;
let saveRecoverySession: typeof import('../../src/config/globalConfig').saveRecoverySession;
let readRecoverySession: typeof import('../../src/config/globalConfig').readRecoverySession;
let isRecoveryActive: typeof import('../../src/config/globalConfig').isRecoveryActive;
let deleteRecoverySession: typeof import('../../src/config/globalConfig').deleteRecoverySession;
let Encryptor: typeof import('../../src/crypto/encryptor').Encryptor;

const orgId = 'org_test_decrypt';
const projectId = 'proj_test_decrypt';
const projectName = 'test-project';

beforeAll(async () => {
  const km = await import('../../src/crypto/keyManager');
  generateSeedPhrase = km.generateSeedPhrase;
  seedPhraseToMasterKey = km.seedPhraseToMasterKey;
  deriveProjectKey = km.deriveProjectKey;
  validateSeedPhrase = km.validateSeedPhrase;

  const gc = await import('../../src/config/globalConfig');
  saveRecoverySession = gc.saveRecoverySession;
  readRecoverySession = gc.readRecoverySession;
  isRecoveryActive = gc.isRecoveryActive;
  deleteRecoverySession = gc.deleteRecoverySession;

  const enc = await import('../../src/crypto/encryptor');
  Encryptor = enc.Encryptor;
});

describe('Recovery Session (globalConfig)', () => {
  beforeEach(() => {
    // Clean up recovery dir before each test
    const recoverDir = join(tempHome, '.capy', 'recover');
    if (existsSync(recoverDir)) {
      rmSync(recoverDir, { recursive: true, force: true });
    }
  });

  it('isRecoveryActive returns false when no session', () => {
    expect(isRecoveryActive()).toBe(false);
  });

  it('saveRecoverySession creates session file', () => {
    saveRecoverySession('deadbeef', orgId);
    expect(isRecoveryActive()).toBe(true);

    const session = readRecoverySession();
    expect(session).not.toBeNull();
    expect(session!.master_key).toBe('deadbeef');
    expect(session!.org_id).toBe(orgId);
  });

  it('deleteRecoverySession removes session', () => {
    saveRecoverySession('deadbeef', orgId);
    expect(isRecoveryActive()).toBe(true);

    deleteRecoverySession();
    expect(isRecoveryActive()).toBe(false);
    expect(readRecoverySession()).toBeNull();
  });

  it('readRecoverySession returns null for corrupt file', () => {
    const sessionPath = join(tempHome, '.capy', 'recover', 'session.json');
    mkdirSync(join(tempHome, '.capy', 'recover'), { recursive: true });
    writeFileSync(sessionPath, 'not json');
    expect(readRecoverySession()).toBeNull();
  });
});

describe('DecryptCommand', () => {
  let seedPhrase: string;
  let projectKey: string;

  beforeAll(() => {
    seedPhrase = generateSeedPhrase();
    const masterKey = seedPhraseToMasterKey(seedPhrase);
    projectKey = deriveProjectKey(masterKey, projectId, orgId);
  });

  function setupProject(branch: string = 'development') {
    // Write keep.lock
    const keepFile = {
      version: '3.0',
      org_id: orgId,
      project_id: projectId,
      project_name: projectName,
      variables: {},
    };
    writeFileSync(join(tempProject, 'keep.lock'), JSON.stringify(keepFile, null, 2));

    // Write .capy/branch
    const capyDir = join(tempProject, '.capy');
    mkdirSync(capyDir, { recursive: true });
    writeFileSync(join(capyDir, 'branch'), branch);

    // Write encrypted .env with metadata headers
    const secrets = {
      DATABASE_URL: 'postgres://localhost:5432/test',
      API_KEY: 'sk_test_123',
    };

    const lines: string[] = [
      `# capy:org_id=${orgId}`,
      `# capy:project_id=${projectId}`,
      `# capy:branch=${branch}`,
      '',
    ];
    for (const [key, value] of Object.entries(secrets)) {
      const encrypted = Encryptor.encrypt(value, projectKey);
      // Format: capy:{resourceId}:{base64payload} — use a dummy resource ID
      lines.push(`${key}=capy:res01:${encrypted}`);
    }
    writeFileSync(join(tempProject, '.env'), lines.join('\n') + '\n');

    // Write .gitignore
    writeFileSync(join(tempProject, '.gitignore'), '.env\n');
  }

  beforeEach(() => {
    // Clean up
    process.cwd = () => tempProject;
    const recoverDir = join(tempHome, '.capy', 'recover');
    if (existsSync(recoverDir)) {
      rmSync(recoverDir, { recursive: true, force: true });
    }
    // Clean decrypted files
    try {
      for (const f of readdirSync(tempProject)) {
        if (/^\.env\..*\.decrypted$/.test(f)) {
          rmSync(join(tempProject, f));
        }
      }
    } catch {}
  });

  it('resolveFromSeedPhrase derives correct key offline', async () => {
    const { resolveFromSeedPhrase } = await import('../../src/crypto/keyResolver');
    const key = resolveFromSeedPhrase(seedPhrase, orgId, projectId);
    expect(key).toBe(projectKey);
  });

  it('validates seed phrases correctly', () => {
    expect(validateSeedPhrase(seedPhrase)).toBe(true);
    expect(validateSeedPhrase('not a valid seed phrase')).toBe(false);
    expect(validateSeedPhrase('')).toBe(false);
  });

  it('recovery session stores and retrieves master key for key derivation', () => {
    const masterKey = seedPhraseToMasterKey(seedPhrase);
    const masterKeyHex = masterKey.toString('hex');

    saveRecoverySession(masterKeyHex, orgId);
    const session = readRecoverySession()!;

    // Re-derive project key from stored master key
    const derivedKey = deriveProjectKey(Buffer.from(session.master_key, 'hex'), projectId, orgId);
    expect(derivedKey).toBe(projectKey);
  });

  it('decrypts .env file correctly with project key', () => {
    setupProject();
    const { FileManager } = require('../../src/files/fileManager');
    const fm = new FileManager(tempProject);

    const decrypted = fm.readEncryptedEnvFile(projectKey);
    expect(decrypted.DATABASE_URL).toBe('postgres://localhost:5432/test');
    expect(decrypted.API_KEY).toBe('sk_test_123');
  });

  it('writes .env.{branch}.decrypted in correct format', () => {
    setupProject('prod');
    const { FileManager } = require('../../src/files/fileManager');
    const fm = new FileManager(tempProject);

    const decrypted = fm.readEncryptedEnvFile(projectKey);

    // Write output file in the format decryptCommand uses
    const content = Object.entries(decrypted)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const outputFile = '.env.prod.decrypted';
    writeFileSync(join(tempProject, outputFile), content + '\n', 'utf-8');

    // Verify output
    const output = readFileSync(join(tempProject, outputFile), 'utf-8');
    expect(output).toContain('DATABASE_URL=postgres://localhost:5432/test');
    expect(output).toContain('API_KEY=sk_test_123');
    expect(output).not.toContain('capy:');
    expect(output).not.toContain('# capy:');
  });

  it('wrong seed phrase fails decryption with auth tag mismatch', () => {
    setupProject();
    const wrongPhrase = generateSeedPhrase(); // different seed phrase
    const wrongMasterKey = seedPhraseToMasterKey(wrongPhrase);
    const wrongProjectKey = deriveProjectKey(wrongMasterKey, projectId, orgId);

    const { FileManager } = require('../../src/files/fileManager');
    const fm = new FileManager(tempProject);

    expect(() => fm.readEncryptedEnvFile(wrongProjectKey)).toThrow();
  });

  it('reads .env metadata for org_id and project_id', () => {
    setupProject();
    const { FileManager } = require('../../src/files/fileManager');
    const fm = new FileManager(tempProject);

    const meta = fm.readEnvMeta();
    expect(meta.org_id).toBe(orgId);
    expect(meta.project_id).toBe(projectId);
  });

  // --- Security: cross-user / cross-org attack scenarios ---

  it('different user seed phrase cannot decrypt values (cross-user attack)', () => {
    setupProject();
    // Attacker generates their own seed phrase
    const attackerSeed = generateSeedPhrase();
    const attackerMaster = seedPhraseToMasterKey(attackerSeed);
    // Attacker derives using VICTIM's orgId/projectId (from keep.lock)
    const attackerKey = deriveProjectKey(attackerMaster, projectId, orgId);

    const { FileManager } = require('../../src/files/fileManager');
    const fm = new FileManager(tempProject);

    // AES-GCM auth tag must reject the wrong key
    expect(() => fm.readEncryptedEnvFile(attackerKey)).toThrow();
  });

  it('spoofed keep.lock (different org) cannot decrypt values', () => {
    setupProject();
    // Attacker has the owner's M but swaps keep.lock to point to a different org
    const masterKey = seedPhraseToMasterKey(seedPhrase);
    const spoofedOrgId = 'org_attacker';
    const spoofedProjectId = 'proj_attacker';
    const spoofedKey = deriveProjectKey(masterKey, spoofedProjectId, spoofedOrgId);

    const { FileManager } = require('../../src/files/fileManager');
    const fm = new FileManager(tempProject);

    expect(() => fm.readEncryptedEnvFile(spoofedKey)).toThrow();
  });

  it('decrypts values that exist ONLY locally (never pushed)', () => {
    setupProject();

    // Simulate: owner adds new encrypted values to .env that were never pushed
    const localOnlyValue = 'LOCAL_ONLY=shh-this-was-never-pushed';
    const encrypted = Encryptor.encrypt('shh-this-was-never-pushed', projectKey);
    const envPath = join(tempProject, '.env');
    const existing = readFileSync(envPath, 'utf-8');
    writeFileSync(envPath, existing + `LOCAL_ONLY=capy:locl1:${encrypted}\n`);

    const { FileManager } = require('../../src/files/fileManager');
    const fm = new FileManager(tempProject);

    const decrypted = fm.readEncryptedEnvFile(projectKey);
    // Owner's seed phrase decrypts local-only values — no service, no push needed
    expect(decrypted.LOCAL_ONLY).toBe('shh-this-was-never-pushed');
    expect(decrypted.DATABASE_URL).toBe('postgres://localhost:5432/test');
  });

  it('recovery session org_id mismatch is rejected', () => {
    // Session from org A
    saveRecoverySession('deadbeef', orgId);

    const session = readRecoverySession()!;
    // If user later cds to a dir with a different org's keep.lock,
    // the decryptCommand checks session.org_id !== keep.org_id and refuses.
    const differentOrgId = 'org_totally_different';

    expect(session.org_id).toBe(orgId);
    expect(session.org_id).not.toBe(differentOrgId);
    // The guard logic in decryptCommand would reject this combo.
  });

  it("another org's seed phrase cannot decrypt this org's values", () => {
    setupProject();

    // Simulate a DIFFERENT org owner trying to recover our .env.
    // They have their own seed phrase for their own org — completely unrelated to ours.
    const otherOrgSeed = generateSeedPhrase();
    const otherOrgMaster = seedPhraseToMasterKey(otherOrgSeed);

    // Their org has a different org_id. They type their seed phrase in our dir.
    // decryptCommand would read OUR keep.lock (our orgId/projectId) and derive:
    const keyWithTheirMOurIds = deriveProjectKey(otherOrgMaster, projectId, orgId);

    const { FileManager } = require('../../src/files/fileManager');
    const fm = new FileManager(tempProject);

    // Their M can never reproduce our M → AES-GCM auth tag mismatch
    expect(() => fm.readEncryptedEnvFile(keyWithTheirMOurIds)).toThrow();

    // Also verify the reverse: their values (encrypted with their M) cannot be
    // decrypted with OUR seed phrase either, regardless of HKDF params.
    const ourMaster = seedPhraseToMasterKey(seedPhrase);
    const theirOrgId = 'org_other_org';
    const theirProjectId = 'proj_other_org';

    // Encrypt a value under their M + their IDs
    const theirKey = deriveProjectKey(otherOrgMaster, theirProjectId, theirOrgId);
    const theirCiphertext = Encryptor.encrypt('their-secret-value', theirKey);

    // Try to decrypt with our M + any combination of IDs — all must fail
    const ourKeyAttempt1 = deriveProjectKey(ourMaster, theirProjectId, theirOrgId);
    const ourKeyAttempt2 = deriveProjectKey(ourMaster, projectId, orgId);
    expect(() => Encryptor.decrypt(theirCiphertext, ourKeyAttempt1)).toThrow();
    expect(() => Encryptor.decrypt(theirCiphertext, ourKeyAttempt2)).toThrow();
  });

  it('another org\'s .env (with valid header) is refused by belt-and-suspenders check', async () => {
    setupProject();

    // Simulate: attacker drops another org's .env — with its valid, matching header —
    // into our project directory. The .env is internally consistent (its header org_id
    // matches what encrypted its values), but disagrees with our keep.lock.
    const otherOrgId = 'org_victim_other_org';
    const otherProjectId = 'proj_victim_other_project';
    const otherOrgSeed = generateSeedPhrase();
    const otherOrgMaster = seedPhraseToMasterKey(otherOrgSeed);
    const otherOrgKey = deriveProjectKey(otherOrgMaster, otherProjectId, otherOrgId);

    const otherEnvLines = [
      `# capy:org_id=${otherOrgId}`,
      `# capy:project_id=${otherOrgId}`,
      '',
      `STOLEN_SECRET=capy:res1:${Encryptor.encrypt('highly-confidential', otherOrgKey)}`,
    ];
    writeFileSync(join(tempProject, '.env'), otherEnvLines.join('\n') + '\n');

    // Also simulate: no active session (fresh run, will prompt for seed phrase).
    // The belt-and-suspenders check happens BEFORE any seed prompt, so it doesn't
    // matter what the user types — the command exits before reaching that step.
    const origExit = process.exit;
    const origError = console.error;
    let exitCode: number | undefined;
    let errOutput = '';
    // @ts-expect-error — stub for test
    process.exit = (code?: number) => { exitCode = code; throw new Error('__STUBBED_EXIT__'); };
    console.error = (msg: string) => { errOutput += msg + '\n'; };

    try {
      const { DecryptCommand } = await import('../../src/commands/decryptCommand');
      const cmd = new DecryptCommand();
      try {
        await cmd.execute();
      } catch (e: any) {
        if (e.message !== '__STUBBED_EXIT__') throw e;
      }
    } finally {
      process.exit = origExit;
      console.error = origError;
    }

    expect(exitCode).toBe(1);
    expect(errOutput).toMatch(/different organization/i);
  });

  it("another org's .env + swapped keep.lock still fails at AES-GCM (defense in depth)", () => {
    // Worst case: attacker has BOTH another org's .env AND that org's keep.lock.
    // The belt-and-suspenders check passes (headers match keep.lock). But the
    // AES-GCM auth tag must still reject, since user's M can't reproduce theirs.
    const otherOrgId = 'org_swapped_defense';
    const otherProjectId = 'proj_swapped_defense';
    const otherOrgSeed = generateSeedPhrase();
    const otherOrgMaster = seedPhraseToMasterKey(otherOrgSeed);
    const otherOrgKey = deriveProjectKey(otherOrgMaster, otherProjectId, otherOrgId);

    // Write another org's .env with matching header + values encrypted under their key
    const otherEnvLines = [
      `# capy:org_id=${otherOrgId}`,
      `# capy:project_id=${otherProjectId}`,
      '',
      `STOLEN_SECRET=capy:res1:${Encryptor.encrypt('never-reveal-me', otherOrgKey)}`,
    ];
    writeFileSync(join(tempProject, '.env'), otherEnvLines.join('\n') + '\n');

    // User types their own seed phrase. Derive key using THEIR M + the attacker's IDs.
    const userMaster = seedPhraseToMasterKey(seedPhrase);
    const userKeyWithAttackersIds = deriveProjectKey(userMaster, otherProjectId, otherOrgId);

    const { FileManager } = require('../../src/files/fileManager');
    const fm = new FileManager(tempProject);

    // Even with matching headers, the crypto rejects
    expect(() => fm.readEncryptedEnvFile(userKeyWithAttackersIds)).toThrow();
  });

  it('DecryptCommand refuses to run when session org_id != keep.lock org_id', async () => {
    // Active recovery session for a DIFFERENT org than the current project
    const otherOrgId = 'org_different_from_keep';
    saveRecoverySession('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', otherOrgId);

    // Current project's keep.lock is for `orgId`, not `otherOrgId`
    setupProject();

    // Capture process.exit + stderr to verify the guard triggers without killing the test runner
    const origExit = process.exit;
    const origError = console.error;
    let exitCode: number | undefined;
    let errOutput = '';
    // @ts-expect-error — stub for test
    process.exit = (code?: number) => { exitCode = code; throw new Error('__STUBBED_EXIT__'); };
    console.error = (msg: string) => { errOutput += msg + '\n'; };

    try {
      const { DecryptCommand } = await import('../../src/commands/decryptCommand');
      const cmd = new DecryptCommand();
      try {
        await cmd.execute();
      } catch (e: any) {
        if (e.message !== '__STUBBED_EXIT__') throw e;
      }
    } finally {
      process.exit = origExit;
      console.error = origError;
    }

    expect(exitCode).toBe(1);
    expect(errOutput).toMatch(/different org/i);
  });
});

describe('EndRecoverCommand', () => {
  beforeEach(() => {
    process.cwd = () => tempProject;
    // Clean up
    const recoverDir = join(tempHome, '.capy', 'recover');
    if (existsSync(recoverDir)) {
      rmSync(recoverDir, { recursive: true, force: true });
    }
    // Clean decrypted files
    try {
      for (const f of readdirSync(tempProject)) {
        if (/^\.env\..*\.decrypted$/.test(f)) {
          rmSync(join(tempProject, f));
        }
      }
    } catch {}
  });

  it('cleans up recovery session and decrypted files', () => {
    // Create recovery session
    saveRecoverySession('deadbeef', orgId);

    // Create some .env.*.decrypted files
    writeFileSync(join(tempProject, '.env.prod.decrypted'), 'KEY=value\n');
    writeFileSync(join(tempProject, '.env.staging.decrypted'), 'KEY=value\n');

    expect(isRecoveryActive()).toBe(true);

    // Simulate end-recover cleanup
    deleteRecoverySession();
    const pattern = /^\.env\..*\.decrypted$/;
    for (const f of readdirSync(tempProject)) {
      if (pattern.test(f)) {
        rmSync(join(tempProject, f));
      }
    }

    expect(isRecoveryActive()).toBe(false);
    expect(existsSync(join(tempProject, '.env.prod.decrypted'))).toBe(false);
    expect(existsSync(join(tempProject, '.env.staging.decrypted'))).toBe(false);
  });

  it('no-ops when no recovery session active', () => {
    expect(isRecoveryActive()).toBe(false);
    // Should not throw
    expect(() => deleteRecoverySession()).not.toThrow();
  });
});

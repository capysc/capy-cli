/**
 * `.env` presence must always compat-flag a project as reading configuration
 * from environment variables — the ONE fact `checkCompat` actually gates on
 * (`plan.ts`'s `!f.usesEnvVars` branch). A plain Node app with nothing but a
 * `.env` (no recognized framework, no package.json hints) still needs to
 * clear onboarding rather than land on `incompatible_project`.
 *
 * `readEnvKeys` (`flows/onboard/edits.ts`) is the detector `onboardCommand.ts`
 * feeds into the `compat.usesEnvVars` field it sends the flow service
 * (`usesEnvVars: envKeys.length > 0 || options.usesEnvVars === true`), and
 * `checkCompat` (`flows/onboard/plan.ts`) is the verdict function itself —
 * this file exercises both, real, end to end, against a real `.env` on disk.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { readEnvKeys } from '../../../src/flows/onboard/edits';
import { checkCompat } from '../../../src/flows/onboard/plan';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(require('os').tmpdir(), 'capy-compat-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('readEnvKeys', () => {
  test('reads key names out of a plain .env — never values', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://user:secret@host/db\nAPI_KEY=shh\n# comment\n\nexport PORT=3000\n');
      const keys = readEnvKeys(dir);
      expect(keys.sort()).toEqual(['API_KEY', 'DATABASE_URL', 'PORT']);
      // Never a value, anywhere in the returned list.
      expect(keys.some((k) => k.includes('secret') || k.includes('shh'))).toBe(false);
    });
  });

  test('a directory with no env files at all returns an empty list', () => {
    withTempDir((dir) => {
      expect(readEnvKeys(dir)).toEqual([]);
    });
  });

  test('merges keys across .env, .env.local, .env.example and .env.sample', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, '.env'), 'A=1\n');
      writeFileSync(join(dir, '.env.local'), 'B=2\n');
      writeFileSync(join(dir, '.env.example'), 'C=\n');
      writeFileSync(join(dir, '.env.sample'), 'D=\n');
      expect(readEnvKeys(dir).sort()).toEqual(['A', 'B', 'C', 'D']);
    });
  });
});

describe('checkCompat — a plain Node app that only has a .env is never incompatible_project', () => {
  test('usesEnvVars:true (from a real .env, no framework detected) is compatible', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, '.env'), 'PORT=3000\nAPI_KEY=xyz\n');
      const envKeys = readEnvKeys(dir);
      expect(envKeys.length).toBeGreaterThan(0);

      const verdict = checkCompat({ usesEnvVars: envKeys.length > 0 });
      expect(verdict.compatible).toBe(true);
      expect(verdict.reason).not.toContain("doesn't appear to read configuration");
    });
  });

  test('no .env and no framework hint is the ONLY case that comes back incompatible', () => {
    withTempDir((dir) => {
      const envKeys = readEnvKeys(dir);
      expect(envKeys).toEqual([]);

      const verdict = checkCompat({ usesEnvVars: envKeys.length > 0 });
      expect(verdict.compatible).toBe(false);
      expect(verdict.reason).toContain("doesn't appear to read configuration");
      expect(verdict.integrateUrl).toBeDefined();
    });
  });

  test('an externalSecretManager hint is incompatible regardless of .env presence', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, '.env'), 'A=1\n');
      const envKeys = readEnvKeys(dir);
      const verdict = checkCompat({ usesEnvVars: envKeys.length > 0, externalSecretManager: 'vault' });
      expect(verdict.compatible).toBe(false);
      expect(verdict.reason).toContain('vault');
    });
  });

  test('the compat.usesEnvVars a caller\'s hint ORs with — a directory with a real .env stays compatible even if the hint is false', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, '.env'), 'A=1\n');
      const envKeys = readEnvKeys(dir);
      // Mirrors onboardCommand.ts's own expression exactly.
      const usesEnvVars = envKeys.length > 0 || (false as boolean);
      expect(usesEnvVars).toBe(true);
      expect(checkCompat({ usesEnvVars }).compatible).toBe(true);
    });
  });
});

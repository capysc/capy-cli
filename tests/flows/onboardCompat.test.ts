import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvKeys } from '../../src/flows/onboard/edits';
import { checkCompat } from '../../src/flows/onboard/plan';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'capy-compat-'));

test('readEnvKeys sees the dotless env.example spelling', () => {
  // capysc/test-project ships `env.example`, not `.env.example`. Missing it
  // made a repo that documents its variables that way read as using none.
  const dir = scratch();
  writeFileSync(join(dir, 'env.example'), 'API_KEY=x\nDATABASE_URL=y\n');

  expect(readEnvKeys(dir).sort()).toEqual(['API_KEY', 'DATABASE_URL']);
});

test('a fresh clone of an onboarded repo is compatible despite no .env', () => {
  // THE BUG: .env is gitignored, so a fresh clone of an onboarded repo has no
  // env file at all. Compat then answered "this project does not read config
  // from environment variables" and the flow refused with
  // blocked:incompatible_project — on the second-device path, which is exactly
  // what onboarding exists to serve.
  const dir = scratch();
  writeFileSync(
    join(dir, 'keep.lock'),
    JSON.stringify({ version: '3.0', org_id: 'o', project_id: 'p', variables: { API_KEY: [] } }),
  );

  // No .env, no env.example — keep.lock alone must settle it.
  expect(readEnvKeys(dir)).toEqual([]);
  expect(checkCompat({ usesEnvVars: true }).compatible).toBe(true);
});

test('compat still refuses a genuinely unrelated project', () => {
  // The gate must keep working for its real audience: a directory with no
  // keep.lock and no env files anywhere.
  const dir = scratch();
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.rs'), 'fn main() {}\n');

  expect(readEnvKeys(dir)).toEqual([]);
  expect(checkCompat({ usesEnvVars: false }).compatible).toBe(false);
});

test('an external secret manager still wins over everything', () => {
  expect(checkCompat({ usesEnvVars: true, externalSecretManager: 'vault' }).compatible).toBe(false);
});

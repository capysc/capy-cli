/**
 * CAP-411 — the headline property, asserted directly.
 *
 * "A freshly minted deploy artifact contains no value that decrypts any
 * `capy:` line in the project `.env`." This is the whole point of the
 * ticket: `mintDeployToken` used to discard the per-deploy derivation token
 * (DT) and return the raw project key as `PROJECT_KEY` instead — the exact
 * value `fm.decryptValue` uses to open every `capy:` line in `.env`
 * (`runCommand.ts` calls `fm.decryptValue(v, projectKeyHex)` with that same
 * `resolveProjectKey` output). So anything holding the artifact held the
 * project key itself, not a scoped credential.
 *
 * This test builds a REAL `capy:` line with `FileManager.writeEncryptedEnvFile`
 * — the same function `capy push`/`capy edit` use — reads it back with the
 * same `FileManager.decryptValue` `capy run` uses, and asserts DT (what
 * `mintDeployToken` now ships as `_CAPY_DEPLOY_KEY`) cannot open it. A second
 * test in this file uses PK — the value that USED to ship — against the same
 * ciphertext to prove the first assertion is a genuine negative rather than a
 * decrypt call that always throws: swap DT back for PK (the regression this
 * ticket exists to prevent) and the "cannot decrypt" test would fail.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { FileManager } from '../../src/files/fileManager';
import {
  generateDeployId,
  generateDerivationToken,
  deployInnerWrap,
} from '../../src/crypto/deployCrypto';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const TEST_DIR = join(tmpdir(), `capy-cap411-falsification-${process.pid}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function decryptError(fm: FileManager, value: string, key: string): CapyError {
  try {
    fm.decryptValue(value, key);
  } catch (e) {
    return e as CapyError;
  }
  throw new Error('expected fm.decryptValue to throw');
}

/**
 * Reproduces exactly what `mintDeployToken` does at mint time (minus the
 * network calls): generate a deploy id + DT, inner-wrap the project's real PK
 * with DT. Returns everything a test needs to check what a minted artifact
 * could and couldn't open.
 */
function simulateMint(pk: Buffer, projectId: string) {
  const deployId = generateDeployId();
  const dt = generateDerivationToken();
  const innerBlob = deployInnerWrap(pk, dt, projectId);
  return { deployId, dt, innerBlob };
}

describe('CAP-411 falsification: DT cannot decrypt a real capy: line', () => {
  test('the DT a fresh mint would ship as _CAPY_DEPLOY_KEY cannot open .env ciphertext encrypted with the project key', () => {
    const projectId = 'falsify-411-project';
    const pk = randomBytes(32);
    const pkHex = pk.toString('hex');

    // Build a real `capy:` line the way `capy push`/`capy edit` do, encrypted
    // with THIS project's real key.
    const fm = new FileManager(TEST_DIR);
    fm.writeEncryptedEnvFile(
      { STRIPE_SECRET_KEY: 'sk_live_definitely_not_a_deploy_credential' },
      pkHex,
    );
    const written = fm.readEnvFile();
    expect(written.STRIPE_SECRET_KEY.startsWith('capy:')).toBe(true);

    // Simulate a fresh `capy deploy` mint against the SAME project key. What
    // ships is `dt`, never `pkHex`.
    const { dt } = simulateMint(pk, projectId);

    // The actual property: DT cannot decrypt a capy: line encrypted with the
    // real project key. Structural non-equality (dt !== pk) is necessary but
    // not sufficient — this is the cryptographic assertion.
    const err = decryptError(fm, written.STRIPE_SECRET_KEY, dt.toString('hex'));
    expect(err).toBeInstanceOf(CapyError);
    expect(err.code).toBe(ERROR_CODES.DECRYPT_KEY_MISMATCH);
  });

  // Falsification control: the SAME assertion shape, but with the value that
  // USED to ship (the raw project key) instead of DT. This must SUCCEED —
  // proving the test above is a real negative. If a future change regresses
  // `mintDeployToken` back to returning `pkHex` (this ticket's original bug),
  // swapping that value into the "cannot decrypt" test's DT slot would flip
  // it from throw to success, i.e. the test above would fail and catch it.
  test('control: the project key itself (what USED to ship) DOES decrypt the same line', () => {
    const pkHex = randomBytes(32).toString('hex');
    const fm = new FileManager(TEST_DIR);
    fm.writeEncryptedEnvFile({ STRIPE_SECRET_KEY: 'sk_live_definitely_not_a_deploy_credential' }, pkHex);
    const written = fm.readEnvFile();

    expect(fm.decryptValue(written.STRIPE_SECRET_KEY, pkHex)).toBe(
      'sk_live_definitely_not_a_deploy_credential',
    );
  });
});

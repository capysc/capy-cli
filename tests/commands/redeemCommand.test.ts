/**
 * `capy redeem [code] --dry-run` (CAP-659 Phase 2/3).
 *
 * The real `execute()` path (consuming the code, co-decrypt, writing a
 * master key) isn't exercised here — see the crypto-level coverage in
 * `tests/crypto/inviteCrypto.test.ts` and the recover/invite flows. This
 * file is only the dry-run preview: parse + expiry check with the real
 * `parseRedeemCode`, a SILENT-only auth probe, never co-decrypt, never a
 * key write.
 */
import { mock, spyOn, jest, describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mockAuthenticateSilent = jest.fn();
const mockCoDecrypt = jest.fn();

mock.module('../../src/auth/authService', () => ({
  AuthService: jest.fn().mockImplementation(() => ({
    authenticateSilent: mockAuthenticateSilent,
  })),
}));

mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: jest.fn(),
    coDecrypt: mockCoDecrypt,
  })),
}));

const mockHasOrgKey = jest.fn();
const realKeyResolver = await import('../../src/crypto/keyResolver');
mock.module('../../src/crypto/keyResolver', () => ({
  ...realKeyResolver,
  hasOrgKey: mockHasOrgKey,
}));

afterAll(() => mock.restore());

import { RedeemCommand } from '../../src/commands/redeemCommand';
import { buildRedeemCode, generateInviteToken } from '../../src/crypto/inviteCrypto';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'capy-redeem-cmd-'));
const ORIGINAL_CWD = process.cwd();

/** A real, well-formed redeem code for `targetOrgId`, expiring at `notAfter` (default: +1h). */
function makeCode(targetOrgId: string, notAfter: number = Date.now() + 3600_000): string {
  const token = generateInviteToken();
  // The ciphertext is opaque to parsing/expiry — co-decrypt is never called
  // in the dry-run path, so any base64 string is fine here.
  const ciphertext = Buffer.from('fake-outer-blob').toString('base64');
  return buildRedeemCode(token, ciphertext, targetOrgId, notAfter);
}

function captureOutput(): { out: () => string; restore: () => void } {
  let buf = '';
  const log = spyOn(console, 'log').mockImplementation(((...a: unknown[]) => { buf += a.join(' ') + '\n'; }) as any);
  const err = spyOn(console, 'error').mockImplementation(((...a: unknown[]) => { buf += a.join(' ') + '\n'; }) as any);
  return { out: () => buf, restore: () => { log.mockRestore(); err.mockRestore(); } };
}

describe('RedeemCommand --dry-run', () => {
  const mockExit = spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as any);

  beforeEach(() => {
    jest.clearAllMocks();
    process.chdir(TEST_DIR);
    mockAuthenticateSilent.mockResolvedValue({ success: false });
    mockHasOrgKey.mockReturnValue(false);
  });

  afterAll(() => process.chdir(ORIGINAL_CWD));

  it('invalid code: refuses exactly like the real run, never authenticates', async () => {
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute('not-a-real-code', { dryRun: true })).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.out()).toContain('Invalid redeem code');
    expect(mockAuthenticateSilent).not.toHaveBeenCalled();
    expect(mockCoDecrypt).not.toHaveBeenCalled();
  });

  it('expired code: refuses exactly like the real run', async () => {
    const code = makeCode('org-target', Date.now() - 1000);
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute(code, { dryRun: true })).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.out()).toContain('expired');
    expect(mockCoDecrypt).not.toHaveBeenCalled();
  });

  it('no cached session at all: sign-in is unanswered (exit 3), never co-decrypts, never writes a key', async () => {
    const code = makeCode('org-target');
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute(code, { dryRun: true })).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(3);
    expect(cap.out()).toContain('sign-in');
    expect(mockCoDecrypt).not.toHaveBeenCalled();
  });

  it('a silent session already scoped to the target org: nothing unanswered, never co-decrypts', async () => {
    const code = makeCode('org-target');
    mockAuthenticateSilent.mockResolvedValue({ success: true, organization_id: 'org-target', user_id: 'u1' });
    mockHasOrgKey.mockReturnValue(true);
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute(code, { dryRun: true })).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(cap.out()).not.toContain('sign-in');
    expect(mockCoDecrypt).not.toHaveBeenCalled();
    // Already has the key — no "unwrap and store" change listed.
    expect(cap.out()).not.toContain('unwrap and store');
  });

  it('silent session scoped to the target org, no local key yet: lists the key-write as a change (never performs it)', async () => {
    const code = makeCode('org-target');
    mockAuthenticateSilent.mockResolvedValue({ success: true, organization_id: 'org-target', user_id: 'u1' });
    mockHasOrgKey.mockReturnValue(false);
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute(code, { dryRun: true })).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(cap.out()).toContain('unwrap and store');
    expect(mockCoDecrypt).not.toHaveBeenCalled();
  });

  it('a keep.lock for a DIFFERENT org in cwd: lists "delete stale keep.lock" as a change, never deletes it', async () => {
    writeFileSync(join(TEST_DIR, 'keep.lock'), JSON.stringify({ org_id: 'some-other-org' }));
    const code = makeCode('org-target');
    mockAuthenticateSilent.mockResolvedValue({ success: true, organization_id: 'org-target', user_id: 'u1' });
    mockHasOrgKey.mockReturnValue(true);
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute(code, { dryRun: true })).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(cap.out()).toContain('delete stale keep.lock');
    expect(existsSync(join(TEST_DIR, 'keep.lock'))).toBe(true);
    rmSync(join(TEST_DIR, 'keep.lock'));
  });

  it('a keep.lock for the SAME org: no deletion listed', async () => {
    writeFileSync(join(TEST_DIR, 'keep.lock'), JSON.stringify({ org_id: 'org-target' }));
    const code = makeCode('org-target');
    mockAuthenticateSilent.mockResolvedValue({ success: true, organization_id: 'org-target', user_id: 'u1' });
    mockHasOrgKey.mockReturnValue(true);
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute(code, { dryRun: true })).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(cap.out()).not.toContain('delete stale keep.lock');
    rmSync(join(TEST_DIR, 'keep.lock'));
  });

  it('real run (no --dry-run, no opts) is unaffected by the new optional second argument', async () => {
    // Just proves `execute(code)` with no second arg still compiles/runs down
    // the ORIGINAL path — it will fail fast on an invalid code either way.
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute('not-a-real-code')).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

/**
 * `capy redeem <v3-code>` (CAP-529 guard 2): a v3 code (20-char Crockford,
 * minted by `capy invite --v3`) pasted into this v2-only command must get a
 * distinct, coded-shape failure — not garbage, and not silently treated as a
 * malformed v2 code. Uses the REAL `../../src/crypto/inviteCrypto` module
 * (unlike tests/commands/redeemCommand.test.ts, which mocks it wholesale for
 * its own unrelated nudge-flow purpose) so the v3 detection is exercised for
 * real, not against a stub.
 */
import { spyOn, describe, test, expect, beforeEach } from 'bun:test';
import { randomBytes } from 'crypto';
import { buildInviteCodeV3, generateInviteTokenV3, buildRedeemCode, generateInviteToken } from '../../src/crypto/inviteCrypto';
import { RedeemCommand } from '../../src/commands/redeemCommand';

function captureOutput(): { out: () => string; restore: () => void } {
  let buf = '';
  const log = spyOn(console, 'log').mockImplementation(((...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  }) as any);
  const err = spyOn(console, 'error').mockImplementation(((...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  }) as any);
  return {
    out: () => buf,
    restore: () => {
      log.mockRestore();
      err.mockRestore();
    },
  };
}

describe('RedeemCommand v3-code guard', () => {
  const mockExit = spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as any);

  beforeEach(() => {
    mockExit.mockClear();
  });

  test('a real v3 code gets the Keep-redirect message, not the generic v2 parse error', async () => {
    const code = buildInviteCodeV3(generateInviteTokenV3());
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute(code)).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.out()).toContain('keep.capy.sc');
    expect(cap.out()).not.toContain('Invalid redeem code:');
  });

  test('a v3 code without dashes still triggers the guard', async () => {
    const code = buildInviteCodeV3(generateInviteTokenV3()).replace(/-/g, '');
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute(code)).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(cap.out()).toContain('keep.capy.sc');
  });

  test('a genuinely malformed v2 code (guard 1) still gets the original error, unchanged', async () => {
    const buf = Buffer.from([0x02, ...randomBytes(5)]); // version 0x02 but truncated
    const shortCode = buf.toString('base64');
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute(shortCode)).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(cap.out()).toContain('Invalid redeem code:');
    expect(cap.out()).toContain('too short');
    expect(cap.out()).not.toContain('keep.capy.sc');
  });

  test('a real v2 code parses successfully via the shared dispatcher — guard 1, at the crypto layer that feeds this command', () => {
    // The full end-to-end (RedeemCommand.execute proceeding into real OAuth)
    // is out of scope for a fast unit test — that catch-block short-circuit
    // is only ever reached when parseRedeemCode ITSELF throws, so a
    // successful v2 parse never touches the new code path at all. Proven
    // directly: parseRedeemCode succeeds, so the guard's parseInviteCode
    // check never runs.
    const token = generateInviteToken();
    const outerBlob = randomBytes(64).toString('base64');
    const code = buildRedeemCode(token, outerBlob, 'org-x', Date.now() + 3600_000);
    const { parseRedeemCode } = require('../../src/crypto/inviteCrypto');
    expect(() => parseRedeemCode(code)).not.toThrow();
  });

  test('an unrecognisable (neither v2- nor v3-shaped) code falls through to the generic v2 error', async () => {
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().execute('not-a-real-code-at-all')).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(cap.out()).toContain('Invalid redeem code:');
    expect(cap.out()).not.toContain('keep.capy.sc');
  });
});

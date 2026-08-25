/**
 * `capy redeem` with NO code — the explicit entry point for
 * first-attach invite-pickup consumption. This is what an E2E harness (or a
 * human whose Keep paste already landed) runs to complete the flow.
 *
 * `consumeInvitePickup` itself is exhaustively tested against fakes in
 * tests/auth/invitePickup/consume.test.ts — this file's job is only the
 * command-level wiring: does `executePickup()` reach it with a real user id,
 * does it print the right thing on each outcome, and does it exit non-zero
 * with a CODED reason (never message-text branching) on every failure shape.
 *
 * ISOLATED (mock.module): registered in run-tests.sh.
 */
import { mock, spyOn, jest, describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const FAKE_USER = 'user_pickup_1';

const mockAuthenticateSilent = jest.fn();
const mockAuthenticate = jest.fn();
const mockGetValidToken = jest.fn();

mock.module('../../src/auth/authService', () => ({
  AuthService: jest.fn().mockImplementation(() => ({
    authenticateSilent: mockAuthenticateSilent,
    authenticate: mockAuthenticate,
    getValidToken: mockGetValidToken,
  })),
}));

const mockSetTokenProvider = jest.fn();
mock.module('../../src/service/serviceClient', () => ({
  ServiceClient: jest.fn().mockImplementation(() => ({
    setTokenProvider: mockSetTokenProvider,
    getPendingInvitePickup: jest.fn(),
    fetchInviteBlob: jest.fn(),
    coDecrypt: jest.fn(),
    wrapOuterLayer: jest.fn(),
    uploadDoorWrapper: jest.fn(),
    listWrappers: jest.fn(),
    deleteInvitePickup: jest.fn(),
  })),
}));

const mockConsumeInvitePickup = jest.fn();
mock.module('../../src/auth/invitePickup/consume', () => ({
  consumeInvitePickup: mockConsumeInvitePickup,
}));

afterAll(() => {
  mock.restore();
});

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

describe('RedeemCommand.executePickup', () => {
  const mockExit = spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as any);

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticateSilent.mockResolvedValue({ success: true, user_id: FAKE_USER, user_email: 'bob@example.com' });
    mockGetValidToken.mockResolvedValue({ access_token: 'tok' });
  });

  test('reaches consumeInvitePickup with the authenticated user id', async () => {
    mockConsumeInvitePickup.mockResolvedValue({ ok: true, noPendingPickup: true });
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().executePickup()).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockConsumeInvitePickup).toHaveBeenCalledTimes(1);
    expect(mockConsumeInvitePickup.mock.calls[0][0]).toBe(FAKE_USER);
  });

  test('no pending pickup: exits 1 with a clear message, not a crash', async () => {
    mockConsumeInvitePickup.mockResolvedValue({ ok: true, noPendingPickup: true });
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().executePickup()).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.out()).toContain('No pending invite');
  });

  test('success (fresh key write): reports success and does not claim "already had access"', async () => {
    mockConsumeInvitePickup.mockResolvedValue({
      ok: true,
      keyAlreadyPresent: false,
      orgId: 'org-1',
      inviteId: 'inv-1',
      credentialId: 'cred-1',
    });
    const cap = captureOutput();
    try {
      await new RedeemCommand().executePickup();
    } finally {
      cap.restore();
    }
    expect(mockExit).not.toHaveBeenCalled();
    expect(cap.out()).toContain('redeemed successfully');
    expect(cap.out()).not.toContain('already had access');
  });

  test('success (guard 5 short-circuit fired): reports the "already had access" branch', async () => {
    mockConsumeInvitePickup.mockResolvedValue({
      ok: true,
      keyAlreadyPresent: true,
      orgId: 'org-1',
      inviteId: 'inv-1',
      credentialId: 'cred-1',
    });
    const cap = captureOutput();
    try {
      await new RedeemCommand().executePickup();
    } finally {
      cap.restore();
    }
    expect(mockExit).not.toHaveBeenCalled();
    expect(cap.out()).toContain('already had access');
  });

  test('ceremony failure: exits 1 with a coded message naming the ceremony code, not a stack trace', async () => {
    mockConsumeInvitePickup.mockRejectedValue(
      new CapyError('ceremony failed', ERROR_CODES.DEVICE_KEY_CEREMONY_FAILED, { ceremonyCode: 'cancelled' }),
    );
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().executePickup()).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.out()).toContain('cancelled');
  });

  test('pickup unwrap failure: coded message, no crash', async () => {
    mockConsumeInvitePickup.mockRejectedValue(
      new CapyError('bad pickup', ERROR_CODES.DEVICE_KEY_UNWRAP_FAILED, { reason: 'pickup_gcm_auth_failed' }),
    );
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().executePickup()).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.out()).toContain('could not be unlocked');
  });

  test('door conflict under a different credential (guard 7 unresolved): coded message, no crash', async () => {
    mockConsumeInvitePickup.mockRejectedValue(new CapyError('conflict', ERROR_CODES.WRAPPER_CONFLICT, {}));
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().executePickup()).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.out()).toContain('different credential');
  });

  test('a non-CapyError failure (e.g. innerUnwrap GCM failure) still exits coded, not a raw crash', async () => {
    mockConsumeInvitePickup.mockRejectedValue(new Error('Unsupported state or unable to authenticate data'));
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().executePickup()).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(cap.out()).toContain('Could not complete the invite');
  });

  test('sign-in failure exits 1 before ever calling consumeInvitePickup', async () => {
    mockAuthenticateSilent.mockResolvedValue({ success: false, error: 'no session' });
    mockAuthenticate.mockResolvedValue({ success: false, error: 'declined' });
    const cap = captureOutput();
    try {
      await expect(new RedeemCommand().executePickup()).rejects.toThrow('process.exit');
    } finally {
      cap.restore();
    }
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockConsumeInvitePickup).not.toHaveBeenCalled();
  });
});

/** ISOLATED (mock.module): real FileSessionStorageBackend authentication installation. */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionStore } from '../../src/types/index';
import type { PairMachineAnswerSession } from '../../src/auth/pairing/pairContract';

const FLOW_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user_authfile';
const SERVICE_ORIGIN = 'https://service.example.test';
const PRIVATE_ROOT = mkdtempSync(join(tmpdir(), 'capy-flow-auth-file-'));
const sessionPath = (userId?: string): string => userId
  ? join(PRIVATE_ROOT, 'auth', 'sessions', `${userId}.json`)
  : join(PRIVATE_ROOT, 'auth', 'session.json');
const readStoredSession = (userId?: string): SessionStore | null => {
  const path = sessionPath(userId);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as SessionStore : null;
};

mock.module('../../src/config/globalConfig', () => ({
  getGlobalCapyDir: () => PRIVATE_ROOT,
  getAuthSessionPath: sessionPath,
  readAuthSession: readStoredSession,
}));
mock.module('../../src/config/profileConfig', () => ({ resolveActiveUrl: () => SERVICE_ORIGIN }));
mock.module('../../src/auth/pairing/runtimePairing', () => ({ assertRuntimePairingUser: () => undefined }));
mock.module('../../src/auth/pairing/pairAttemptLease', () => ({
  acquirePairAttemptLease: () => ({ path: join(PRIVATE_ROOT, 'pair-attempt.lock') }),
  releasePairAttemptLease: () => undefined,
}));

const startDeviceAuthorization = mock(async () => ({
  device_code: 'PRIVATE_DEVICE_CODE',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.example.test/device',
  expires_in: 300,
  interval: 5,
}));
mock.module('../../src/auth/pairing/deviceAuth', () => ({
  startDeviceAuthorization,
  deviceVerificationHandoff: (authorization: Readonly<{ verification_uri: string; user_code: string }>) => ({
    url: authorization.verification_uri,
    userCode: authorization.user_code,
    codePrefilled: false,
  }),
  toAnswerSession: () => { throw new Error('issued checkpoint must not redeem again'); },
}));

import {
  AuthenticationExecutorError,
  executeLocalFlowAuthentication,
  type AuthenticationCheckpoint,
} from '../../src/commands/flowAuthenticateCommand';
import { FileSessionStorageBackend } from '../../src/auth/session/fileBackend';
import { buildSessionStoreFromAnswer } from '../../src/auth/pairing/installPairedSession';

const options = { expectedUserId: USER_ID, serviceOrigin: SERVICE_ORIGIN } as const;
const answer = (refreshToken: string): PairMachineAnswerSession => ({
  user: { id: USER_ID, email: 'authfile@example.test', first_name: null, last_name: null },
  refresh_token: refreshToken,
  organizations: [],
  sessions: undefined,
});
const R0 = buildSessionStoreFromAnswer(answer('PRIVATE_REFRESH_R0'));
const R1_ANSWER = answer('PRIVATE_REFRESH_R1');
const R1 = buildSessionStoreFromAnswer(R1_ANSWER);
const R2 = buildSessionStoreFromAnswer(answer('PRIVATE_REFRESH_R2'));
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const checkpointPath = (): string => join(
  PRIVATE_ROOT,
  'auth',
  'authentication-flows',
  `${FLOW_ID}.json`,
);
const readCheckpoint = (): AuthenticationCheckpoint =>
  JSON.parse(readFileSync(checkpointPath(), 'utf8')) as AuthenticationCheckpoint;
const writeCheckpoint = (checkpoint: AuthenticationCheckpoint): void => {
  mkdirSync(dirname(checkpointPath()), { recursive: true, mode: 0o700 });
  writeFileSync(checkpointPath(), JSON.stringify(checkpoint), { mode: 0o600 });
};
const seedInitialAuthority = (): void => new FileSessionStorageBackend().save(R0, USER_ID);
const prepareIssuedCheckpoint = async (): Promise<AuthenticationCheckpoint> => {
  seedInitialAuthority();
  const pending = await executeLocalFlowAuthentication(FLOW_ID, options);
  expect(pending.stage).toBe('approval_pending');
  const checkpoint = readCheckpoint();
  const issued = {
    ...checkpoint,
    issued: { session: R1_ANSWER, bearer: 'PRIVATE_IDENTITY_BEARER' },
  } as const;
  writeCheckpoint(issued);
  return issued;
};

const captureRequest = mock((url: string, init: RequestInit | undefined) => ({ url, init }));
const completionStatus = mock(() => 200);
const fetchSpy = spyOn(globalThis, 'fetch');

beforeEach(() => {
  rmSync(PRIVATE_ROOT, { recursive: true, force: true });
  mkdirSync(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
  [startDeviceAuthorization, captureRequest, completionStatus]
    .forEach((candidate) => candidate.mockClear());
  completionStatus.mockReturnValue(200);
  fetchSpy.mockImplementation(async (input, init) => {
    const url = String(input);
    captureRequest(url, init);
    if (!url.endsWith('/complete')) throw new Error('device grant must not be redeemed again');
    const status = completionStatus();
    return status === 200
      ? Response.json({ stage: 'authenticated', user_id: USER_ID })
      : Response.json({ code: 'NOT_ACKNOWLEDGED' }, { status });
  });
});

afterAll(() => {
  fetchSpy.mockRestore();
  rmSync(PRIVATE_ROOT, { recursive: true, force: true });
  mock.restore();
});

const expectFixedInstallationRefusal = async (run: Promise<unknown>): Promise<void> => {
  const failure = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AuthenticationExecutorError);
  expect((failure as AuthenticationExecutorError).code).toBe('AUTH_SESSION_INSTALLATION_REFUSED');
};

describe('flow authentication real file-backend installation', () => {
  test('installs R1 against the pre-authorization R0 baseline and acknowledges once', async () => {
    const issued = await prepareIssuedCheckpoint();

    const result = await executeLocalFlowAuthentication(FLOW_ID, options);

    expect(result.stage).toBe('authenticated');
    expect(new FileSessionStorageBackend().load(USER_ID)).toEqual(R1);
    expect(issued.installationBaseline).toEqual({
      userId: USER_ID,
      refreshAuthoritySha256: digest(R0.refresh_token),
    });
    expect(startDeviceAuthorization).toHaveBeenCalledTimes(1);
    expect(captureRequest).toHaveBeenCalledTimes(1);
    expect(captureRequest.mock.calls[0]?.[0]).toEndWith(`/flows/authentication/${FLOW_ID}/complete`);
    expect(readCheckpoint()).toMatchObject({ completed: true, deviceCode: '' });
  });

  test('resumes the same installed grant after an unacknowledged completion without redeeming again', async () => {
    await prepareIssuedCheckpoint();
    completionStatus.mockReturnValueOnce(503);

    await expect(executeLocalFlowAuthentication(FLOW_ID, options))
      .rejects.toThrow('AUTH_COMPLETION_NOT_ACKNOWLEDGED');
    expect(readCheckpoint().installed).toBe(true);
    expect(new FileSessionStorageBackend().load(USER_ID)).toEqual(R1);

    const resumed = await executeLocalFlowAuthentication(FLOW_ID, options);
    expect(resumed.stage).toBe('authenticated');
    expect(startDeviceAuthorization).toHaveBeenCalledTimes(1);
    expect(captureRequest.mock.calls.map(([url]) => url)).toEqual([
      `${SERVICE_ORIGIN}/flows/authentication/${FLOW_ID}/complete`,
      `${SERVICE_ORIGIN}/flows/authentication/${FLOW_ID}/complete`,
    ]);
  });

  test('accepts the exact already-installed R1 after a crash before checkpointing installation', async () => {
    const issued = await prepareIssuedCheckpoint();
    const installed = new FileSessionStorageBackend().saveIfRefreshAuthorityMatches(
      R1,
      USER_ID,
      issued.installationBaseline.refreshAuthoritySha256,
    );
    expect(installed).toBe(true);

    const resumed = await executeLocalFlowAuthentication(FLOW_ID, options);
    expect(resumed.stage).toBe('authenticated');
    expect(startDeviceAuthorization).toHaveBeenCalledTimes(1);
    expect(captureRequest).toHaveBeenCalledTimes(1);
  });

  test('rejects concurrent R2 drift with a fixed code and never acknowledges', async () => {
    await prepareIssuedCheckpoint();
    const backend = new FileSessionStorageBackend();
    writeFileSync(sessionPath(USER_ID), JSON.stringify(R2), { mode: 0o600 });

    await expectFixedInstallationRefusal(executeLocalFlowAuthentication(FLOW_ID, options));

    expect(backend.load(USER_ID)).toEqual(R2);
    expect(captureRequest).not.toHaveBeenCalled();
    expect(startDeviceAuthorization).toHaveBeenCalledTimes(1);
  });

  test('does not treat an authority inserted after an empty baseline as still absent', async () => {
    const pending = await executeLocalFlowAuthentication(FLOW_ID, options);
    expect(pending.stage).toBe('approval_pending');
    expect(readCheckpoint().installationBaseline.refreshAuthoritySha256).toBeNull();
    mkdirSync(dirname(sessionPath(USER_ID)), { recursive: true, mode: 0o700 });
    writeFileSync(sessionPath(USER_ID), JSON.stringify(R2), { mode: 0o600 });
    writeCheckpoint({
      ...readCheckpoint(),
      issued: { session: R1_ANSWER, bearer: 'PRIVATE_IDENTITY_BEARER' },
    });

    await expectFixedInstallationRefusal(executeLocalFlowAuthentication(FLOW_ID, options));

    expect(new FileSessionStorageBackend().load(USER_ID)).toEqual(R2);
    expect(captureRequest).not.toHaveBeenCalled();
  });

  test('rejects a durable refresh fence with a fixed code and never acknowledges', async () => {
    await prepareIssuedCheckpoint();
    const fence = {
      v: 1,
      id: '22222222-2222-4222-8222-222222222222',
      user_id: USER_ID,
      authority_sha256: digest(R0.refresh_token),
      started_at: '2026-09-10T00:00:00.000Z',
      phase: 'in_flight',
    } as const;
    writeFileSync(`${sessionPath(USER_ID)}.refresh-in-flight`, JSON.stringify(fence), { mode: 0o600 });

    await expectFixedInstallationRefusal(executeLocalFlowAuthentication(FLOW_ID, options));

    expect(captureRequest).not.toHaveBeenCalled();
    expect(startDeviceAuthorization).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['empty', () => writeFileSync(sessionPath(USER_ID), '', { mode: 0o600 })],
    ['unprotected', () => {
      writeFileSync(sessionPath(USER_ID), JSON.stringify(R0), { mode: 0o600 });
      chmodSync(sessionPath(USER_ID), 0o644);
    }],
    ['dangling symlink', () => symlinkSync(join(PRIVATE_ROOT, 'missing-session'), sessionPath(USER_ID))],
    ['directory', () => mkdirSync(sessionPath(USER_ID), { recursive: true, mode: 0o700 })],
  ] as const)('strict session reads reject an existing %s authority path', (_kind, arrange) => {
    mkdirSync(dirname(sessionPath(USER_ID)), { recursive: true, mode: 0o700 });
    arrange();
    expect(() => new FileSessionStorageBackend().load(USER_ID)).toThrow();
  });
});

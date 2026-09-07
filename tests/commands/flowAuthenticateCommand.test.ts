import { describe, expect, it } from 'bun:test';
import { executeFlowAuthentication, projectAuthenticationResult, type AuthenticationCheckpoint, type AuthenticationExecutorDependencies } from '../../src/commands/flowAuthenticateCommand';
import { createHash } from 'crypto';

const flowId = '11111111-1111-4111-8111-111111111111';
const options = { expectedUserId: 'user_test', serviceOrigin: 'https://dev.invalid' };
const deviceCode = 'PRIVATE_DEVICE_CODE';
const now = Date.parse('2026-09-05T23:00:00Z');
const state: AuthenticationCheckpoint = {
  version: 1, flowId, userId: options.expectedUserId, apiUrl: options.serviceOrigin,
  deviceCode, intervalMs: 5000, pollAfter: now,
  handoff: { attemptId: flowId, deviceCodeHash: createHash('sha256').update(deviceCode).digest('hex'),
    url: 'https://dev.authkit.app/device?user_code=ABCD-EFGH', userCode: 'ABCD-EFGH',
    expiresAt: new Date(now + 300_000).toISOString() },
};
const fail = (): never => { throw new Error('unexpected dependency'); };
const deps: AuthenticationExecutorDependencies = {
  now: () => now, wait: async () => {}, request: fail, start: fail,
  read: () => null, save: () => {}, remove: fail, assertUser: () => {}, install: fail,
};
const session = { user: { id: 'user_test', email: 'test@example.invalid', first_name: null, last_name: null },
  refresh_token: 'PRIVATE_REFRESH_TOKEN', organizations: [], sessions: undefined };

describe('non-interactive authentication executor', () => {
  it('projects pending authentication back to its onboarding parent without exposing private state', async () => {
    const parentId = '22222222-2222-4222-8222-222222222222';
    const result = await executeFlowAuthentication(flowId, { ...options, onboardFlowId: parentId }, {
      ...deps, read: () => ({ ...state, pollAfter: now + 30_000 }),
    });
    const projected = projectAuthenticationResult(result, parentId);
    expect(projected.continuation).toEqual({ tool: 'capy_onboard', args: {
      flow_id: parentId, authentication_handoff: state.handoff,
    } });
    expect(projected.flow_id).toBe(flowId);
    expect(JSON.stringify(projected)).not.toContain(deviceCode);
    expect(projectAuthenticationResult(result)).toEqual(result);
  });

  it('projects authenticated completion without a stale authentication handoff', async () => {
    const parentId = '22222222-2222-4222-8222-222222222222';
    const result = await executeFlowAuthentication(flowId, options, { ...deps,
      read: () => ({ ...state, deviceCode: '', completed: true }), hasInstalledSession: () => true,
    });
    expect(projectAuthenticationResult(result, parentId).continuation).toEqual({
      tool: 'capy_onboard', args: { flow_id: parentId },
    });
  });

  it('refuses invalid parent ids before any local or network change', async () => {
    await expect(executeFlowAuthentication(flowId, { ...options, onboardFlowId: '../invalid' }, {
      ...deps, read: fail, save: fail, assertUser: fail,
    })).rejects.toThrow('AUTH_ARGUMENT_INVALID');
  });
  it.each([
    [{ error: 'access_denied' }, 'AUTH_ACCESS_DENIED'],
    [{ error: 'expired_token' }, 'AUTH_FLOW_EXPIRED'],
    [{ code: 'AUTH_ACCOUNT_MISMATCH' }, 'AUTH_ACCOUNT_MISMATCH'],
  ] as const)('refuses a denied or invalid exchange without installing credentials: %j', async (body, code) => {
    await expect(executeFlowAuthentication(flowId, options, { ...deps,
      read: () => state,
      request: (async () => Response.json(body, { status: 400 })) as typeof fetch,
    })).rejects.toThrow(code);
  });
  it('returns at the link without polling or installing and saves private state separately', async () => {
    const result = await executeFlowAuthentication(flowId, options, { ...deps,
      start: async () => ({ device_code: deviceCode, user_code: 'ABCD-EFGH', verification_uri: 'https://dev.authkit.app/device', expires_in: 300, interval: 5 }),
      save: (saved) => { expect(saved.deviceCode).toBe(deviceCode); expect(saved.userId).toBe('user_test'); },
    });
    expect(result.stage).toBe('approval_pending');
    expect(JSON.stringify(result)).not.toContain(deviceCode);
    expect(result.continuation.tool).toBe('capy_authenticate');
  });

  it('resumes an issued credential without exchanging the device code again', async () => {
    const result = await executeFlowAuthentication(flowId, options, { ...deps,
      read: () => ({ ...state, issued: { session, bearer: 'PRIVATE_ACCESS_TOKEN' } }),
      install: (installed) => { expect(installed).toEqual(session); },
      save: (saved) => { expect(saved.installed === true || saved.completed === true).toBe(true); }, remove: () => {},
      request: (async (url, init) => {
        expect(String(url)).toEndWith('/complete');
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer PRIVATE_ACCESS_TOKEN');
        return Response.json({ stage: 'authenticated', user_id: 'user_test' });
      }) as typeof fetch,
    });
    expect(result.stage).toBe('authenticated');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it('does not install the session twice after an interrupted acknowledgement', async () => {
    const result = await executeFlowAuthentication(flowId, options, { ...deps,
      read: () => ({ ...state, installed: true, issued: { session, bearer: 'PRIVATE_ACCESS_TOKEN' } }),
      remove: () => {}, request: (async () => Response.json({ stage: 'authenticated', user_id: 'user_test' })) as typeof fetch,
    });
    expect(result.stage).toBe('authenticated');
  });

  it('rejects identity changes, environment changes, and expired attempts', async () => {
    await expect(executeFlowAuthentication(flowId, options, { ...deps, read: () => ({ ...state, userId: 'user_other' }) })).rejects.toThrow('AUTH_LOCAL_STATE_INVALID');
    await expect(executeFlowAuthentication(flowId, options, { ...deps, read: () => ({ ...state, apiUrl: 'https://other.invalid' }) })).rejects.toThrow('AUTH_LOCAL_STATE_INVALID');
    await expect(executeFlowAuthentication(flowId, options, { ...deps, read: () => state, now: () => now + 300_000 })).rejects.toThrow('AUTH_FLOW_EXPIRED');
    await expect(executeFlowAuthentication(flowId, options, { ...deps,
      read: () => ({ ...state, issued: { session: { ...session, user: { ...session.user, id: 'user_other' } }, bearer: 'PRIVATE_ACCESS_TOKEN' } }),
    })).rejects.toThrow('AUTH_ACCOUNT_MISMATCH');
  });

  it('respects persisted polling deadlines across restarts', async () => {
    const result = await executeFlowAuthentication(flowId, options, { ...deps, read: () => ({ ...state, pollAfter: now + 30_000 }) });
    expect(result.stage).toBe('approval_pending');
  });

  it('replays a completed receipt without opening another device grant', async () => {
    const result = await executeFlowAuthentication(flowId, options, { ...deps,
      read: () => ({ ...state, deviceCode: '', completed: true }), hasInstalledSession: () => true,
    });
    expect(result.stage).toBe('authenticated');
    await expect(executeFlowAuthentication(flowId, options, { ...deps,
      read: () => ({ ...state, deviceCode: '', completed: true }), hasInstalledSession: () => false,
    })).rejects.toThrow('AUTH_LOCAL_SESSION_MISSING');
  });

  it('accepts org-less identity credentials without creating an organization', async () => {
    const result = await executeFlowAuthentication(flowId, options, { ...deps, read: () => state,
      request: (async (url) => String(url).endsWith('/complete')
        ? Response.json({ stage: 'authenticated', user_id: 'user_test' })
        : Response.json({ status: 'complete', identity_access_token: 'PRIVATE_ACCESS_TOKEN',
          token: { refresh_token: session.refresh_token, access_token: null }, user: session.user, organizations: [] })) as typeof fetch,
      install: (installed) => { expect(installed.organizations).toEqual([]); }, remove: () => {},
    });
    expect(result.stage).toBe('authenticated');
  });
});

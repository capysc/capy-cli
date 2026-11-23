import { describe, test, expect } from 'bun:test';
import { pairApprovalLink, resolvePairScope } from '../../src/auth/pairing/pairScope';
import { pairKeyFingerprint } from '../../src/crypto/pairFingerprint';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const lock = (orgId: string, projectId: string) => () => ({ orgId, projectId }) as any;
const none = () => null;

describe('resolvePairScope: keep.lock and --org are hints, never required', () => {
  test('plain capy pair is sign-in only, hinting the keep.lock org', () => {
    expect(resolvePairScope({}, '/x', { readProject: lock('org_1', 'proj_1') }))
      .toEqual({ mode: 'session', orgId: 'org_1', projectId: null, signup: false });
  });

  test('outside a project with no --org, nothing is hinted: the Keep session org decides', () => {
    expect(resolvePairScope({}, '/x', { readProject: none }))
      .toEqual({ mode: 'session', orgId: null, projectId: null, signup: false });
  });

  test('--org wins over keep.lock', () => {
    expect(resolvePairScope({ org: ' org_2 ' }, '/x', { readProject: lock('org_1', 'proj_1') }).orgId).toBe('org_2');
  });

  test('--transport hints the keep.lock org and project', () => {
    expect(resolvePairScope({ transport: true }, '/x', { readProject: lock('org_1', 'proj_1') }))
      .toEqual({ mode: 'transport', orgId: 'org_1', projectId: 'proj_1', signup: false });
  });

  test('--transport with --org naming another org drops the project hint (it belongs to keep.lock\'s org)', () => {
    expect(resolvePairScope({ transport: true, org: 'org_2' }, '/x', { readProject: lock('org_1', 'proj_1') }))
      .toEqual({ mode: 'transport', orgId: 'org_2', projectId: null, signup: false });
  });

  test('--transport outside a project is allowed, unhinted', () => {
    expect(resolvePairScope({ transport: true }, '/x', { readProject: none }))
      .toEqual({ mode: 'transport', orgId: null, projectId: null, signup: false });
  });

  test('--signup is an unhinted transport pairing, refused inside a project', () => {
    expect(resolvePairScope({ signup: true }, '/x', { readProject: none }))
      .toEqual({ mode: 'transport', orgId: null, projectId: null, signup: true });
    try {
      resolvePairScope({ signup: true }, '/x', { readProject: lock('org_1', 'proj_1') });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CapyError);
      expect((error as CapyError).code).toBe(ERROR_CODES.PAIR_SCOPE_REQUIRED);
    }
  });

  test('the approval link is Keep /pair for sign-in and /transport/pair for a key handover', () => {
    expect(pairApprovalLink({ mode: 'session', orgId: null, projectId: null, signup: false }, 'AB CD')).toMatch(/\/pair\?code=AB%20CD$/);
    expect(pairApprovalLink({ mode: 'transport', orgId: null, projectId: null, signup: false }, 'ABCD')).toMatch(/\/transport\/pair\?code=ABCD$/);
  });
});

describe('pairKeyFingerprint', () => {
  test('matches the vector Keep and the service tests use', () => {
    const publicKey = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url');
    expect(pairKeyFingerprint(publicKey)).toBe('EE5C-8300-CD17-3089');
  });
});

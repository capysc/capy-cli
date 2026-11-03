import { describe, expect, mock, test } from 'bun:test';
import { encryptMasterKey, masterKeyAAD } from '../../../src/crypto/keyManager';
import { deriveLocalInnerKey } from '../../../src/crypto/localKeyRoot';
import { inspectExistingFilesystemCustody, type ExistingFilesystemCustodyDependencies } from '../../../src/auth/pairing/existingFilesystemCustody';

const userId = 'user_fixture';
const orgId = 'org-fixture';
const root = Buffer.alloc(32, 1);
const master = Buffer.alloc(32, 2);
const wrapped = 'outer-wrapped-fixture';
const inner = encryptMasterKey(master, deriveLocalInnerKey(root), masterKeyAAD(userId, orgId));
const input = { serviceOrigin: 'https://service.example', userId } as const;
const dependencies = (): ExistingFilesystemCustodyDependencies => ({
  authenticate: async () => ({ userId, orgId, accessToken: 'scoped-token' }),
  readRoot: () => root,
  readWrapped: () => wrapped,
  unwrapOuter: async () => inner,
});

describe('existing filesystem custody', () => {
  test('proves the saved root opens the authenticated account and organization wrapper', async () => {
    const unwrap = mock(async () => inner);
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), unwrapOuter: unwrap })).toEqual({ kind: 'verified', orgId });
    expect(unwrap).toHaveBeenCalledWith(input.serviceOrigin, { userId, orgId, accessToken: 'scoped-token' }, wrapped);
    expect(root.equals(Buffer.alloc(32, 1))).toBe(true);
  });
  test('an absent local identity or absent key pair retains the new-device path', async () => {
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), authenticate: async () => null })).toEqual({ kind: 'missing' });
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readRoot: () => null, readWrapped: () => null })).toEqual({ kind: 'missing' });
  });
  test('another account cannot inspect or acknowledge these key files', async () => {
    const readRoot = mock(() => root);
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), authenticate: async () => ({ userId: 'user_other', orgId, accessToken: 'other' }), readRoot })).toEqual({ kind: 'invalid' });
    expect(readRoot).not.toHaveBeenCalled();
  });
  test('missing, truncated or incorrect keys never establish custody', async () => {
    for (const candidate of [null, Buffer.alloc(3), Buffer.alloc(32, 9)]) {
      expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readRoot: () => candidate })).toEqual({ kind: 'invalid' });
    }
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readWrapped: () => null })).toEqual({ kind: 'invalid' });
  });
  test('a wrapper for another identity or organization fails authentication', async () => {
    const wrongBinding = encryptMasterKey(master, deriveLocalInnerKey(root), masterKeyAAD('user_other', orgId));
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), unwrapOuter: async () => wrongBinding })).toEqual({ kind: 'invalid' });
  });
  test('server refusal cannot be replaced by possession of a local file', async () => {
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), unwrapOuter: async () => { throw new Error('403'); } })).toEqual({ kind: 'invalid' });
  });
  test('files changed during verification are rejected without writes', async () => {
    const readRoot = mock(() => root).mockReturnValueOnce(root).mockReturnValueOnce(Buffer.alloc(32, 3));
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readRoot })).toEqual({ kind: 'invalid' });
    const readWrapped = mock(() => wrapped).mockReturnValueOnce(wrapped).mockReturnValueOnce('replacement');
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readWrapped })).toEqual({ kind: 'invalid' });
  });
});

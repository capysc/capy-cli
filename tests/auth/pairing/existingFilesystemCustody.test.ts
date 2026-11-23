import { describe, expect, mock, test } from 'bun:test';
import { encryptMasterKey, masterKeyAAD } from '../../../src/crypto/keyManager';
import { deriveLocalInnerKey } from '../../../src/crypto/localKeyRoot';
import { inspectExistingFilesystemCustody, type ExistingFilesystemCustodyDependencies } from '../../../src/auth/pairing/existingFilesystemCustody';

const userId = 'user_fixture';
const orgId = 'org-fixture';
const root = Buffer.alloc(32, 1);
const master = Buffer.alloc(32, 2);
const wrapped = 'outer-wrapped-fixture';
const keyFile = JSON.stringify({ version: '2.0', org_id: orgId, wrapping_method: 'local_root', encrypted_master_key: wrapped });
const inner = encryptMasterKey(master, deriveLocalInnerKey(root), masterKeyAAD(userId, orgId));
const input = { serviceOrigin: 'https://service.example', userId } as const;
const dependencies = (): ExistingFilesystemCustodyDependencies => ({
  authenticate: async () => ({ userId, orgId, accessToken: 'scoped-token' }),
  readRoot: () => root,
  readKeyFile: () => keyFile,
  unwrapOuter: async () => inner,
});

describe('existing filesystem custody', () => {
  test('proves the saved root opens the authenticated account and organization wrapper', async () => {
    const unwrap = mock(async () => inner);
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), unwrapOuter: unwrap })).toEqual({ kind: 'verified', orgId });
    expect(unwrap).toHaveBeenCalledWith(input.serviceOrigin, { userId, orgId, accessToken: 'scoped-token' }, wrapped, undefined);
    expect(root.equals(Buffer.alloc(32, 1))).toBe(true);
  });
  test('an absent local identity or absent key pair retains the new-device path', async () => {
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), authenticate: async () => null })).toEqual({ kind: 'missing' });
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readRoot: () => null, readKeyFile: () => null })).toEqual({ kind: 'missing' });
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
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readKeyFile: () => null })).toEqual({ kind: 'invalid' });
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
    const readKeyFile = mock(() => keyFile).mockReturnValueOnce(keyFile).mockReturnValueOnce('replacement');
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readKeyFile })).toEqual({ kind: 'invalid' });
  });
  test('reuses current Transport custody with its original row context and unchanged file bytes', async () => {
    const transportId = '55555555-5555-4555-8555-555555555555';
    const raw = JSON.stringify({ ...JSON.parse(keyFile), transport_id: transportId });
    const readKeyFile = mock(() => raw);
    const unwrapOuter = mock(async () => inner);
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readKeyFile, unwrapOuter })).toEqual({ kind: 'verified', orgId });
    expect(unwrapOuter).toHaveBeenCalledWith(input.serviceOrigin, { userId, orgId, accessToken: 'scoped-token' }, wrapped, transportId);
    expect(readKeyFile.mock.results.map(result => result.value)).toEqual([raw, raw]);
  });
  test('recognized Transport metadata never falls back after a wrong org, malformed id or missing owner binding', async () => {
    const transportFile = { ...JSON.parse(keyFile), transport_id: '55555555-5555-4555-8555-555555555555' };
    for (const file of [{ ...transportFile, org_id: 'other' }, { ...transportFile, transport_id: 'invalid' },
      { ...transportFile, transport_id: null }, { ...transportFile, wrapping_method: 'other' }]) {
      const unwrapOuter = mock(async () => inner);
      expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readKeyFile: () => JSON.stringify(file), unwrapOuter })).toEqual({ kind: 'invalid' });
      expect(unwrapOuter).not.toHaveBeenCalled();
    }
    const unbound = encryptMasterKey(master, deriveLocalInnerKey(root));
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readKeyFile: () => JSON.stringify(transportFile),
      unwrapOuter: async () => unbound })).toEqual({ kind: 'invalid' });
  });
  test('a changed Transport id during verification is refused even when the ciphertext is unchanged', async () => {
    const first = JSON.stringify({ ...JSON.parse(keyFile), transport_id: '55555555-5555-4555-8555-555555555555' });
    const second = JSON.stringify({ ...JSON.parse(first), transport_id: '66666666-6666-4666-8666-666666666666' });
    const readKeyFile = mock(() => first).mockReturnValueOnce(first).mockReturnValueOnce(second);
    expect(await inspectExistingFilesystemCustody(input, { ...dependencies(), readKeyFile })).toEqual({ kind: 'invalid' });
  });
});

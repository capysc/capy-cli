import { expect, mock, test } from 'bun:test';
import { prepareTransportCustody } from '../../../src/auth/pairing/transportCustody';
import { CapyError, ERROR_CODES } from '../../../src/types/index';
import { deriveLocalInnerKey } from '../../../src/crypto/localKeyRoot';
import { decryptBoundMasterKey, encryptMasterKey, masterKeyAAD } from '../../../src/crypto/keyManager';

const root = Buffer.alloc(32, 7);
const master = Buffer.alloc(32, 9);
const transport = '11111111-1111-4111-8111-111111111111';
const inner = encryptMasterKey(master, deriveLocalInnerKey(root), masterKeyAAD('user_synthetic', 'org-synthetic'));
const keyFile = { version: '2.0', org_id: 'org-synthetic', wrapping_method: 'local_root', transport_id: transport,
  encrypted_master_key: 'synthetic-transport-outer', created_at: '2026-11-02T00:00:00.000Z' } as const;
const entry = { org_id: 'org-synthetic', user_id: 'user_synthetic', k_local: root.toString('base64url'),
  transport_id: transport, key_enc: JSON.stringify(keyFile) } as const;
const operations = () => ({ unwrap: mock(async () => inner), wrap: mock(async () => 'synthetic-installed-outer') });

test('current Transport installation verifies the same root and sends its exact row binding', async () => {
  const ops = operations();
  const installed = await prepareTransportCustody(entry, ops);
  expect(ops.unwrap).toHaveBeenCalledWith(entry.org_id, keyFile.encrypted_master_key, transport);
  expect(ops.wrap).toHaveBeenCalledWith(entry.org_id, inner);
  expect(installed.k_local).toBe(entry.k_local);
  expect(installed.user_id).toBe(entry.user_id);
  const installedFile = JSON.parse(installed.key_enc);
  expect(installedFile).toEqual({ version: '2.0', org_id: entry.org_id, wrapping_method: 'local_root',
    encrypted_master_key: 'synthetic-installed-outer', created_at: keyFile.created_at });
  expect(decryptBoundMasterKey(inner, deriveLocalInnerKey(root), masterKeyAAD(entry.user_id, entry.org_id))).toEqual(master);
  expect(JSON.parse(entry.key_enc)).toEqual(keyFile);
});

test('legacy pairing file bytes are reused without a wrap or unwrap operation', async () => {
  const legacy = { org_id: entry.org_id, user_id: entry.user_id, k_local: entry.k_local,
    key_enc: JSON.stringify({ version: '2.0', org_id: entry.org_id, encrypted_master_key: 'legacy-outer' }) };
  const ops = operations();
  expect(await prepareTransportCustody(legacy, ops)).toBe(legacy);
  expect(ops.unwrap).not.toHaveBeenCalled();
  expect(ops.wrap).not.toHaveBeenCalled();
});

test('wrong owner, organization, root or row id cannot prepare an installation', async () => {
  const cases = [
    { ...entry, user_id: 'user_foreign' },
    { ...entry, org_id: 'org-foreign' },
    { ...entry, k_local: Buffer.alloc(32, 1).toString('base64url') },
    { ...entry, transport_id: '22222222-2222-4222-8222-222222222222' },
    { ...entry, key_enc: JSON.stringify({ ...keyFile, transport_id: 'invalid' }) },
  ];
  for (const candidate of cases) {
    const ops = operations();
    await expect(prepareTransportCustody(candidate, ops)).rejects.toHaveProperty('code', 'DECRYPT_KEY_MISMATCH');
    expect(ops.wrap).not.toHaveBeenCalled();
  }
});

test('an unbound or tampered inner ciphertext never falls back to legacy custody', async () => {
  const unbound = encryptMasterKey(master, deriveLocalInnerKey(root));
  const corrupt = Buffer.from(inner, 'base64').toString('base64').slice(0, -4) + 'AAAA';
  for (const ciphertext of [unbound, corrupt]) {
    const ops = { ...operations(), unwrap: async () => ciphertext };
    await expect(prepareTransportCustody(entry, ops)).rejects.toHaveProperty('code', 'DECRYPT_KEY_MISMATCH');
    expect(ops.wrap).not.toHaveBeenCalled();
  }
});

test('server revocation or unwrap refusal cannot be replaced by local possession', async () => {
  const ops = { ...operations(), unwrap: async () => { throw new CapyError('Synthetic refusal', ERROR_CODES.PERMISSION_DENIED); } };
  await expect(prepareTransportCustody(entry, ops)).rejects.toHaveProperty('code', 'PERMISSION_DENIED');
  expect(ops.wrap).not.toHaveBeenCalled();
});

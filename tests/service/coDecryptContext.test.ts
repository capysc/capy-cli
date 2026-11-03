import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
const actual = await import('../../src/config/globalConfig');
const read = mock((): string | null => null);
mock.module('../../src/config/globalConfig', () => ({ ...actual, readOrgKeyFileRaw: read }));
import { ServiceClient } from '../../src/service/serviceClient';

const row = '55555555-5555-4555-8555-555555555555';
const ciphertext = 'synthetic-encrypted-master-key';
const file = { version: '2.0', org_id: 'org_synthetic', wrapping_method: 'local_root', transport_id: row, encrypted_master_key: ciphertext };
const fetcher = spyOn(globalThis, 'fetch');
beforeEach(() => { read.mockReset(); read.mockReturnValue(JSON.stringify(file)); fetcher.mockReset(); fetcher.mockImplementation(async () => Response.json({ plaintext: 'synthetic-inner-ciphertext' })); });
afterAll(() => { fetcher.mockRestore(); mock.restore(); });
const client = () => {
  const service = new ServiceClient('https://synthetic-service.invalid', true);
  service.setTokenProvider(async () => ({ user_id: 'user_synthetic', organization_id: 'org_synthetic', access_token: 'synthetic-access-token', expires_at: Date.now() + 60000 }));
  return service;
};
const sent = () => JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string);

test('all normal CLI key operations retain the stored Transport row context without rewriting custody', async () => {
  await client().coDecrypt('org_synthetic', ciphertext);
  expect(read).toHaveBeenCalledWith('org_synthetic', 'user_synthetic');
  expect(sent()).toEqual({ ciphertext, transport_id: row });
});
test('unrelated invite ciphertext and legacy files do not inherit a Transport context', async () => {
  await client().coDecrypt('org_synthetic', 'synthetic-unrelated-invite');
  expect(sent()).toEqual({ ciphertext: 'synthetic-unrelated-invite' });
  fetcher.mockClear();
  read.mockReturnValue(JSON.stringify({ version: '2.0', org_id: 'org_synthetic', encrypted_master_key: ciphertext, wrapping_method: 'local_root' }));
  await client().coDecrypt('org_synthetic', ciphertext);
  expect(sent()).toEqual({ ciphertext });
});
test('explicit Transport and time-limited redemption calls retain their own context', async () => {
  await client().coDecrypt('org_synthetic', ciphertext, undefined, 'explicit-row');
  expect(read).not.toHaveBeenCalled();
  expect(sent()).toEqual({ ciphertext, transport_id: 'explicit-row' });
  fetcher.mockClear();
  await client().coDecrypt('org_synthetic', ciphertext, 1234);
  expect(read).not.toHaveBeenCalled();
  expect(sent()).toEqual({ ciphertext, not_after: 1234 });
});
test('malformed or different-organization stored context cannot downgrade to a legacy unwrap', async () => {
  for (const candidate of [{ ...file, transport_id: 'invalid' }, { ...file, org_id: 'org_other' }]) {
    read.mockReturnValue(JSON.stringify(candidate));
    await expect(client().coDecrypt('org_synthetic', ciphertext)).rejects.toThrow('CUSTODY_FILE_INVALID');
    expect(fetcher).not.toHaveBeenCalled();
  }
});

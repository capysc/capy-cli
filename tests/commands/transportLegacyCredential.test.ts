import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'capy-transport-legacy-'));
const actualOs = await import('os');
mock.module('os', () => ({ ...actualOs, homedir: () => home }));
const orgId = '11111111-1111-4111-8111-111111111111';
const userId = 'user_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const transportId = '22222222-2222-4222-8222-222222222222';
const config = await import('../../src/config/globalConfig');
const crypto = await import('../../src/crypto/keyManager');
const { deriveLocalInnerKey } = await import('../../src/crypto/localKeyRoot');
const { openTransportBlob, parseTransportFragmentV4, unpackTransportV3 } = await import('../../src/crypto/transportPackV3');
const { CapyError, ERROR_CODES } = await import('../../src/types/index');
const fixtureKey = Buffer.alloc(32, 8);
const fixtureOuterKey = Buffer.alloc(32, 9);
const createTransport = mock(async (_ciphertext: string) => ({ id: transportId, expires_at: '2030-01-01T00:00:00.000Z' }));
const wrap = mock(async (_id: string, plaintext: string) => ({ ciphertext: crypto.encryptMasterKey(Buffer.from(plaintext), fixtureOuterKey) }));
const coDecrypt = mock(async (_id: string, ciphertext: string) => ({ plaintext: crypto.decryptMasterKey(ciphertext, fixtureOuterKey).toString() }));
mock.module('../../src/core/orgContext', () => ({ resolveOrgContext: async () => ({
  orgId, userId, serviceClient: { coDecrypt, wrapOuterLayer: wrap, createTransport },
}) }));
const { TransportCommand } = await import('../../src/commands/transportCommand');
const output = spyOn(console, 'log').mockImplementation(() => {});
const errors = spyOn(console, 'error').mockImplementation(() => {});
const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('test exit'); });

beforeEach(() => {
  rmSync(join(home, '.capy'), { recursive: true, force: true });
  output.mockClear(); errors.mockClear(); exit.mockClear(); createTransport.mockClear();
  wrap.mockReset(); coDecrypt.mockReset();
  wrap.mockImplementation(async (_id, plaintext) => ({ ciphertext: crypto.encryptMasterKey(Buffer.from(plaintext), fixtureOuterKey) }));
  coDecrypt.mockImplementation(async (_id, ciphertext) => ({ plaintext: crypto.decryptMasterKey(ciphertext, fixtureOuterKey).toString() }));
});
afterAll(() => { mock.restore(); rmSync(home, { recursive: true, force: true }); });

function legacyFile(ciphertext: string): string {
  return JSON.stringify({ version: '1.0', org_id: orgId, encrypted_master_key: ciphertext, wrapping_method: 'auth_token', created_at: '2026-09-29T00:00:00.000Z' }, null, 2);
}
function seedLegacy(withRoot: boolean, outer: boolean): string {
  if (withRoot) config.saveLocalRoot(orgId, Buffer.alloc(32, 3), userId);
  const inner = crypto.encryptMasterKey(fixtureKey, crypto.deriveWrappingKey(userId, orgId), crypto.masterKeyAAD(userId, orgId));
  const raw = legacyFile(outer ? crypto.encryptMasterKey(Buffer.from(inner), fixtureOuterKey) : inner);
  config.writeOrgKeyFileRaw(orgId, raw, userId);
  return raw;
}
async function assertRoundTrip(): Promise<void> {
  await new TransportCommand().execute({ json: true });
  const result = JSON.parse(output.mock.calls.map(args => args.join(' ')).join('\n'));
  const { key } = parseTransportFragmentV4(result.url.split('#')[1]);
  const entry = unpackTransportV3(openTransportBlob(createTransport.mock.calls[0][0], key));
  expect(entry.key_enc).toBe(config.readOrgKeyFileRaw(orgId, userId)!);
  expect(entry.k_local).toBe(config.readLocalRoot(orgId, userId)!.toString('base64url'));
  const stored = JSON.parse(entry.key_enc);
  expect(stored.version).toBe('2.0');
  const inner = crypto.decryptMasterKey(stored.encrypted_master_key, fixtureOuterKey).toString();
  expect(crypto.decryptMasterKey(inner, deriveLocalInnerKey(Buffer.from(entry.k_local, 'base64url')), crypto.masterKeyAAD(userId, orgId))).toEqual(fixtureKey);
}

test('legacy file with an existing root migrates before producing a readable link', async () => {
  seedLegacy(true, true);
  await assertRoundTrip();
});
test('legacy file without a root migrates rather than reporting no local key', async () => {
  seedLegacy(false, true);
  await assertRoundTrip();
});
test('oldest single-wrapped file uses the existing migration path', async () => {
  seedLegacy(false, false);
  await assertRoundTrip();
});
test('current storage is packed unchanged without migration service calls', async () => {
  config.saveLocalRoot(orgId, Buffer.alloc(32, 3), userId);
  config.saveMasterKey(orgId, Buffer.alloc(60, 1).toString('base64'), userId);
  const before = config.readOrgKeyFileRaw(orgId, userId);
  await new TransportCommand().execute({ json: true });
  expect(config.readOrgKeyFileRaw(orgId, userId)).toBe(before);
  expect(coDecrypt).not.toHaveBeenCalled(); expect(wrap).not.toHaveBeenCalled();
  expect(createTransport).toHaveBeenCalledTimes(1);
});
test('failed persistence preserves the old file and creates no transport', async () => {
  const before = seedLegacy(true, true);
  wrap.mockRejectedValue(new CapyError('Service unavailable', ERROR_CODES.NETWORK_ERROR));
  await expect(new TransportCommand().execute({ json: true })).rejects.toThrow('test exit');
  expect(config.readOrgKeyFileRaw(orgId, userId)).toBe(before);
  expect(createTransport).not.toHaveBeenCalled();
  expect(JSON.parse(output.mock.calls[0][0] as string).code).toBe(ERROR_CODES.NETWORK_ERROR);
});
test('access denial is preserved without creating a transport or modifying credentials', async () => {
  const before = seedLegacy(true, true);
  coDecrypt.mockRejectedValue(new CapyError('Access denied', ERROR_CODES.PERMISSION_DENIED, { status: 403 }));
  await expect(new TransportCommand().execute({ json: true })).rejects.toThrow('test exit');
  expect(config.readOrgKeyFileRaw(orgId, userId)).toBe(before);
  expect(wrap).not.toHaveBeenCalled(); expect(createTransport).not.toHaveBeenCalled();
  expect(JSON.parse(output.mock.calls[0][0] as string).code).toBe(ERROR_CODES.PERMISSION_DENIED);
});
test('legacy metadata on already upgraded storage is persisted before packing', async () => {
  const root = Buffer.alloc(32, 3);
  config.saveLocalRoot(orgId, root, userId);
  const inner = crypto.encryptMasterKey(fixtureKey, deriveLocalInnerKey(root), crypto.masterKeyAAD(userId, orgId));
  config.writeOrgKeyFileRaw(orgId, legacyFile(crypto.encryptMasterKey(Buffer.from(inner), fixtureOuterKey)), userId);
  await assertRoundTrip();
});

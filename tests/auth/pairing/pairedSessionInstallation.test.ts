import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const temporaryHome = mkdtempSync('/private/tmp/capy-paired-installation-');
mock.module('os', () => ({ ...require('os'), homedir: () => temporaryHome }));
const { FileSessionStorageBackend } = await import('../../../src/auth/session/fileBackend');
const { capturePairedSessionInstallationBaseline: capture, installDeviceAuthenticatedSession: install } =
  await import('../../../src/auth/pairing/pairedSessionInstallation');
import type { SessionStore } from '../../../src/types/index';

const directory = join(temporaryHome, '.capy');
const backend = new FileSessionStorageBackend();
const session = (refreshToken: string, userId = 'user_1'): SessionStore => ({
  version: 2, user_id: userId, user_email: `${userId}@example.invalid`,
  refresh_token: refreshToken, organizations: [], sessions: {},
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const path = (userId = 'user_1') => join(directory, 'auth', 'sessions', `${userId}.json`);
const fence = () => {
  mkdirSync(join(directory, 'auth', 'sessions'), { recursive: true, mode: 0o700 });
  writeFileSync(`${path()}.refresh-in-flight`, JSON.stringify({
    v: 1, id: '11223344-1234-4234-8234-123456789012', user_id: 'user_1',
    authority_sha256: digest('R0'), started_at: '2026-09-10T00:00:00Z', phase: 'in_flight',
  }), { mode: 0o600 });
};
beforeEach(() => rmSync(directory, { recursive: true, force: true }));
afterAll(() => { mock.restore(); rmSync(temporaryHome, { recursive: true, force: true }); });

test('reproduces ordinary replacement refusal and durably installs an explicitly approved R1', async () => {
  const original = session('R0');
  const replacement = session('R1');
  backend.save(original, 'user_1');
  expect(() => backend.save(replacement, 'user_1')).toThrow('AUTH_REFRESH_AUTHORITY_CHANGED');
  const baseline = capture('user_1');
  await install(replacement, baseline);
  expect(backend.load('user_1')).toEqual(replacement);
  expect(JSON.parse(readFileSync(path(), 'utf8'))).toEqual(replacement);
  expect(statSync(path()).mode & 0o777).toBe(0o600);
});

test('refuses concurrent R2 and leaves its exact bytes unchanged', async () => {
  backend.save(session('R0'), 'user_1');
  const baseline = capture();
  expect(backend.saveIfRefreshAuthorityMatches(session('R2'), 'user_1', digest('R0'))).toBe(true);
  const bytes = readFileSync(path(), 'utf8');
  await expect(install(session('R1'), baseline)).rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
  expect(readFileSync(path(), 'utf8')).toBe(bytes);
});

test('refuses logout followed by an attempted R1 installation', async () => {
  backend.save(session('R0'), 'user_1');
  const baseline = capture();
  backend.clear('user_1');
  await expect(install(session('R1'), baseline)).rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
  expect(backend.load('user_1')).toBeNull();
});

test('a captured empty destination refuses a competing sign-in', async () => {
  const baseline = capture();
  backend.save(session('R2'), 'user_1');
  await expect(install(session('R1'), baseline)).rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
  expect(backend.load('user_1')).toEqual(session('R2'));
});

test('omitting a baseline permits bootstrap only', async () => {
  await install(session('R0'));
  await expect(install(session('R1'))).rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
  expect(backend.load('user_1')).toEqual(session('R0'));
});

test('known runtime subject cannot be replaced with another account', async () => {
  const baseline = capture('user_1');
  await expect(install(session('R1', 'user_2'), baseline)).rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
  expect(backend.load('user_2')).toBeNull();
});

test('per-subject snapshots preserve unrelated accounts without selecting one', async () => {
  backend.save(session('A0', 'user_1'), 'user_1');
  backend.save(session('B0', 'user_2'), 'user_2');
  const baseline = capture();
  expect(baseline.expectedUserId).toBeNull();
  await install(session('B1', 'user_2'), baseline);
  expect(backend.load('user_1')).toEqual(session('A0', 'user_1'));
  expect(backend.load('user_2')).toEqual(session('B1', 'user_2'));
});

test('fence-only subject refuses capture before device authorization', () => {
  fence();
  expect(() => capture()).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
  expect(() => capture('user_1')).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
});

test('a fence arriving after capture prevents installation without clearing it', async () => {
  backend.save(session('R0'), 'user_1');
  const baseline = capture();
  fence();
  const bytes = readFileSync(`${path()}.refresh-in-flight`, 'utf8');
  await expect(install(session('R1'), baseline)).rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
  expect(readFileSync(`${path()}.refresh-in-flight`, 'utf8')).toBe(bytes);
  expect(JSON.parse(readFileSync(path(), 'utf8'))).toEqual(session('R0'));
});

test('malformed or scope-mismatched existing state refuses capture', () => {
  backend.save(session('R0', 'user_2'), 'user_1');
  expect(() => capture()).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
  writeFileSync(path(), 'not-json', { mode: 0o600 });
  expect(() => capture()).toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
});

test('legacy identity constrains the subject but never substitutes its token for target authority', async () => {
  backend.save(session('legacy'), undefined);
  const baseline = capture();
  expect(baseline.expectedUserId).toBe('user_1');
  await expect(install(session('R1', 'user_2'), baseline)).rejects.toThrow('AUTH_REFRESH_AUTHORITY_INDETERMINATE');
  await install(session('R1'), baseline);
  expect(backend.load('user_1')).toEqual(session('R1'));
  expect(backend.load(undefined)).toEqual(session('legacy'));
});

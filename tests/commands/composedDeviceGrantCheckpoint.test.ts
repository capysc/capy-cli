import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkpointMatchesExpectedUser,
  checkpointMustRetire,
  recoveredSessionMatchesCheckpoint,
  retireCheckpoint,
  type ComposedDeviceGrantCheckpoint,
} from '../../src/commands/composedDeviceGrant';
import { buildSessionStoreFromAnswer } from '../../src/auth/pairing/installPairedSession';

const flowId = 'c6c5f18a-dd05-484f-b561-7905f1d62e70';
const userId = 'user_01M2GKXQ317T8GNPKE1CK1F30Q';
const otherUserId = 'user_other';
const now = Date.parse('2026-09-15T18:28:00.000Z');

const checkpoint = (overrides: Readonly<Record<string, unknown>> = {}): ComposedDeviceGrantCheckpoint => ({
  version: 1,
  origin: 'https://mabels-mac-mini.tailcbfb49.ts.net:3444',
  grant: {
    device_code: 'device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://example.test/device',
    flow_id: flowId, keep_url: `https://keep.example.test/flow/authentication?f=${flowId}&compose=signin`,
    expires_at: '2026-09-15T19:00:00.000Z', expires_in: 1_920, interval: 5,
  },
  baseline: { expectedUserId: userId, authorities: [{ userId, refreshAuthoritySha256: null }] },
  intervalMs: 5_000,
  pollAfter: now,
  issued: {
    session: {
      user: { id: userId, email: 'doan@capy.sc' }, refresh_token: 'refresh-token',
      organizations: [{ id: 'org_one', name: 'One' }],
      sessions: { org_one: { access_token: 'access-token', expires_at: now + 60_000 } },
    },
    identityAccessToken: 'identity-token', attemptId: flowId,
  },
  ...overrides,
});

describe('composed device-grant checkpoint lifecycle', () => {
  test('retires an expired issued checkpoint before attempting to reuse its credentials', async () => {
    const expired = checkpoint({ grant: { ...checkpoint().grant, expires_at: '2026-09-15T01:15:07.482Z' } });

    expect(await checkpointMustRetire(expired, {
      now: () => now,
      inspectFlow: async () => { throw new Error('expired checkpoint must not be inspected'); },
    })).toBe(true);
  });

  test('retires an issued checkpoint only when the required server flow is conclusively absent', async () => {
    expect(await checkpointMustRetire(checkpoint(), {
      now: () => now,
      inspectFlow: async () => new Response(null, { status: 404 }),
    })).toBe(true);
    expect(await checkpointMustRetire(checkpoint(), {
      now: () => now,
      inspectFlow: async () => new Response(null, { status: 410 }),
    })).toBe(true);
  });

  test('preserves a valid resumable checkpoint and preserves one when flow inspection is unavailable', async () => {
    const valid = checkpoint();
    expect(await checkpointMustRetire(valid, {
      now: () => now,
      inspectFlow: async () => new Response(JSON.stringify({ flow_id: flowId, user_id: userId, stage: 'credentials_issued' }), { status: 200 }),
    })).toBe(false);
    expect(await checkpointMustRetire(valid, {
      now: () => now,
      inspectFlow: async () => null,
    })).toBe(false);
    expect(await checkpointMustRetire(valid, {
      now: () => now,
      inspectFlow: async () => new Response(null, { status: 401 }),
    })).toBe(false);
    expect(await checkpointMustRetire(valid, {
      now: () => now,
      inspectFlow: async () => new Response(null, { status: 500 }),
    })).toBe(false);
  });

  test('refuses a recovered session when local state changed during recovery', () => {
    const state = checkpoint();
    const expected = buildSessionStoreFromAnswer(state.issued!.session);
    const changed = { ...expected, refresh_token: 'replacement-token' };

    expect(recoveredSessionMatchesCheckpoint(state, changed)).toBe(false);
    expect(recoveredSessionMatchesCheckpoint(state, expected)).toBe(true);
  });

  test('refuses an issued checkpoint whose recovered user differs from the expected user', () => {
    const state = checkpoint({ issued: { ...checkpoint().issued!, session: {
      ...checkpoint().issued!.session,
      user: { id: otherUserId, email: 'other@capy.sc' },
    } } });

    expect(checkpointMatchesExpectedUser(state, userId)).toBe(false);
  });

  test('preserves both records when a checkpoint archive already exists for its flow', () => {
    const directory = mkdtempSync(join(tmpdir(), 'capy-checkpoint-'));
    const active = join(directory, 'composed-device-grant.json');
    const archived = join(directory, `composed-device-grant.retired-${flowId}.json`);
    try {
      writeFileSync(active, 'newer-state', { mode: 0o600 });
      writeFileSync(archived, 'older-state', { mode: 0o600 });

      retireCheckpoint(active, checkpoint());

      const revision = readdirSync(directory).find((name) => name !== archived.split('/').at(-1));
      expect(readFileSync(archived, 'utf8')).toBe('older-state');
      expect(revision).toBeDefined();
      expect(readFileSync(join(directory, revision!), 'utf8')).toBe('newer-state');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

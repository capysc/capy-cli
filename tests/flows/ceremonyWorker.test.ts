/**
 * The DETACHED sandbox-session ceremony worker (CAP-451 follow-up).
 *
 * Four things this covers, matching the module's own four sections:
 *
 *  1. `spawnCeremonyWorker` never puts secret material on argv — the whole
 *     payload (private key, flow secret, PRF salt) rides the child's stdin
 *     only, written exactly once.
 *  2. `prepareCeremonyScreen` returns the `screen` step IMMEDIATELY (never
 *     polls, never blocks), spawning a worker only the FIRST time a
 *     connection is seen — a second call for the same still-pending
 *     connection re-issues the identical screen without a second spawn.
 *  3. A settled marker ('done'/'failed') is read back as the ceremony's
 *     outcome and consumed (deleted) rather than re-driving the ceremony.
 *  4. `runCeremonyWorker` reuses the EXISTING `runSandboxCeremony` — the
 *     same function the old in-process design called, unchanged — end to
 *     end against a fake poll, proving the worker gets the real
 *     `applyFirstRun` tail for free rather than a reimplementation of it.
 */
import { describe, test, expect, mock, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';

// Same convention as tests/flows/sandboxCeremony.test.ts and
// tests/flows/driver.test.ts: hasAnyLocalKeyMaterial() (reached via
// buildCeremonyUrl, inside prepareCeremonyScreen) and the real session
// backend (reached via runCeremonyWorker's runSandboxCeremony call) both
// read getGlobalCapyDir() -> os.homedir() lazily at call time.
const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-ceremony-worker-home-'));
mock.module('os', () => {
  const actual = require('os');
  return { ...actual, homedir: () => tempHome };
});
afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

import {
  prepareCeremonyScreen,
  spawnCeremonyWorker,
  runCeremonyWorker,
  readCeremonyMarker,
  writeCeremonyMarker,
  type CeremonyWorkerPayload,
} from '../../src/flows/onboard/ceremonyWorker';
import { CEREMONY_CODES } from '../../src/flows/onboard/sandboxCeremony';
import { mintConnectionKeypair, exportConnectionPrivateKeyB64 } from '../../src/service/brokerEnvelope';
import { generatePrfSalt } from '../../src/auth/deviceKey/crypto';
import { sealEnvelopePageSide } from '../helpers/sealEnvelope';
import { keepOrigin } from '../../src/ui/screens/keepScreens';
import { FlowStep } from '../../src/flows/validate';

type FakeSpawn = typeof import('child_process').spawn;

function fakeSpawnRecorder(): { spawnImpl: FakeSpawn; calls: Array<{ command: string; args: string[]; opts: unknown }>; writes: string[] } {
  const calls: Array<{ command: string; args: string[]; opts: unknown }> = [];
  const writes: string[] = [];
  const spawnImpl = ((command: string, args: string[], opts: unknown) => {
    calls.push({ command, args, opts });
    return {
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
        end: () => undefined,
      },
      unref: () => undefined,
    } as unknown as ReturnType<FakeSpawn>;
  }) as FakeSpawn;
  return { spawnImpl, calls, writes };
}

function makeStep(connectionId: string, userCode: string | undefined = 'BCDF-GHJK'): FlowStep {
  return {
    contract_version: '1',
    flow_id: 'flow-prep-1',
    flow_type: 'onboard',
    step_id: 's-prep-1',
    kind: 'screen',
    resumed: false,
    screen: 'sandbox_session',
    url: `${keepOrigin()}/flow/sandbox-session?c=${connectionId}`,
    params: { connection_id: connectionId, user_code: userCode },
  } as unknown as FlowStep;
}

function fakeJwt(orgId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ org_id: orgId })).toString('base64url');
  return `${header}.${body}.sig`;
}

// ---------------------------------------------------------------------------
// 1. spawnCeremonyWorker — no secrets on argv, full payload on stdin only
// ---------------------------------------------------------------------------

describe('spawnCeremonyWorker — payload rides stdin only, never argv', () => {
  test('writes the exact payload to stdin exactly once, ends stdin, and unrefs the child', () => {
    const { spawnImpl, writes } = fakeSpawnRecorder();
    const payload: CeremonyWorkerPayload = {
      v: 1,
      privateKeyB64: 'PRIVATE_KEY_SECRET_MATERIAL',
      publicKeyB64: 'pub-b64',
      connectionId: 'conn-spawn-1',
      userCode: 'ABCD-EFGH',
      baseUrl: 'https://keep.capy.sc/flow/sandbox-session?c=conn-spawn-1',
      flowSecret: 'FLOW_SECRET_MATERIAL',
      prfSaltB64: 'PRF_SALT_SECRET_MATERIAL',
      targetDir: '/tmp/x',
      serviceUrl: 'https://api.test.invalid',
      devMode: false,
    };

    spawnCeremonyWorker(payload, {
      spawnImpl,
      resolveCommand: () => ({ command: 'node', args: ['cli-entry.js', 'onboard', '--ceremony-worker'] }),
    });

    expect(writes.length).toBe(1);
    expect(JSON.parse(writes[0])).toEqual(payload);
  });

  test('detached, with no shared stdio — stdin is the only channel, stdout/stderr are both ignored', () => {
    const { spawnImpl, calls } = fakeSpawnRecorder();
    spawnCeremonyWorker(
      {
        v: 1,
        privateKeyB64: 'x',
        publicKeyB64: 'x',
        connectionId: 'conn-spawn-2',
        baseUrl: 'https://keep.capy.sc/flow/sandbox-session?c=conn-spawn-2',
        flowSecret: 'x',
        prfSaltB64: 'x',
        targetDir: '/tmp/x',
        serviceUrl: 'https://api.test.invalid',
        devMode: false,
      },
      { spawnImpl, resolveCommand: () => ({ command: 'node', args: ['x'] }) },
    );

    expect(calls.length).toBe(1);
    expect(calls[0].opts).toMatchObject({ detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  });

  test('the re-invocation command/args never carry any of the secret fields — inert to `ps`', () => {
    const secrets = ['PRIVATE_KEY_SECRET_MATERIAL', 'FLOW_SECRET_MATERIAL', 'PRF_SALT_SECRET_MATERIAL'];
    const { spawnImpl, calls } = fakeSpawnRecorder();

    spawnCeremonyWorker(
      {
        v: 1,
        privateKeyB64: secrets[0],
        publicKeyB64: 'pub-b64',
        connectionId: 'conn-spawn-3',
        baseUrl: 'https://keep.capy.sc/flow/sandbox-session?c=conn-spawn-3',
        flowSecret: secrets[1],
        prfSaltB64: secrets[2],
        targetDir: '/tmp/x',
        serviceUrl: 'https://api.test.invalid',
        devMode: false,
      },
      { spawnImpl, resolveCommand: () => ({ command: 'node', args: ['cli-entry.js', 'onboard', '--ceremony-worker'] }) },
    );

    const argvLine = `${calls[0].command} ${calls[0].args.join(' ')}`;
    for (const secret of secrets) {
      expect(argvLine.includes(secret)).toBe(false);
    }
    expect(calls[0].args).toEqual(['cli-entry.js', 'onboard', '--ceremony-worker']);
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. prepareCeremonyScreen — immediate screen, spawn-once, resume semantics
// ---------------------------------------------------------------------------

describe('prepareCeremonyScreen — returns the screen immediately, spawns exactly one worker', () => {
  test('returns url+user_code on the first call and writes a pending marker', async () => {
    const targetDir = mkdtempSync(join(require('os').tmpdir(), 'capy-ceremony-prepare-'));
    const { spawnImpl, calls } = fakeSpawnRecorder();

    try {
      const result = await prepareCeremonyScreen({
        step: makeStep('conn-prep-1'),
        keypair: mintConnectionKeypair(),
        flowSecret: 'flow-secret',
        serviceUrl: 'https://api.test.invalid',
        devMode: false,
        targetDir,
        spawnImpl,
        resolveCommand: () => ({ command: 'node', args: ['x'] }),
      });

      expect(result.kind).toBe('screen');
      if (result.kind !== 'screen') throw new Error('unreachable');
      expect(result.step.url).toContain('#r=');
      expect(result.step.params.user_code).toBe('BCDF-GHJK');
      expect(calls.length).toBe(1);

      const marker = readCeremonyMarker(targetDir, 'conn-prep-1');
      expect(marker?.state).toBe('pending');
      expect(marker?.url).toBe(result.step.url);
      expect(marker?.userCode).toBe('BCDF-GHJK');
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('a second call for the SAME pending connection re-issues the SAME screen, without a second spawn', async () => {
    const targetDir = mkdtempSync(join(require('os').tmpdir(), 'capy-ceremony-prepare-'));
    const { spawnImpl, calls } = fakeSpawnRecorder();

    try {
      const opts = {
        step: makeStep('conn-prep-2'),
        keypair: mintConnectionKeypair(),
        flowSecret: 'flow-secret',
        serviceUrl: 'https://api.test.invalid',
        devMode: false,
        targetDir,
        spawnImpl,
        resolveCommand: () => ({ command: 'node', args: ['x'] }),
      };

      const first = await prepareCeremonyScreen(opts);
      const second = await prepareCeremonyScreen(opts);

      expect(calls.length).toBe(1); // NOT spawned a second time
      expect(first.kind).toBe('screen');
      expect(second.kind).toBe('screen');
      if (first.kind !== 'screen' || second.kind !== 'screen') throw new Error('unreachable');
      expect(second.step.url).toBe(first.step.url);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('a settled "done" marker resolves as an ok outcome, consumes the marker, and spawns nothing', async () => {
    const targetDir = mkdtempSync(join(require('os').tmpdir(), 'capy-ceremony-prepare-'));
    const { spawnImpl, calls } = fakeSpawnRecorder();
    writeCeremonyMarker(targetDir, {
      state: 'done',
      url: 'https://keep.capy.sc/flow/sandbox-session?c=conn-prep-3#r=x',
      connectionId: 'conn-prep-3',
      createdAt: Date.now(),
    });

    try {
      const result = await prepareCeremonyScreen({
        step: makeStep('conn-prep-3'),
        keypair: mintConnectionKeypair(),
        flowSecret: 'flow-secret',
        serviceUrl: 'https://api.test.invalid',
        devMode: false,
        targetDir,
        spawnImpl,
        resolveCommand: () => ({ command: 'node', args: ['x'] }),
      });

      expect(result).toEqual({ kind: 'settled', outcome: 'ok' });
      expect(calls.length).toBe(0);
      expect(readCeremonyMarker(targetDir, 'conn-prep-3')).toBeNull();
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('a settled "failed" marker resolves as a failed outcome carrying its code, and consumes the marker', async () => {
    const targetDir = mkdtempSync(join(require('os').tmpdir(), 'capy-ceremony-prepare-'));
    const { spawnImpl, calls } = fakeSpawnRecorder();
    writeCeremonyMarker(targetDir, {
      state: 'failed',
      url: 'https://keep.capy.sc/flow/sandbox-session?c=conn-prep-4#r=x',
      connectionId: 'conn-prep-4',
      createdAt: Date.now(),
      code: CEREMONY_CODES.EXPIRED,
    });

    try {
      const result = await prepareCeremonyScreen({
        step: makeStep('conn-prep-4'),
        keypair: mintConnectionKeypair(),
        flowSecret: 'flow-secret',
        serviceUrl: 'https://api.test.invalid',
        devMode: false,
        targetDir,
        spawnImpl,
        resolveCommand: () => ({ command: 'node', args: ['x'] }),
      });

      expect(result).toEqual({ kind: 'settled', outcome: 'failed', code: CEREMONY_CODES.EXPIRED });
      expect(calls.length).toBe(0);
      expect(readCeremonyMarker(targetDir, 'conn-prep-4')).toBeNull();
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. runCeremonyWorker — reuses runSandboxCeremony's EXISTING tail
// ---------------------------------------------------------------------------

describe('runCeremonyWorker — reuses the existing runSandboxCeremony/applyFirstRun tail, driven by a fake poll', () => {
  test('reads its payload from stdin, runs the full tail on an "ok" answer, and writes a done marker', async () => {
    const keypair = mintConnectionKeypair();
    const targetDir = mkdtempSync(join(require('os').tmpdir(), 'capy-ceremony-worker-target-'));

    const answerPlaintext = JSON.stringify({
      v: 1,
      flow: 'sandbox-session',
      ok: true,
      user: { id: 'user_1', email: 'a@b.com' },
      refresh_token: 'rt-1',
      organizations: [{ id: 'org_1', workos_org_id: 'workos-org-1', name: 'Org One' }],
      sessions: { org_1: { access_token: fakeJwt('workos-org-1'), expires_at: Date.now() + 3600_000 } },
      // No first_run: the "1 org, key on device" rail — the same fixture
      // shape tests/flows/driver.test.ts's old inline-ceremony test used.
    });
    const ciphertext = await sealEnvelopePageSide({
      plaintext: answerPlaintext,
      connectionId: 'conn-worker-1',
      clientPubkeyB64: keypair.publicKeyB64,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('/connections/')) {
        return new Response(JSON.stringify({ status: 'answered', ciphertext }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch in this test: ${String(url)}`);
    }) as typeof fetch;

    const payload: CeremonyWorkerPayload = {
      v: 1,
      privateKeyB64: exportConnectionPrivateKeyB64(keypair),
      publicKeyB64: keypair.publicKeyB64,
      connectionId: 'conn-worker-1',
      userCode: 'BCDF-GHJK',
      baseUrl: `${keepOrigin()}/flow/sandbox-session?c=conn-worker-1`,
      flowSecret: 'flow-secret-worker-1',
      prfSaltB64: generatePrfSalt().toString('base64'),
      targetDir,
      serviceUrl: 'https://api.test.invalid',
      devMode: false,
    };

    try {
      await runCeremonyWorker(Readable.from([JSON.stringify(payload)]));
    } finally {
      globalThis.fetch = originalFetch;
    }

    try {
      const marker = readCeremonyMarker(targetDir, 'conn-worker-1');
      expect(marker?.state).toBe('done');
      expect(marker?.code).toBeUndefined();
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('a coded poll failure (connection expired, HTTP 410) writes a failed marker carrying that code — never prose', async () => {
    const keypair = mintConnectionKeypair();
    const targetDir = mkdtempSync(join(require('os').tmpdir(), 'capy-ceremony-worker-target-'));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 410, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const payload: CeremonyWorkerPayload = {
      v: 1,
      privateKeyB64: exportConnectionPrivateKeyB64(keypair),
      publicKeyB64: keypair.publicKeyB64,
      connectionId: 'conn-worker-2',
      baseUrl: `${keepOrigin()}/flow/sandbox-session?c=conn-worker-2`,
      flowSecret: 'flow-secret-worker-2',
      prfSaltB64: generatePrfSalt().toString('base64'),
      targetDir,
      serviceUrl: 'https://api.test.invalid',
      devMode: false,
    };

    try {
      await runCeremonyWorker(Readable.from([JSON.stringify(payload)]));
    } finally {
      globalThis.fetch = originalFetch;
    }

    try {
      const marker = readCeremonyMarker(targetDir, 'conn-worker-2');
      expect(marker?.state).toBe('failed');
      expect(marker?.code).toBe(CEREMONY_CODES.EXPIRED);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('a malformed stdin payload exits silently — no marker written, nothing thrown', async () => {
    await expect(runCeremonyWorker(Readable.from(['not json']))).resolves.toBeUndefined();
  });
});

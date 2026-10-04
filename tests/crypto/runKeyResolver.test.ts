/**
 * ONE unlock per run (CAP-698). `capy secrets` used to unwrap the org master key M
 * (a co-decrypt) for every location; a run now unwraps it once, keeps it only in
 * memory, and derives each project key locally with the same HKDF `resolveProjectKey`
 * uses. Isolated: the home directory is a temp dir, the KMS is a fake, nothing leaves
 * the process.
 */
import { mock, describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const tempHome = mkdtempSync(join(require('os').tmpdir(), 'capy-run-keys-test-'));
mock.module('os', () => {
  const patched = { ...require('os'), homedir: () => tempHome };
  return { ...patched, default: patched };
});
afterAll(() => {
  mock.restore();
  rmSync(tempHome, { recursive: true, force: true });
});

type KeyManager = typeof import('../../src/crypto/keyManager');
type Resolver = typeof import('../../src/crypto/keyResolver');
type Engine = typeof import('../../src/commands/secretsSet');
type World = typeof import('../helpers/secretsWorld');
type Enc = typeof import('../../src/crypto/encryptor');
type Svc = typeof import('../../src/service/serviceClient');

const ORG = 'org_run_keys';
const USER = 'user_run_keys';
const KMS = 'KMS1.';
const kms = {
  coDecrypt: async (_o: string, ct: string) => {
    if (!ct.startsWith(KMS)) throw new Error('not KMS-wrapped');
    return ct.slice(KMS.length);
  },
  wrapOuterLayer: async (_o: string, pt: string) => KMS + pt,
};

/** Loaded after the `os` mock above, with M on disk the way a real machine holds it: K_local inner layer, KMS outer layer. */
const state = await (async () => {
  const km: KeyManager = await import('../../src/crypto/keyManager');
  const kr: Resolver = await import('../../src/crypto/keyResolver');
  const masterKey = km.seedPhraseToMasterKey(km.generateSeedPhrase());
  await kr.wrapAndSaveMasterKey(masterKey, ORG, USER, kms);
  const engine: Engine = await import('../../src/commands/secretsSet');
  const world: World = await import('../helpers/secretsWorld');
  const enc: Enc = await import('../../src/crypto/encryptor');
  return { km, kr, masterKey, engine, world, enc };
})();

describe('one unlock per run', () => {
  const counting = (override?: () => Promise<string>) => {
    const coDecrypt = mock(async (o: string, ct: string) => (override ? override() : kms.coDecrypt(o, ct)));
    return { co: coDecrypt, ops: { coDecrypt, wrapOuterLayer: kms.wrapOuterLayer } };
  };

  it('many callers across many projects, at once: exactly ONE co-decrypt, and every key equals resolveProjectKey and the HKDF derivation', async () => {
    const { co, ops } = counting();
    const resolve = state.kr.createRunKeyResolver(ORG, USER, ops);
    const projects = ['p1', 'p2', 'p3', 'p1', 'p2', 'p3', 'p1'];
    const keys = await Promise.all(projects.map((p) => resolve(p)));
    expect(co.mock.calls).toHaveLength(1);
    const reference = counting();
    const viaResolveProjectKey = await Promise.all(projects.map((p) => state.kr.resolveProjectKey(ORG, p, USER, reference.ops)));
    expect(reference.co.mock.calls).toHaveLength(projects.length); // the old way: one unlock per call
    expect(keys).toEqual(viaResolveProjectKey);
    expect(keys).toEqual(projects.map((p) => state.km.deriveProjectKey(state.masterKey, p, ORG)));
    expect(new Set(keys).size).toBe(3); // one key per project, not one for all
    // A later caller of the same run shares the same unlock too.
    expect(await resolve('p2')).toBe(keys[1]);
    expect(co.mock.calls).toHaveLength(1);
  });

  it('a value encrypted for a project with the reference key decrypts with the run key (and not with another project\'s)', async () => {
    const { ops } = counting();
    const resolve = state.kr.createRunKeyResolver(ORG, USER, ops);
    const referenceKey = await state.kr.resolveProjectKey(ORG, 'pX', USER, counting().ops);
    const sealed = state.enc.Encryptor.encrypt(state.world.OLD_VALUE, referenceKey);
    expect(state.enc.Encryptor.decrypt(sealed, await resolve('pX'))).toBe(state.world.OLD_VALUE);
    const otherKey = await resolve('pY');
    expect(() => state.enc.Encryptor.decrypt(sealed, otherKey)).toThrow();
  });

  it('each run unlocks again: nothing is kept between runs', async () => {
    const { co, ops } = counting();
    await state.kr.createRunKeyResolver(ORG, USER, ops)('p1');
    await state.kr.createRunKeyResolver(ORG, USER, ops)('p1');
    expect(co.mock.calls).toHaveLength(2);
  });

  it('a failed unlock fails every caller with the same coded error, and is not retried per caller', async () => {
    const denied = () => Promise.reject(new CapyError('not allowed', ERROR_CODES.PERMISSION_DENIED, { status: 403 }));
    const { co, ops } = counting(denied);
    const resolve = state.kr.createRunKeyResolver(ORG, USER, ops);
    const outcomes = await Promise.allSettled(['p1', 'p2', 'p3', 'p1', 'p2'].map((p) => resolve(p)));
    expect(outcomes.every((o) => o.status === 'rejected')).toBe(true);
    const codes = outcomes.map((o) => (o.status === 'rejected' && o.reason instanceof CapyError ? o.reason.code : 'other'));
    expect(codes).toEqual(Array(5).fill(ERROR_CODES.PERMISSION_DENIED));
    await resolve('p9').catch(() => undefined);
    expect(co.mock.calls).toHaveLength(1);
  });

  it('a failed unlock nobody has asked about yet is not an unhandled rejection', async () => {
    const { ops } = counting(() => Promise.reject(new CapyError('net', ERROR_CODES.NETWORK_ERROR)));
    state.kr.createRunKeyResolver(ORG, USER, ops); // never called
    await new Promise((r) => setTimeout(r, 20)); // an unhandled rejection would fail this file
    expect(true).toBe(true);
  });

  // ── through the real engine environment (createSetEnv) ────────────────────

  /** A client whose projects hold NAME encrypted with the key HKDF derives for them, and which counts co-decrypts. */
  function clientWorld(locs: ReadonlyArray<import('../helpers/secretsWorld').Loc>, coBehaviour?: () => Promise<void>) {
    const { world, enc, km } = state;
    const keyOf = (p: string) => km.deriveProjectKey(state.masterKey, p, ORG);
    const inner = world.fakeService({ locs });
    // `coBehaviour` throws to make the call fail; otherwise the real stored blob is unwrapped.
    const co = mock(async (o: string, ct: string) => {
      await coBehaviour?.();
      return { plaintext: await kms.coDecrypt(o, ct) };
    });
    const getDecryptData = mock(async (projectId: string, branch?: string) => ({
      env_content: `${world.NAME}=capy:${(await import('../../src/crypto/resourceId')).deriveResourceId(branch ?? '', world.NAME)}:${enc.Encryptor.encrypt(world.OLD_VALUE, keyOf(projectId))}`,
      decrypt_key: '',
      expires_at: '',
      keep_file: JSON.stringify(world.serverKeep(projectId as import('../helpers/secretsWorld').ProjectId, locs)),
    }));
    const pushSecrets = mock((...a: Parameters<typeof inner.pushSecrets>) => inner.pushSecrets(...a));
    const client = { coDecrypt: co, wrapOuterLayer: async (o: string, pt: string) => ({ ciphertext: await kms.wrapOuterLayer(o, pt) }), getDecryptData, pushSecrets };
    return { client: client as unknown as InstanceType<Svc['ServiceClient']>, co, getDecryptData, pushSecrets, keyOf };
  }

  const requestFor = (locs: ReadonlyArray<import('../helpers/secretsWorld').Loc>) => ({
    name: state.world.NAME,
    value: state.world.SENTINEL,
    locations: locs.map((l) => ({ project_id: l.project, project_name: state.world.PROJECT_NAMES[l.project], branch: l.branch, protected: false })),
    repos: [],
    bases: {},
  });

  it('a run over 9 locations in 3 projects: ONE co-decrypt; every pushed blob decrypts to the new value with that project\'s derived key', async () => {
    const locs = state.world.manyLocs(9);
    const w = clientWorld(locs);
    const env = state.engine.createSetEnv(ORG, USER, w.client);
    const result = await state.engine.runSecretSet(requestFor(locs), env);
    expect(w.co.mock.calls).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(result.updated).toHaveLength(9);
    w.pushSecrets.mock.calls.forEach(([projectId, , blob]) => {
      const line = String(blob).split('\n').find((l) => l.startsWith(`${state.world.NAME}=`)) ?? '';
      expect(state.enc.Encryptor.decrypt(line.split(':').slice(2).join(':'), w.keyOf(String(projectId)))).toBe(state.world.SENTINEL);
    });
  });

  it('the dry run unlocks once too, and not at all when there is no value to compare', async () => {
    const locs = state.world.manyLocs(9);
    const w = clientWorld(locs);
    const env = state.engine.createSetEnv(ORG, USER, w.client);
    const locations = requestFor(locs).locations;
    const previews = await state.engine.previewLocations(env, locations, state.world.NAME, state.world.SENTINEL);
    expect(previews.every((p) => p.action === 'update')).toBe(true);
    expect(w.co.mock.calls).toHaveLength(1);
    const unchanged = await state.engine.previewLocations(env, locations, state.world.NAME, state.world.OLD_VALUE);
    expect(unchanged.every((p) => p.action === 'unchanged')).toBe(true); // the derived keys really decrypt the existing values
    const noValue = clientWorld(locs);
    await state.engine.previewLocations(state.engine.createSetEnv(ORG, USER, noValue.client), locations, state.world.NAME, undefined);
    expect(noValue.co.mock.calls).toHaveLength(0);
  });

  it('a failed unlock: every location fails with that code, one co-decrypt, nothing read or pushed', async () => {
    const locs = state.world.manyLocs(9);
    const w = clientWorld(locs, () => Promise.reject(new CapyError('no', ERROR_CODES.PERMISSION_DENIED, { status: 403 })));
    const result = await state.engine.runSecretSet(requestFor(locs), state.engine.createSetEnv(ORG, USER, w.client));
    expect(w.co.mock.calls).toHaveLength(1);
    expect(result.failed).toHaveLength(9);
    expect(result.failed.every((f) => f.code === ERROR_CODES.PERMISSION_DENIED)).toBe(true);
    expect(w.getDecryptData.mock.calls).toHaveLength(0);
    expect(w.pushSecrets.mock.calls).toHaveLength(0);
  });

  it('a 429 on the unlock is waited out (the server\'s own wait) and then it works: 2 co-decrypts, the run completes', async () => {
    const locs = state.world.manyLocs(6);
    const tries = mock((_n: number) => undefined);
    const behaviour = async () => {
      tries(1);
      if (tries.mock.calls.length === 1) throw new CapyError('slow down', ERROR_CODES.RATE_LIMITED, { status: 429, retry_after_ms: 10 });
    };
    const w = clientWorld(locs, behaviour);
    const result = await state.engine.runSecretSet(requestFor(locs), state.engine.createSetEnv(ORG, USER, w.client));
    expect(w.co.mock.calls).toHaveLength(2);
    expect(result.updated).toHaveLength(6);
  });

  it('a limited unlock that never recovers fails every location with RATE_LIMITED after the bounded attempts', async () => {
    const locs = state.world.manyLocs(6);
    const w = clientWorld(locs, () => Promise.reject(new CapyError('slow down', ERROR_CODES.RATE_LIMITED, { status: 429, retry_after_ms: 1 })));
    const result = await state.engine.runSecretSet(requestFor(locs), state.engine.createSetEnv(ORG, USER, w.client));
    expect(w.co.mock.calls).toHaveLength(4);
    expect(result.failed.map((f) => f.code)).toEqual(Array(6).fill('RATE_LIMITED'));
  });

  it('no key material in anything a run returns or sends: not M, not a project key (sentinel-shaped leak check)', async () => {
    const locs = state.world.manyLocs(9);
    const w = clientWorld(locs);
    const logged = mock((..._a: unknown[]) => undefined);
    const spies = [
      (await import('bun:test')).spyOn(console, 'log').mockImplementation(logged as never),
      (await import('bun:test')).spyOn(console, 'error').mockImplementation(logged as never),
    ];
    const result = await state.engine.runSecretSet(requestFor(locs), state.engine.createSetEnv(ORG, USER, w.client));
    const denied = clientWorld(locs, () => Promise.reject(new CapyError('no', ERROR_CODES.PERMISSION_DENIED)));
    const failed = await state.engine.runSecretSet(requestFor(locs), state.engine.createSetEnv(ORG, USER, denied.client));
    spies.forEach((s) => s.mockRestore());
    const everything = JSON.stringify([result, failed, w.pushSecrets.mock.calls, w.getDecryptData.mock.calls, denied.getDecryptData.mock.calls, logged.mock.calls]);
    const secrets = [
      state.masterKey.toString('hex'),
      state.masterKey.toString('base64'),
      ...['pA', 'pB', 'pC'].flatMap((p) => [w.keyOf(p), Buffer.from(w.keyOf(p)).toString('hex')]),
    ];
    secrets.forEach((s) => expect(everything).not.toContain(s));
    expect(everything).not.toContain(state.world.SENTINEL);
  });
});

import { describe, expect, it } from 'bun:test';
import {
  importInitRunDeliveryKeypair,
  initRunCliKeyFingerprint,
  mintInitRunDeliveryKeypair,
  openInitRunAuthResult,
} from '../../src/auth/initRunEnvelope';

describe('init-run delivery keys', () => {
  it('mints a valid P-256 public key and refuses a mismatched private import', () => {
    const first = mintInitRunDeliveryKeypair();
    const second = mintInitRunDeliveryKeypair();
    const exported = second.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    expect(Buffer.from(first.publicKeyB64, 'base64').length).toBe(65);
    expect(initRunCliKeyFingerprint(first.publicKeyB64)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(importInitRunDeliveryKeypair({
      publicKeyB64: first.publicKeyB64,
      privateKeyPkcs8B64: exported,
    })).toBeNull();
  });

  it('rejects malformed and unsupported envelopes before decryption', () => {
    const keypair = mintInitRunDeliveryKeypair();
    const fingerprint = initRunCliKeyFingerprint(keypair.publicKeyB64);
    if (!fingerprint) throw new Error('fixture key was not valid P-256');
    const binding = {
      run_id: '11111111-1111-4111-8111-111111111111',
      subject_user_id: 'user_demo',
      service_origin: 'https://api.dev.example',
      runtime_id: '77777777-7777-4777-8777-777777777777',
      repository_fingerprint: `sha256:${'a'.repeat(64)}`,
      cli_key_fingerprint: fingerprint,
    } as const;

    expect(openInitRunAuthResult({ sealedAuthResult: 'not-base64', binding, keypair }))
      .toEqual({ ok: false, code: 'MALFORMED' });
    const unsupported = Buffer.from(JSON.stringify({
      v: 2,
      epk: keypair.publicKeyB64,
      iv: Buffer.alloc(12).toString('base64'),
      ct: Buffer.alloc(17).toString('base64'),
    })).toString('base64');
    expect(openInitRunAuthResult({ sealedAuthResult: unsupported, binding, keypair }))
      .toEqual({ ok: false, code: 'UNSUPPORTED_VERSION' });
  });
});

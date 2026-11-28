/**
 * Regenerates tests/fixtures/conversationWireVectors.json (CAP-921), shared byte for byte with
 * keep-app. Run with `bun scripts/genConversationWireVectors.ts`, then copy the file to keep-app
 * tests/fixtures. Inputs are fixed, so a rerun is byte-identical unless the scheme changed.
 */
import { writeFileSync } from 'node:fs';
import * as w from '../src/crypto/conversationWire';
const hex = (s: string) => Buffer.from(s, 'hex');
const nonce = hex('0102030405060708090a0b0c');

const makeCase = (base: { kLocal: string; cli: string; page: string; id: string; userId: string; orgId: string; projectId: string; purpose: string; transportId: string; unlock: w.Unlock; protection: w.Protection; answerName: string; helloPlain: string; firstPlain: string; answerPlain: string }) => {
  const kLocal = hex(base.kLocal);
  const cli = w.newKeyPair(hex(base.cli));
  const page = w.newKeyPair(hex(base.page));
  const k = w.pinFor(base.id, cli.publicKey);
  const ctx = { id: base.id, k, userId: base.userId, orgId: base.orgId, projectId: base.projectId, purpose: base.purpose, transportId: base.transportId };
  const kAuth = w.authKey(kLocal, base.id, k);
  const hk = w.helloKey(cli, 'cli', ctx, cli.publicKey, page.publicKey);
  const s = w.sessionKeys(cli, 'cli', kAuth, ctx, cli.publicKey, page.publicKey);
  const seal = w.sealRecordWithNonceForVectors;
  const h = (direction: w.Direction, n: number, ack: number, kind: string, name = '') => ({ id: base.id, direction, n, ack, kind, name });
  return {
    inputs: { kLocal: w.b64u(kLocal), cliPrivate: w.b64u(cli.privateKey), pagePrivate: w.b64u(page.privateKey), id: base.id, userId: base.userId, orgId: base.orgId,
      projectId: base.projectId, purpose: base.purpose, transportId: base.transportId, unlock: base.unlock, protection: base.protection, nonce: w.b64u(nonce),
      answerName: base.answerName, helloPlain: base.helloPlain, firstPlain: base.firstPlain, answerPlain: base.answerPlain },
    outputs: { cliPub: w.b64u(cli.publicKey), pagePub: w.b64u(page.publicKey), k: w.b64u(k), ctx: w.b64u(w.ctxBytes(ctx)), kAuth: w.b64u(kAuth),
      helloTag: w.b64u(w.helloTag(kAuth, ctx, page.publicKey, base.unlock, base.protection)), cliTag: w.b64u(w.cliTag(kAuth, ctx, cli.publicKey, page.publicKey)),
      helloKey: w.b64u(hk), c2p: w.b64u(s.c2p), p2c: w.b64u(s.p2c),
      hello: seal(hk, h('p2c', 1, 0, 'hello'), Buffer.from(base.helloPlain), nonce),
      first: seal(s.c2p, h('c2p', 1, 1, 'cli-hello'), Buffer.from(base.firstPlain), nonce),
      answer: seal(s.p2c, h('p2c', 2, 1, 'answer', base.answerName), Buffer.from(base.answerPlain), nonce) },
  };
};

const a = makeCase({ kLocal: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', cli: 'c1'.repeat(32), page: 'a7'.repeat(32),
  id: '6f1c2b3a-4d5e-4f60-8a1b-2c3d4e5f6a7b', userId: 'user_01JTESTUSER', orgId: 'org_01JTESTORG', projectId: '', purpose: 'setup',
  transportId: '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b', unlock: 'remembered', protection: 'passkey', answerName: 'DATABASE_URL',
  helloPlain: '{"v":1}', firstPlain: '{"tag":"x"}', answerPlain: 'ünïcode answer' });
const b = makeCase({ kLocal: 'f0e1d2c3b4a5968778695a4b3c2d1e0f0f1e2d3c4b5a69788796a5b4c3d2e1f0', cli: '3c'.repeat(32), page: '5e'.repeat(32),
  id: '1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d', userId: 'user_01JOTHERUSER', orgId: 'org_01JOTHERORG', projectId: 'prj_01JTESTPROJ', purpose: 'rotate ü',
  transportId: '9f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b', unlock: 'fresh', protection: 'passphrase', answerName: 'DB_ü',
  helloPlain: '{"v":1,"note":"ß"}', firstPlain: '{"tag":"y"}', answerPlain: '' });

const tampered = w.unb64u(a.outputs.answer);
tampered[20] ^= 1;
const v = {
  scheme: w.SCHEME,
  note: 'Shared by capy-cli tests/fixtures and keep-app tests/fixtures. Do not edit by hand; regenerate in capy-cli.',
  lpExample: w.b64u(w.lp('a', '', new Uint8Array([1, 2]))),
  cases: [a, b],
  refuse: {
    b64u: [`${a.outputs.answer}=`, 'a', 'ab+c', 'ab/c', 'AB', 'AAB', 'A A'],
    points: [w.b64u(Buffer.alloc(65, 4)), w.b64u(w.unb64u(a.outputs.cliPub).subarray(0, 33)), w.b64u(Buffer.concat([Buffer.from([2]), w.unb64u(a.outputs.cliPub).subarray(1)]))],
    tamperedAnswer: w.b64u(tampered),
    shortRecord: w.b64u(Buffer.alloc(27)),
  },
};
writeFileSync(new URL('../tests/fixtures/conversationWireVectors.json', import.meta.url), JSON.stringify(v, null, 2) + '\n');
console.log('cases', v.cases.length, Object.keys(v.cases[0].outputs).join(','));

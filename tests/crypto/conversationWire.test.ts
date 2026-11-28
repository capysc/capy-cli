import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as w from '../../src/crypto/conversationWire';

const V = JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/conversationWireVectors.json'), 'utf8'));
const R = V.refuse;

const load = (c: { inputs: Record<string, string>; outputs: Record<string, string> }) => {
  const I = c.inputs;
  const cli = w.newKeyPair(w.unb64u(I.cliPrivate));
  const page = w.newKeyPair(w.unb64u(I.pagePrivate));
  const k = w.pinFor(I.id, cli.publicKey);
  const ctx: w.ConversationContext = { id: I.id, k, userId: I.userId, orgId: I.orgId, projectId: I.projectId, purpose: I.purpose, transportId: I.transportId };
  const kAuth = w.authKey(w.unb64u(I.kLocal), I.id, k);
  const h = (direction: w.Direction, n: number, ack: number, kind: string, name = ''): w.RecordHeader => ({ id: I.id, direction, n, ack, kind, name });
  return { I, O: c.outputs, cli, page, k, ctx, kAuth, h, nonce: w.unb64u(I.nonce) };
};
const A = load(V.cases[0]);

describe('capy.conv.c.v1 matches the shared vectors (keep-app checks the same file)', () => {
  test('lp encoding', () => {
    expect(w.b64u(w.lp('a', '', new Uint8Array([1, 2])))).toBe(V.lpExample);
  });

  for (const [index, c] of V.cases.entries()) {
    const { I, O, cli, page, k, ctx, kAuth, h, nonce } = load(c);
    test(`case ${index}: keys, pin, K_auth and both tags`, () => {
      expect(w.b64u(cli.publicKey)).toBe(O.cliPub);
      expect(w.b64u(page.publicKey)).toBe(O.pagePub);
      expect(w.b64u(k)).toBe(O.k);
      expect(w.b64u(w.ctxBytes(ctx))).toBe(O.ctx);
      expect(w.b64u(kAuth)).toBe(O.kAuth);
      expect(w.b64u(w.helloTag(kAuth, ctx, page.publicKey, I.unlock, I.protection))).toBe(O.helloTag);
      expect(w.b64u(w.cliTag(kAuth, ctx, cli.publicKey, page.publicKey))).toBe(O.cliTag);
    });

    test(`case ${index}: hello key and session keys agree from either side`, () => {
      expect(w.b64u(w.helloKey(cli, 'cli', ctx, cli.publicKey, page.publicKey))).toBe(O.helloKey);
      expect(w.b64u(w.helloKey(page, 'page', ctx, cli.publicKey, page.publicKey))).toBe(O.helloKey);
      const fromCli = w.sessionKeys(cli, 'cli', kAuth, ctx, cli.publicKey, page.publicKey);
      const fromPage = w.sessionKeys(page, 'page', kAuth, ctx, cli.publicKey, page.publicKey);
      expect(w.b64u(fromCli.c2p)).toBe(O.c2p);
      expect(w.b64u(fromCli.p2c)).toBe(O.p2c);
      expect(fromPage.c2p.equals(fromCli.c2p) && fromPage.p2c.equals(fromCli.p2c)).toBe(true);
      expect(fromCli.c2p.equals(fromCli.p2c)).toBe(false);
    });

    test(`case ${index}: records seal to the vectors and open back`, () => {
      const s = w.sessionKeys(cli, 'cli', kAuth, ctx, cli.publicKey, page.publicKey);
      const hk = w.helloKey(cli, 'cli', ctx, cli.publicKey, page.publicKey);
      const seal = w.sealRecordWithNonceForVectors;
      expect(seal(hk, h('p2c', 1, 0, 'hello'), Buffer.from(I.helloPlain), nonce)).toBe(O.hello);
      expect(seal(s.c2p, h('c2p', 1, 1, 'cli-hello'), Buffer.from(I.firstPlain), nonce)).toBe(O.first);
      expect(seal(s.p2c, h('p2c', 2, 1, 'answer', I.answerName), Buffer.from(I.answerPlain), nonce)).toBe(O.answer);
      expect(w.openRecord(hk, h('p2c', 1, 0, 'hello'), O.hello).toString('utf8')).toBe(I.helloPlain);
      expect(w.openRecord(s.p2c, h('p2c', 2, 1, 'answer', I.answerName), O.answer).toString('utf8')).toBe(I.answerPlain);
    });
  }

  test('sealRecord picks a fresh nonce each time', () => {
    const s = w.sessionKeys(A.cli, 'cli', A.kAuth, A.ctx, A.cli.publicKey, A.page.publicKey);
    const header = A.h('c2p', 2, 1, 'question', 'X');
    const one = w.sealRecord(s.c2p, header, Buffer.from('q'));
    expect(one).not.toBe(w.sealRecord(s.c2p, header, Buffer.from('q')));
    expect(w.openRecord(s.c2p, header, one).toString()).toBe('q');
  });
});

describe('a lying service is refused', () => {
  const { I, O, cli, page, k, ctx, kAuth, h } = A;
  const s = w.sessionKeys(cli, 'cli', kAuth, ctx, cli.publicKey, page.publicKey);
  const header = h('p2c', 2, 1, 'answer', I.answerName);

  test('a swapped CLI key does not match the pin, and no hello or session key is derived for it', () => {
    const service = w.newKeyPair();
    expect(w.pinFor(I.id, service.publicKey).equals(k)).toBe(false);
    expect(() => w.helloKey(page, 'page', ctx, service.publicKey, page.publicKey)).toThrow(w.ConversationWireError);
    expect(() => w.sessionKeys(page, 'page', kAuth, ctx, service.publicKey, page.publicKey)).toThrow(w.ConversationWireError);
  });

  test('without K_local the service cannot make either tag', () => {
    const guessed = w.authKey(Buffer.alloc(32, 9), I.id, k);
    expect(w.tagsEqual(w.helloTag(guessed, ctx, page.publicKey, I.unlock, I.protection), w.unb64u(O.helloTag))).toBe(false);
    expect(w.tagsEqual(w.cliTag(guessed, ctx, cli.publicKey, page.publicKey), w.unb64u(O.cliTag))).toBe(false);
  });

  test('a tag for one context fails for any other field', () => {
    const tag = w.unb64u(O.cliTag);
    for (const change of [{ orgId: 'org_other' }, { projectId: 'prj_x' }, { purpose: 'rotate' }, { userId: 'user_other' }, { transportId: '00000000-0000-4000-8000-000000000000' }]) {
      expect(w.tagsEqual(w.cliTag(kAuth, { ...ctx, ...change }, cli.publicKey, page.publicKey), tag)).toBe(false);
    }
  });

  test('the hello tag changes with how the page unlocked and with its key', () => {
    const tag = w.unb64u(O.helloTag);
    const other = w.newKeyPair();
    expect(w.tagsEqual(w.helloTag(kAuth, ctx, page.publicKey, 'fresh', I.protection), tag)).toBe(false);
    expect(w.tagsEqual(w.helloTag(kAuth, ctx, page.publicKey, I.unlock, 'passphrase'), tag)).toBe(false);
    expect(w.tagsEqual(w.helloTag(kAuth, ctx, other.publicKey, I.unlock, I.protection), tag)).toBe(false);
    expect(() => w.helloTag(kAuth, ctx, page.publicKey, 'bogus' as w.Unlock, I.protection)).toThrow(w.ConversationWireError);
  });

  test('a record moved to another turn, ack, direction, kind, name or conversation does not open', () => {
    for (const moved of [{ n: 3 }, { ack: 2 }, { ack: 0 }, { direction: 'c2p' as const }, { kind: 'note' }, { name: 'OTHER' }, { id: '00000000-0000-4000-8000-000000000000' }]) {
      expect(() => w.openRecord(s.p2c, { ...header, ...moved }, O.answer)).toThrow(w.ConversationWireError);
    }
    expect(() => w.openRecord(s.c2p, header, O.answer)).toThrow(w.ConversationWireError);
  });

  test('the shared refusal vectors are refused', () => {
    for (const bad of R.b64u) expect(() => w.unb64u(bad)).toThrow(w.ConversationWireError);
    for (const bad of R.points) {
      expect(() => w.helloKey(cli, 'cli', ctx, cli.publicKey, w.unb64u(bad))).toThrow(w.ConversationWireError);
      expect(() => w.helloKey(page, 'page', ctx, cli.publicKey, w.unb64u(bad))).toThrow(w.ConversationWireError);
    }
    expect(() => w.openRecord(s.p2c, header, R.tamperedAnswer)).toThrow(w.ConversationWireError);
    expect(() => w.openRecord(s.p2c, header, R.shortRecord)).toThrow(w.ConversationWireError);
  });

  test('numbers go up by exactly one; replays and gaps are dropped', () => {
    expect(w.acceptNumber(0, 1)).toBe(true);
    expect(w.acceptNumber(1, 1)).toBe(false);
    expect(w.acceptNumber(1, 3)).toBe(false);
    expect(w.acceptNumber(2, 1)).toBe(false);
  });

  test('ack never goes back and never names a record not yet sent', () => {
    expect(w.acceptAck(0, 1, 1)).toBe(true);
    expect(w.acceptAck(2, 2, 5)).toBe(true);
    expect(w.acceptAck(2, 1, 5)).toBe(false);
    expect(w.acceptAck(0, 6, 5)).toBe(false);
  });

  test('bad input of any shape is the one error, never a crash of another type', () => {
    const cases: (() => unknown)[] = [
      () => w.pinFor(I.id.toUpperCase(), cli.publicKey),
      () => w.pinFor(I.id, cli.publicKey.subarray(0, 33)),
      () => w.authKey(Buffer.alloc(1), I.id, k),
      () => w.authKey(Buffer.alloc(32), I.id, k.subarray(0, 5)),
      () => w.cliTag(Buffer.alloc(0), ctx, cli.publicKey, page.publicKey),
      () => w.ctxBytes({ ...ctx, k: Buffer.alloc(5) }),
      () => w.lp('\ud800'),
      () => w.lp([1, 2] as unknown as Uint8Array),
      () => w.lp(7 as unknown as string),
      () => w.openRecord(s.p2c, { ...header, kind: 7 as unknown as string }, O.answer),
      () => w.openRecord(s.p2c, { ...header, direction: 'sideways' as w.Direction }, O.answer),
      () => w.openRecord(Buffer.alloc(16), header, O.answer),
      () => w.sealRecordWithNonceForVectors(s.p2c, header, Buffer.from('x'), Buffer.alloc(8)),
      () => w.sessionKeys(cli, 'nobody' as w.Role, kAuth, ctx, cli.publicKey, page.publicKey),
      () => w.newKeyPair(Buffer.alloc(32)),
    ];
    for (const run of cases) expect(run).toThrow(w.ConversationWireError);
    expect(w.tagsEqual([1] as unknown as Uint8Array, [1] as unknown as Uint8Array)).toBe(false);
  });

  test('private keys are always 32 bytes, even when the scalar has leading zeros', () => {
    for (let i = 0; i < 2000; i += 1) expect(w.newKeyPair().privateKey.length).toBe(32);
    const small = Buffer.alloc(32);
    small[31] = 5;
    const pair = w.newKeyPair(small);
    expect(pair.privateKey.equals(small)).toBe(true);
    expect(w.newKeyPair(pair.privateKey).publicKey.equals(pair.publicKey)).toBe(true);
  });
});

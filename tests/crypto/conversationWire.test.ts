import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as w from '../../src/crypto/conversationWire';

const V = JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/conversationWireVectors.json'), 'utf8'));
const I = V.inputs;
const O = V.outputs;
const kLocal = w.unb64u(I.kLocal);
const cli = w.newKeyPair(w.unb64u(I.cliPrivate));
const page = w.newKeyPair(w.unb64u(I.pagePrivate));
const k = w.pinFor(I.id, cli.publicKey);
const ctx: w.ConversationContext = { id: I.id, k, userId: I.userId, orgId: I.orgId, projectId: I.projectId, purpose: I.purpose, transportId: I.transportId };
const kAuth = w.authKey(kLocal, I.id, k);
const nonce = w.unb64u(I.nonce);

describe('capy.conv.c.v1 matches the shared vectors (keep-app checks the same file)', () => {
  test('encoding, pin, K_auth and both tags', () => {
    expect(w.b64u(w.lp('a', '', new Uint8Array([1, 2])))).toBe(O.lpExample);
    expect(w.b64u(cli.publicKey)).toBe(O.cliPub);
    expect(w.b64u(page.publicKey)).toBe(O.pagePub);
    expect(w.b64u(k)).toBe(O.k);
    expect(w.b64u(w.ctxBytes(ctx))).toBe(O.ctx);
    expect(w.b64u(kAuth)).toBe(O.kAuth);
    expect(w.b64u(w.helloTag(kAuth, ctx, page.publicKey, I.unlock, I.protection))).toBe(O.helloTag);
    expect(w.b64u(w.cliTag(kAuth, ctx, cli.publicKey, page.publicKey))).toBe(O.cliTag);
  });

  test('hello key and session keys agree from either side', () => {
    expect(w.b64u(w.helloKey(cli, page.publicKey, I.id, k))).toBe(O.helloKey);
    expect(w.b64u(w.helloKey(page, cli.publicKey, I.id, k))).toBe(O.helloKey);
    const fromCli = w.sessionKeys(cli, page.publicKey, kAuth, ctx, cli.publicKey, page.publicKey);
    const fromPage = w.sessionKeys(page, cli.publicKey, kAuth, ctx, cli.publicKey, page.publicKey);
    expect(w.b64u(fromCli.c2p)).toBe(O.c2p);
    expect(w.b64u(fromCli.p2c)).toBe(O.p2c);
    expect(fromPage.c2p.equals(fromCli.c2p) && fromPage.p2c.equals(fromCli.p2c)).toBe(true);
    expect(fromCli.c2p.equals(fromCli.p2c)).toBe(false);
  });

  test('records seal to the vectors and open back', () => {
    const s = w.sessionKeys(cli, page.publicKey, kAuth, ctx, cli.publicKey, page.publicKey);
    const hk = w.helloKey(cli, page.publicKey, I.id, k);
    const h = (direction: w.Direction, n: number, kind: string, name = ''): w.RecordHeader => ({ id: I.id, direction, n, kind, name });
    expect(w.sealRecord(hk, h('p2c', 1, 'hello'), Buffer.from(I.helloPlain), nonce)).toBe(O.hello);
    expect(w.sealRecord(s.c2p, h('c2p', 1, 'cli-hello'), Buffer.from(I.firstPlain), nonce)).toBe(O.first);
    expect(w.sealRecord(s.p2c, h('p2c', 2, 'answer', 'DATABASE_URL'), Buffer.from(I.answerPlain), nonce)).toBe(O.answer);
    expect(w.openRecord(s.p2c, h('p2c', 2, 'answer', 'DATABASE_URL'), O.answer).toString('utf8')).toBe(I.answerPlain);
  });
});

describe('a lying service is refused', () => {
  const s = w.sessionKeys(cli, page.publicKey, kAuth, ctx, cli.publicKey, page.publicKey);
  const header: w.RecordHeader = { id: I.id, direction: 'p2c', n: 2, kind: 'answer', name: 'DATABASE_URL' };

  test('a swapped CLI key does not match the pin in the link', () => {
    const service = w.newKeyPair();
    expect(w.pinFor(I.id, service.publicKey).equals(k)).toBe(false);
  });

  test('without K_local the service cannot make either tag', () => {
    const guessed = w.authKey(Buffer.alloc(32, 9), I.id, k);
    expect(w.tagsEqual(w.helloTag(guessed, ctx, page.publicKey, 'fresh', 'passkey'), w.unb64u(O.helloTag))).toBe(false);
    expect(w.tagsEqual(w.cliTag(guessed, ctx, cli.publicKey, page.publicKey), w.unb64u(O.cliTag))).toBe(false);
  });

  test('a tag for one context fails for any other field', () => {
    const tag = w.unb64u(O.cliTag);
    for (const change of [{ orgId: 'org_other' }, { projectId: 'prj_x' }, { purpose: 'rotate' }, { userId: 'user_other' }]) {
      expect(w.tagsEqual(w.cliTag(kAuth, { ...ctx, ...change }, cli.publicKey, page.publicKey), tag)).toBe(false);
    }
  });

  test('a record moved to another turn, direction, kind, name or conversation does not open', () => {
    for (const moved of [{ n: 3 }, { direction: 'c2p' as const }, { kind: 'note' }, { name: 'OTHER' }, { id: '00000000-0000-4000-8000-000000000000' }]) {
      expect(() => w.openRecord(s.p2c, { ...header, ...moved }, O.answer)).toThrow(w.ConversationWireError);
    }
    expect(() => w.openRecord(s.c2p, header, O.answer)).toThrow(w.ConversationWireError);
  });

  test('a flipped bit or a non-canonical encoding is refused', () => {
    const bytes = w.unb64u(O.answer);
    bytes[20] ^= 1;
    expect(() => w.openRecord(s.p2c, header, w.b64u(bytes))).toThrow(w.ConversationWireError);
    expect(() => w.openRecord(s.p2c, header, `${O.answer}=`)).toThrow(w.ConversationWireError);
  });

  test('numbers go up by exactly one; replays and gaps are dropped', () => {
    expect(w.acceptNumber(0, 1)).toBe(true);
    expect(w.acceptNumber(1, 1)).toBe(false);
    expect(w.acceptNumber(1, 3)).toBe(false);
    expect(w.acceptNumber(2, 1)).toBe(false);
  });

  test('a point that is not on the curve, or not uncompressed, is refused', () => {
    expect(() => w.helloKey(cli, Buffer.alloc(65, 4), I.id, k)).toThrow(w.ConversationWireError);
    expect(() => w.pinFor(I.id, cli.publicKey.subarray(0, 33))).toThrow(w.ConversationWireError);
  });

  test('upper-case or malformed ids are refused, so one conversation has one encoding', () => {
    expect(() => w.pinFor(I.id.toUpperCase(), cli.publicKey)).toThrow(w.ConversationWireError);
  });
});

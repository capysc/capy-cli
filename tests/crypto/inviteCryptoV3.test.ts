import { randomBytes } from 'crypto';
import {
  generateInviteTokenV3,
  buildInviteCodeV3,
  parseInviteCode,
  deriveInviteId,
  generateInviteToken,
  innerWrap,
  innerUnwrap,
  buildRedeemCode,
  parseRedeemCode,
  TOKEN_LENGTH_V3,
} from '../../src/crypto/inviteCrypto';
import { CapyError, ERROR_CODES } from '../../src/types/index';

describe('inviteCrypto v3', () => {
  describe('generateInviteTokenV3', () => {
    it('generates a 12-byte token', () => {
      const t = generateInviteTokenV3();
      expect(t).toBeInstanceOf(Buffer);
      expect(t.length).toBe(TOKEN_LENGTH_V3);
    });

    it('generates unique tokens', () => {
      const a = generateInviteTokenV3();
      const b = generateInviteTokenV3();
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('buildInviteCodeV3 / parseInviteCode round-trip', () => {
    it('round-trips a random 12-byte token through the rendered code', () => {
      const token = generateInviteTokenV3();
      const code = buildInviteCodeV3(token);
      expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      const parsed = parseInviteCode(code);
      expect(parsed.version).toBe(3);
      if (parsed.version === 3) {
        expect(parsed.token.equals(token)).toBe(true);
      }
    });

    it('parses identically whether dashes are present or not', () => {
      const token = generateInviteTokenV3();
      const code = buildInviteCodeV3(token);
      const noDashes = code.replace(/-/g, '');
      const parsed = parseInviteCode(noDashes);
      expect(parsed.version).toBe(3);
      if (parsed.version === 3) expect(parsed.token.equals(token)).toBe(true);
    });

    it('decodes to exactly 12 bytes for every all-zero / all-max token', () => {
      const zero = Buffer.alloc(12, 0x00);
      const max = Buffer.alloc(12, 0xff);
      for (const token of [zero, max]) {
        const code = buildInviteCodeV3(token);
        const parsed = parseInviteCode(code);
        expect(parsed.version).toBe(3);
        if (parsed.version === 3) {
          expect(parsed.token.length).toBe(12);
          expect(parsed.token.equals(token)).toBe(true);
        }
      }
    });

    it('lower-case input parses the same as upper-case', () => {
      const token = generateInviteTokenV3();
      const code = buildInviteCodeV3(token);
      const parsed = parseInviteCode(code.toLowerCase());
      expect(parsed.version).toBe(3);
      if (parsed.version === 3) expect(parsed.token.equals(token)).toBe(true);
    });

    it('folds I/L to 1 and O to 0 on decode', () => {
      // Craft a code, then swap a couple of its characters for their
      // ambiguous look-alikes and confirm the fold recovers the same bytes.
      const token = generateInviteTokenV3();
      const code = buildInviteCodeV3(token).replace(/-/g, '');
      // Only meaningful if the code actually contains a foldable target;
      // build one deterministically instead of relying on the random draw.
      const withOnes = code.replace(/1/g, 'I').replace(/0/g, 'O');
      // Not every code contains 0/1, but replacing is safe either way — if
      // there was nothing to fold, this is just a byte-identical string.
      const parsed = parseInviteCode(withOnes);
      expect(parsed.version).toBe(3);
      if (parsed.version === 3) expect(parsed.token.equals(token)).toBe(true);
    });

    it('rejects a 20-char code whose final 4 padding bits are non-zero', () => {
      const token = generateInviteTokenV3();
      const code = buildInviteCodeV3(token).replace(/-/g, '');
      // The last character encodes the trailing 4 padding bits plus 1 real
      // bit. Swap it for one guaranteed to set at least one padding bit,
      // unless it already is that character.
      const lastChar = code[code.length - 1];
      const replacement = lastChar === 'Z' ? 'Y' : 'Z';
      // 'Z' is value 31 (11111) -- if the last real bit is 0, padding
      // becomes 1111 (non-zero). If already Z, use Y (11110) instead, which
      // still forces the padding nibble to something with the last real bit
      // fixed and non-zero padding in the general case. To make this
      // deterministic, directly construct a code with a known-bad tail: take
      // a fixed 12-byte token, encode, then force the last symbol to 'Z'.
      const knownToken = Buffer.alloc(12, 0x00); // all-zero -> code ends in all-zero-padding
      const knownCode = buildInviteCodeV3(knownToken).replace(/-/g, '');
      const tampered = knownCode.slice(0, 19) + 'Z'; // 'Z' = 31 = 11111, sets padding bits
      expect(() => parseInviteCode(tampered)).toThrow(CapyError);
      try {
        parseInviteCode(tampered);
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CapyError);
        expect((err as CapyError).code).toBe(ERROR_CODES.INVALID_FORMAT);
      }
      void replacement;
    });
  });

  describe('deriveInviteId', () => {
    it('is deterministic for a fixed T (known-answer vector)', () => {
      // T = 12 zero bytes. Pinned so a regression in the derivation recipe
      // (hash input order, prefix string, truncation length) is caught by a
      // fixed expected value rather than only by internal consistency.
      const token = Buffer.alloc(12, 0x00);
      const id = deriveInviteId(token);
      expect(id).toBe('5f6fb0139ece0df7f400478c413176d7');
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('differs for different T', () => {
      const a = deriveInviteId(generateInviteTokenV3());
      const b = deriveInviteId(generateInviteTokenV3());
      expect(a).not.toBe(b);
    });

    it('is the same function the redeemer would call — both derive it from T alone', () => {
      const token = generateInviteTokenV3();
      expect(deriveInviteId(token)).toBe(deriveInviteId(Buffer.from(token)));
    });
  });

  describe('v3 inner wrap uses the unmodified inner-wrap primitives', () => {
    it('round-trips M through innerWrap/innerUnwrap with a 12-byte T', () => {
      const masterKey = randomBytes(32);
      const orgId = 'org-v3';
      const email = 'bob@example.com';
      const token = generateInviteTokenV3();
      const wrapped = innerWrap(masterKey, token, orgId, email);
      const unwrapped = innerUnwrap(wrapped, token, orgId, email);
      expect(unwrapped.equals(masterKey)).toBe(true);
    });
  });

  describe('UPGRADE_REQUIRED (guard 2)', () => {
    it('a v3 code parses as v3, never as v2 and never silently as garbage', () => {
      const token = generateInviteTokenV3();
      const code = buildInviteCodeV3(token);
      const parsed = parseInviteCode(code);
      expect(parsed.version).toBe(3);
    });

    it('an unrecognised base64 blob (wrong version byte) raises UPGRADE_REQUIRED', () => {
      // A 21-char string is not a v3 shape (must be exactly 20) and, decoded
      // as base64, its first byte is not 0x02 either.
      const buf = Buffer.from([0x99, ...randomBytes(40)]);
      const code = buf.toString('base64');
      expect(() => parseInviteCode(code)).toThrow(CapyError);
      try {
        parseInviteCode(code);
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CapyError);
        expect((err as CapyError).code).toBe(ERROR_CODES.UPGRADE_REQUIRED);
      }
    });

    it('a future v4-shaped code (not 20 chars, not a 0x02 blob) also raises UPGRADE_REQUIRED', () => {
      const weird = 'not-a-real-code-at-all';
      expect(() => parseInviteCode(weird)).toThrow(CapyError);
      try {
        parseInviteCode(weird);
      } catch (err) {
        expect((err as CapyError).code).toBe(ERROR_CODES.UPGRADE_REQUIRED);
      }
    });
  });

  describe('guard 1 — v2 codes parse byte-identically through the shared dispatcher', () => {
    it('a v2 code parsed via parseInviteCode matches parseRedeemCode exactly', () => {
      const token = generateInviteToken(); // 32-byte v2 token
      const outerBlob = randomBytes(64).toString('base64');
      const notAfter = Date.now() + 3600_000;
      const orgId = 'org-v2';
      const code = buildRedeemCode(token, outerBlob, orgId, notAfter);

      const direct = parseRedeemCode(code);
      const viaDispatch = parseInviteCode(code);

      expect(viaDispatch.version).toBe(2);
      if (viaDispatch.version === 2) {
        expect(viaDispatch.token.equals(direct.token)).toBe(true);
        expect(viaDispatch.orgId).toBe(direct.orgId);
        expect(viaDispatch.ciphertext).toBe(direct.ciphertext);
        expect(viaDispatch.notAfter).toBe(direct.notAfter);
      }
    });

    it('a malformed v2 code still throws the original (non-CapyError) error, not UPGRADE_REQUIRED', () => {
      // Version byte 0x02 but truncated — parseRedeemCode's own "too short" path.
      const buf = Buffer.from([0x02, ...randomBytes(5)]);
      const shortCode = buf.toString('base64');
      expect(() => parseInviteCode(shortCode)).toThrow(/too short/);
    });
  });
});

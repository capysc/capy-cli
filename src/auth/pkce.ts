import { createHash, randomBytes } from 'crypto';

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

/** RFC 7636 S256 pair. The verifier never leaves the initiating CLI. */
export function generatePKCE(random: (bytes: number) => Buffer = randomBytes): PkcePair {
  const codeVerifier = random(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

// Loopback intake guards, isolated for unit testing. The intake server accepts a
// secret value from a local browser; these checks make that safe: a single-use
// constant-time nonce, plus Host/Origin pinning to the exact loopback address we
// bound (defends against DNS-rebinding from a malicious web page).
import { timingSafeEqual } from 'crypto';

export function nonceEqual(received: unknown, expected: string): boolean {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function isLoopbackHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}`;
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  // Absent Origin (same-origin form submit/navigation) is allowed; if present it
  // must be exactly our loopback origin.
  return !origin || origin === `http://127.0.0.1:${port}`;
}

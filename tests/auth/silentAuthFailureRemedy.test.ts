import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { silentAuthFailureMessage } from '../../src/auth/authService';
import type { AuthResult } from '../../src/types/index';

const SRC = join(__dirname, '..', '..', 'src');

function fail(code: AuthResult['error_code'], error: string): AuthResult {
  return { success: false, error, error_code: code };
}

describe('silentAuthFailureMessage', () => {
  test('an ended session sends you to sign in', () => {
    const msg = silentAuthFailureMessage(fail('session_ended', 'Session expired — sign-in required'));
    expect(msg).toBe('Session expired — sign-in required. Run `capy` to sign in.');
  });

  test('nothing cached sends you to sign in', () => {
    const msg = silentAuthFailureMessage(fail('no_session', 'No valid session available'));
    expect(msg).toBe('No valid session available. Run `capy` to sign in.');
  });

  // The point of the whole change: these two are NOT fixed by signing in, and
  // saying so sends the user into a browser round-trip that cannot succeed.
  test('an unreachable service does not tell you to sign in', () => {
    const msg = silentAuthFailureMessage(
      fail('network', 'Could not reach the Capy service to refresh your session'),
    );
    expect(msg).not.toContain('sign in');
    expect(msg).toBe('Could not reach the Capy service to refresh your session. Check your connection and try again.');
  });

  test('a 5xx from the service does not tell you to sign in', () => {
    const msg = silentAuthFailureMessage(fail('server_error', 'Token refresh failed (HTTP 503)'));
    expect(msg).not.toContain('sign in');
    expect(msg).toContain('try again');
  });

  test('the remedy comes from the code, not the sentence', () => {
    // Three different sentences carrying the same code must produce the same
    // remedy. If this ever fails, someone has started reading the prose.
    const remedies = ['a', 'b', 'c'].map(
      (s) => silentAuthFailureMessage(fail('network', s)).replace(s, ''),
    );
    expect(new Set(remedies).size).toBe(1);
  });

  test('a result with no code still gets a usable sentence', () => {
    expect(silentAuthFailureMessage({ success: false })).toBe('Not authenticated. Run `capy` to sign in.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Derived guard.
//
// `authenticateSilent` is used two ways. Most commands treat it as a probe and
// escalate to interactive `authenticate()` when it fails — for those, a generic
// message after the browser ALSO failed is fine. A handful treat it as the only
// attempt, so its failure ends the command; those are the ones that must report
// why. This finds the second kind from source rather than listing them, so a
// new one shows up here instead of shipping a bare "auth failed".

interface Site {
  file: string;
  line: number;
  body: string;
}

export function terminalSilentAuthSites(source: string, file = '<memory>'): Site[] {
  const lines = source.split('\n');
  const calls: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\bauthenticateSilent\(/.test(lines[i])) continue;
    if (/async authenticateSilent/.test(lines[i])) continue; // the definition
    calls.push(i);
  }

  // Commands commonly probe twice — org-scoped, then unscoped — before
  // deciding. That is one decision, not two, so a run of nearby calls
  // collapses to the last one; anchoring on the first would cut the window
  // off before the escalation and flag a site that does escalate.
  const anchors = calls.filter((line, idx) => {
    const next = calls[idx + 1];
    return next === undefined || next - line > 4;
  });

  const sites: Site[] = [];
  for (const anchor of anchors) {
    const body = lines.slice(anchor + 1, Math.min(lines.length, anchor + 15)).join('\n');
    if (!/if \(!\w+\.success/.test(body)) continue; // no failure branch here
    if (/\.authenticate\(/.test(body)) continue; // escalates to interactive auth
    sites.push({ file, line: anchor + 1, body });
  }

  return sites;
}

function reportsWhy(body: string): boolean {
  // `console.error` is not a read of `result.error`. Matching it was the first
  // version's bug: every site that printed anything looked compliant.
  const withoutLogging = body.replace(/console\.error/g, 'console.LOG');
  return (
    /silentAuthFailureMessage\(/.test(withoutLogging) ||
    /\berror_code\b/.test(withoutLogging) ||
    /getLastRefreshFailure\(/.test(withoutLogging) ||
    /\w+\.error\b/.test(withoutLogging)
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('every terminal silent-auth failure reports why', () => {
  const sites = walk(SRC).flatMap((f) =>
    terminalSilentAuthSites(readFileSync(f, 'utf-8'), relative(SRC, f)),
  );

  test('the scan finds the terminal sites it is meant to cover', () => {
    // Guards that match nothing pass forever. This is the floor, not the list:
    // it fails loudly if a refactor makes the detector stop seeing anything.
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  test('none of them ends on a message that omits the reason', () => {
    const bare = sites.filter((s) => !reportsWhy(s.body));
    const detail = bare.map((s) => `  ${s.file}:${s.line}`).join('\n');
    expect(
      bare.length === 0 ? '' : `silent auth failure reported without a reason:\n${detail}\n\n` +
        'Use silentAuthFailureMessage(result) — it picks the remedy from result.error_code.',
    ).toBe('');
  });
});

// A guard whose detector is wrong reports clean, which is worse than no guard.
// Both halves are checked against source shaped like the real thing.
describe('the detector itself', () => {
  const TERMINAL = `
      const result = await auth.authenticateSilent(orgId);
      if (!result.success || !result.user_id) {
        console.error('capy run: not authenticated. Run \`capy\` to sign in.');
        return 1;
      }
`;

  const ESCALATING = `
    let authResult = await authService.authenticateSilent(orgId);
    if (!authResult.success) authResult = await authService.authenticateSilent();
    if (!authResult.success) authResult = await authService.authenticate(orgId);
    if (!authResult.success) {
      console.error('Authentication failed');
      process.exit(1);
    }
`;

  const FIXED = `
      const result = await auth.authenticateSilent(orgId);
      if (!result.success || !result.user_id) {
        console.error(\`capy run: \${silentAuthFailureMessage(result)}\`);
        return 1;
      }
`;

  test('catches a terminal site that swallows the reason', () => {
    const found = terminalSilentAuthSites(TERMINAL);
    expect(found).toHaveLength(1);
    expect(reportsWhy(found[0].body)).toBe(false);
  });

  test('does not flag a site that escalates to interactive auth', () => {
    expect(terminalSilentAuthSites(ESCALATING)).toHaveLength(0);
  });

  // The false positive the first version produced: a probe-then-probe-then-
  // escalate chain, where anchoring on the first call cut the window off
  // before the `authenticate(` that makes it non-terminal.
  test('does not flag a chained probe whose escalation comes later', () => {
    const CHAINED = `
      let result = await this.authService.authenticateSilent(orgId);

      if (!result.success) {
        result = await this.authService.authenticateSilent();
      }

      if (!result.success) {
        const refreshFailure = this.authService.getLastRefreshFailure();
        if (refreshFailure?.reason === 'network') {
          throw new CapyError('offline', ERROR_CODES.NETWORK_ERROR);
        }
        result = await this.authService.authenticate(orgId);
      }
`;
    expect(terminalSilentAuthSites(CHAINED)).toHaveLength(0);
  });

  test('console.error alone does not count as reporting the reason', () => {
    expect(reportsWhy("console.error('Authentication failed');")).toBe(false);
    expect(reportsWhy('console.error(`${silentAuthFailureMessage(result)}`);')).toBe(true);
  });

  test('accepts the fixed shape', () => {
    const found = terminalSilentAuthSites(FIXED);
    expect(found).toHaveLength(1);
    expect(reportsWhy(found[0].body)).toBe(true);
  });
});

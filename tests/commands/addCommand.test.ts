/**
 * What is left of `capy add` once the intake moved.
 *
 * `parseVars`, `runWebIntake` and the loopback contract are now
 * `tests/ui/secretIntakeScreen.test.ts` — they went with the code, which moved
 * to `ui/secretIntakeScreen.ts` along with the compiled screen it serves. This
 * file keeps the one thing that is genuinely argv's: turning repeatable
 * `--help-url NAME=URL` flags into per-variable links.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { parseHelpUrls, overwriteNotice, AddCommand } from '../../src/commands/addCommand';

/** Captures console.log output across a run and restores it afterward. */
function captureLog(): { out: () => string; restore: () => void } {
  let buf = '';
  const log = spyOn(console, 'log').mockImplementation(((...a: unknown[]) => {
    buf += a.join(' ') + '\n';
  }) as any);
  return { out: () => buf, restore: () => log.mockRestore() };
}

describe('parseHelpUrls (repeatable --help-url NAME=URL)', () => {
  test('maps valid http(s) pairs by name', () => {
    expect(
      parseHelpUrls(['STRIPE_SECRET_KEY=https://dashboard.stripe.com/apikeys', 'OPENAI_API_KEY=http://example.com/k']),
    ).toEqual({
      STRIPE_SECRET_KEY: 'https://dashboard.stripe.com/apikeys',
      OPENAI_API_KEY: 'http://example.com/k',
    });
  });

  test('drops non-http(s) URLs and malformed/invalid-name pairs', () => {
    expect(parseHelpUrls(['A=javascript:alert(1)', 'B=ftp://x', 'no-equals', '=https://x', '1BAD=https://x'])).toEqual(
      {},
    );
  });

  test('returns {} for undefined', () => {
    expect(parseHelpUrls(undefined)).toEqual({});
  });
});

describe('overwriteNotice', () => {
  test('carries the terminal confirm word for word', () => {
    // `--web` used to skip the confirm entirely — it is gated on `!opts.web` —
    // so a browser intake overwrote existing values without a word anywhere.
    // Two wordings for one thing is a bug, so this is the CLI's own sentence.
    expect(overwriteNotice(['A', 'B'])).toBe('A, B already exist(s). Overwrite?');
  });

  test('says nothing when nothing would be overwritten', () => {
    expect(overwriteNotice([])).toBeUndefined();
  });
});

describe('AddCommand — CAP-659 Phase 2/3 (non-tty ordering + dry-run preview)', () => {
  test('non-tty without --web refuses BEFORE resolveContext — no network/auth attempted', async () => {
    // `resolveContext()` is never mocked in this file; if it were reached it
    // would hit a real `ProjectManager`/`process.exit(1)` in this cwd, not
    // the `CapyError` below. Getting exactly this error proves the refusal
    // fired first.
    await expect(new AddCommand().execute(['FOO'], { nonTty: true })).rejects.toThrow(
      'Non-interactive add requires --web',
    );
  });

  test('non-tty WITH --web does not hit the refusal (falls through toward the web intake)', async () => {
    // Can't drive the real web intake without a browser/loopback in this
    // unit test — just prove the specific refusal above is skipped: the
    // unmocked `resolveContext()` is reached instead and exits on this cwd's
    // lack of a keep.lock (mocked here so it throws instead of really
    // exiting the test runner).
    const errSpy = spyOn(console, 'error').mockImplementation((() => {}) as any);
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
    try {
      await expect(new AddCommand().execute(['FOO'], { nonTty: true, web: true })).rejects.not.toThrow(
        'Non-interactive add requires --web',
      );
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test('--dry-run: never calls resolveContext (no auth/network at all)', async () => {
    const cap = captureLog();
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
    try {
      await expect(new AddCommand().execute(['FOO', 'BAR'], { dryRun: true })).rejects.toThrow('__exit_3__');
    } finally {
      cap.restore();
      exitSpy.mockRestore();
    }
    const out = cap.out();
    expect(out).toContain('FOO');
    expect(out).toContain('BAR');
  });

  test('--dry-run without --web: value entry is unanswered (exit 3), push + per-name writes are listed', async () => {
    const cap = captureLog();
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
    try {
      await expect(new AddCommand().execute(['FOO'], { dryRun: true })).rejects.toThrow('__exit_3__');
    } finally {
      cap.restore();
      exitSpy.mockRestore();
    }
    const out = cap.out();
    expect(out).toContain('write value to .env FOO');
    expect(out).toContain('push to Capy');
    expect(out).toContain('--web');
  });

  test('--dry-run --web: nothing unanswered (exit 0), a browser change is listed', async () => {
    const cap = captureLog();
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
    try {
      await expect(new AddCommand().execute(['FOO'], { dryRun: true, web: true })).rejects.toThrow('__exit_0__');
    } finally {
      cap.restore();
      exitSpy.mockRestore();
    }
    expect(cap.out()).toContain('open local intake page');
  });

  test('--dry-run --no-push: no push change listed', async () => {
    const cap = captureLog();
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
    try {
      await expect(new AddCommand().execute(['FOO'], { dryRun: true, web: true, noPush: true })).rejects.toThrow('__exit_0__');
    } finally {
      cap.restore();
      exitSpy.mockRestore();
    }
    expect(cap.out()).not.toContain('push to Capy');
  });
});

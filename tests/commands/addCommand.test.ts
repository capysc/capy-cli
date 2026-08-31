/**
 * What is left of `capy add` once the intake moved.
 *
 * `parseVars`, `runWebIntake` and the loopback contract are now
 * `tests/ui/secretIntakeScreen.test.ts` — they went with the code, which moved
 * to `ui/secretIntakeScreen.ts` along with the compiled screen it serves. This
 * file keeps the one thing that is genuinely argv's: turning repeatable
 * `--help-url NAME=URL` flags into per-variable links.
 */
import { describe, test, expect } from 'bun:test';
import {
  AddCommand,
  firstSecretEnvDecision,
  parseHelpUrls,
  overwriteNotice,
  type AddCommandDependencies,
} from '../../src/commands/addCommand';
import { CapyError, ERROR_CODES } from '../../src/types';

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

describe('firstSecretEnvDecision', () => {
  const missingLocklessEnvironment = {
    lockless: true,
    localEnvExists: false,
    remoteEnvExists: false,
    createEnvApproved: false,
  } as const;

  test('returns a coded approval decision before the first lockless secret intake', () => {
    expect(firstSecretEnvDecision(missingLocklessEnvironment)).toEqual({
      code: ERROR_CODES.FIRST_SECRET_ENV_REQUIRED,
      question: 'Create .env for this project?',
      retryFlag: '--create-env',
    });
  });

  test('the explicit approval retry clears only the missing-environment decision', () => {
    expect(firstSecretEnvDecision({ ...missingLocklessEnvironment, createEnvApproved: true })).toBeNull();
  });

  test('an existing local or remote environment stays on the established intake path', () => {
    expect(firstSecretEnvDecision({ ...missingLocklessEnvironment, localEnvExists: true })).toBeNull();
    expect(firstSecretEnvDecision({ ...missingLocklessEnvironment, remoteEnvExists: true })).toBeNull();
  });

  test('paid keep.lock behavior is unaffected even when no environment exists', () => {
    expect(firstSecretEnvDecision({ ...missingLocklessEnvironment, lockless: false })).toBeNull();
  });

  test('non-TTY execution fails coded before secret intake can open', async () => {
    const dependencies = {
      resolveContext: async () => ({
        lockless: true,
        branch: 'development',
        keep: { variables: {} },
        pm: { detectProjectState: async () => ({ hasEnvFile: false }) },
      }) as unknown as Awaited<ReturnType<AddCommandDependencies['resolveContext']>>,
      writeAndSync: async () => {
        throw new Error('writeAndSync must not run before environment approval');
      },
      runWebIntake: async () => {
        throw new Error('secret intake must not open before environment approval');
      },
    } as AddCommandDependencies;
    const outcome = await new AddCommand(true, dependencies)
      .execute(['EXAMPLE_KEY'], { web: true, nonTty: true })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    expect(outcome.ok).toBeFalse();
    expect(outcome.ok ? null : outcome.error).toBeInstanceOf(CapyError);
    expect(outcome.ok ? null : (outcome.error as CapyError).code).toBe(ERROR_CODES.FIRST_SECRET_ENV_REQUIRED);
    expect(outcome.ok ? null : (outcome.error as CapyError).details).toEqual({
      decision: 'create_env',
      question: 'Create .env for this project?',
      retry_flag: '--create-env',
    });
  });
});

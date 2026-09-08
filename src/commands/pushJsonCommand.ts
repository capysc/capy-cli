import { CapyError, ERROR_CODES } from '../types/index';
import { PushCommand } from './pushCommand';

export interface PushJsonCommandOptions {
  readonly plan?: boolean;
  readonly confirm?: string;
  readonly expectedUserId?: string;
  readonly serviceOrigin?: string;
}

type ValidPushJsonCommandOptions =
  | { readonly plan: true; readonly confirm?: undefined; readonly expectedUserId: string; readonly serviceOrigin: string }
  | { readonly plan?: false; readonly confirm: string; readonly expectedUserId: string; readonly serviceOrigin: string };

function validOptions(options: PushJsonCommandOptions): options is ValidPushJsonCommandOptions {
  return Boolean(options.expectedUserId && options.serviceOrigin)
    && (options.plan === true ? options.confirm === undefined : options.confirm !== undefined);
}

function failureCode(error: unknown): string {
  return error instanceof CapyError ? error.code : ERROR_CODES.SERVICE_ERROR;
}

/**
 * Prints exactly one JSON value. A matching hash is only an integrity binding
 * for a reviewed plan; the hosted bridge remains responsible for obtaining
 * and recording human approval before it supplies `--confirm`.
 */
export async function runPushJsonCommand(
  options: PushJsonCommandOptions,
  devMode = false,
): Promise<number> {
  if (!validOptions(options)) {
    console.log(JSON.stringify({ ok: false, code: 'PUSH_REVIEW_ARGUMENT_INVALID' }));
    return 1;
  }
  try {
    const command = new PushCommand(devMode);
    const result = await command.executeJsonReview(options);
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } catch (error: unknown) {
    console.log(JSON.stringify({ ok: false, code: failureCode(error) }));
    return 1;
  }
}

/**
 * `capy connect vercel --discover --import-environment <environment>[=<branch>]`
 * (repeatable): which Vercel environments are imported, and which Capy branch
 * each one lands on.
 *
 * Without the option, discovery imports every environment onto a branch of the
 * same name. With it, ONLY the named environments are imported, each onto its
 * named branch (or onto a branch named like the environment when no `=<branch>`
 * is given).
 *
 * This file only parses and checks the option's own text. It runs before any
 * request, so a refusal here changes nothing. Whether a named environment
 * exists is checked against the plan, in `vercel.ts`. Every refusal is a
 * stable code; nothing branches on a message.
 */
import { branchNameProblem } from '../../core/branchNameRule';
import { ERROR_CODES } from '../../types/index';
import type { ConnectFailure } from './registry';

export interface EnvironmentBranchChoice {
  readonly environment: string;
  readonly branch: string;
}

export type ParsedEnvironmentChoices =
  | { readonly ok: true; readonly choices: readonly EnvironmentBranchChoice[] }
  | ConnectFailure;

/** `preview=staging` as `{ preview, staging }`; `production` as `{ production, production }`. Splits on the first `=` only. */
function parseOne(spec: string): { readonly environment: string; readonly branch: string; readonly branchGiven: boolean } {
  const at = spec.indexOf('=');
  if (at < 0) return { environment: spec.trim(), branch: spec.trim(), branchGiven: false };
  return { environment: spec.slice(0, at).trim(), branch: spec.slice(at + 1).trim(), branchGiven: true };
}

function firstDuplicate(names: readonly string[]): string | undefined {
  return names.find((name, i) => names.indexOf(name) !== i);
}

/** The first problem in the parsed list, as a refusal, or `null` when the list is fine. Order: an empty environment, a bad branch name, an environment named twice, a branch used twice. */
function problemWith(parsed: ReadonlyArray<ReturnType<typeof parseOne>>): ConnectFailure | null {
  const unnamed = parsed.find((p) => p.environment === '');
  if (unnamed) {
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    return { ok: false, code: ERROR_CODES.VERCEL_ENVIRONMENT_NOT_FOUND, message: '--import-environment needs an environment name.' };
  }
  const badBranch = parsed.map((p) => ({ p, problem: branchNameProblem(p.branch) })).find((x) => x.problem !== null);
  if (badBranch?.problem) {
    return { ok: false, code: badBranch.problem.code, message: `${badBranch.p.environment}: ${badBranch.problem.message}` };
  }
  const twiceEnvironment = firstDuplicate(parsed.map((p) => p.environment));
  if (twiceEnvironment !== undefined) {
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    return { ok: false, code: ERROR_CODES.VERCEL_ENVIRONMENT_DUPLICATE, message: `Environment named twice: ${twiceEnvironment}.` };
  }
  const twiceBranch = firstDuplicate(parsed.map((p) => p.branch));
  if (twiceBranch !== undefined) {
    // COPY-FLAG: new user-facing string, minimal/neutral wording.
    return { ok: false, code: ERROR_CODES.VERCEL_BRANCH_DUPLICATE, message: `Branch used twice: ${twiceBranch}.` };
  }
  return null;
}

/** Parses every `--import-environment` value. An empty list is not an error: it means the option was not given. */
export function parseEnvironmentChoices(specs: readonly string[]): ParsedEnvironmentChoices {
  const parsed = specs.map(parseOne);
  const problem = problemWith(parsed);
  if (problem) return problem;
  return { ok: true, choices: parsed.map((p) => ({ environment: p.environment, branch: p.branch })) };
}

/**
 * Whether the option may be used with the rest of this run's options: not
 * together with `--environment` (which already restricts the environments).
 * The "only under --discover" check lives in `import()`.
 */
export function optionConflict(choices: readonly EnvironmentBranchChoice[], environmentFlag: string | undefined): ConnectFailure | null {
  if (choices.length === 0 || !environmentFlag?.trim()) return null;
  // COPY-FLAG: new user-facing string, minimal/neutral wording.
  return { ok: false, code: ERROR_CODES.VERCEL_IMPORT_ENVIRONMENT_NOT_APPLICABLE, message: '--import-environment cannot be used with --environment.' };
}

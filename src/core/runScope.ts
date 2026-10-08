import { CapyError, ERROR_CODES } from '../types/index';

export interface RunScopeOptions {
  readonly org?: string;
  readonly project?: string;
  readonly branch?: string;
  readonly only?: string;
  readonly nonTty?: boolean;
}

export interface RunProjectContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly branch: string | null;
}

/** A usability guard for automation, not an identity or sandbox boundary. */
export function requiresExplicitRunScope(
  stdinIsTTY: boolean | undefined,
  env: Readonly<Record<string, string | undefined>>,
  nonTty = false,
): boolean {
  return nonTty || !stdinIsTTY || ['CODEX_THREAD_ID', 'CODEX_CI', 'CLAUDECODE', 'CURSOR_AGENT'].some(name => Boolean(env[name]));
}

export function hasRunScope(options: RunScopeOptions): boolean {
  return [options.org, options.project, options.branch, options.only].some(value => value !== undefined);
}

export function validateRunScope(options: RunScopeOptions): readonly string[] {
  if (![options.org, options.project, options.branch, options.only].every(value => typeof value === 'string' && value.trim().length > 0)) {
    throw new CapyError(
      'Automated local runs require --org <id> --project <id> --branch <name> --only <VAR,...> before --. ' +
      'Select only variables authorized for this task. If the command needs no project secrets, run it directly without capy run. ' +
      'Check keep.lock and the active Capy branch to confirm context; do not guess or switch to a PTY to bypass this check.',
      ERROR_CODES.RUN_SCOPE_REQUIRED,
    );
  }
  const names = (options.only as string).split(',').map(name => name.trim());
  if (names.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new CapyError('--only must contain explicit comma-separated variable names; empty names and wildcards are not accepted.', ERROR_CODES.RUN_SCOPE_INVALID);
  }
  return [...new Set(names)];
}

export function selectRunVariables(
  values: Readonly<Record<string, string>>,
  names: readonly string[],
  options: RunScopeOptions,
  context: RunProjectContext,
  metadata: Readonly<{ org_id?: string; project_id?: string }>,
): Readonly<Record<string, string>> {
  if (options.org !== context.orgId || options.project !== context.projectId || options.branch !== context.branch
    || (metadata.org_id !== undefined && metadata.org_id !== context.orgId)
    || (metadata.project_id !== undefined && metadata.project_id !== context.projectId)) {
    throw new CapyError('Requested organization, project, or branch does not match the local project context. No variables were injected.', ERROR_CODES.RUN_CONTEXT_MISMATCH);
  }
  if (names.some(name => !Object.hasOwn(values, name))) {
    throw new CapyError('One or more --only variables are absent from this project’s local .env. No variables were injected.', ERROR_CODES.RUN_SCOPE_INVALID);
  }
  return Object.fromEntries(names.map(name => [name, values[name]]));
}

/** Unselected project variables must not sneak back in through the shell. */
export function scopedShellEnvironment(
  shell: Readonly<Record<string, string | undefined>>,
  projectNames: readonly string[],
  selectedNames: readonly string[],
): Readonly<Record<string, string | undefined>> {
  const omitted = new Set(projectNames.filter(name => !selectedNames.includes(name)));
  return Object.fromEntries(Object.entries(shell).filter(([name]) => !omitted.has(name)));
}

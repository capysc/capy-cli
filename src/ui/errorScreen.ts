import { CapyError, ERROR_CODES } from '../types/index';
import { isMembershipRevokedError } from '../errors/membershipRevoked';

const grey = (s: string) => `\x1b[90m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

interface ErrorContext {
  projectName?: string;
  projectId?: string;
  branch?: string;
}

/**
 * Render a user-friendly error screen for a CapyError.
 * Returns the formatted string to print (does not print itself).
 */
export function renderError(error: any, context: ErrorContext = {}): string {
  // Handle Ctrl+C
  if (error?.name === 'ExitPromptError') {
    return '';
  }

  // Handle CapyError with specific layouts
  if (error instanceof CapyError) {
    switch (error.code) {
      case ERROR_CODES.AUTH_FAILED:
        return renderAuthFailed(error);
      case ERROR_CODES.KEY_NOT_ON_DEVICE:
        return renderKeyNotOnDevice(error);
      case ERROR_CODES.PERMISSION_DENIED:
        // Being kicked and being denied are different sentences to read, and
        // the first was UNREACHABLE: its check lived in `renderServiceError`
        // behind `status === 403`, but a 403 is thrown as PERMISSION_DENIED
        // and never arrives there. Nobody has seen the "Access revoked" page.
        return isMembershipRevokedError(error)
          ? renderMembershipRevoked()
          : renderPermissionDenied(error, context);
      case ERROR_CODES.NETWORK_ERROR:
        return renderNetworkError(error);
      case ERROR_CODES.SERVICE_ERROR:
        return renderServiceError(error, context);
      // Each of these used to be a sentence this file matched against inside
      // `renderServiceError`. `classifyResponse` decides them at the boundary
      // now, so they are ordinary cases in the same switch as everything else.
      case ERROR_CODES.PROJECT_NOT_FOUND:
        return renderProjectNotFound(context);
      case ERROR_CODES.BRANCH_NOT_FOUND:
        return renderBranchNotFound(error);
      case ERROR_CODES.INVALID_FORMAT:
        return renderInvalidFormat(error);
      case ERROR_CODES.NO_KEEP_FILE:
        return renderNoKeepFile();
      case ERROR_CODES.QUOTA_EXCEEDED:
        return renderQuotaExceeded(error);
      // The local-state refusals. Each of these was a bare `console.error` at
      // the top of a command, which is fine in a terminal and invisible under
      // `--web` — the flag exists because the caller is an agent. Routing them
      // through here costs the terminal nothing and gives the browser half a
      // payload to draw, from one switch on one code.
      case ERROR_CODES.NO_ACTIVE_BRANCH:
        return renderNoActiveBranch();
      case ERROR_CODES.NO_MANAGED_KEYS:
        return renderNoManagedKeys();
      case ERROR_CODES.NO_VARIABLES:
        return renderNoVariables();
      case ERROR_CODES.VARIABLE_NOT_FOUND:
        return renderVariableNotFound(error);
      case ERROR_CODES.NO_CONNECTORS:
        return renderNoConnectors();
      case ERROR_CODES.DEV_LIVE_FIREWALL:
        return renderDevLiveFirewall(error);
      default:
        return renderGeneric(error);
    }
  }

  // Unknown error
  const msg = error?.message || 'An unexpected error occurred';
  return `\n  ${msg}\n`;
}

/**
 * End the run on the failure, wherever the caller is looking.
 *
 * Async, and every call site awaits it. That is not ceremony: under `--web`
 * this has to hold the process open until the browser has actually fetched the
 * page. `ScreenServer.start()` resolves when the socket is LISTENING, and a
 * command that exits on the next line closes it microseconds before the
 * browser connects — the same defect that made every ending page in the
 * connectors parcel undeliverable. `serveEndingPage` waits for delivery; this
 * function cannot return before it does.
 *
 * The terminal still gets its ANSI in both modes. A `--web` run has a terminal
 * somewhere even when nobody is watching it, and a transcript that goes quiet
 * at the moment of failure is worse than one nobody reads.
 */
export async function displayErrorAndExit(
  error: any,
  context: ErrorContext = {},
): Promise<never> {
  if (error?.name === 'ExitPromptError') {
    process.exit(0);
  }

  const output = renderError(error, context);
  if (output) console.log(output);

  const { isWebMode } = await import('./webMode');
  if (isWebMode()) {
    try {
      const { buildCommandErrorData } = await import('./commandErrorScreen');
      const { serveEndingPage } = await import('./endingPage');
      await serveEndingPage('command-error', buildCommandErrorData(error, context), {
        lead: 'What went wrong is in your browser:',
        // Shorter than an ending that reports work: the run is already over
        // and nothing is pending, so a page nobody collects must not hold a
        // failed command open for two minutes.
        timeoutMs: 60_000,
        flow: 'error',
      });
    } catch {
      // A failure while reporting a failure is not worth a second failure.
      // The ANSI above already went out, and the exit code is the contract.
    }
  }

  process.exit(1);
}

function renderAuthFailed(error: CapyError): string {
  const detail = error.details?.detail || error.message;
  const lines = [
    '',
    `  ${bold('Authentication failed')}`,
    `  ${grey(detail)}`,
    '',
    `  Try:`,
    `    1. Run ${bold('capy')} again to re-authenticate`,
    `    2. Check your internet connection`,
    `    3. Verify your account at ${grey('https://capy.sc')}`,
    `    4. If you're the org owner, run ${bold('capy decrypt')} to decrypt offline with your seed phrase`,
    '',
  ];
  return lines.join('\n');
}

/**
 * The account can reach the org; this device has no key for it. Its own screen
 * because the remedy is an invite code, not signing in again — the sentence
 * this error carries already says so, and it used to be rendered under
 * "Authentication failed", which pointed at the wrong fix.
 */
function renderKeyNotOnDevice(error: CapyError): string {
  return ['', `  ${bold('This device has no key for that organization')}`, `  ${grey(error.message)}`, ''].join('\n');
}

function renderPermissionDenied(error: CapyError, ctx: ErrorContext): string {
  const variable = error.details?.variable;

  // Wrong decryption key — branch on the typed code, never message text (Rule 4).
  if (error.code === ERROR_CODES.DECRYPT_KEY_MISMATCH || error.details?.cause?.code === ERROR_CODES.DECRYPT_KEY_MISMATCH) {
    const lines = [
      '',
      `  ${bold('Cannot decrypt secrets')}`,
      variable ? `  ${grey(`Variable: ${variable}`)}` : '',
      '',
      `  These secrets were encrypted with a different project's key.`,
      `  This usually happens when:`,
      `    - The project was re-initialized to a different org`,
      `    - The keep.lock/.capy files were reset without clearing .env`,
      '',
      `  To fix:`,
      `    1. Delete ${bold('.env')} and run ${bold('capy')} to pull fresh secrets`,
      `    2. Or restore .env from your ${bold('.env.pre-capy.old')} backup`,
      '',
    ];
    return lines.filter(l => l !== '').join('\n') + '\n';
  }

  const lines = [
    '',
    `  ${bold('Permission denied')}`,
    `  You do not have access to ${ctx.branch ? `this branch (${ctx.branch})` : 'these secrets'}.`,
    '',
    `  Contact your project admin to get access.`,
    '',
    `  If you are trying to log into another computer, run ${bold('capy transport')}`,
    `  where you have an initialized account and copy the redeem code to this`,
    `  computer. If you don't have access to that computer, you can alternately`,
    `  get a team member to send you an invite.`,
    '',
  ];
  return lines.join('\n');
}

function renderNetworkError(error: CapyError): string {
  const lines = [
    '',
    `  ${bold('Connection failed')}`,
    `  ${grey(`Could not reach the ${bold('Capy')} service.`)}`,
    '',
    `  Check:`,
    `    1. Your internet connection`,
    `    2. The service is running ${grey('(capy-dev: http://localhost:3001)')}`,
    '',
    `  If you're the org owner, run ${bold('capy decrypt')} to decrypt secrets offline with your seed phrase.`,
    '',
  ];
  return lines.join('\n');
}

function renderServiceError(error: CapyError, ctx: ErrorContext): string {
  const status = error.details?.status;
  const serverMsg = error.details?.data?.error || error.message;

  // Generic service error — everything specific is now its own code, handled
  // in the switch above.
  const lines = [
    '',
    `  ${bold('Service error')}${status ? grey(` (${status})`) : ''}`,
    `  ${serverMsg}`,
    '',
  ];
  return lines.join('\n');
}

function renderMembershipRevoked(): string {
  const lines = [
    '',
    `  ${bold('Access revoked')}`,
    `  ${grey('You are no longer a member of this organization.')}`,
    '',
    `  To regain access, ask an org admin to re-invite you.`,
    '',
  ];
  return lines.join('\n') + '\n';
}

function renderProjectNotFound(ctx: ErrorContext): string {
  const lines = [
    '',
    `  ${bold('Project not found')}`,
    ctx.projectName ? `  ${grey(`Project "${ctx.projectName}" does not exist on the server.`)}` : '',
    ctx.projectId ? `  ${grey(`ID: ${ctx.projectId}`)}` : '',
    '',
    `  This can happen when:`,
    `    - The database was reset`,
    `    - The project was deleted`,
    `    - The keep.lock file is from a different environment`,
    '',
    `  To fix:`,
    `    1. Delete ${bold('keep.lock')} and ${bold('.capy/')} then run ${bold('capy')} to re-initialize`,
    `    2. Or run ${bold('capy')} — it will offer to recreate the project`,
    '',
  ];
  return lines.filter(l => l !== '').join('\n') + '\n';
}

function renderBranchNotFound(error: CapyError): string {
  const lines = [
    '',
    `  ${bold('Branch not found')}`,
    // Display only: the server's sentence names the branch, and showing it is
    // the whole value. Nothing here reads it.
    `  ${grey(error.details?.data?.error || error.message)}`,
    '',
    `  Run ${bold('capy branch')} to see available branches.`,
    '',
  ];
  return lines.join('\n');
}

function renderInvalidFormat(error: CapyError): string {
  const lines = [
    '',
    `  ${bold('Invalid file format')}`,
    `  ${grey(error.message)}`,
    '',
    `  Try deleting ${bold('keep.lock')} and ${bold('.capy/')} then run ${bold('capy')} to re-initialize.`,
    '',
  ];
  return lines.join('\n');
}

function renderNoKeepFile(): string {
  const lines = [
    '',
    `  ${bold('No keep.lock file found')}`,
    `  ${grey(`This project has not been initialized with ${bold('Capy')} yet.`)}`,
    '',
    `  Run ${bold('capy')} to initialize.`,
    '',
  ];
  return lines.join('\n');
}

function renderNoActiveBranch(): string {
  const lines = [
    '',
    `  ${bold('No active branch')}`,
    `  ${grey('Nothing here records which branch this directory is on.')}`,
    '',
    `  Run ${bold('capy')} to select a branch.`,
    '',
  ];
  return lines.join('\n');
}

function renderNoManagedKeys(): string {
  const lines = [
    '',
    `  ${bold('No managed keys to rotate on this branch')}`,
    `  ${grey('Rotation goes through the provider, so a variable has to be linked to one first.')}`,
    '',
    `  Connect one with ${bold('capy connect <provider>')}, or run ${bold('capy rotate')} to set up an existing var.`,
    '',
  ];
  return lines.join('\n');
}

function renderNoVariables(): string {
  const lines = [
    '',
    `  ${bold('No variables on this branch yet')}`,
    '',
    `  Add one to ${bold('.env')} and run ${bold('capy')}, or run ${bold('capy connect <provider>')}.`,
    '',
  ];
  return lines.join('\n');
}

function renderVariableNotFound(error: CapyError): string {
  const variable = error.details?.variable;
  const branch = error.details?.branch;
  // Display only — the caller already decided this case on the code.
  const available: string[] = error.details?.available ?? [];
  const lines = [
    '',
    `  ${bold('Variable not found')}`,
    `  ${bold(String(variable))} is not in your environment on branch ${String(branch)}.`,
    ...(available.length > 0 ? [`  ${grey(`Available: ${available.join(', ')}`)}`] : []),
    '',
    available.length > 0
      ? `  Add it to ${bold('.env')} and run ${bold('capy')}, or pick one of the names above.`
      : `  Add it to ${bold('.env')} and run ${bold('capy')}.`,
    '',
  ];
  return lines.join('\n');
}

function renderNoConnectors(): string {
  const lines = [
    '',
    `  ${bold('No connectors are registered')}`,
    `  ${grey('This build has no third-party integration to promote a variable to.')}`,
    '',
  ];
  return lines.join('\n');
}

function renderDevLiveFirewall(error: CapyError): string {
  // Two facts, told apart on a structured flag rather than on the sentence:
  // one live key stopped a single rotation, or every managed key was live and
  // the run has nothing left to do.
  const nothingLeft = error.details?.nothingLeft === true;
  const variables: string[] = error.details?.variables ?? [];
  const lines = nothingLeft
    ? [
        '',
        `  ${bold('Nothing to rotate')}`,
        `  ${grey('All managed keys on this branch are live-mode.')}`,
        '',
        `  ${bold('capy-dev')} never touches a live credential. Use the production ${bold('capy')} binary.`,
        '',
      ]
    : [
        '',
        `  ${bold('Live mode is not allowed in capy-dev')}`,
        `  ${grey(`${String(variables[0])} is configured for live mode.`)}`,
        '',
        `  Rotate cannot run via ${bold('capy-dev')}. Use the production ${bold('capy')} binary.`,
        '',
      ];
  return lines.join('\n');
}

function renderQuotaExceeded(error: CapyError): string {
  const kind = error.details?.kind;
  const limit = error.details?.limit;
  const upgradeUrl = error.details?.upgrade_url || 'https://admin.capy.sc/billing';

  // The 1-org-per-user cap is a hard rule, not a paywall — render distinctly.
  if (kind === 'organization') {
    const lines = [
      '',
      `  ${bold('Organization limit reached')}`,
      `  ${grey(error.message)}`,
      '',
      `  Each Capy account can own one organization. To work in another org,`,
      `  ask its owner to invite you with ${bold('capy invite')}.`,
      '',
    ];
    return lines.join('\n');
  }

  let headline: string;
  let cta: string;
  if (kind === 'project') {
    headline = `Project limit reached${limit ? grey(` (${limit}/org)`) : ''}`;
    cta = 'Upgrade to Capy Business for unlimited projects';
  } else {
    // member
    headline = `Member limit reached${limit ? grey(` (${limit}/org)`) : ''}`;
    cta = 'Upgrade to Capy Business to invite more members';
  }
  const lines = [
    '',
    `  ${bold(headline)}`,
    `  ${grey(error.message)}`,
    '',
    `  ${cta}:`,
    `    ${upgradeUrl}`,
    '',
  ];
  return lines.join('\n');
}

function renderGeneric(error: CapyError): string {
  const lines = [
    '',
    `  ${error.message}`,
    '',
  ];
  return lines.join('\n');
}

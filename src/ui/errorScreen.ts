import { CapyError, ERROR_CODES } from '../types/index';

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
      case ERROR_CODES.PERMISSION_DENIED:
        return renderPermissionDenied(error, context);
      case ERROR_CODES.NETWORK_ERROR:
        return renderNetworkError(error);
      case ERROR_CODES.SERVICE_ERROR:
        return renderServiceError(error, context);
      case ERROR_CODES.INVALID_FORMAT:
        return renderInvalidFormat(error);
      case ERROR_CODES.NO_KEEP_FILE:
        return renderNoKeepFile();
      default:
        return renderGeneric(error);
    }
  }

  // Unknown error
  const msg = error?.message || 'An unexpected error occurred';
  return `\n  ${msg}\n`;
}

/**
 * Print the error screen and exit.
 */
export function displayErrorAndExit(error: any, context: ErrorContext = {}): never {
  if (error?.name === 'ExitPromptError') {
    process.exit(0);
  }

  const output = renderError(error, context);
  if (output) console.log(output);
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
    '',
  ];
  return lines.join('\n');
}

function renderPermissionDenied(error: CapyError, ctx: ErrorContext): string {
  const lines = [
    '',
    `  ${bold('Permission denied')}`,
    `  You do not have access to this ${ctx.branch ? `branch (${ctx.branch})` : 'project'}.`,
    '',
    `  Contact your project admin to get access.`,
    '',
  ];
  return lines.join('\n');
}

function renderNetworkError(error: CapyError): string {
  const lines = [
    '',
    `  ${bold('Connection failed')}`,
    `  ${grey('Could not reach the Capy service.')}`,
    '',
    `  Check:`,
    `    1. Your internet connection`,
    `    2. The service is running ${grey('(capy-dev: http://localhost:3000)')}`,
    '',
  ];
  return lines.join('\n');
}

function renderServiceError(error: CapyError, ctx: ErrorContext): string {
  const status = error.details?.status;
  const serverMsg = error.details?.data?.error || error.message;

  // Project not found — special layout
  if (status === 404 && serverMsg?.includes('Project not found')) {
    const lines = [
      '',
      `  ${bold('Project not found')}`,
      ctx.projectName ? `  ${grey(`Project "${ctx.projectName}" does not exist on the server.`)}` : '',
      ctx.projectId ? `  ${grey(`ID: ${ctx.projectId}`)}` : '',
      '',
      `  This can happen when:`,
      `    - The database was reset`,
      `    - The project was deleted`,
      `    - The .keep file is from a different environment`,
      '',
      `  To fix:`,
      `    1. Delete ${bold('.keep')} and ${bold('.capy/')} then run ${bold('capy')} to re-initialize`,
      `    2. Or run ${bold('capy')} — it will offer to recreate the project`,
      '',
    ];
    return lines.filter(l => l !== '').join('\n') + '\n';
  }

  // Branch not found
  if (status === 404 && serverMsg?.includes('Branch')) {
    const lines = [
      '',
      `  ${bold('Branch not found')}`,
      `  ${grey(serverMsg)}`,
      '',
      `  Run ${bold('capy branch')} to see available branches.`,
      '',
    ];
    return lines.join('\n');
  }

  // Generic service error
  const lines = [
    '',
    `  ${bold('Service error')}${status ? grey(` (${status})`) : ''}`,
    `  ${serverMsg}`,
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
    `  Try deleting ${bold('.keep')} and ${bold('.capy/')} then run ${bold('capy')} to re-initialize.`,
    '',
  ];
  return lines.join('\n');
}

function renderNoKeepFile(): string {
  const lines = [
    '',
    `  ${bold('No .keep file found')}`,
    `  ${grey('This project has not been initialized with Capy yet.')}`,
    '',
    `  Run ${bold('capy')} to initialize.`,
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

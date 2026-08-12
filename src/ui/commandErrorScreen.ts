/**
 * The browser half of `errorScreen.ts`.
 *
 * `displayErrorAndExit` writes ANSI and exits. Under `--web` that goes to a
 * stream nobody is reading — the flag exists because the caller is an agent —
 * and if a window is already open it is left holding a page whose server the
 * exit has just closed. So the run's last fact, the one that says what to do
 * next, was the one fact that never reached the surface anybody was looking at.
 *
 * This builds the same eight layouts as data. It is a straight port and the
 * wording is deliberately identical: two surfaces describing one failure in
 * two vocabularies is worse than either alone, and someone comparing a
 * terminal transcript with a screenshot has to be able to see they match.
 *
 * WHAT IT MAY NOT DO. Decide which failure this is. That is settled before we
 * get here — `classifyResponse` mints the code at the boundary and
 * `renderError` switches on it — so this file switches on the same code and
 * never looks at a message to choose a shape. It reads `error.message` in
 * exactly one way: as a sentence to display.
 */
import { CapyError, ERROR_CODES } from '../types/index';
import { isMembershipRevokedError } from '../errors/membershipRevoked';
import type { CommandErrorData } from './screens/contract';

export interface ErrorContext {
  projectName?: string;
  projectId?: string;
  branch?: string;
}

/** Strip the bold/dim codes the CLI's own messages carry into a browser. */
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const fact = (label: string, value?: string): Array<{ label: string; value: string }> =>
  value ? [{ label, value: plain(value) }] : [];

/**
 * The typed error as a payload.
 *
 * `code` is whatever the CLI branched on, verbatim, so the page carries the
 * same handle an agent would have got from an exit path — never a
 * re-description of it.
 */
export function buildCommandErrorData(error: any, ctx: ErrorContext = {}): CommandErrorData {
  if (!(error instanceof CapyError)) {
    return {
      code: 'UNKNOWN',
      title: 'An unexpected error occurred',
      ...(error?.message ? { detail: plain(String(error.message)) } : {}),
    };
  }

  const base = { code: error.code };
  const detail = plain(error.details?.detail || error.message || '');

  switch (error.code) {
    case ERROR_CODES.AUTH_FAILED:
      return {
        ...base,
        title: 'Authentication failed',
        detail,
        remedies: [
          { text: 'Sign in again', command: 'capy' },
          { text: 'Check your internet connection' },
          { text: 'Verify your account at https://capy.sc' },
          {
            text: 'If you own the org, decrypt offline with your seed phrase',
            command: 'capy decrypt',
          },
        ],
      };

    case ERROR_CODES.PERMISSION_DENIED: {
      if (isMembershipRevokedError(error)) {
        return {
          ...base,
          title: 'Access revoked',
          detail: 'You are no longer a member of this organization.',
          remedies: [{ text: 'Ask an org admin to re-invite you' }],
        };
      }
      // The wrong-key case, chosen on the typed code — including one carried
      // through as a `cause`, which is how a decrypt failure arrives wrapped.
      const wrongKey =
        error.details?.cause?.code === ERROR_CODES.DECRYPT_KEY_MISMATCH;
      if (wrongKey) return decryptKeyMismatch(error);
      return {
        ...base,
        title: 'Permission denied',
        detail: ctx.branch
          ? `You do not have access to this branch (${plain(ctx.branch)}).`
          : 'You do not have access to these secrets.',
        context: fact('Branch', ctx.branch),
        remedies: [
          { text: 'Ask your project admin for access' },
          {
            text: 'Already set up on another machine? Copy a redeem code across',
            command: 'capy transport',
          },
          {
            text: 'No other machine and no browser here? Pair this one with a code entered elsewhere',
            command: 'capy pair',
          },
          { text: 'Or have a teammate send you an invite' },
        ],
      };
    }

    case ERROR_CODES.DECRYPT_KEY_MISMATCH:
      return decryptKeyMismatch(error);

    case ERROR_CODES.NETWORK_ERROR:
      return {
        ...base,
        title: 'Connection failed',
        detail: 'Could not reach the Capy service.',
        remedies: [
          { text: 'Check your internet connection' },
          { text: 'Check the service is running (capy-dev: http://localhost:3000)' },
          {
            text: 'If you own the org, decrypt offline with your seed phrase',
            command: 'capy decrypt',
          },
        ],
      };

    case ERROR_CODES.PROJECT_NOT_FOUND:
      return {
        ...base,
        title: 'Project not found',
        detail: ctx.projectName
          ? `Project "${plain(ctx.projectName)}" does not exist on the server.`
          : 'This project does not exist on the server.',
        context: [...fact('Project', ctx.projectName), ...fact('ID', ctx.projectId)],
        causes: [
          'The database was reset',
          'The project was deleted',
          'The keep.lock file is from a different environment',
        ],
        remedies: [
          { text: 'Delete keep.lock and .capy/, then re-initialize', command: 'capy' },
          { text: 'Or run capy — it will offer to recreate the project', command: 'capy' },
        ],
      };

    case ERROR_CODES.BRANCH_NOT_FOUND:
      return {
        ...base,
        title: 'Branch not found',
        detail,
        context: fact('Project', ctx.projectName),
        remedies: [{ text: 'See the branches you can reach', command: 'capy branch' }],
      };

    case ERROR_CODES.INVALID_FORMAT:
      return {
        ...base,
        title: 'Invalid file format',
        detail,
        remedies: [
          {
            text: 'Delete keep.lock and .capy/, then re-initialize',
            command: 'capy',
          },
        ],
      };

    case ERROR_CODES.NO_KEEP_FILE:
      return {
        ...base,
        title: 'No keep.lock file found',
        detail: 'This project has not been initialized with Capy yet.',
        remedies: [{ text: 'Initialize this directory', command: 'capy' }],
      };

    // The local-state refusals, in the same order and the same words as
    // `errorScreen.ts` tells them. These are the ones an agent is most likely
    // to hit first — a wrong variable name, a directory that was never
    // initialised — so `context` carries the branch and the names that WOULD
    // have worked, which is the difference between a page that ends the run
    // and one that lets the caller correct itself and try again.
    case ERROR_CODES.NO_ACTIVE_BRANCH:
      return {
        ...base,
        title: 'No active branch',
        detail: 'Nothing here records which branch this directory is on.',
        remedies: [{ text: 'Select a branch', command: 'capy' }],
      };

    case ERROR_CODES.NO_MANAGED_KEYS:
      return {
        ...base,
        title: 'No managed keys to rotate on this branch',
        detail:
          'Rotation goes through the provider, so a variable has to be linked to one first.',
        context: fact('Branch', error.details?.branch ?? ctx.branch),
        remedies: [
          { text: 'Link a variable to a provider', command: 'capy connect <provider>' },
          { text: 'Or set up an existing variable', command: 'capy rotate' },
        ],
      };

    case ERROR_CODES.NO_VARIABLES:
      return {
        ...base,
        title: 'No variables on this branch yet',
        context: fact('Branch', error.details?.branch ?? ctx.branch),
        remedies: [
          { text: 'Add one to .env, then sync', command: 'capy' },
          { text: 'Or pull one from a provider', command: 'capy connect <provider>' },
        ],
      };

    case ERROR_CODES.VARIABLE_NOT_FOUND: {
      const variable = error.details?.variable;
      const branch = error.details?.branch ?? ctx.branch;
      const available: string[] = error.details?.available ?? [];
      return {
        ...base,
        title: 'Variable not found',
        detail: `${plain(String(variable))} is not in your environment on branch ${plain(
          String(branch),
        )}.`,
        context: [
          ...fact('Variable', variable),
          ...fact('Branch', branch),
          // The names that would have worked. A page that says "not found"
          // and stops makes the caller guess; this one is the answer.
          ...fact('Available', available.join(', ')),
        ],
        remedies: [
          { text: 'Add it to .env, then sync', command: 'capy' },
          ...(available.length > 0 ? [{ text: 'Or use one of the names above' }] : []),
        ],
      };
    }

    case ERROR_CODES.NO_CONNECTORS:
      return {
        ...base,
        title: 'No connectors are registered',
        detail: 'This build has no third-party integration to promote a variable to.',
      };

    case ERROR_CODES.DEV_LIVE_FIREWALL: {
      // Told apart on the structured flag, never on the sentence.
      const nothingLeft = error.details?.nothingLeft === true;
      const variables: string[] = error.details?.variables ?? [];
      return {
        ...base,
        title: nothingLeft ? 'Nothing to rotate' : 'Live mode is not allowed in capy-dev',
        detail: nothingLeft
          ? 'All managed keys on this branch are live-mode.'
          : `${plain(String(variables[0]))} is configured for live mode.`,
        context: variables.length > 0 ? [{ label: 'Live keys', value: plain(variables.join(', ')) }] : [],
        causes: ['capy-dev never touches a live credential'],
        remedies: [{ text: 'Rotate with the production binary', command: 'capy rotate' }],
      };
    }

    case ERROR_CODES.QUOTA_EXCEEDED:
      return quotaExceeded(error, detail);

    default:
      return {
        ...base,
        title: error.details?.status
          ? `Service error (${error.details.status})`
          : 'Something went wrong',
        detail,
        context: [...fact('Project', ctx.projectName), ...fact('Branch', ctx.branch)],
      };
  }
}

function decryptKeyMismatch(error: CapyError): CommandErrorData {
  return {
    code: ERROR_CODES.DECRYPT_KEY_MISMATCH,
    title: 'Cannot decrypt secrets',
    detail: "These secrets were encrypted with a different project's key.",
    context: fact('Variable', error.details?.variable),
    causes: [
      'The project was re-initialized to a different org',
      'The keep.lock/.capy files were reset without clearing .env',
    ],
    remedies: [
      { text: 'Delete .env and pull fresh secrets', command: 'capy' },
      { text: 'Or restore .env from your .env.pre-capy.old backup' },
    ],
  };
}

function quotaExceeded(error: CapyError, detail: string): CommandErrorData {
  const kind = error.details?.kind;
  const limit = error.details?.limit;

  // The one-org-per-account cap is a rule, not a paywall, and an upgrade link
  // under it would be an offer that cannot be taken.
  if (kind === 'organization') {
    return {
      code: ERROR_CODES.QUOTA_EXCEEDED,
      title: 'Organization limit reached',
      detail: detail || 'Each Capy account can own one organization.',
      remedies: [
        { text: 'To work in another org, ask its owner to invite you', command: 'capy invite' },
      ],
    };
  }

  const noun = kind === 'project' ? 'Project' : 'Member';
  const upgrade =
    kind === 'project'
      ? 'Upgrade to Capy Business for unlimited projects'
      : 'Upgrade to Capy Business to invite more members';
  return {
    code: ERROR_CODES.QUOTA_EXCEEDED,
    title: limit ? `${noun} limit reached (${limit}/org)` : `${noun} limit reached`,
    detail,
    context: limit ? [{ label: 'Limit', value: `${limit} per organization` }] : [],
    remedies: [
      { text: upgrade },
      {
        text:
          kind === 'project'
            ? 'Or remove a project you no longer use'
            : 'Or remove a member you no longer need',
      },
    ],
  };
}

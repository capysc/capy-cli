/**
 * `capy kick <email>`: remove a teammate from the organization.
 *
 * In a terminal it asks "Remove ... ?" and removes on yes. Without a terminal (`--json`, `--non-tty`, or stdin that is
 * not a terminal) nobody can answer, so without `--yes` it removes nothing and refuses with CONFIRMATION_REQUIRED
 * (exit 3) and a `confirm` elicitation (`ui/elicitation.ts`) whose question is the terminal's, word for word, and whose
 * `answer.yes` is the command to run on a yes. With `--yes` it removes the member and answers in JSON. Every refusal
 * is coded; JSON goes to stdout. No secret is ever printed: an email, an organization and ids only.
 *
 * The terminal path is the original one. `execute(email)` with no options is that path.
 */
import { resolveOrgContext } from '../core/orgContext';
import type { ServiceClient } from '../service/serviceClient';
import { CapyError, ERROR_CODES } from '../types/index';
import { isInteractive, EXIT_NEEDS_INPUT } from '../ui/interactive';
import type { ElicitationConfirm } from '../ui/elicitation';
import { kickMemberDisplay } from '../ui/elicitationDisplay';
import { refuse, settle } from './refusal';

/** What `capy kick` was given besides the email. */
export interface KickOptions {
  /** `--yes`: remove without asking. */
  readonly yes?: boolean;
  /** `--json`: answer in JSON; nobody is asked. */
  readonly json?: boolean;
  /** `--non-tty`: treat stdin as not a terminal; it means the same as `--json`. */
  readonly nonTty?: boolean;
}

interface Member {
  readonly membershipId: string;
  readonly email: string;
}

/** The member whose email is `email`, ignoring case. */
function memberWithEmail<T extends Member>(members: readonly T[], email: string): T | undefined {
  return members.find((m) => m.email.toLowerCase() === email.toLowerCase());
}

/** The membership id for `email`, or exits 1 when there is none or the list cannot be read. */
async function findMembershipId(serviceClient: ServiceClient, orgId: string, email: string): Promise<string> {
  try {
    const { members } = await serviceClient.listMemberDetails(orgId);
    const match = memberWithEmail(members, email);
    if (!match) {
      console.error(`No member found matching "${email}".`);
      process.exit(1);
    }
    return match.membershipId;
  } catch (err: any) {
    console.error(`Failed to list members: ${err.message}`);
    process.exit(1);
  }
}

/** The question, as the terminal asks it and as the elicitation asks it. */
const confirmQuestion = (email: string): string => `Remove ${email} from this organization? They will lose access to all secrets.`;

/** An email as one shell word: as typed when it is plain, else in single quotes. */
function shellWord(text: string): string {
  return /^[A-Za-z0-9._%+@-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

type AgentOutcome =
  | { readonly kind: 'needs-confirmation'; readonly elicitation: ElicitationConfirm }
  | { readonly kind: 'removed'; readonly email: string; readonly org: { readonly id: string; readonly name: string } };

export class KickCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(email: string, options?: KickOptions): Promise<void> {
    const agentMode = options !== undefined && (options.json === true || options.nonTty === true || !isInteractive(options.nonTty));
    if (agentMode) return this.executeForAgent(email, options.yes === true);
    return this.executeInTerminal(email, options?.yes === true);
  }

  private async executeInTerminal(email: string, skipConfirm: boolean): Promise<void> {
    const { orgId, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);

    // Find the membership by email
    const membershipId = await findMembershipId(serviceClient, orgId, email);

    if (!skipConfirm) {
      const inquirer = (await import('inquirer')).default;
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: confirmQuestion(email),
        default: false,
      }]);

      if (!confirm) {
        console.log('Cancelled.');
        return;
      }
    }

    try {
      await serviceClient.kickMember(orgId, membershipId);
    } catch (err: any) {
      console.error(`Failed to remove member: ${err.message}`);
      process.exit(1);
    }

    console.log('');
    console.log(`  \x1b[33m${email}\x1b[0m has been removed from the organization.`);
    console.log(`  \x1b[90mMembership ${membershipId} deleted.\x1b[0m`);
    console.log('  \x1b[90mThey can no longer co-decrypt secrets.\x1b[0m');
    console.log('');
  }

  /** Nobody to ask: removes only with `--yes`; otherwise hands the question to the agent. Every failure is a coded refusal. */
  private async executeForAgent(email: string, yes: boolean): Promise<void> {
    const settled = await settle(() => this.agentFlow(email, yes));
    if (!settled.ok) {
      const { refusalFor } = await import('./projectLifecycleCommand');
      return refuse(true, refusalFor(settled.error));
    }
    const outcome = settled.value;
    if (outcome.kind === 'needs-confirmation') {
      return refuse(true, {
        code: ERROR_CODES.CONFIRMATION_REQUIRED,
        message: '`capy kick` needs confirmation. Pass --yes, or run it in a terminal.', // COPY-FLAG
        exitCode: EXIT_NEEDS_INPUT,
        extra: { elicitation: outcome.elicitation },
      });
    }
    console.log(JSON.stringify({ ok: true, removed: true, email: outcome.email, org: outcome.org }, null, 2));
  }

  private async agentFlow(email: string, yes: boolean): Promise<AgentOutcome> {
    // Agent mode never opens a prompt, not even to pick an organization.
    const { orgId, orgName, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode, { promptForOrg: false, agentMode: true });
    const org = { id: orgId, name: orgName };
    const { members } = await serviceClient.listMemberDetails(orgId);
    const match = memberWithEmail(members, email);
    if (match === undefined) throw new CapyError(`No member found matching "${email}".`, ERROR_CODES.MEMBER_NOT_FOUND);

    if (!yes) {
      return {
        kind: 'needs-confirmation',
        elicitation: {
          kind: 'confirm',
          question: confirmQuestion(email), // the terminal question, word for word
          details: { org, member: { email: match.email } },
          display: kickMemberDisplay({ org, email: match.email }),
          answer: { yes: `capy kick ${shellWord(email)} --yes --json` },
        },
      };
    }
    await serviceClient.kickMember(orgId, match.membershipId);
    return { kind: 'removed', email: match.email, org };
  }
}

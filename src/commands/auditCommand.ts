import type { Command } from 'commander';
import inquirer from 'inquirer';
import { AuthService, silentAuthFailureMessage } from '../auth/authService';
import { ProjectManager } from '../core/projectManager';
import { assertNotLocalOnly } from '../core/localGate';
import { resolveActiveUrl } from '../config/profileConfig';
import { CapyError, ERROR_CODES } from '../types';
import { AUDIT_FILTERS, AUDIT_SORTS, AuditSearch, createAuditClient } from '../service/auditClient';
import { auditText, runAuditTui } from '../ui/auditTui';

interface AuditOptions extends Readonly<Partial<Record<typeof AUDIT_FILTERS[number], string>>> {
  readonly org?: string;
  readonly json?: boolean;
  readonly sort?: string;
  readonly order?: string;
  readonly limit?: string;
  readonly cursor?: string;
}

export function auditSearchOptions(options: AuditOptions): AuditSearch {
  const sort = options.sort ?? 'occurred_at';
  const order = options.order ?? 'desc';
  const limit = Number(options.limit ?? '50');
  if (!(AUDIT_SORTS as readonly string[]).includes(sort)) throw new Error(`Invalid sort: ${sort}`);
  if (order !== 'asc' && order !== 'desc') throw new Error('Order must be asc or desc.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Limit must be between 1 and 200.');
  return {
    ...Object.fromEntries(AUDIT_FILTERS.flatMap(key => options[key] ? [[key, options[key]]] : [])),
    sort: sort as AuditSearch['sort'], order, limit, cursor: options.cursor,
  };
}

export async function auditCommand(options: AuditOptions, devMode = false): Promise<void> {
  assertNotLocalOnly('audit');
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const terminalPageSize = Math.min(200, Math.max(3, (process.stdout.rows ?? 24) - 12));
  const search = auditSearchOptions({ ...options, limit: options.limit ?? String(options.json ? 50 : terminalPageSize) });
  if (!options.json && !interactive) throw new Error('Use --json to search audit logs without a terminal.');
  const project = await new ProjectManager().detectProjectState();
  const auth = new AuthService(undefined, devMode, project.userId);
  const requestedOrg = options.org ?? project.organizationId;
  const silent = await auth.authenticateSilent(requestedOrg);
  const session = silent.success || !interactive || options.json ? silent : await auth.authenticate(requestedOrg);
  if (!session.success) throw new CapyError(silentAuthFailureMessage(session), ERROR_CODES.AUTH_FAILED);
  const orgId = requestedOrg || session.organization_id || (interactive && !options.json
    ? (await inquirer.prompt<{ org: string }>([{
      type: 'list', name: 'org', message: 'Organization',
      choices: (session.organizations ?? []).map(org => ({ name: auditText(org.name), value: org.id })),
    }])).org : undefined);
  if (!orgId) throw new Error('Choose an organization with --org <id>.');
  const scoped = session.organization_id === orgId ? session : await auth.authenticateSilent(orgId);
  if (!scoped.success || scoped.organization_id !== orgId) {
    throw new CapyError(scoped.success ? 'Could not authenticate for the requested organization.' : silentAuthFailureMessage(scoped), ERROR_CODES.PERMISSION_DENIED);
  }
  const query = createAuditClient(orgId, () => auth.getValidToken(), resolveActiveUrl(devMode));
  if (options.json) {
    console.log(JSON.stringify(await query(search), null, 2));
    return;
  }
  // The first server query checks current admin membership before showing any records.
  await runAuditTui(scoped.organization_name ?? orgId, query, search);
}

export function registerAuditCommand(program: Command, devMode = false): void {
  const command = program.command('audit')
    .description('Search organization audit logs in a TUI (owner/admin only)')
    .option('--org <id>', 'organization ID (defaults to this project or session)')
    .option('--json', 'return one page as JSON without opening the TUI')
    .option('--sort <field>', `sort by ${AUDIT_SORTS.join(', ')}`, 'occurred_at')
    .option('--order <direction>', 'asc or desc', 'desc')
    .option('--limit <count>', 'events per page (1–200; defaults to terminal height or 50 for JSON)')
    .option('--cursor <cursor>', 'continue the same search with next_cursor');
  for (const field of AUDIT_FILTERS) {
    command.option(`--${field.replace(/_/g, '-')} <text>`, `search ${field.replace(/_/g, ' ')} (case-insensitive contains)`);
  }
  command.action(async (options: Readonly<Record<string, string | boolean>>) => {
    const searchFields = Object.fromEntries(AUDIT_FILTERS.map(field => [field, options[field.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())]]));
    await auditCommand({ ...options, ...searchFields } as AuditOptions, devMode);
  });
}

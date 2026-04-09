import { AuthService } from '../auth/authService';
import { ProjectManager } from '../core/projectManager';

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class InfoCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(): Promise<void> {
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();

    if (!projectState.initialized || !projectState.organizationId) {
      console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
      process.exit(1);
    }

    const orgId = projectState.organizationId;

    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
    const authResult = await authService.authenticate(orgId);
    if (!authResult.success) {
      console.error('Authentication failed');
      process.exit(1);
    }

    const org = authResult.organizations?.find(o => o.id === orgId);
    const orgName = authResult.organization_name || org?.name;
    const workosOrgId = org?.workos_org_id;
    const branch = projectState.activeBranch || 'default';

    const rows: [string, string][] = [
      ['User', authResult.user_email || '—'],
      ['User ID', authResult.user_id || '—'],
      ['Organization', orgName || '—'],
      ['Org ID', orgId],
      ['WorkOS Org ID', workosOrgId || '—'],
      ['Project', projectState.projectName || '—'],
      ['Project ID', projectState.projectId || '—'],
      ['Branch', branch],
    ];

    const labelWidth = Math.max(...rows.map(([label]) => label.length));

    console.log('');
    console.log(`  ${GREEN}Session Info${RESET}`);
    console.log('  ' + '─'.repeat(labelWidth + 3 + Math.max(...rows.map(([, v]) => v.length))));
    for (const [label, value] of rows) {
      console.log(`  ${DIM}${label.padEnd(labelWidth)}${RESET}   ${value}`);
    }
    console.log('');
  }
}

import { AuthService } from '../auth/authService';
import { ProjectManager } from '../core/projectManager';
import { ServiceClient } from '../service/serviceClient';

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  'project-admin': 'Project Admin',
  member: 'Member',
};

export class InfoCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(opts: { json?: boolean } = {}): Promise<void> {
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    const hasKeep = projectState.initialized && !!projectState.organizationId;

    // keep.lock pins one specific org+project, but `capy info` is also useful
    // outside any project — to see which user is signed in, what orgs they
    // belong to, etc. Fall through to a session-only view when there's no
    // keep.lock instead of forcing the user to init a project first.
    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
    let authResult = await authService.authenticateSilent(projectState.organizationId);
    if (!authResult.success) authResult = await authService.authenticateSilent();
    if (!authResult.success && hasKeep) {
      authResult = await authService.authenticate(projectState.organizationId!);
    }
    if (!authResult.success) {
      console.error(`Not signed in. Run ${B('capy')} to authenticate.`);
      process.exit(1);
    }

    // The "active org" for this directory. From keep.lock when present,
    // else the session's currently-scoped org (which is just whichever org
    // authenticateSilent happened to pick first — historically misleading
    // when the user has memberships in multiple orgs, hence the explicit
    // membership list below).
    const activeOrgId = projectState.organizationId || authResult.organization_id;
    const allOrgs = authResult.organizations || [];
    const activeOrg = activeOrgId ? allOrgs.find(o => o.id === activeOrgId) : undefined;
    const activeOrgName = (activeOrgId ? authResult.organization_name : undefined) || activeOrg?.name;
    const workosOrgId = activeOrg?.workos_org_id;
    const branch = projectState.activeBranch;

    // Resolve the user's role in the active org (best effort).
    let roleLabel = '—';
    let roleSlug: string | null = null;
    if (activeOrgId && authService.getToken() && authResult.user_id) {
      try {
        const serviceClient = new ServiceClient(this.apiUrl, this.devMode);
        serviceClient.setTokenProvider(() => authService.getValidToken());
        const { members } = await serviceClient.listMembers(activeOrgId);
        const me = members.find((m: any) => m.userId === authResult.user_id);
        const slug = me?.role?.slug;
        if (slug) {
          roleLabel = ROLE_LABELS[slug] || slug;
          roleSlug = slug;
        }
      } catch {
        // leave as —
      }
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            user: { email: authResult.user_email ?? null, userId: authResult.user_id ?? null },
            org: { id: activeOrgId ?? null, name: activeOrgName ?? null, workosOrgId: workosOrgId ?? null, fromKeepLock: hasKeep },
            role: roleSlug,
            project: { name: projectState.projectName ?? null, id: projectState.projectId ?? null },
            branch: hasKeep ? branch : null,
            memberships: allOrgs.map((o) => ({ id: o.id, name: o.name ?? null, workosOrgId: o.workos_org_id ?? null })),
          },
          null,
          2,
        ),
      );
      return;
    }

    const activeOrgLabel = hasKeep
      ? `${activeOrgName || '—'} ${DIM}(from keep.lock)${RESET}`
      : activeOrgId
        ? `${activeOrgName || '—'} ${DIM}(session default — not pinned by keep.lock)${RESET}`
        : `${YELLOW}none${RESET} ${DIM}(no keep.lock and no scoped session)${RESET}`;

    const rows: [string, string][] = [
      ['User', authResult.user_email || '—'],
      ['User ID', authResult.user_id || '—'],
      ['Active Org', activeOrgLabel],
      ['Org ID', activeOrgId || '—'],
      ['WorkOS Org ID', workosOrgId || '—'],
      ['Role', roleLabel],
      ['Project', projectState.projectName || '—'],
      ['Project ID', projectState.projectId || '—'],
      ['Branch', (hasKeep && branch) || '—'],
    ];

    const labelWidth = Math.max(...rows.map(([label]) => label.length));

    console.log('');
    console.log(`  ${GREEN}Session Info${RESET}`);
    console.log('  ' + '─'.repeat(labelWidth + 3 + 40));
    for (const [label, value] of rows) {
      console.log(`  ${DIM}${label.padEnd(labelWidth)}${RESET}   ${value}`);
    }

    // Memberships block — surface the full list so the "always shows the
    // same org" surprise is impossible. The active row is marked.
    if (allOrgs.length > 0) {
      console.log('');
      console.log(`  ${GREEN}Memberships${RESET} ${DIM}(${allOrgs.length})${RESET}`);
      const nameWidth = Math.max(...allOrgs.map(o => (o.name || '').length));
      for (const o of allOrgs) {
        const marker = o.id === activeOrgId ? `${GREEN}●${RESET}` : ' ';
        const name = (o.name || '—').padEnd(nameWidth);
        console.log(`  ${marker} ${B(name)}   ${DIM}${o.id}${RESET}   ${DIM}${o.workos_org_id || ''}${RESET}`);
      }
    }
    console.log('');
  }
}

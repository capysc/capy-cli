import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class KickCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(email: string): Promise<void> {
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();

    if (!projectState.initialized || !projectState.organizationId) {
      console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
      process.exit(1);
    }

    const orgId = projectState.organizationId;

    // Authenticate
    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
    const serviceClient = new ServiceClient(this.apiUrl);
    serviceClient.setTokenRefresher(async () => {
      const refreshed = await authService.refreshToken();
      return refreshed ? authService.getToken() : null;
    });
    const authResult = await authService.authenticate(orgId);
    if (!authResult.success) {
      console.error('Authentication failed');
      process.exit(1);
    }
    const token = authService.getToken();
    if (token) serviceClient.setToken(token);

    // Find the membership by email
    let membershipId: string;
    try {
      const { members } = await serviceClient.listMemberDetails(orgId);
      const match = members.find(m =>
        m.email.toLowerCase() === email.toLowerCase()
      );
      if (!match) {
        console.error(`No member found matching "${email}".`);
        process.exit(1);
      }
      membershipId = match.membershipId;
    } catch (err: any) {
      console.error(`Failed to list members: ${err.message}`);
      process.exit(1);
    }

    // Confirm
    const inquirer = (await import('inquirer')).default;
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Remove ${email} from this organization? They will lose access to all secrets.`,
      default: false,
    }]);

    if (!confirm) {
      console.log('Cancelled.');
      return;
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
}

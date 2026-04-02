import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { InteractiveTable } from '../ui/interactiveTable';
import { Spinner } from '../ui/spinner';

export class UsersCommand {
  private apiUrl?: string;

  constructor(apiUrl?: string) {
    this.apiUrl = apiUrl;
  }

  async execute(): Promise<void> {
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();

    if (!projectState.initialized || !projectState.organizationId) {
      console.error('No .keep file found. Run capy first to initialize.');
      process.exit(1);
    }

    const orgId = projectState.organizationId;

    // Authenticate
    const authService = new AuthService(this.apiUrl);
    const serviceClient = new ServiceClient(this.apiUrl);
    const authResult = await authService.authenticate(orgId);
    if (!authResult.success) {
      console.error('Authentication failed');
      process.exit(1);
    }
    const token = authService.getToken();
    if (token) serviceClient.setToken(token);

    // Fetch member details
    const spinner = new Spinner('Loading members...');
    spinner.start();
    let members;
    try {
      const result = await serviceClient.listMemberDetails(orgId);
      members = result.members;
      spinner.succeed(`${members.length} member${members.length !== 1 ? 's' : ''}`);
    } catch (err: any) {
      spinner.fail('Failed to load members');
      console.error(`  ${err.message}`);
      process.exit(1);
    }

    if (members.length === 0) {
      console.log('\n  No members found.\n');
      return;
    }

    // Launch TUI or static fallback
    const table = new InteractiveTable();
    if (process.stdin.isTTY) {
      await table.run(members);
    } else {
      console.log(table.renderStatic(members));
    }
  }
}

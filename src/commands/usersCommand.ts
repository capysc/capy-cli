import inquirer from 'inquirer';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { InteractiveTable } from '../ui/interactiveTable';
import { Spinner } from '../ui/spinner';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class UsersCommand {
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

    // Authenticate
    const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
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
      await table.run(members, {
        changeRole: async (userId, newRole, projectId) => {
          await serviceClient.changeRole(orgId, userId, newRole, projectId);
        },
        pickProject: async (prompt: string) => {
          const projects = await serviceClient.listProjects();
          if (projects.length === 0) return null;
          const { chosen } = await inquirer.prompt([{
            type: 'list',
            name: 'chosen',
            message: prompt,
            choices: projects.map((p) => ({ name: p.name, value: p.id })),
          }]);
          return chosen;
        },
        reload: async () => {
          const result = await serviceClient.listMemberDetails(orgId);
          return result.members;
        },
      });
    } else {
      console.log(table.renderStatic(members));
    }
  }
}

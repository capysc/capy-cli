import { resolveOrgContext } from '../core/orgContext';
import { InteractiveTable } from '../ui/interactiveTable';
import { Spinner } from '../ui/spinner';

export class UsersCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(): Promise<void> {
    const { orgId, serviceClient } = await resolveOrgContext(this.apiUrl, this.devMode);

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

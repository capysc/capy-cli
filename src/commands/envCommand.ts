import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { existsSync, writeFileSync } from 'fs';
import inquirer from 'inquirer';
import {
  Environment,
  ENVIRONMENTS,
} from '../types/index';

export class EnvCommand {
  private projectManager: ProjectManager;
  private fileManager: FileManager;

  constructor() {
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
  }

  async execute(targetEnv?: string): Promise<void> {
    try {
      await this._execute(targetEnv);
    } catch (error: any) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }

  private async _execute(targetEnv?: string): Promise<void> {
    const projectState = await this.projectManager.detectProjectState();
    if (!projectState.initialized) {
      console.error('No keep.lock file found. Run capy first to initialize.');
      process.exit(1);
    }

    const currentEnv = projectState.activeEnvironment || 'local';

    let selectedEnv: Environment;
    if (targetEnv && ENVIRONMENTS.includes(targetEnv as Environment)) {
      selectedEnv = targetEnv as Environment;
    } else {
      // Show current environment and prompt to switch
      console.log(`\n  Current environment: \x1b[1m${currentEnv}\x1b[0m\n`);

      const choices = ENVIRONMENTS.map(env => ({
        name: env === currentEnv ? `${env}  \x1b[38;5;43m← current\x1b[0m` : env,
        value: env,
      }));

      const { selected } = await inquirer.prompt([{
        type: 'list',
        name: 'selected',
        message: 'Switch environment:',
        choices,
        default: currentEnv,
      }]);

      selectedEnv = selected;
    }

    if (selectedEnv === currentEnv) {
      console.log(`Already on ${currentEnv}`);
      return;
    }

    // Set the environment pointer
    this.projectManager.writeActiveEnvironment(selectedEnv);

    // Bootstrap the env file if it doesn't exist
    const envFilePath = this.fileManager.getEnvPathForEnvironment(selectedEnv);
    if (!existsSync(envFilePath)) {
      writeFileSync(envFilePath, '', 'utf-8');
      console.log(`Created ${envFilePath === '.env' ? '.env' : `.env.${selectedEnv}`}`);
    }

    // Check for missing variables
    const keep = this.projectManager.readKeepFile();
    if (keep) {
      const allVars = Object.keys(keep.variables);
      const envVars = allVars.filter(v => keep.variables[v][selectedEnv]);
      const missing = allVars.length - envVars.length;

      if (missing > 0) {
        console.log(`\x1b[31m${missing} variable(s) have no value set for ${selectedEnv}\x1b[0m`);
      }
    }

    console.log(`\nSwitched to ${selectedEnv}`);
    console.log(`\x1b[90mRun \x1b[0mcapy\x1b[90m to sync secrets for this environment.\x1b[0m`);
  }
}

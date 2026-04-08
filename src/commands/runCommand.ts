import { spawn } from 'child_process';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import {
  CapyError,
  ERROR_CODES,
  Environment,
} from '../types/index';
import { resolveProjectKey } from '../crypto/keyResolver';

export class RunCommand {
  private projectManager: ProjectManager;
  private fileManager: FileManager;

  constructor() {
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
  }

  async execute(command: string[]): Promise<void> {
    if (command.length === 0) {
      console.error('Usage: capy run <command> [args...]');
      process.exit(1);
    }

    try {
      await this._execute(command);
    } catch (error: any) {
      if (error instanceof CapyError) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  }

  private async _execute(command: string[]): Promise<void> {
    const projectState = await this.projectManager.detectProjectState();
    if (!projectState.initialized) {
      console.error('No keep.lock file found. Run capy first to initialize.');
      process.exit(1);
    }

    // Read active environment (default: local)
    const activeEnvironment: Environment = projectState.activeEnvironment || 'local';

    // Read the corresponding .env file
    const envFilePath = this.fileManager.getEnvPathForEnvironment(activeEnvironment);
    const rawEnv = this.fileManager.readEnvFile(envFilePath);

    if (Object.keys(rawEnv).length === 0) {
      console.error(`No variables in ${envFilePath}. Run capy to sync first.`);
      process.exit(1);
    }

    // Resolve decryption key
    const encryptionKey = resolveProjectKey(
      projectState.organizationId!,
      projectState.projectId!,
      projectState.userId!,
    );

    // Decrypt all capy: prefixed values
    const decrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawEnv)) {
      if (value.startsWith('capy:')) {
        decrypted[key] = this.fileManager.decryptValue(value, encryptionKey);
      } else {
        decrypted[key] = value;
      }
    }

    // Spawn the child command with decrypted values in its environment
    const childEnv = { ...process.env, ...decrypted };
    const [cmd, ...args] = command;

    const child = spawn(cmd, args, {
      env: childEnv,
      stdio: 'inherit',
      shell: true,
    });

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });

    child.on('error', (err) => {
      console.error(`Failed to start ${cmd}: ${err.message}`);
      process.exit(1);
    });
  }
}

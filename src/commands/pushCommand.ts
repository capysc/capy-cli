import ora from '../ui/spinner';
import { ProjectManager } from '../core/projectManager';
import { FileManager } from '../files/fileManager';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { SyncEngine } from '../sync/syncEngine';
import { createHash } from 'crypto';
import {
  CapyError,
  ERROR_CODES,
  Environment,
  ENVIRONMENTS,
} from '../types/index';
import { resolveProjectKey } from '../crypto/keyResolver';
import { deriveResourceIdV4 } from '../crypto/resourceId';

export class PushCommand {
  private projectManager: ProjectManager;
  private fileManager: FileManager;
  private authService: AuthService;
  private serviceClient: ServiceClient;
  private devMode: boolean;

  constructor(devMode: boolean = false) {
    this.devMode = devMode;
    this.projectManager = new ProjectManager();
    this.fileManager = new FileManager();
    this.authService = new AuthService(undefined, devMode);
    this.serviceClient = new ServiceClient(undefined, devMode);

    this.serviceClient.setTokenRefresher(async () => {
      const refreshed = await this.authService.refreshToken();
      if (refreshed) {
        return this.authService.getToken();
      }
      return null;
    });
  }

  async execute(): Promise<void> {
    try {
      await this._execute();
    } catch (error: any) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }

  private async _execute(): Promise<void> {
    const projectState = await this.projectManager.detectProjectState();
    if (!projectState.initialized) {
      console.error('No keep.lock file found. Run capy first to initialize.');
      process.exit(1);
    }

    if (projectState.userId) {
      this.authService.setSessionUserId(projectState.userId);
    }

    // Authenticate
    const spinner = ora('Authenticating...').start();
    const authResult = await this.authService.authenticate(projectState.organizationId);
    if (!authResult.success) {
      spinner.fail('Authentication failed');
      throw new CapyError(authResult.error || 'Authentication failed', ERROR_CODES.AUTH_FAILED);
    }

    const token = this.authService.getToken();
    if (token) this.serviceClient.setToken(token);
    spinner.stop();

    const encryptionKey = resolveProjectKey(
      projectState.organizationId!,
      projectState.projectId!,
      authResult.user_id!,
    );

    // Read keep.lock
    const keep = this.projectManager.readKeepFile();
    if (!keep) {
      console.error('No keep.lock file found.');
      process.exit(1);
    }

    // Read and encrypt all environment files
    const pushSpinner = ora('Pushing secrets to S3...').start();
    const environmentBlobs: Partial<Record<Environment, string>> = {};

    for (const env of ENVIRONMENTS) {
      const envFilePath = this.fileManager.getEnvPathForEnvironment(env);
      try {
        const rawLocal = this.fileManager.readEnvFile(envFilePath);
        if (Object.keys(rawLocal).length === 0) continue;

        // Encrypt all values
        const encrypted: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawLocal)) {
          if (value.startsWith('capy:')) {
            encrypted[key] = value; // Already encrypted
          } else {
            const { Encryptor } = await import('../crypto/encryptor');
            const enc = Encryptor.encrypt(value, encryptionKey);
            const resourceId = deriveResourceIdV4(key);
            encrypted[key] = `capy:${resourceId}:${enc}`;
          }
        }

        const blob = Object.entries(encrypted)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n');

        environmentBlobs[env] = blob;

        // Update keep.lock hashes for this environment
        for (const [key, value] of Object.entries(rawLocal)) {
          const plaintext = value.startsWith('capy:')
            ? this.fileManager.decryptValue(value, encryptionKey)
            : value;
          const valueHash = createHash('sha256').update(plaintext).digest('hex').slice(0, 16);
          const resourceId = deriveResourceIdV4(key);

          if (!keep.variables[key]) {
            keep.variables[key] = { resource_id: resourceId };
          }
          keep.variables[key][env] = valueHash;
          keep.variables[key].resource_id = resourceId;
        }
      } catch {
        // Environment file doesn't exist or can't be read — skip
      }
    }

    if (Object.keys(environmentBlobs).length === 0) {
      pushSpinner.fail('No environment files to push');
      return;
    }

    // Push to S3
    const keepFileContent = JSON.stringify(keep);
    const result = await this.serviceClient.pushEnvironments(
      projectState.projectId!,
      keepFileContent,
      environmentBlobs,
    );

    // Update keep.lock with new state
    this.fileManager.writeKeepFile(keep);

    pushSpinner.succeed(
      `Pushed ${Object.keys(environmentBlobs).length} environment(s) to S3 (keep_hash: ${result.keep_hash.slice(0, 8)}...)`
    );
  }
}

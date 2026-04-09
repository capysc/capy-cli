import { execSync } from 'child_process';
import { AuthService } from '../auth/authService';
import { ServiceClient } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { resolveProjectKey } from '../crypto/keyResolver';
import {
  generateDeployId,
  generateDerivationToken,
  deployInnerWrap,
  deployInnerUnwrap,
  buildDeployCode,
  parseDeployCode,
} from '../crypto/deployCrypto';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

export class DeploySetupCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(): Promise<void> {
    try {
      const pm = new ProjectManager();
      const projectState = await pm.detectProjectState();

      if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
        console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
        process.exit(1);
      }

      const orgId = projectState.organizationId;
      const projectId = projectState.projectId;

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

      const userId = authResult.user_id!;

      // Resolve project key from keyring
      const pkHex = resolveProjectKey(orgId, projectId, userId);
      const pk = Buffer.from(pkHex, 'hex');

      // Generate deploy ID and derivation token
      const deployId = generateDeployId();
      const dt = generateDerivationToken();

      // Inner wrap PK with IK derived from DT
      const innerBlob = deployInnerWrap(pk, dt, projectId);

      // Service KMS-wraps the inner blob
      const { outer_blob: outerBlob } = await serviceClient.createDeployToken(
        orgId,
        deployId.toString('hex'),
        projectId,
        innerBlob,
      );

      // Build the deploy code
      const deployCode = buildDeployCode(deployId, dt, outerBlob);

      // Try to set GitHub secret via gh CLI
      let ghSet = false;
      try {
        execSync(`gh secret set CAPY_DEPLOY_CODE --body "${deployCode}"`, {
          stdio: 'pipe',
          timeout: 15000,
        });
        ghSet = true;
      } catch {
        // gh not available or not authenticated — fall through
      }

      console.log('');
      console.log('  Deploy token created');
      console.log(`  ID: ${deployId.toString('hex').slice(0, 12)}...`);
      console.log('');

      if (ghSet) {
        console.log('  \x1b[32m✓\x1b[0m CAPY_DEPLOY_CODE set as GitHub secret');
      } else {
        console.log('  Set this as CAPY_DEPLOY_CODE in your CI environment:');
        console.log('');
        console.log(`  ${deployCode}`);
      }

      console.log('');
      console.log('  Add this to your GitHub Actions workflow:');
      console.log('');
      console.log('    - name: Decrypt secrets');
      console.log(`      run: eval $(${B('capy')} deploy decrypt)`);
      console.log('      env:');
      console.log('        CAPY_DEPLOY_CODE: ${{ secrets.CAPY_DEPLOY_CODE }}');
      console.log('');
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }
}

export class DeployDecryptCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(): Promise<void> {
    const deployCode = process.env.CAPY_DEPLOY_CODE;
    if (!deployCode) {
      console.error('CAPY_DEPLOY_CODE environment variable is not set.');
      process.exit(1);
    }

    let parsed: ReturnType<typeof parseDeployCode>;
    try {
      parsed = parseDeployCode(deployCode);
    } catch (err: any) {
      console.error(`Invalid CAPY_DEPLOY_CODE: ${err.message}`);
      process.exit(1);
    }

    const { deployId, dt, outerBlob } = parsed;

    // Call service to KMS-unwrap (unauthenticated)
    const serviceClient = new ServiceClient(this.apiUrl);
    let innerBlob: string;
    try {
      const result = await serviceClient.deployDecrypt(
        deployId.toString('hex'),
        outerBlob,
      );
      innerBlob = result.plaintext;
    } catch (err: any) {
      console.error(`Deploy decrypt failed: ${err.message}`);
      process.exit(1);
    }

    // Read project ID from keep.lock or .env headers to use as HKDF salt
    const pm = new ProjectManager();
    const projectState = await pm.detectProjectState();
    const projectId = projectState.projectId;

    if (!projectId) {
      console.error('No keep.lock file found. Cannot determine project ID for key derivation.');
      process.exit(1);
    }

    // Unwrap inner layer: IK = HKDF(DT, salt=projectId, info="capy:deploy")
    let pk: Buffer;
    try {
      pk = deployInnerUnwrap(innerBlob, dt, projectId);
    } catch {
      console.error('Deploy token does not match this project.');
      process.exit(1);
    }

    // Output as shell export for eval
    const pkHex = pk.toString('hex');
    console.log(`export CAPY_KEY=${pkHex}`);
  }
}

export class DeployRevokeCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(deployIdPrefix: string): Promise<void> {
    try {
      const pm = new ProjectManager();
      const projectState = await pm.detectProjectState();

      if (!projectState.initialized || !projectState.organizationId) {
        console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
        process.exit(1);
      }

      const orgId = projectState.organizationId;

      const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
      const serviceClient = new ServiceClient(this.apiUrl);
      const authResult = await authService.authenticate(orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }
      const token = authService.getToken();
      if (token) serviceClient.setToken(token);

      await serviceClient.revokeDeployToken(deployIdPrefix);

      console.log(`  Deploy token ${deployIdPrefix.slice(0, 12)}... revoked.`);
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }
}

export class DeployListCommand {
  private apiUrl?: string;
  private devMode: boolean;

  constructor(apiUrl?: string, devMode: boolean = false) {
    this.apiUrl = apiUrl;
    this.devMode = devMode;
  }

  async execute(): Promise<void> {
    try {
      const pm = new ProjectManager();
      const projectState = await pm.detectProjectState();

      if (!projectState.initialized || !projectState.organizationId || !projectState.projectId) {
        console.error(`No keep.lock file found. Run ${B('capy')} first to initialize.`);
        process.exit(1);
      }

      const orgId = projectState.organizationId;
      const projectId = projectState.projectId;

      const authService = new AuthService(this.apiUrl, this.devMode, projectState.userId);
      const serviceClient = new ServiceClient(this.apiUrl);
      const authResult = await authService.authenticate(orgId);
      if (!authResult.success) {
        console.error('Authentication failed');
        process.exit(1);
      }
      const token = authService.getToken();
      if (token) serviceClient.setToken(token);

      const { tokens } = await serviceClient.listDeployTokens(orgId, projectId);

      if (tokens.length === 0) {
        console.log('  No deploy tokens for this project.');
        return;
      }

      console.log('');
      console.log(`  Deploy tokens for "${projectState.projectName}":`);
      console.log('');
      for (const t of tokens) {
        const status = t.revoked_at ? '\x1b[31mrevoked\x1b[0m' : '\x1b[32mactive\x1b[0m';
        const label = t.label ? ` (${t.label})` : '';
        const created = new Date(t.created_at).toLocaleDateString();
        console.log(`  ${t.deploy_id.slice(0, 12)}...${label}  ${status}  created ${created}`);
      }
      console.log('');
    } catch (error) {
      const { displayErrorAndExit } = await import('../ui/errorScreen');
      displayErrorAndExit(error);
    }
  }
}

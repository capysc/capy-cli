/**
 * `capy device-key enroll|list|remove` (CAP-382) — the device-key lifecycle
 * commands.
 *
 * NAMING DECISION (documented tension): the ticket sketch says `capy passkey
 * ...`, but invariant 9 mandates "device key" in every user-facing surface
 * (never "passkey"). This file names the command group `device-key`,
 * matching every other user-facing string in the program (keep-app's
 * ceremony page, CAP-380's onboarding module, this repo's own error-code
 * comments). `passkey` is flagged for ship-time: if the ticket title itself
 * is treated as user-facing anywhere (Linear, docs), it should be corrected
 * to match; this command's name is the one place code and copy must agree,
 * and it agrees with the invariant.
 *
 * Whole surface is gated behind CAPY_DEVICE_KEYS (flag.ts) — same standing
 * as every other CAP-382 wiring point: off by default, and off means "this
 * command refuses with a coded message", not a silently different behavior.
 */
import { AuthService } from '../auth/authService';
import { ServiceClient, KeyWrapperMetadata } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { AuthResult, CapyError, ERROR_CODES } from '../types/index';
import { deviceKeysEnabled } from '../auth/deviceKey/flag';
import {
  runDeviceKeyEnrollment,
  reportEnrollmentOutcome,
  DeviceKeyWiringContext,
} from '../auth/deviceKey/wiring';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

function refuseFlagOff(): never {
  console.error('');
  console.error('  Device keys are not enabled on this build.');
  console.error(`  Set ${B('CAPY_DEVICE_KEYS=1')} to try them.`);
  console.error('');
  process.exit(1);
}

async function bootstrapAuth(
  apiUrl: string | undefined,
  devMode: boolean,
): Promise<{ authService: AuthService; authResult: AuthResult; serviceClient: ServiceClient }> {
  const pm = new ProjectManager();
  const projectState = await pm.detectProjectState();
  const authService = new AuthService(apiUrl, devMode, projectState.userId);

  let authResult = await authService.authenticateSilent();
  if (!authResult.success) {
    authResult = await authService.authenticate();
  }
  if (!authResult.success || !authResult.user_id) {
    console.error(`\n  Sign-in failed: ${authResult.error || 'unknown error'}.\n`);
    process.exit(1);
  }

  const serviceClient = new ServiceClient(apiUrl, devMode);
  serviceClient.setTokenProvider(() => authService.getValidToken());
  return { authService, authResult, serviceClient };
}

export interface DeviceKeyCommandOptions {
  json?: boolean;
}

export class DeviceKeyEnrollCommand {
  constructor(private apiUrl?: string, private devMode: boolean = false) {}

  async execute(): Promise<void> {
    if (!deviceKeysEnabled()) refuseFlagOff();

    const { authService, authResult, serviceClient } = await bootstrapAuth(this.apiUrl, this.devMode);
    const ctx: DeviceKeyWiringContext = {
      authService,
      serviceClient,
      devMode: this.devMode,
      userId: authResult.user_id!,
      userEmail: authResult.user_email,
      organizations: authResult.organizations || [],
      activeOrgId: authResult.organization_id || null,
    };

    const orgName =
      ctx.organizations.find((o) => o.id === ctx.activeOrgId)?.name || ctx.organizations[0]?.name || 'your account';

    const outcome = await runDeviceKeyEnrollment(ctx);
    switch (outcome.kind) {
      case 'enrolled':
        reportEnrollmentOutcome(outcome.result, orgName);
        return;
      case 'declined':
        console.error(`\n  Ceremony not completed (${outcome.ceremonyCode}). No device key was enrolled.\n`);
        process.exitCode = 1;
        return;
      case 'already_enrolled':
        console.log('\n  This account already has a device key enrolled.');
        console.log(`  Run ${B('capy device-key list')} to see it.\n`);
        return;
      case 'not_ready':
        if (outcome.verdictKind === 'brand_new') {
          console.error('\n  No organization and no local encryption key yet.');
          console.error(`  Run ${B('capy')} first to create or join one, then retry.\n`);
        } else {
          console.error('\n  No usable local encryption key on this machine.');
          console.error(`  Run ${B('capy recover')} or ${B('capy redeem <code>')} first, then retry.\n`);
        }
        process.exitCode = 1;
        return;
    }
  }
}

function formatWrapperRow(w: KeyWrapperMetadata): string {
  const kind = w.type === 'wrapped_k_local' ? 'device key' : 'org key copy';
  const status = w.deleted_at ? 'removed' : w.is_seed ? 'seed' : w.verified_at ? 'verified' : 'unverified';
  const detail = w.credential_id ? `  ${w.credential_id.slice(0, 20)}…` : w.organization_id ? `  org:${w.organization_id}` : '';
  return `  ${w.id}  ${kind.padEnd(12)} ${status.padEnd(9)}${detail}`;
}

export class DeviceKeyListCommand {
  constructor(private apiUrl?: string, private devMode: boolean = false) {}

  async execute(options: DeviceKeyCommandOptions & { includeDeleted?: boolean } = {}): Promise<void> {
    if (!deviceKeysEnabled()) refuseFlagOff();

    const { serviceClient } = await bootstrapAuth(this.apiUrl, this.devMode);
    const wrappers = await serviceClient.listWrappers(options.includeDeleted ?? false);

    if (options.json) {
      console.log(JSON.stringify({ wrappers }, null, 2));
      return;
    }

    if (wrappers.length === 0) {
      console.log('\n  No device keys enrolled for this account.');
      console.log(`  Run ${B('capy device-key enroll')} to set one up.\n`);
      return;
    }

    console.log('');
    for (const w of wrappers) console.log(formatWrapperRow(w));
    console.log('');
  }
}

export class DeviceKeyRemoveCommand {
  constructor(private apiUrl?: string, private devMode: boolean = false) {}

  async execute(id: string): Promise<void> {
    if (!deviceKeysEnabled()) refuseFlagOff();

    const { serviceClient } = await bootstrapAuth(this.apiUrl, this.devMode);
    try {
      await serviceClient.deleteWrapper(id);
      console.log(`\n  Removed device key wrapper ${B(id)}.\n`);
    } catch (err) {
      if (err instanceof CapyError && err.code === ERROR_CODES.WRAPPER_INVARIANT_VIOLATION) {
        console.error('');
        console.error('  This is your only verified device key (or the account\'s enrollment seed).');
        console.error('  Removing it would leave this account without any verified device key backing');
        console.error('  up its encryption keys. Enroll a new device key, or verify another existing');
        console.error('  one, before removing this one.');
        console.error('');
        process.exit(1);
      }
      if (err instanceof CapyError && err.code === ERROR_CODES.WRAPPER_NOT_FOUND) {
        console.error(`\n  No device key wrapper found with id ${B(id)}.\n`);
        process.exit(1);
      }
      console.error(`\n  Failed to remove device key: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  }
}

/**
 * `capy doors` (CAP-378) — read-only inventory of "everything that can act
 * as this account": device keys, org key copies, and WorkOS sessions (the
 * only server-observable "signed in as me" signal this service has — see
 * DoorsInventory in serviceClient.ts for the honest gaps: transport codes
 * are never persisted server-side, and the sessions section can be marked
 * unavailable rather than silently empty).
 *
 * Account-wide, not project-scoped — same bootstrap shape as
 * `capy device-key list` (no keep.lock required; org context is resolved
 * through AuthService's own silent/interactive fallback chain, the
 * established session path for this class of command).
 *
 * Per-row revoke is deliberately NOT part of this command. The keep-app
 * doors page (`/flow/doors`) owns revocation — it can act on sessions too,
 * which this CLI has no other surface for. This command is the inventory
 * view; its own output tells the reader where to go to act on what it shows.
 */
import { AuthService } from '../auth/authService';
import { ServiceClient, Door, DoorsInventory, DoorType } from '../service/serviceClient';
import { ProjectManager } from '../core/projectManager';
import { AuthResult, CapyError, ERROR_CODES } from '../types/index';
import { formatRelativeTime } from '../ui/relativeTime';
import { keepOrigin } from '../ui/screens/keepScreens';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

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

const SECTION_ORDER: DoorType[] = ['device_key', 'org_key', 'session'];

const SECTION_TITLE: Record<string, string> = {
  device_key: 'Device keys',
  org_key: 'Org key copies',
  session: 'Sessions',
};

function kindLabel(t: DoorType): string {
  switch (t) {
    case 'device_key': return 'device key';
    case 'org_key': return 'org key copy';
    case 'session': return 'session';
    case 'transport_code': return 'transport code';
  }
}

function statusLabel(d: Door): string {
  if (d.door_type === 'session') return d.status ?? 'active';
  // device_key / org_key: the inventory only ever lists live rows, so
  // "removed" cannot happen here — only the verification tier matters.
  return d.is_seed ? 'seed' : d.verified_at ? 'verified' : 'unverified';
}

function detailFor(d: Door): string {
  if (d.door_type === 'device_key') {
    return d.credential_id ? `${d.credential_id.slice(0, 20)}…` : '';
  }
  if (d.door_type === 'org_key') {
    return d.organization_id ? `org:${d.organization_id}` : '';
  }
  if (d.door_type === 'session') {
    return [d.auth_method, d.ip_address].filter(Boolean).join(' · ');
  }
  return '';
}

function formatDoorRow(d: Door): string {
  const kind = kindLabel(d.door_type);
  const status = statusLabel(d);
  const detail = detailFor(d);
  const created = formatRelativeTime(d.created_at);
  const detailPart = detail ? `  ${detail}` : '';
  return `  ${d.id}  ${kind.padEnd(14)} ${status.padEnd(10)}${detailPart}  ${DIM}${created}${RESET}`;
}

function renderHuman(inventory: DoorsInventory): void {
  console.log('');

  if (inventory.doors.length === 0) {
    console.log('  No doors found for this account.');
  } else {
    for (const type of SECTION_ORDER) {
      const rows = inventory.doors.filter((d) => d.door_type === type);
      if (rows.length === 0) continue;
      console.log(`  ${B(SECTION_TITLE[type])}`);
      for (const d of rows) console.log(formatDoorRow(d));
      console.log('');
    }
  }

  if (inventory.sessions_unavailable_reason) {
    console.log(
      `  ${DIM}Sessions could not be listed (${inventory.sessions_unavailable_reason}) — that is not` +
        ` the same as having zero sessions.${RESET}`,
    );
  }
  for (const gap of inventory.unavailable_door_types) {
    if (gap.door_type === 'transport_code') {
      console.log(
        `  ${DIM}Transport codes never appear here — capy transport/redeem is a one-time exchange` +
          ` the server never stores (reason: ${gap.reason}).${RESET}`,
      );
    }
  }

  console.log('');
  console.log(`  capy doors is inventory-only. To revoke a door, visit ${B(`${keepOrigin()}/flow/doors`)}`);
  console.log(`  ${DIM}(device keys can also be removed with capy device-key remove <id>).${RESET}`);
  console.log('');
}

export interface DoorsCommandOptions {
  json?: boolean;
}

export class DoorsCommand {
  constructor(private apiUrl?: string, private devMode: boolean = false) {}

  async execute(options: DoorsCommandOptions = {}): Promise<void> {
    const { serviceClient } = await bootstrapAuth(this.apiUrl, this.devMode);

    let inventory: DoorsInventory;
    try {
      inventory = await serviceClient.listDoors();
    } catch (err) {
      if (err instanceof CapyError && err.code === ERROR_CODES.DOORS_NOT_SUPPORTED) {
        // Capability gap, not a request failure — the server this CLI is
        // pointed at predates the doors route. Coded (ServiceClient decided
        // this from the 404 status, never from response text) so this stays
        // distinguishable from every other listDoors failure below.
        console.error('');
        console.error('  capy doors is not available yet: this Capy service does not support');
        console.error('  device-key doors (no /doors route).');
        console.error('  If you administer this service, upgrade it; otherwise check back later.');
        console.error('');
        process.exit(1);
      }
      console.error(`\n  Failed to load doors: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(inventory, null, 2));
      return;
    }

    renderHuman(inventory);
  }
}

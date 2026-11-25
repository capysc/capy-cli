/**
 * What `capy pair` says about the machine asking to be paired (CAP-892, spec
 * section 3i). Keep shows it on its "Unlock Device" screen, badged as reported
 * by the device, so the person can tell the request is theirs. It is display
 * only: unauthenticated, never branched on by the service or Keep, and never
 * a secret. The service caps each field's length.
 */
import { arch, hostname, platform } from 'node:os';
import { cliVersion } from '../../cliVersion';

export interface PairingDeviceInfo {
  /** The machine's hostname. */
  readonly name?: string;
  /** Operating system and architecture, e.g. `macOS (arm64)`. */
  readonly system: string;
  /** e.g. `Capy CLI 0.9.18`. */
  readonly client: string;
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows', freebsd: 'FreeBSD' };

export function pairingDeviceInfo(): PairingDeviceInfo {
  const name = (() => {
    try {
      return hostname().trim().slice(0, 64);
    } catch {
      return '';
    }
  })();
  const os = platform();
  return {
    ...(name ? { name } : {}),
    system: `${PLATFORM_NAMES[os] ?? os} (${arch()})`,
    client: `Capy CLI ${cliVersion}`.slice(0, 64),
  };
}

import { pairCommand } from './pairCommand';
import { resolveActiveUrl } from '../config/profileConfig';
import type { AuthResult } from '../types/index';

export interface LoginOptions {
  readonly json?: boolean;
  readonly devMode?: boolean;
}

/**
 * Explicit login always establishes both a Keep device-grant session and a
 * Transport payload. It intentionally bypasses cached AuthService sessions.
 */
export async function loginCommand(options: LoginOptions = {}): Promise<AuthResult> {
  const devMode = options.devMode === true;
  return pairCommand({
    json: options.json === true,
    apiUrl: resolveActiveUrl(devMode),
    devMode,
    presentation: 'inline',
  });
}

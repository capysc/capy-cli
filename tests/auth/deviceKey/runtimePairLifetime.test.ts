/**
 * The runtime-pair holder and the temporary sandbox grant deliberately use
 * different lifetimes. Milliseconds stand in for minutes so this proves the
 * boundary without a 30-minute wall-clock test.
 */
import { describe, expect, test } from 'bun:test';
import {
  createGrantDaemonServer,
  fetchGrantedKLocal,
  listenGrantDaemonServer,
} from '../../../src/auth/deviceKey/grantHolder';
import { ERROR_CODES } from '../../../src/types/index';

const USER_ID = 'user_runtime_lifetime';
const CREDENTIAL_ID = 'credential_runtime_lifetime';
const keyMaterial = (): Buffer => Buffer.alloc(32, 0x4d);

describe('runtime-pair lifetime separation', () => {
  test('process-bound runtime custody remains usable beyond the simulated temporary-grant deadline', async () => {
    const daemon = createGrantDaemonServer(
      { userId: USER_ID, credentialId: CREDENTIAL_ID, kLocal: keyMaterial() },
      null,
    );
    await listenGrantDaemonServer(daemon.server, daemon.socketPath);
    try {
      await Bun.sleep(100);
      const fetched = await fetchGrantedKLocal(daemon.socketPath, USER_ID);
      expect(fetched.expiresAt).toBe(0);
      expect(fetched.kLocal).toEqual(keyMaterial());
    } finally {
      daemon.close();
    }
  });

  test('a finite temporary grant still expires and fails closed', async () => {
    const daemon = createGrantDaemonServer(
      { userId: USER_ID, credentialId: CREDENTIAL_ID, kLocal: keyMaterial() },
      30,
      { reapGraceMs: 300 },
    );
    await listenGrantDaemonServer(daemon.server, daemon.socketPath);
    try {
      await Bun.sleep(100);
      await expect(fetchGrantedKLocal(daemon.socketPath, USER_ID)).rejects.toMatchObject({
        code: ERROR_CODES.DEVICE_KEY_GRANT_EXPIRED,
      });
    } finally {
      daemon.close();
    }
  });
});

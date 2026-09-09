import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const [entrypoint, expected] of [['capy-dev', 'development'], ['capy', 'production'], ['capy-staging', 'staging']] as const) {
  test(`${entrypoint} nested grant recovery uses its environment with an isolated state directory`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'capy-environment-test-'));
    try {
      const script = join(directory, entrypoint);
      writeFileSync(script, `
        import { expect } from 'bun:test';
        import { runtimePairingEnvironment } from ${JSON.stringify(resolve('src/auth/pairing/runtimePairingEnvironment.ts'))};
        import { resolveRuntimePairingSocket } from ${JSON.stringify(resolve('src/auth/pairing/runtimePairingSocket.ts'))};
        const expected = ${JSON.stringify(expected)};
        expect(runtimePairingEnvironment()).toBe(expected);
        const record = { version: 1, userId: 'user_test', socketPath: '/test.sock',
          filesystemCustody: { environment: expected } };
        const socket = await resolveRuntimePairingSocket('/test.sock', 'user_test', {
          read: () => record,
          environment: runtimePairingEnvironment,
          recover: async (request) => {
            expect(request.environment).toBe(record.filesystemCustody.environment);
            expect(request.expectedUserId).toBe('user_test');
            return { ...record, socketPath: '/restored.sock' };
          },
        });
        expect(socket).toBe('/restored.sock');
      `);
      const result = spawnSync(process.execPath, [script], {
        env: { ...process.env, CAPY_GLOBAL_DIR_NAME: '.capy-dev-custom-regression' }, encoding: 'utf8',
      });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

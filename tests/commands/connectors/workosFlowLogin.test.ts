import { describe, expect, test } from 'bun:test';
import { workosFlowLoginArgs, workosLoginHandoff } from '../../../src/commands/connectors/workosFlowLogin';

describe('WorkOS provider login handoff', () => {
  test('uses the provider credential store by default', () => {
    expect(workosFlowLoginArgs(false)).toEqual(['auth', 'login', '--json']);
  });

  test('uses the approved sandbox file backend when explicitly requested', () => {
    expect(workosFlowLoginArgs(true)).toEqual(['auth', 'login', '--json', '--insecure-storage']);
  });

  test('forwards the public WorkOS provider URL and comparison code only', () => {
    expect(workosLoginHandoff('Open https://signin.workos.com/device\nEnter code: ABCD-EFGH\n'))
      .toEqual({ url: 'https://signin.workos.com/device', code: 'ABCD-EFGH' });
  });

  test('rejects a handoff for a different authentication service', () => {
    expect(workosLoginHandoff('Open https://example.com/device\nEnter code: ABCD-EFGH\n')).toBeNull();
  });
});

// Run the real process adapter against a fake WorkOS executable. This verifies
// logout really precedes login, without contacting WorkOS or reading keychains.
describe('fresh provider login process', () => {
  test('clears only WorkOS and relays its public in-flow authentication events', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'workos-flow-process-'));
    try {
      writeFileSync(join(root, 'workos'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$WORKOS_TEST_CALLS"\nif [ "$2" = "login" ]; then\nprintf "Open https://signin.workos.com/device\\nEnter code: ABCD-EFGH\\n"\nfi\n', { mode: 0o700 });
      const source = `
        import { mock } from 'bun:test';
        import { runWorkOSFlowLogin } from './src/commands/connectors/workosFlowLogin.ts';
        const progress = mock(async event => undefined);
        await runWorkOSFlowLogin({progress}, {force:true});
        console.log(JSON.stringify(progress.mock.calls.map(([event]) => event.provider_auth)));
      `;
      const child = Bun.spawnSync([process.execPath, '--eval', source], {
        cwd: join(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, WORKOS_TEST_CALLS: join(root, 'calls'), CAPY_WORKOS_INSECURE_STORAGE: '1' },
      });
      expect(child.exitCode).toBe(0);
      expect(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n')).toEqual([
        'auth logout --json --insecure-storage', 'auth login --json --insecure-storage',
      ]);
      const events = JSON.parse(new TextDecoder().decode(child.stdout));
      expect(events.map((event: Readonly<{ state: string }>) => event.state)).toEqual(['starting', 'pending', 'authorized']);
      expect(events[1].authorization_url).toBe('https://signin.workos.com/device');
      expect(events[1].verification_code).toBe('ABCD-EFGH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

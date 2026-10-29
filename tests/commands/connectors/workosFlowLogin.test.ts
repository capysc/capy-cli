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

const retryScenario = async (decisions: readonly boolean[], failCount: number) => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'workos-login-retry-'));
  try {
    writeFileSync(join(root, 'workos'), `#!/bin/sh
printf "%s\\n" "$*" >> "$WORKOS_TEST_CALLS"
if [ "$2" = "logout" ]; then exit 0; fi
count=$(grep -c 'auth login' "$WORKOS_TEST_CALLS")
if [ "$count" -le "$WORKOS_TEST_FAILURES" ]; then
  printf 'Open https://signin.workos.com/device\\nEnter code: AAAA-BBBB\\n'
  printf '{"error":{"code":"expired_token","message":"private-provider-fixture"}}\\n' >&2
  exit 1
fi
printf 'Open https://signin.workos.com/device\\nEnter code: CCCC-DDDD\\n'
`, { mode: 0o700 });
    const source = `
      import { mock } from 'bun:test';
      import { runWorkOSFlowLogin } from './src/commands/connectors/workosFlowLogin.ts';
      const decisions = ${JSON.stringify(decisions)};
      const progress = mock(async event => undefined);
      const prompt = mock(async question => {
        const decision = question.decide({value:decisions[prompt.mock.calls.length - 1]});
        if ('error' in decision) throw new Error(decision.error);
        return decision.value;
      });
      const result = await runWorkOSFlowLogin({progress,prompt}, {force:true})
        .then(() => ({ok:true})).catch(error => ({ok:false,cancelled:error.name==='ExitPromptError'}));
      console.log(JSON.stringify({result,events:progress.mock.calls.map(([event]) => event.provider_auth),questions:prompt.mock.calls.map(([question]) => question.view)}));
    `;
    const child = Bun.spawnSync([process.execPath, '--eval', source], {
      cwd: join(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, WORKOS_TEST_CALLS: join(root, 'calls'), WORKOS_TEST_FAILURES: String(failCount), CAPY_WORKOS_INSECURE_STORAGE: '1' },
    });
    if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    const output = new TextDecoder().decode(child.stdout);
    return { ...JSON.parse(output), calls: readFileSync(join(root, 'calls'), 'utf8').trim().split('\n'), leaked: output.includes('private-provider-fixture') };
  } finally { rmSync(root, { recursive: true, force: true }); }
};

describe('provider code expiry can recover inside the same rotation', () => {
  test('requests another code and continues after successful authentication', async () => {
    const result = await retryScenario([true], 1);
    expect(result.result).toEqual({ok:true});
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].text).toContain('Request a new code');
    expect(result.events.map((event: Readonly<{state:string}>) => event.state)).toEqual(['starting','pending','failed','starting','pending','authorized']);
    expect(result.events[1].verification_code).toBe('AAAA-BBBB');
    expect(result.events[4].verification_code).toBe('CCCC-DDDD');
    expect(result.events[1].id).not.toBe(result.events[4].id);
    expect(result.calls).toEqual(['auth logout --json --insecure-storage','auth login --json --insecure-storage','auth login --json --insecure-storage']);
    expect(result.leaked).toBe(false);
  });
  test('declining renewal cancels without starting a new login', async () => {
    const result = await retryScenario([false], 1);
    expect(result.result).toEqual({ok:false,cancelled:true});
    expect(result.calls).toHaveLength(2);
    expect(result.events.at(-1).state).toBe('failed');
    expect(result.leaked).toBe(false);
  });
  test('repeated expirations require a new explicit user decision every time', async () => {
    const result = await retryScenario([true,true], 2);
    expect(result.result.ok).toBe(true);
    expect(result.questions).toHaveLength(2);
    expect(result.calls.filter((call: string) => call.startsWith('auth login'))).toHaveLength(3);
    expect(result.leaked).toBe(false);
  });
});

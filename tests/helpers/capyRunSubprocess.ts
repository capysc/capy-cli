/**
 * CAP-383 — spawn the REAL built CLI (`dist/index.js run`) against a given
 * `~/.capy` tree, exactly the way `tests/commands/runCommand.test.ts`'s own
 * `capy()` helper does. Shared so every CAP-383 e2e file that needs to end a
 * scenario in "a real `capy run` invocation" does it identically.
 */
import { spawn } from 'child_process';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { Encryptor } from '../../src/crypto/encryptor';

/**
 * Point a spawned CLI at a test service by writing a PROFILE into its HOME.
 *
 * CAPY_API_URL used to do this, but the environment can no longer name an
 * origin — a var able to redirect a secrets CLI is an exfiltration channel.
 * A profile is the sanctioned mechanism, so tests exercise the same path real
 * operators use. `keepUrl` rides along on the same profile, which is what
 * keeps the two origins from drifting.
 */
export function writeTestProfile(home: string, serviceUrl: string, keepUrl?: string): void {
  const dir = join(home, '.capy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      default: 'test',
      profiles: { test: { url: serviceUrl, ...(keepUrl ? { keepUrl } : {}), displayName: 'test' } },
    }),
    { mode: 0o600 },
  );
}

export function capyRun(
  cwd: string,
  home: string,
  serviceUrl: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(__dirname, '../../dist/index.js');
  writeTestProfile(home, serviceUrl);
  return new Promise((resolve) => {
    const child = spawn('node', [cliPath, 'run', ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
      } as Record<string, string>,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const killer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.on('error', () => {
      clearTimeout(killer);
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

/** Writes a minimal keep.lock + a single-secret .env, ready for `capyRun`. */
export function writeEncryptedProject(
  projectDir: string,
  opts: { orgId: string; projectId: string; masterKey: Buffer; secretValue: string; deriveProjectKey: (m: Buffer, p: string, o: string) => string },
): void {
  writeFileSync(
    join(projectDir, 'keep.lock'),
    JSON.stringify({ version: '3.0', org_id: opts.orgId, project_id: opts.projectId, project_name: 'demo', variables: {} }),
  );
  const projectKeyHex = opts.deriveProjectKey(opts.masterKey, opts.projectId, opts.orgId);
  const ciphertext = Encryptor.encrypt(opts.secretValue, projectKeyHex);
  writeFileSync(join(projectDir, '.env'), `SECRET_VAR=capy:res123:${ciphertext}\n`);
}

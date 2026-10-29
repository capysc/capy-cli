import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { InteractionCommandError, ExitPromptError, type Interaction, type ProviderAuthentication } from '../../ui/interaction';

/** Only the public handoff from WorkOS CLI v0.22 login output is forwarded. */
export function workosLoginHandoff(text: string): Readonly<{ url: string; code: string }> | null {
  const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const candidate = plain.match(/https:\/\/signin\.workos\.com\/device(?:\?[^\s]*)?/u)?.[0];
  const code = plain.match(/Enter code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/u)?.[1];
  if (!candidate || !code) return null;
  const url = new URL(candidate);
  if (url.origin !== 'https://signin.workos.com' || url.pathname !== '/device' || url.username || url.password) return null;
  return { url: url.toString(), code };
}

/** File storage is opt-in for a sandbox whose owner has approved that backend. */
export const workosFlowLoginArgs = (insecureStorage: boolean): readonly string[] => [
  'auth', 'login', '--json', ...(insecureStorage ? ['--insecure-storage'] : []),
];

async function runWorkOSFlowLoginAttempt(
  interaction: Interaction,
  options: Readonly<{ force?: boolean }> = {},
): Promise<void> {
  const id = randomUUID();
  const report = async (state: ProviderAuthentication['state'], handoff?: Readonly<{ url: string; code: string }>, failureCode?: string): Promise<void> => {
    await interaction.progress({
      status: state === 'authorized' ? 'success' : state === 'failed' ? 'failure' : 'start',
      text: state === 'starting' ? 'Starting WorkOS login…' : state === 'pending'
        ? 'Sign in to WorkOS to continue rotation.' : state === 'authorized' ? 'WorkOS login completed.' : 'WorkOS login could not complete.',
      provider_auth: { id, provider: 'WorkOS', state, authorization_url: handoff?.url ?? null,
        verification_code: handoff?.code ?? null, expires_at: null, ...(failureCode ? { failure_code: failureCode } : {}) },
    });
  };
  await report('starting');
  // WorkOS auth login reuses a valid session unless the provider CLI logs out
  // first. This only clears WorkOS credentials, never the Capy session.
  if (options.force) {
    const storage = process.env.CAPY_WORKOS_INSECURE_STORAGE === '1' ? ['--insecure-storage'] : [];
    const logout = spawnSync('workos', ['auth', 'logout', '--json', ...storage], {
      stdio: 'pipe', env: { ...process.env, WORKOS_MODE: 'agent' },
    });
    if (logout.status !== 0) {
      await report('failed', undefined, 'ROTATE_WORKOS_LOGOUT_FAILED');
      throw new InteractionCommandError('ROTATE_WORKOS_LOGOUT_FAILED', 'Could not reset the WorkOS session for a fresh sign-in.');
    }
  }
  const child = spawn('workos', workosFlowLoginArgs(process.env.CAPY_WORKOS_INSECURE_STORAGE === '1'), {
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    env: { ...process.env, WORKOS_MODE: 'agent', CI: '', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const stop = (): void => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch { /* The provider may already have exited. */ }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', stop);
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new InteractionCommandError('ROTATE_WORKOS_LOGIN_START_FAILED', 'Could not start the WorkOS CLI.')));
    child.once('close', code => resolve(code));
  });
  // Observe rejection immediately even while consuming the public handoff.
  void completed.catch(() => undefined);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const consume = async (buffer: string, reported: boolean): Promise<void> => {
    const next = await iterator.next();
    if (next.done) return;
    if (reported) return consume('', true);
    const text = `${buffer}\n${next.value}`.slice(-16_384);
    const handoff = workosLoginHandoff(text);
    if (handoff) await report('pending', handoff);
    return consume(handoff ? '' : text, Boolean(handoff));
  };
  try {
    const [, code] = await Promise.all([consume('', false), completed]);
    if (code !== 0) throw new InteractionCommandError('ROTATE_WORKOS_LOGIN_FAILED', 'WorkOS login failed or expired. Start login again to continue.');
    await report('authorized');
  } catch (error) {
    stop();
    await report('failed', undefined, error instanceof InteractionCommandError ? error.code : 'ROTATE_WORKOS_LOGIN_FAILED');
    throw error;
  } finally {
    lines.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('exit', stop);
  }
}


/** Keep the rotation open while the user renews an expired provider handoff. */
export async function runWorkOSFlowLogin(
  interaction: Interaction,
  options: Readonly<{ force?: boolean }> = {},
): Promise<void> {
  const outcome = await runWorkOSFlowLoginAttempt(interaction, options)
    .then(() => ({ ok: true as const })).catch((error: unknown) => ({ ok: false as const, error }));
  if (outcome.ok) return;
  if (!(outcome.error instanceof InteractionCommandError) || outcome.error.code !== 'ROTATE_WORKOS_LOGIN_FAILED') throw outcome.error;
  const retry = await interaction.prompt<boolean>({
    view: {
      text: 'WorkOS login expired or could not complete. Request a new code to continue this rotation?',
      input: { kind: 'confirm', default: true },
    },
    decide: payload => typeof payload.value === 'boolean'
      ? { value: payload.value } : { error: 'Choose yes to request a new code, or no to cancel.' },
  });
  if (!retry) throw new ExitPromptError('WorkOS login cancelled; no key was created');
  // The previous child is fully closed before a new device authorization starts.
  // Logout is only needed for the initial forced reauthentication, not retries.
  return runWorkOSFlowLogin(interaction);
}

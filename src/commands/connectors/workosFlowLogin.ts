import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { InteractionCommandError, type Interaction, type ProviderAuthentication } from '../../ui/interaction';

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

export async function runWorkOSFlowLogin(interaction: Interaction): Promise<void> {
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
  const child = spawn('workos', ['auth', 'login', '--json'], {
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

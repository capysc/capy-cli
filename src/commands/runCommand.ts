import { spawn, ChildProcess } from 'child_process';

export async function runCommand(args: string[]): Promise<number> {
  if (args.length === 0) {
    console.error('Usage: capy run -- <command> [args...]');
    return 1;
  }

  // Import SDK dynamically to keep it out of the main CLI bundle path
  const capy = (await import('@capy/sdk')).default;

  // Let the SDK handle ALL .env reading and decryption.
  // SDK reads .env from CWD, resolves keys, decrypts capy: values in-place.
  // If no capy: values exist, this is a no-op (no key required).
  const env: Record<string, string | undefined> = { ...process.env };
  try {
    await capy.init(env, { dir: process.cwd() });
  } catch (err: any) {
    console.error(`capy run: ${err.message}`);
    return 1;
  }

  // Register signal handlers BEFORE spawn to avoid race condition
  let child: ChildProcess | null = null;
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => child?.kill(sig));
  }

  // Spawn child process with decrypted env
  child = spawn(args[0], args.slice(1), {
    env: env as Record<string, string>,
    stdio: 'inherit',
  });

  return new Promise((resolve) => {
    child!.on('error', (err) => {
      console.error(`capy run: ${err.message}`);
      resolve(1);
    });
    child!.on('close', (code) => resolve(code ?? 1));
  });
}

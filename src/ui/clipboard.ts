import { spawn } from 'child_process';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[90m${s}\x1b[0m`;

/** Construction, not mutation: `spawn` either returns the child synchronously or throws — this just turns the throw into a `null` return instead of a reassigned-after-declaration binding. (CAP-684 follow-up cleanup: this function's caller, `copyToClipboard`, is what this change touches.) */
function trySpawn(cmd: string, args: string[]) {
  try {
    return spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
  } catch {
    return null;
  }
}

function spawnCopy(cmd: string, args: string[], text: string): Promise<boolean> {
  const child = trySpawn(cmd, args);
  if (!child) return Promise.resolve(false);
  return new Promise((resolve) => {
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

/** Exported for `maskedLinkPrompt.ts`'s `c`-to-copy handler, which manages its own raw-mode prompt and calls this directly rather than going through `promptCopyToClipboard`'s own prompt-and-wait loop. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const platform = process.platform;
  if (platform === 'darwin') return spawnCopy('pbcopy', [], text);
  if (platform === 'win32') return spawnCopy('clip', [], text);
  const candidates: [string, string[]][] = [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
  for (const [cmd, args] of candidates) {
    if (await spawnCopy(cmd, args, text)) return true;
  }
  return false;
}

/**
 * Prompts the user to press `c` to copy text to the clipboard.
 * No-op when stdin is not a TTY (scripts, CI). Returns when the user
 * presses any key.
 */
export async function promptCopyToClipboard(text: string, indent = '  '): Promise<void> {
  if (!process.stdin.isTTY) return;

  process.stdout.write(`${indent}${DIM('Press')} ${B('c')} ${DIM(`to copy, or any other key to continue...`)} `);

  const key = await new Promise<string>((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (data: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      resolve(data);
    };
    stdin.on('data', onData);
  });

  process.stdout.write('\n');

  if (key === '\u0003') {
    process.exit(130);
  }

  if (key.toLowerCase() !== 'c') return;

  const ok = await copyToClipboard(text);
  if (ok) {
    console.log(`${indent}${GREEN('✓ Copied to clipboard')}`);
  } else {
    console.log(`${indent}${DIM('Could not access clipboard — copy the command above manually.')}`);
  }
}

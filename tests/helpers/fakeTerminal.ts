/**
 * A fake terminal for driving real inquirer prompts in tests: keys go in on a
 * stream, rendered output comes back as text. Nothing touches the real stdin,
 * stdout, a browser or the network.
 */
import { PassThrough } from 'stream';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const KEYS = {
  enter: '\r',
  down: '\x1b[B',
  up: '\x1b[A',
  backspace: '\x7f',
  escape: '\x1b',
} as const;

export function fakeTerminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (c) => chunks.push(String(c)));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    input,
    output,
    context: { input, output },
    /** Send keys one at a time, letting the prompt re-render between them. A lone Esc waits out readline's escape timeout. */
    async type(...keys: string[]): Promise<void> {
      for (const k of keys) {
        input.write(k);
        await wait(k === '\x1b' ? 600 : 15);
      }
    },
    /** Everything drawn so far, with colour codes removed. */
    screen(): string {
      return chunks.join('').replace(ANSI, '');
    },
    wait,
  };
}

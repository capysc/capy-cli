/**
 * The `capy pair` entry point: sends agent mode to `pairAgentCommand.ts`, the only agent flow (email, link with QR,
 * wait), and everything else to the terminal flow in `pairCommand.ts`, which it leaves exactly as it was.
 *
 * Agent mode is `--json` or no terminal (`isInteractive`), plus the flags that only exist for it (`--email`,
 * `--wait`, `--cancel`, `--code`).
 */
import { isInteractive } from '../ui/interactive';
import type { PairAgentOptions } from './pairAgentCommand';

export function isPairAgentMode(options: PairAgentOptions): boolean {
  return options.json === true || options.wait === true || options.cancel === true || options.email !== undefined || options.code !== undefined || !isInteractive();
}

export async function pairEntry(options: PairAgentOptions): Promise<void> {
  if (isPairAgentMode(options)) {
    const { pairAgentCommand } = await import('./pairAgentCommand');
    return pairAgentCommand(options);
  }
  const { pairCommand } = await import('./pairCommand');
  return pairCommand(options);
}

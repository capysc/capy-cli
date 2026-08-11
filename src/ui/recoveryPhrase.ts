import inquirer from 'inquirer';
import { isInteractive } from './interactive';
import { CapyError, ERROR_CODES } from '../types/index';

const warn = (s: string) => `\x1b[38;2;235;90;120m${s}\x1b[0m`;

/**
 * Render the recovery phrase inside the standard !!!IMPORTANT!!! box, offer to
 * copy it to the clipboard, and gate on an "I have saved my recovery phrase"
 * confirmation. Shared by org creation and local-only setup so every place
 * that shows a recovery phrase looks and behaves identically.
 *
 * `bodyLines` is the context-specific copy shown inside the lower box (org vs
 * local mode differ only in this body text).
 *
 * CAP-402: this is the ONE place in the CLI that prints a full recovery
 * phrase — the master-key-equivalent for whatever it seeds — to stdout in
 * plaintext. That is safe exactly when a human is physically at a real
 * terminal to read and write it down; it is the opposite of safe when
 * stdout is something else's input (an agent's own transcript, a log, a
 * pipe). `--web` callers never reach this function at all — they render the
 * phrase in a browser instead (see orgCreation.ts's own SECURITY comment) —
 * so the only question here is real-TTY or not.
 *
 * Refuses instead of printing when `isInteractive()` is false. The eventual
 * home for that case is a `keep.capy.sc` page reached over the broker
 * (CAP-376) — the CLI-to-page channel it needs is being built concurrently
 * and is not wired up yet, so for now a non-interactive caller gets a coded
 * refusal, not a silent downgrade to stdout and not a hang waiting on a
 * confirm prompt nobody can answer.
 */
export async function displayAndConfirmRecoveryPhrase(
  phrase: string,
  bodyLines: string[],
): Promise<void> {
  if (!isInteractive()) {
    throw new CapyError(
      'This would display a one-time recovery phrase, and only a human at a real terminal can safely record it.\n\n' +
      'Run this command at an interactive terminal, or have someone with terminal access do it and invite you afterward.',
      ERROR_CODES.RECOVERY_PHRASE_UNSAFE_SURFACE,
    );
  }

  const maxLen = Math.max(50, ...bodyLines.map((l) => l.length + 2));
  const title = '!!!IMPORTANT!!! - SAVE THIS RECOVERY PHRASE';
  const titlePad = Math.max(0, maxLen - title.length);
  const titleLeft = Math.floor(titlePad / 2);
  const titleRight = titlePad - titleLeft;

  console.log('');
  console.log(warn('─'.repeat(maxLen + 2)));
  console.log(warn(' '.repeat(titleLeft + 1) + title + ' '.repeat(titleRight + 1)));
  console.log(warn('─'.repeat(maxLen + 2)));
  console.log('');
  console.log('');
  console.log('');
  console.log(phrase);
  console.log('');
  console.log('');
  console.log('');

  console.log(warn('┌' + '─'.repeat(maxLen) + '┐'));
  for (const line of bodyLines) {
    const pad = maxLen - line.length - 1;
    console.log(`${warn('│')} ${warn(line)}${' '.repeat(Math.max(0, pad))}${warn('│')}`);
  }
  console.log(warn('└' + '─'.repeat(maxLen) + '┘'));
  console.log('');

  const { promptCopyToClipboard } = await import('./clipboard');
  await promptCopyToClipboard(phrase, '');
  console.log('');

  while (true) {
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: 'I have saved my recovery phrase',
      default: false,
    }]);
    if (confirmed) break;
    console.log(warn('⚠ The recovery phrase cannot be recovered if lost. Scroll up to review, then confirm.'));
    console.log('');
  }
}

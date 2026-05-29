import inquirer from 'inquirer';

const warn = (s: string) => `\x1b[38;2;235;90;120m${s}\x1b[0m`;

/**
 * Render the recovery phrase inside the standard !!!IMPORTANT!!! box, offer to
 * copy it to the clipboard, and gate on an "I have saved my recovery phrase"
 * confirmation. Shared by org creation and local-only setup so every place
 * that shows a recovery phrase looks and behaves identically.
 *
 * `bodyLines` is the context-specific copy shown inside the lower box (org vs
 * local mode differ only in this body text).
 */
export async function displayAndConfirmRecoveryPhrase(
  phrase: string,
  bodyLines: string[],
): Promise<void> {
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

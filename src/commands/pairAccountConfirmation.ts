import { CapyError, ERROR_CODES } from '../types/index';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;

function localPart(email: string): string {
  return email.split('@')[0] ?? '';
}

export async function confirmPairAccount(email: string, json: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new CapyError(`Account confirmation is required for ${email}. No session or keys were installed. Run capy pair in an interactive terminal.`, ERROR_CODES.AUTH_FAILED);
  }
  const inquirer = (await import('inquirer')).default;
  const prompt = inquirer.createPromptModule({ output: json ? process.stderr : process.stdout });
  const expectedLocalPart = localPart(email);
  const answer = await prompt<{ readonly localPart: string }>([{
    type: 'input',
    name: 'localPart',
    message: `Are you ${email}? If you are, enter ${B(expectedLocalPart)} to continue.`,
    validate: (value: string) => value === expectedLocalPart || 'The local part does not match this account.',
  }]);
  return answer.localPart === expectedLocalPart;
}

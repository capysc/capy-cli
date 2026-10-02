import { CapyError, ERROR_CODES } from '../types/index';

export async function confirmPairAccount(email: string, json: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new CapyError(`Account confirmation is required for ${email}. No session or keys were installed. Run capy pair in an interactive terminal.`, ERROR_CODES.AUTH_FAILED);
  }
  const inquirer = (await import('inquirer')).default;
  const prompt = inquirer.createPromptModule({ output: json ? process.stderr : process.stdout });
  const answer = await prompt<{ readonly confirmed: boolean }>([{
    type: 'confirm', name: 'confirmed', message: `Enable this location as ${email}?`, default: false,
  }]);
  return answer.confirmed;
}


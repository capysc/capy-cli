import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const promptMock = mock(async () => ({ localPart: 'accounts-slidespeak' }));
const createPromptModuleMock = mock((_options: unknown) => promptMock);

mock.module('inquirer', () => ({
  default: { createPromptModule: createPromptModuleMock },
}));

import { confirmPairAccount } from '../../src/commands/pairAccountConfirmation';

const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function setStdinTty(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

function promptQuestion(): any {
  return promptMock.mock.calls[0]?.[0]?.[0];
}

describe('confirmPairAccount', () => {
  beforeEach(() => {
    promptMock.mockClear();
    createPromptModuleMock.mockClear();
    promptMock.mockResolvedValue({ localPart: 'accounts-slidespeak' });
    setStdinTty(true);
  });

  afterEach(() => {
    if (originalStdinTty) Object.defineProperty(process.stdin, 'isTTY', originalStdinTty);
  });

  test('accepts only the exact local part and renders it in bold', async () => {
    await expect(confirmPairAccount('accounts-slidespeak@capy.sc', false)).resolves.toBe(true);

    const question = promptQuestion();
    expect(question).toMatchObject({ type: 'input', name: 'localPart' });
    expect(question.message).toBe(
      'Are you accounts-slidespeak@capy.sc? If you are, enter \x1b[1maccounts-slidespeak\x1b[0m to continue.',
    );
    expect(question.message.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('[');
    expect(question.default).toBeUndefined();
    expect(question.validate('accounts-slidespeak')).toBe(true);
  });

  test('refuses a mismatched local part', async () => {
    promptMock.mockResolvedValue({ localPart: 'someone-else' });

    await expect(confirmPairAccount('accounts-slidespeak@capy.sc', false)).resolves.toBe(false);
    expect(promptQuestion().validate('someone-else')).toBe('The local part does not match this account.');
  });

  test('refuses an empty local part', async () => {
    promptMock.mockResolvedValue({ localPart: '' });

    await expect(confirmPairAccount('accounts-slidespeak@capy.sc', false)).resolves.toBe(false);
    expect(promptQuestion().validate('')).toBe('The local part does not match this account.');
  });

  test('sends a JSON-mode prompt to stderr and a human prompt to stdout', async () => {
    await confirmPairAccount('accounts-slidespeak@capy.sc', true);
    expect(createPromptModuleMock).toHaveBeenLastCalledWith({ output: process.stderr });

    await confirmPairAccount('accounts-slidespeak@capy.sc', false);
    expect(createPromptModuleMock).toHaveBeenLastCalledWith({ output: process.stdout });
  });

  test('refuses non-TTY input before opening a prompt', async () => {
    setStdinTty(false);

    await expect(confirmPairAccount('accounts-slidespeak@capy.sc', true)).rejects.toMatchObject({
      code: ERROR_CODES.AUTH_FAILED,
    } satisfies Partial<CapyError>);
    expect(createPromptModuleMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });
});

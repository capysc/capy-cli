import { describe, test, expect } from 'bun:test';
import { confirmationQuestion } from '../../src/commands/pairConfirmationCode';

describe('the terminal question for the code Keep shows (CAP-877)', () => {
  test('asks plainly the first time', () => {
    expect(confirmationQuestion({ mismatch: false, attemptsLeft: 5 })).toBe('Enter the code shown in Keep:');
  });
  test('says the last code was wrong, with the tries left', () => {
    expect(confirmationQuestion({ mismatch: true, attemptsLeft: 1 })).toBe('That code did not match. 1 try left. Enter the code shown in Keep:');
    expect(confirmationQuestion({ mismatch: true, attemptsLeft: 3 })).toBe('That code did not match. 3 tries left. Enter the code shown in Keep:');
    expect(confirmationQuestion({ mismatch: true, attemptsLeft: null })).toBe('That code did not match. Enter the code shown in Keep:');
  });
});

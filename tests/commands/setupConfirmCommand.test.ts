import { describe, expect, test } from 'bun:test';

import { setupConfirmCommand } from '../../src/commands/setupCommand';

describe('setupConfirmCommand', () => {
  test('keeps plan and apply on the production binary', () => {
    expect(setupConfirmCommand('capy', 'sha256:abc')).toBe(
      'capy setup --json --confirm sha256:abc',
    );
  });

  test('keeps plan and apply on the development binary', () => {
    expect(setupConfirmCommand('capy-dev', 'sha256:def')).toBe(
      'capy-dev setup --json --confirm sha256:def',
    );
  });

  test('keeps plan and apply on the staging binary', () => {
    expect(setupConfirmCommand('capy-staging', 'sha256:ghi')).toBe(
      'capy-staging setup --json --confirm sha256:ghi',
    );
  });
});

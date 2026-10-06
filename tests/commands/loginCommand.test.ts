import { beforeEach, describe, expect, jest, mock, test } from 'bun:test';

const mockPairCommand = mock();
mock.module('../../src/commands/pairCommand', () => ({
  pairCommand: mockPairCommand,
}));

const mockResolveActiveUrl = mock();
mock.module('../../src/config/profileConfig', () => ({
  resolveActiveUrl: mockResolveActiveUrl,
}));

import { loginCommand } from '../../src/commands/loginCommand';

describe('loginCommand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveActiveUrl.mockReturnValue('https://staging.api.test');
    mockPairCommand.mockResolvedValue({ success: true, organization_id: 'org-123' });
  });

  test('always invokes device pairing for an explicit login', async () => {
    await expect(loginCommand()).resolves.toEqual({ success: true, organization_id: 'org-123' });
    expect(mockResolveActiveUrl).toHaveBeenCalledWith(false);
    expect(mockPairCommand).toHaveBeenCalledWith({
      json: false,
      apiUrl: 'https://staging.api.test',
      devMode: false,
      presentation: 'inline',
    });
  });

  test('preserves the active dev API selection and JSON channel', async () => {
    await loginCommand({ json: true, devMode: true });
    expect(mockResolveActiveUrl).toHaveBeenCalledWith(true);
    expect(mockPairCommand).toHaveBeenCalledWith({
      json: true,
      apiUrl: 'https://staging.api.test',
      devMode: true,
      presentation: 'inline',
    });
  });
});

/**
 * `capy pair` routing: agent mode goes to `pairAgentCommand`, the terminal flow stays `pairCommand`.
 * Both are mocked, so this only proves which one runs.
 */
import { mock, jest, describe, test, expect, beforeEach } from 'bun:test';

const mockIsInteractive = jest.fn();
const realInteractive = await import('../../src/ui/interactive');
mock.module('../../src/ui/interactive', () => ({ ...realInteractive, isInteractive: mockIsInteractive }));

const mockPairCommand = jest.fn(async () => {});
mock.module('../../src/commands/pairCommand', () => ({ pairCommand: mockPairCommand }));
const mockPairAgentCommand = jest.fn(async () => {});
mock.module('../../src/commands/pairAgentCommand', () => ({ pairAgentCommand: mockPairAgentCommand }));

const { pairEntry, isPairAgentMode } = await import('../../src/commands/pairEntry');

describe('capy pair routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a terminal without --json runs the terminal flow, untouched', async () => {
    mockIsInteractive.mockReturnValue(true);
    const options = { force: true };
    await pairEntry(options);
    expect(mockPairCommand).toHaveBeenCalledWith(options);
    expect(mockPairAgentCommand).not.toHaveBeenCalled();
  });

  test('--json is agent mode, even on a terminal', async () => {
    mockIsInteractive.mockReturnValue(true);
    await pairEntry({ json: true });
    expect(mockPairAgentCommand).toHaveBeenCalledTimes(1);
    expect(mockPairCommand).not.toHaveBeenCalled();
  });

  test('no terminal is agent mode', async () => {
    mockIsInteractive.mockReturnValue(false);
    await pairEntry({});
    expect(mockPairAgentCommand).toHaveBeenCalledTimes(1);
    expect(mockPairCommand).not.toHaveBeenCalled();
  });

  test.each([{ wait: true }, { cancel: true }, { email: 'a@b.co' }])('%p is agent mode on a terminal', async (options) => {
    mockIsInteractive.mockReturnValue(true);
    await pairEntry(options);
    expect(mockPairAgentCommand).toHaveBeenCalledTimes(1);
    expect(mockPairCommand).not.toHaveBeenCalled();
  });

  test('isPairAgentMode reads only the options and the terminal', () => {
    mockIsInteractive.mockReturnValue(true);
    expect(isPairAgentMode({})).toBe(false);
    expect(isPairAgentMode({ json: false, wait: false, cancel: false })).toBe(false);
  });
});

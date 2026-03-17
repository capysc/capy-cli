// Jest setup file for CLI tests

// Mock console methods to reduce test noise
global.console = {
  ...console,
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
};

// Mock process.exit to prevent tests from actually exiting
const mockExit = jest.fn();
Object.defineProperty(process, 'exit', {
  value: mockExit,
  writable: true
});

// Reset all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});
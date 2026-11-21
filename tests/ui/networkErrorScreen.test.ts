import { describe, it, expect } from 'bun:test';
import { renderError } from '../../src/ui/errorScreen';
import { CapyError, ERROR_CODES } from '../../src/types/index';
import { isDevBuild } from '../../src/config/prodPins';

const networkError = () => new CapyError('unreachable', ERROR_CODES.NETWORK_ERROR);

describe('network error screen', () => {
  it('production build prints neither capy-dev nor localhost:3000', () => {
    const out = renderError(networkError(), {}, {});
    expect(out).not.toContain('capy-dev');
    expect(out).not.toContain('localhost:3000');
    expect(out).toContain('2. The service is running');
  });

  it('dev build still prints the local service hint', () => {
    const out = renderError(networkError(), {}, { CAPY_GLOBAL_DIR_NAME: '.capy-dev' });
    expect(out).toContain('capy-dev: http://localhost:3000');
  });

  it('lists the blocked-connection check in both builds', () => {
    const prod = renderError(networkError(), {}, {});
    const dev = renderError(networkError(), {}, { CAPY_GLOBAL_DIR_NAME: '.capy-dev' });
    expect(prod).toContain('    3. ');
    expect(dev).toContain('    3. ');
  });

  it('isDevBuild reads the pinned variable, which prod strips', () => {
    expect(isDevBuild({})).toBe(false);
    expect(isDevBuild({ CAPY_GLOBAL_DIR_NAME: '.capy-dev' })).toBe(true);
  });
});

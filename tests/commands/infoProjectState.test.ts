import { describe, expect, it } from 'bun:test';
import { projectStateFor } from '../../src/commands/infoCommand';
import { CapyError, ERROR_CODES } from '../../src/types/index';

const client = (fail?: unknown) => ({
  listBranches: async () => {
    if (fail !== undefined) throw fail;
    return [{ name: 'main' }];
  },
});

describe('capy info: project state', () => {
  it('a branch list means the project is live', async () => {
    expect(await projectStateFor(client(), 'proj_1')).toBe('live');
  });

  it('the PROJECT_DELETED code means it was deleted', async () => {
    const err = new CapyError('gone', ERROR_CODES.PROJECT_DELETED);
    expect(await projectStateFor(client(err), 'proj_1')).toBe('deleted');
  });

  it('any other failure is unknown, never live or deleted', async () => {
    expect(await projectStateFor(client(new CapyError('down', ERROR_CODES.SERVICE_ERROR)), 'proj_1')).toBe('unknown');
    expect(await projectStateFor(client(new Error('network')), 'proj_1')).toBe('unknown');
  });
});

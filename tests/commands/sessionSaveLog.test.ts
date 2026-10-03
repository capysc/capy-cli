/**
 * The append-only log of a `capy edit` session's saves (sessionSaveLog.ts).
 */
import { describe, test, expect } from 'bun:test';
import { startSaveLog } from '../../src/commands/sessionSaveLog';
import type { EditSaveRecord } from '../../src/deploy/keepGate';

const save = (variable: string): EditSaveRecord => ({
  branch: 'development',
  entries: [{ variable, entry: { resource_id: `r-${variable}`, branch: 'development', value_hash: variable } }],
});

describe('startSaveLog', () => {
  test('returns every save, in order', async () => {
    const log = startSaveLog();
    log.record(save('A'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    log.record(save('B'));
    log.record(save('C'));
    expect((await log.finish()).map((r) => r.entries[0].variable)).toEqual(['A', 'B', 'C']);
  });

  test('a save recorded right before finish() is not lost', async () => {
    const log = startSaveLog();
    log.record(save('LAST'));
    expect((await log.finish()).map((r) => r.entries[0].variable)).toEqual(['LAST']);
  });

  test('no saves: empty', async () => {
    expect(await startSaveLog().finish()).toEqual([]);
  });

  test('two logs do not share saves', async () => {
    const a = startSaveLog();
    const b = startSaveLog();
    a.record(save('ONLY_A'));
    expect(await b.finish()).toEqual([]);
    expect(await a.finish()).toHaveLength(1);
  });
});

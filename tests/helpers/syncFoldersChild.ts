/**
 * Run as a child process (HOME points at a throwaway world): bare `capy`'s real runner over the folders given as
 * arguments, one after the other, the way a discovery run does. Prints one JSON line: each folder's result, the working
 * directory before and after, and whether anything tried to end the process.
 */
import { syncFolder } from '../../src/sync/gate';

const folders = process.argv.slice(2);
const ended = { code: undefined as number | undefined };
process.exit = ((code?: number) => {
  Object.assign(ended, { code: code ?? 0 });
  throw new Error('the process must not end');
}) as never;

const before = process.cwd();
const results = await folders.reduce<Promise<readonly unknown[]>>(
  async (acc, dir) => [...(await acc), await syncFolder(dir, { json: true, nonTty: true })],
  Promise.resolve([]),
);
console.log(JSON.stringify({ results, before, after: process.cwd(), ended: ended.code }));

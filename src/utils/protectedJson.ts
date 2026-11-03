import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { getGlobalCapyDir } from '../config/globalConfig';

const refuse = (): never => { throw new Error('FLOW_CHECKPOINT_PERMISSIONS'); };
const assertDirectories = (path: string): void => {
  const home = getGlobalCapyDir();
  const parts = relative(home, dirname(path)).split(sep);
  if (parts.includes('..')) return refuse();
  for (const directory of [home, ...parts.map((_part, index) => join(home, ...parts.slice(0, index + 1)))]) {
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) return refuse();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
};

export function readProtectedJson<T>(path: string): T | null {
  assertDirectories(path);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1_048_576
    || (process.getuid && stat.uid !== process.getuid())) return refuse();
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function saveProtectedJson(path: string, value: unknown): void {
  assertDirectories(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertDirectories(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

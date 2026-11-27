/**
 * The files discovery looks at (CAP-927): a bounded walk of the folder that skips Git, dependencies, build output and
 * lockfiles and `.env*` files, and never follows a link. Each file's text is read at most once, and only when the scan asks for it.
 */
import { lstatSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ScanFile } from './scan';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'bower_components', 'vendor', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
  '.output', '.terraform', '.serverless', '.wrangler', '.idea', '.vscode', '.capy',
]);

const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Gemfile.lock', 'poetry.lock', 'go.sum', 'Cargo.lock', 'composer.lock']);

export const MAX_FILES = 5000;
export const MAX_BYTES = 512 * 1024;

export interface Walk {
  readonly files: readonly ScanFile[];
  readonly truncated: boolean;
}

/** `.vercel/output` is build output; `.vercel/project.json` is the signal discovery wants. */
function skipDir(relative: string, name: string): boolean {
  return SKIP_DIRS.has(name) || relative === '.vercel/output' || relative.endsWith('/.vercel/output');
}

function lazyText(absolute: string): () => string | undefined {
  let read = false;
  let text: string | undefined;
  return () => {
    if (!read) {
      read = true;
      try {
        const content = readFileSync(absolute);
        // A NUL byte in the first few KB means a binary file: nothing to scan.
        text = content.subarray(0, 8192).includes(0) ? undefined : content.toString('utf-8');
      } catch {
        text = undefined;
      }
    }
    return text;
  };
}

export function walkFolder(root: string, maxFiles: number = MAX_FILES): Walk {
  const files: ScanFile[] = [];
  const queue: string[] = [''];
  while (queue.length > 0) {
    const relativeDir = queue.shift() as string;
    let entries: string[];
    try {
      entries = readdirSync(join(root, relativeDir)).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      const relative = relativeDir === '' ? name : `${relativeDir}/${name}`;
      const absolute = join(root, relative);
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (!skipDir(relative, name)) queue.push(relative);
        continue;
      }
      // `.env*` files are never handed to the scan, so no rule can ever read a value from one.
      if (!stat.isFile() || stat.size > MAX_BYTES || SKIP_FILES.has(name) || name.startsWith('.env')) continue;
      if (files.length >= maxFiles) return { files, truncated: true };
      files.push({ path: relative, text: lazyText(absolute) });
    }
  }
  return { files, truncated: false };
}

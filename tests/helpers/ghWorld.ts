/**
 * A fake `gh` first on PATH for a built-cli test, plus a git checkout with an
 * `origin`: enough for the keep.lock PR step's reads (default branch) and for
 * proving a dry run made no GitHub write. Nothing touches the network.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Harness } from './pipedHarness';

const FAKE_GH_SCRIPT = join(__dirname, 'fake-gh.cjs');

/** Puts a fake gh on PATH that knows `acme/solo` (default branch `main`). Returns the env a cli run needs. */
export function installFakeGh(h: Harness, defaultBranch = 'main'): Record<string, string> {
  const bin = join(h.root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(FAKE_GH_SCRIPT)});\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(h.root, 'gh-config.json'), JSON.stringify({ repos: { 'acme/solo': { id: 42, default_branch: defaultBranch, files: {} } } }));
  return { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_GH_DIR: h.root };
}

/** `git init` the project folder with an `origin`. */
export function gitInit(dir: string, origin: string): void {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
}

/** Every call the fake gh received. */
export function ghCalls(h: Harness): Array<{ args: string[]; stdin: string }> {
  try {
    return readFileSync(join(h.root, 'gh-log.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { args: string[]; stdin: string });
  } catch {
    return [];
  }
}

/** A read in POST clothing: the batched GraphQL default-branch query. */
export const isGraphqlRead = (c: { args: string[] }): boolean => c.args[c.args.length - 1] === 'graphql';

/** The GitHub calls that would have written something (any POST except the GraphQL read). */
export const ghWrites = (h: Harness) => ghCalls(h).filter((c) => c.args.includes('POST') && !isGraphqlRead(c));
